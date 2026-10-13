const express = require('express');
const q = require('../lib/queries');
const { action, rateLimit, flash } = require('../lib/middleware');
const { HttpError, toInt } = require('../lib/util');

module.exports = function publicRoutes(ctx) {
  const { db, settings, config } = ctx;
  const router = express.Router();
  const formLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });

  function withCategories(readers) {
    return readers.map((r) => ({ ...r, categories: q.readerCategories(db, r.id) }));
  }

  router.get('/', (req, res) => {
    res.render('public/home', {
      title: settings.get('site_tagline'),
      banners: db.prepare('SELECT * FROM banners WHERE active = 1 ORDER BY sort_order').all(),
      top: q.topReaders(db, 3),
      categories: q.categories(db),
      readers: withCategories(q.readerList(db, { limit: 9 })),
      packages: q.packages(db),
      reviews: q.recentReviews(db, 8),
      posts: q.recentPosts(db, 3),
      firstPurchase: !req.user || !ctx.payments.hasPaidCreditOrder(req.user.id),
    });
  });

  router.get(['/tarologos', '/categorias/:slug'], (req, res, next) => {
    const cats = q.categories(db);
    let category = null;
    if (req.params.slug) {
      category = cats.find((c) => c.slug === req.params.slug);
      if (!category) return next();
    }
    return res.render('public/readers', {
      title: category ? `Tarólogos: ${category.name}` : 'Consulta de tarot online',
      categories: cats,
      category,
      readers: withCategories(q.readerList(db, { categoryId: category && category.id })),
    });
  });

  router.get('/tarologo/:slug', (req, res, next) => {
    const reader = db.prepare('SELECT * FROM readers WHERE slug = ? AND active = 1').get(req.params.slug);
    if (!reader) return next();
    const reviews = ctx.reviews.forReader(reader.id, { limit: 100 });
    return res.render('public/reader', {
      title: reader.display_name,
      description: (reader.bio || '').slice(0, 155),
      r: reader,
      categories: q.readerCategories(db, reader.id),
      reviews,
      reviewCount: reviews.length,
      slots: ctx.appointments.upcomingSlots(reader.id),
      balance: req.user ? ctx.wallet.balance(req.user.id) : 0,
      alertActive: req.user ? !!db.prepare('SELECT 1 FROM availability_alerts WHERE client_id = ? AND reader_id = ? AND notified_at IS NULL').get(req.user.id, reader.id) : false,
      maxQuestions: settings.get('question_max_per_order'),
    });
  });

  router.get('/comprar-creditos', (req, res) => {
    res.render('public/buy', {
      title: 'Comprar créditos',
      packages: q.packages(db),
      firstPurchase: !req.user || !ctx.payments.hasPaidCreditOrder(req.user.id),
      firstBonus: settings.get('first_purchase_bonus_cents'),
      refPrice: settings.get('default_price_chat_cents'),
      selected: toInt(req.query.pacote, 0),
    });
  });

  router.get('/perguntas-frequentes', (req, res) => {
    res.render('public/faq', { title: 'Como consultar', faqs: db.prepare('SELECT * FROM faqs WHERE active = 1 ORDER BY sort_order').all() });
  });

  router.get(['/quem-somos', '/termos-de-uso', '/politica-de-privacidade'], (req, res, next) => {
    const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.path.slice(1));
    if (!page) return next();
    return res.render('public/page', { title: page.title, page });
  });

  router.get('/depoimentos', (req, res) => {
    res.render('public/testimonials', { title: 'Depoimentos', reviews: q.recentReviews(db, 60) });
  });

  router.get('/contato', (req, res) => res.render('public/contact', { title: 'Fale conosco' }));
  router.post('/contato', formLimiter, action(async (req, res) => {
    const b = req.body;
    if (b.website) throw new HttpError(400, 'Mensagem inválida');
    if (!b.name || !b.email || !b.message) throw new HttpError(400, 'Preencha nome, e-mail e mensagem');
    db.prepare('INSERT INTO contacts (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)')
      .run(String(b.name).slice(0, 120), String(b.email).slice(0, 160), String(b.phone || '').slice(0, 30), String(b.subject || '').slice(0, 150), String(b.message).slice(0, 5000));
    ctx.notifications.notifyAdmins({ title: 'Nova mensagem de contato', body: b.subject || b.name, link: '/admin/contatos' });
    flash(req, 'success', 'Mensagem enviada! Responderemos pelo e-mail informado.');
    res.redirect('/contato');
  }));

  router.get('/trabalhe-conosco', (req, res) => res.render('public/apply', { title: 'Trabalhe conosco' }));
  router.post('/trabalhe-conosco', formLimiter, action(async (req, res) => {
    const b = req.body;
    if (b.website) throw new HttpError(400, 'Cadastro inválido');
    const required = ['name', 'email', 'birth_date', 'location', 'phone', 'professional_name', 'experience', 'schedule', 'oracles', 'profile'];
    if (required.some((k) => !String(b[k] || '').trim())) throw new HttpError(400, 'Preencha todos os campos obrigatórios');
    if (!b.terms) throw new HttpError(400, 'Aceite os termos para enviar');
    const social = ['facebook', 'instagram', 'youtube'].map((k) => (b[k] ? `${k}: ${b[k]}` : '')).filter(Boolean).join(' | ');
    db.prepare(`INSERT INTO applications (name, email, birth_date, location, phone, social, professional_name, experience, schedule, oracles, profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...['name', 'email', 'birth_date', 'location', 'phone'].map((k) => String(b[k]).slice(0, 300)),
      social, ...['professional_name', 'experience', 'schedule', 'oracles'].map((k) => String(b[k]).slice(0, 300)), String(b.profile).slice(0, 5000),
    );
    ctx.notifications.notifyAdmins({ title: 'Nova candidatura de tarólogo', body: b.professional_name, link: '/admin/candidaturas' });
    flash(req, 'success', 'Candidatura enviada! Nossa equipe vai analisar e entrar em contato.');
    res.redirect('/trabalhe-conosco');
  }));

  // ---- Blog ----------------------------------------------------------------
  router.get(['/blog', '/blog/categoria/:slug'], (req, res, next) => {
    const cats = db.prepare('SELECT * FROM blog_categories ORDER BY name').all();
    let category = null;
    if (req.params.slug) {
      category = cats.find((c) => c.slug === req.params.slug);
      if (!category) return next();
    }
    const page = Math.max(1, toInt(req.query.pagina, 1));
    const per = 9;
    const where = `p.published = 1${category ? ' AND p.category_id = ?' : ''}`;
    const params = category ? [category.id] : [];
    const total = db.prepare(`SELECT COUNT(*) n FROM blog_posts p WHERE ${where}`).get(...params).n;
    const posts = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM blog_posts p
      LEFT JOIN blog_categories c ON c.id = p.category_id WHERE ${where} ORDER BY p.published_at DESC LIMIT ? OFFSET ?`)
      .all(...params, per, (page - 1) * per);
    return res.render('public/blog', { title: category ? `Blog: ${category.name}` : 'Blog', cats, category, posts, page, pages: Math.ceil(total / per) || 1 });
  });

  router.get('/blog/:slug', (req, res, next) => {
    const post = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM blog_posts p
      LEFT JOIN blog_categories c ON c.id = p.category_id WHERE p.slug = ? AND p.published = 1`).get(req.params.slug);
    if (!post) return next();
    return res.render('public/post', {
      title: post.title,
      description: post.excerpt,
      post,
      comments: db.prepare("SELECT * FROM blog_comments WHERE post_id = ? AND status = 'approved' ORDER BY id").all(post.id),
      shareUrl: `${config.baseUrl}/blog/${post.slug}`,
    });
  });

  router.post('/blog/:slug/comentar', formLimiter, action(async (req, res) => {
    const post = db.prepare('SELECT id, slug FROM blog_posts WHERE slug = ? AND published = 1').get(req.params.slug);
    if (!post) throw new HttpError(404, 'Artigo não encontrado');
    if (req.body.website) throw new HttpError(400, 'Comentário inválido');
    const name = String(req.body.name || (req.user && req.user.name) || '').trim().slice(0, 80);
    const body = String(req.body.body || '').trim().slice(0, 2000);
    if (!name || body.length < 3) throw new HttpError(400, 'Preencha nome e comentário');
    const status = settings.get('comments_require_approval') ? 'pending' : 'approved';
    db.prepare('INSERT INTO blog_comments (post_id, name, email, body, status) VALUES (?, ?, ?, ?, ?)')
      .run(post.id, name, String(req.body.email || '').slice(0, 160), body, status);
    flash(req, 'success', status === 'pending' ? 'Comentário enviado para aprovação.' : 'Comentário publicado.');
    res.redirect(`/blog/${post.slug}#comentarios`);
  }));

  // ---- Loja ----------------------------------------------------------------
  router.get(['/loja', '/loja/categoria/:slug'], (req, res, next) => {
    const cats = db.prepare('SELECT * FROM product_categories ORDER BY name').all();
    let category = null;
    if (req.params.slug) {
      category = cats.find((c) => c.slug === req.params.slug);
      if (!category) return next();
    }
    const search = String(req.query.busca || '').trim();
    const where = ['active = 1'];
    const params = [];
    if (category) { where.push('category_id = ?'); params.push(category.id); }
    if (search) { where.push('(name LIKE ? OR summary LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (req.query.ofertas) where.push('compare_at_cents > price_cents');
    const products = db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY sort_order, name`).all(...params);
    return res.render('public/store', { title: 'Loja', cats, category, products, search });
  });

  router.get('/loja/produto/:slug', (req, res, next) => {
    const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
    if (!product) return next();
    return res.render('public/product', { title: product.name, description: product.summary, product, shareUrl: `${config.baseUrl}/loja/produto/${product.slug}` });
  });

  function cartView(req) {
    const items = (req.session.cart || []).map((i) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(i.productId);
      return p ? { ...i, product: p, lineCents: p.price_cents * i.quantity } : null;
    }).filter(Boolean);
    return { items, totalCents: items.reduce((s, i) => s + i.lineCents, 0) };
  }

  router.get('/carrinho', (req, res) => res.render('public/cart', { title: 'Carrinho', ...cartView(req) }));

  router.post('/carrinho', action(async (req, res) => {
    const productId = toInt(req.body.product_id);
    const quantity = Math.max(0, Math.min(99, toInt(req.body.quantity, 1)));
    if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(productId)) throw new HttpError(404, 'Produto indisponível');
    const cart = (req.session.cart || []).filter((i) => i.productId !== productId);
    if (quantity > 0) {
      const existing = (req.session.cart || []).find((i) => i.productId === productId);
      const qty = req.body.mode === 'set' ? quantity : (existing ? existing.quantity : 0) + quantity;
      cart.push({ productId, quantity: Math.min(99, qty) });
    }
    req.session.cart = cart;
    if (req.body.mode !== 'set') flash(req, 'success', 'Produto adicionado ao carrinho.');
    res.redirect('/carrinho');
  }));

  router.post('/carrinho/finalizar', action(async (req, res) => {
    if (!req.user) return res.redirect('/entrar?next=/carrinho');
    const { items } = cartView(req);
    const order = ctx.payments.createStoreOrder(req.user.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      req.body.notes ? { notes: String(req.body.notes).slice(0, 1000) } : null);
    req.session.cart = [];
    return res.redirect(`/pagamento/${order.id}`);
  }));

  // ---- SEO -----------------------------------------------------------------
  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /atendente\nDisallow: /minha-conta\nDisallow: /pagamento\nDisallow: /sala\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', (req, res) => {
    const urls = ['/', '/tarologos', '/comprar-creditos', '/perguntas-frequentes', '/quem-somos', '/contato', '/trabalhe-conosco',
      '/depoimentos', '/blog', '/loja', '/termos-de-uso', '/politica-de-privacidade'];
    for (const c of q.categories(db)) urls.push(`/categorias/${c.slug}`);
    for (const r of db.prepare('SELECT slug FROM readers WHERE active = 1').all()) urls.push(`/tarologo/${r.slug}`);
    for (const p of db.prepare('SELECT slug FROM blog_posts WHERE published = 1').all()) urls.push(`/blog/${p.slug}`);
    for (const p of db.prepare('SELECT slug FROM products WHERE active = 1').all()) urls.push(`/loja/produto/${p.slug}`);
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${config.baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>`);
  });

  router.get('/manifest.webmanifest', (req, res) => {
    res.json({
      name: settings.get('site_name'),
      short_name: settings.get('site_name'),
      start_url: '/',
      display: 'standalone',
      background_color: '#160b26',
      theme_color: '#2a1245',
      icons: [{ src: '/public/img/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  });

  return router;
};
