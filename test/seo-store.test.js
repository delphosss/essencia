const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, startServer, loginAs } = require('./web');

test('SEO: redirecionamentos 301 das URLs antigas', async (t) => {
  const { base, ctx } = await startServer(t);
  const b = browser(base);
  const cases = {
    '/terapeutas/': '/tarologos',
    '/terapeuta/dama-da-noite/': '/tarologo/dama-da-noite',
    '/comprar-saldo/': '/comprar-creditos',
    '/blog-artigo/tarot/como-se-preparar-para-a-primeira-consulta/': '/blog/como-se-preparar-para-a-primeira-consulta',
    '/loja-item/servicos/mapa-astral-comentado/': '/loja/produto/mapa-astral-comentado',
    '/depoimentos-terapeutas/': '/depoimentos',
    '/quem-somos/': '/quem-somos',
    '/blog/tarot': '/blog/categoria/tarot',
  };
  for (const [from, to] of Object.entries(cases)) {
    const r = await b.req(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  ctx.db.prepare("INSERT INTO redirects (from_path, to_path) VALUES ('/promo-antiga', '/comprar-creditos')").run();
  assert.equal((await b.req('/promo-antiga')).location, '/comprar-creditos');
  assert.equal(ctx.db.prepare("SELECT hits FROM redirects WHERE from_path = '/promo-antiga'").get().hits, 1);
});

test('SEO: canonical, Open Graph, JSON-LD, noindex e sitemap', async (t) => {
  const { base } = await startServer(t);
  const b = browser(base);
  const profile = (await b.req('/tarologo/dama-da-noite')).text;
  assert.match(profile, /<link rel="canonical" href="[^"]+\/tarologo\/dama-da-noite">/);
  assert.match(profile, /<meta property="og:type" content="profile">/);
  assert.match(profile, /"@type":"Person"/);
  assert.match(profile, /"@type":"BreadcrumbList"/);
  assert.match((await b.req('/blog/como-se-preparar-para-a-primeira-consulta')).text, /"@type":"BlogPosting"/);
  assert.match((await b.req('/loja/produto/mapa-astral-comentado')).text, /"@type":"Product"/);
  assert.match((await b.req('/perguntas-frequentes')).text, /"@type":"FAQPage"/);
  assert.match((await b.req('/entrar')).text, /<meta name="robots" content="noindex, nofollow">/);
  assert.match((await b.req('/')).text, /<meta name="robots" content="index, follow/);
  const page2 = (await b.req('/blog?pagina=2')).text;
  assert.match(page2, /canonical" href="[^"]+\/blog\?pagina=2"/);
  const sitemap = (await b.req('/sitemap.xml')).text;
  for (const path of ['/tarologo/dama-da-noite', '/blog/categoria/tarot', '/loja/produto/mapa-astral-comentado', '/categorias/']) assert.ok(sitemap.includes(path), path);
  assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.match((await b.req('/robots.txt')).text, /Disallow: \/admin/);
  assert.match((await b.req('/blog/feed.xml')).text, /<rss version="2.0">/);
});

test('loja: exige dados do trabalho, paga com saldo e acompanha o andamento', async (t) => {
  const { base, ctx } = await startServer(t);
  const client = await loginAs(base, 'cliente@exemplo.com', 'cliente123');
  const user = ctx.db.prepare("SELECT * FROM users WHERE email = 'cliente@exemplo.com'").get();
  ctx.wallet.credit(user.id, 20000, 'adjustment', 'teste');
  const product = ctx.db.prepare("SELECT * FROM products WHERE slug = 'leitura-completa-por-escrito'").get();
  await client.req(`/loja/produto/${product.slug}`);
  await client.req('/carrinho', { form: { product_id: String(product.id), quantity: '1' } });
  await client.req('/carrinho');
  const missing = await client.req('/carrinho/finalizar', { form: {} });
  assert.equal(missing.location, '/carrinho', 'sem os dados do trabalho volta ao carrinho');
  await client.req('/carrinho');
  const done = await client.req('/carrinho/finalizar', { form: {
    [`people_${product.id}`]: 'Ana Souza', [`birthdates_${product.id}`]: '01/02/1990', [`intention_${product.id}`]: 'Clareza no relacionamento',
  } });
  assert.match(done.location, /^\/pagamento\/\d+$/);
  const orderId = Number(done.location.split('/').pop());
  const checkout = await client.req(done.location);
  assert.match(checkout.text, /Pagar com saldo/);
  assert.match(checkout.text, /Ana Souza/);
  await client.req(`/pagamento/${orderId}/saldo`, { form: {} });
  const order = ctx.payments.getOrder(orderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.method, 'wallet');
  assert.equal(order.fulfillment_status, 'received');
  assert.equal(ctx.wallet.balance(user.id), 20000 - product.price_cents);

  const admin = await loginAs(base, 'admin@exemplo.com', 'admin123');
  await admin.req(`/admin/pedidos/${orderId}`);
  await admin.req(`/admin/pedidos/${orderId}/andamento`, { form: { fulfillment_status: 'done', fulfillment_note: 'Seu trabalho foi realizado hoje.' } });
  assert.equal(ctx.payments.getOrder(orderId).fulfillment_status, 'done');
  assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Pedido #%Concluído'").get(user.id));
  assert.match((await client.req('/minha-conta/pedidos-loja')).text, /Seu trabalho foi realizado hoje/);
});

test('admin: telas novas abrem (redirecionamentos, post com editor, produto com galeria)', async (t) => {
  const { base } = await startServer(t);
  const admin = await loginAs(base, 'admin@exemplo.com', 'admin123');
  for (const p of ['/admin', '/admin/redirecionamentos', '/admin/redirecionamentos/novo', '/admin/posts/1', '/admin/produtos/1', '/admin/categorias/1', '/admin/tarologos/1', '/admin/configuracoes', '/admin/paginas/quem-somos']) {
    assert.equal((await admin.req(p)).status, 200, p);
  }
  assert.match((await admin.req('/admin/posts/1')).text, /quill/);
  assert.match((await admin.req('/admin')).text, /Receita do site/);
});
