const express = require('express');
const q = require('../lib/queries');
const { action, rateLimit, flash } = require('../lib/middleware');
const { HttpError, toInt } = require('../lib/util');
const { metaDescription, stripHtml } = require('../lib/seo');

module.exports = function publicRoutes(ctx) {
  const { db, settings, config } = ctx;
  const router = express.Router();
  const formLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
  const seo = () => ctx.seo;

  function withCategories(readers) {
    return readers.map((r) => ({ ...r, categories: q.readerCategories(db, r.id) }));
  }

  router.get('/', (req, res) => {
    res.render('public/home', {
      title: settings.get('site_tagline'),
      description: `Consulta de tarot online com tarólogos experientes. Chat ao vivo a partir de ${ctx.util.money(settings.get('default_price_chat_cents'))}/min, perguntas avulsas e agendamento. Bônus na primeira compra.`,
      jsonld: [seo().organization(), seo().website()],
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
      title: category ? `Tarot para ${category.name.toLowerCase()} — consulta online` : 'Tarólogos online: consulta de tarot por chat',
      description: category ? metaDescription(category.description, `Tarólogos especialistas em ${category.name.toLowerCase()}. Consulte agora por chat ao vivo.`)
        : 'Escolha entre tarólogos e oraculistas online agora. Veja avaliações, especialidades e preços e comece a consulta por chat em segundos.',
      breadcrumbs: category ? [['Início', '/'], ['Tarólogos', '/tarologos'], [category.name, `/categorias/${category.slug}`]] : [['Início', '/'], ['Tarólogos', '/tarologos']],
      jsonld: [seo().breadcrumbs(category ? [['Início', '/'], ['Tarólogos', '/tarologos'], [category.name, `/categorias/${category.slug}`]] : [['Início', '/'], ['Tarólogos', '/tarologos']])],
      categories: cats,
      category,
      readers: withCategories(q.readerList(db, { categoryId: category && category.id })),
    });
  });

  router.get('/tarologo/:slug', (req, res, next) => {
    const reader = db.prepare('SELECT * FROM readers WHERE slug = ? AND active = 1').get(req.params.slug);
    if (!reader) return next();
    const reviews = ctx.reviews.forReader(reader.id, { limit: 100 });
    const cats = q.readerCategories(db, reader.id);
    const crumbs = [['Início', '/'], ['Tarólogos', '/tarologos'], [reader.display_name, `/tarologo/${reader.slug}`]];
    return res.render('public/reader', {
      title: reader.meta_title || `${reader.display_name} — tarot online por chat`,
      description: metaDescription(reader.meta_description, `${reader.display_name}: ${reader.oracles || 'tarot'}. ${reader.bio || ''}`),
      ogImage: reader.photo,
      ogType: 'profile',
      breadcrumbs: crumbs,
      jsonld: [seo().reader(reader, cats), seo().breadcrumbs(crumbs)],
      r: reader,
      categories: cats,
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
      title: 'Comprar créditos para consulta de tarot',
      description: 'Pacotes de créditos para consultas de tarot por chat e perguntas avulsas. Pague com Pix, cartão ou PayPal e ganhe bônus na primeira compra.',
      packages: q.packages(db),
      firstPurchase: !req.user || !ctx.payments.hasPaidCreditOrder(req.user.id),
      firstBonus: settings.get('first_purchase_bonus_cents'),
      refPrice: settings.get('default_price_chat_cents'),
      selected: toInt(req.query.pacote, 0),
    });
  });

  router.get('/perguntas-frequentes', (req, res) => {
    const faqs = db.prepare('SELECT * FROM faqs WHERE active = 1 ORDER BY sort_order').all();
    res.render('public/faq', {
      title: 'Como consultar e perguntas frequentes',
      description: 'Saiba como funciona a consulta de tarot online: cadastro, compra de créditos, cobrança por minuto, formas de pagamento e cancelamentos.',
      faqs,
      jsonld: [seo().faq(faqs)],
    });
  });

  router.get(['/quem-somos', '/termos-de-uso', '/politica-de-privacidade'], (req, res, next) => {
    const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.path.slice(1));
    if (!page) return next();
    return res.render('public/page', { title: page.title, page, description: metaDescription(page.body) });
  });

  router.get('/depoimentos', (req, res) => {
    res.render('public/testimonials', { title: 'Depoimentos de clientes', description: 'Leia o que nossos clientes dizem sobre as consultas de tarot online com nossos tarólogos.', reviews: q.recentReviews(db, 60) });
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
  const postSelect = `SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM blog_posts p
    LEFT JOIN blog_categories c ON c.id = p.category_id`;

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
    const posts = db.prepare(`${postSelect} WHERE ${where} ORDER BY p.published_at DESC LIMIT ? OFFSET ?`)
      .all(...params, per, (page - 1) * per);
    const basePath = category ? `/blog/categoria/${category.slug}` : '/blog';
    const crumbs = [['Início', '/'], ['Blog', '/blog'], ...(category ? [[category.name, basePath]] : [])];
    return res.render('public/blog', {
      title: `${category ? category.name : 'Blog de tarot, espiritualidade e autoconhecimento'}${page > 1 ? ` — página ${page}` : ''}`,
      description: metaDescription(category && category.description, 'Artigos sobre tarot, signos, espiritualidade e amor para você se conhecer melhor e aproveitar cada consulta.'),
      canonical: `${config.baseUrl}${basePath}${page > 1 ? `?pagina=${page}` : ''}`,
      breadcrumbs: crumbs,
      jsonld: [seo().breadcrumbs(crumbs)],
      cats, category, posts, page, pages: Math.ceil(total / per) || 1, basePath,
    });
  });

  router.get('/blog/feed.xml', (req, res) => {
    const posts = db.prepare(`${postSelect} WHERE p.published = 1 ORDER BY p.published_at DESC LIMIT 30`).all();
    const x = ctx.util.escapeHtml;
    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${x(settings.get('site_name'))} — Blog</title><link>${config.baseUrl}/blog</link><language>pt-BR</language>
<description>${x(settings.get('site_tagline'))}</description>
${posts.map((p) => `<item><title>${x(p.title)}</title><link>${config.baseUrl}/blog/${p.slug}</link><guid>${config.baseUrl}/blog/${p.slug}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate><description>${x(metaDescription(p.excerpt, p.body))}</description></item>`).join('\n')}
</channel></rss>`);
  });

  router.get('/blog/:slug', (req, res, next) => {
    const post = db.prepare(`${postSelect} WHERE p.slug = ? AND p.published = 1`).get(req.params.slug);
    if (!post) {
      // URL antiga /blog/{categoria}/ → nova página da categoria.
      const cat = db.prepare('SELECT slug FROM blog_categories WHERE slug = ?').get(req.params.slug);
      return cat ? res.redirect(301, `/blog/categoria/${cat.slug}`) : next();
    }
    const words = stripHtml(post.body).split(' ').length;
    const related = db.prepare(`${postSelect} WHERE p.published = 1 AND p.id != ? ORDER BY (p.category_id IS ?) DESC, p.published_at DESC LIMIT 3`)
      .all(post.id, post.category_id);
    const crumbs = [['Início', '/'], ['Blog', '/blog'], ...(post.category_name ? [[post.category_name, `/blog/categoria/${post.category_slug}`]] : []), [post.title, `/blog/${post.slug}`]];
    return res.render('public/post', {
      title: post.meta_title || post.title,
      description: metaDescription(post.meta_description, post.excerpt, post.body),
      ogImage: post.cover,
      ogType: 'article',
      breadcrumbs: crumbs,
      jsonld: [seo().blogPosting(post), seo().breadcrumbs(crumbs)],
      post,
      readingMinutes: Math.max(1, Math.round(words / 200)),
      related,
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
    if (status === 'pending') ctx.notifications.notifyAdmins({ title: 'Comentário aguardando aprovação', body: name, link: '/admin/comentarios' });
    flash(req, 'success', status === 'pending' ? 'Comentário enviado para aprovação.' : 'Comentário publicado.');
    res.redirect(`/blog/${post.slug}#comentarios`);
  }));

  // ---- Loja de serviços espirituais ----------------------------------------
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
    const crumbs = [['Início', '/'], ['Loja', '/loja'], ...(category ? [[category.name, `/loja/categoria/${category.slug}`]] : [])];
    return res.render('public/store', {
      title: category ? `${category.name} — loja espiritual` : 'Loja de rituais e trabalhos espirituais',
      description: metaDescription(category && category.description, 'Rituais, banhos, limpezas e trabalhos espirituais realizados por nossos especialistas, com acompanhamento pelo site.'),
      noindex: !!search || !!req.query.ofertas,
      breadcrumbs: crumbs,
      jsonld: [seo().breadcrumbs(crumbs)],
      cats, category, products, search,
    });
  });

  router.get('/loja/produto/:slug', (req, res, next) => {
    const product = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id WHERE p.slug = ? AND p.active = 1`).get(req.params.slug);
    if (!product) return next();
    const crumbs = [['Início', '/'], ['Loja', '/loja'], ...(product.category_name ? [[product.category_name, `/loja/categoria/${product.category_slug}`]] : []), [product.name, `/loja/produto/${product.slug}`]];
    return res.render('public/product', {
      title: product.meta_title || product.name,
      description: metaDescription(product.meta_description, product.summary, product.description),
      ogImage: product.image,
      ogType: 'product',
      breadcrumbs: crumbs,
      jsonld: [seo().product(product), seo().breadcrumbs(crumbs)],
      product,
      gallery: [product.image, ...JSON.parse(product.gallery || '[]')].filter(Boolean),
      related: db.prepare('SELECT * FROM products WHERE active = 1 AND id != ? ORDER BY (category_id IS ?) DESC, sort_order LIMIT 3').all(product.id, product.category_id),
      shareUrl: `${config.baseUrl}/loja/produto/${product.slug}`,
    });
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

  // Finalizar: coleta os dados do trabalho (pessoas, datas, intenção) de cada item que exige.
  router.post('/carrinho/finalizar', action(async (req, res) => {
    if (!req.user) return res.redirect('/entrar?next=/carrinho');
    const { items } = cartView(req);
    const field = (name, id) => String((req.body[`${name}_${id}`] || '')).trim().slice(0, 1000);
    const details = items.filter((i) => i.product.requires_details).map((i) => ({
      productId: i.productId,
      product: i.product.name,
      people: field('people', i.productId),
      birthdates: field('birthdates', i.productId),
      intention: field('intention', i.productId),
    }));
    const missing = details.find((d) => !d.people || !d.intention);
    if (missing) throw new HttpError(400, `Preencha os dados do trabalho: ${missing.product}`);
    const order = ctx.payments.createStoreOrder(req.user.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      req.body.notes ? { notes: String(req.body.notes).slice(0, 1000) } : null, details);
    req.session.cart = [];
    return res.redirect(`/pagamento/${order.id}`);
  }, { back: '/carrinho' }));

  // ---- SEO -----------------------------------------------------------------
  router.get('/robots.txt', (req, res) => {
    if (config.demoMode) return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    res.type('text/plain').send(['User-agent: *', 'Allow: /',
      ...['/admin', '/atendente', '/minha-conta', '/pagamento', '/sala', '/chamando', '/mensagens', '/carrinho', '/api/', '/auth/', '/*?busca='].map((p) => `Disallow: ${p}`),
      `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n'));
  });

  router.get('/sitemap.xml', (req, res) => {
    const x = ctx.util.escapeHtml;
    const urls = [
      ['/', null, '1.0'], ['/tarologos', null, '0.9'], ['/comprar-creditos', null, '0.8'], ['/perguntas-frequentes'], ['/quem-somos'],
      ['/contato'], ['/trabalhe-conosco'], ['/depoimentos', null, '0.7'], ['/blog', null, '0.8'], ['/loja', null, '0.8'],
      ['/termos-de-uso', null, '0.3'], ['/politica-de-privacidade', null, '0.3'],
    ].map(([loc, lastmod, priority]) => ({ loc, lastmod, priority }));
    for (const c of q.categories(db)) urls.push({ loc: `/categorias/${c.slug}`, priority: '0.8' });
    for (const r of db.prepare('SELECT slug, photo, display_name FROM readers WHERE active = 1').all()) {
      urls.push({ loc: `/tarologo/${r.slug}`, priority: '0.9', image: r.photo, imageTitle: r.display_name });
    }
    for (const c of db.prepare('SELECT slug FROM blog_categories').all()) urls.push({ loc: `/blog/categoria/${c.slug}` });
    for (const p of db.prepare('SELECT slug, cover, title, COALESCE(updated_at, published_at) AS mod FROM blog_posts WHERE published = 1').all()) {
      urls.push({ loc: `/blog/${p.slug}`, lastmod: p.mod, priority: '0.7', image: p.cover, imageTitle: p.title });
    }
    for (const c of db.prepare('SELECT slug FROM product_categories').all()) urls.push({ loc: `/loja/categoria/${c.slug}` });
    for (const p of db.prepare('SELECT slug, image, name FROM products WHERE active = 1').all()) {
      urls.push({ loc: `/loja/produto/${p.slug}`, priority: '0.7', image: p.image, imageTitle: p.name });
    }
    const body = urls.map((u) => `  <url><loc>${config.baseUrl}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}${u.priority ? `<priority>${u.priority}</priority>` : ''}${u.image ? `<image:image><image:loc>${seo().abs(u.image)}</image:loc><image:title>${x(u.imageTitle)}</image:title></image:image>` : ''}</url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>`);
  });

  router.get('/manifest.webmanifest', (req, res) => {
    res.json({
      name: settings.get('site_name'),
      short_name: settings.get('site_name'),
      start_url: '/',
      display: 'standalone',
      background_color: '#160b26',
      theme_color: '#2a1245',
      icons: [{ src: '/public/img/icon-essencia-192.png', sizes: '192x192', type: 'image/png' }, { src: '/public/img/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  });

  return router;
};
