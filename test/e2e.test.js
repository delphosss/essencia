const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { createContext } = require('../src/context');
const { createApp } = require('../src/app');
const { attachRealtime } = require('../src/realtime');
const { seed } = require('../src/db/seed');

// Navegador mínimo: guarda cookies e lê o token CSRF das páginas.
function browser(base) {
  const jar = new Map();
  let csrf = '';
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(path, { form, json, method = form || json ? 'POST' : 'GET' } = {}) {
    const headers = { cookie: cookie() };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams({ _csrf: csrf, ...form }).toString(); }
    if (json) { headers['content-type'] = 'application/json'; headers.accept = 'application/json'; headers['x-csrf-token'] = csrf; body = JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  }
  return { req, cookie, setCsrf: (t) => { csrf = t; } };
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

test('fluxo completo: cadastro → compra → chamada → chat → cobrança → encerramento', async (t) => {
  const ctx = createContext({ databasePath: ':memory:', quiet: true });
  seed(ctx, { demo: true });
  const app = createApp(ctx);
  const server = http.createServer(app);
  attachRealtime(ctx, server, app.sessionMiddleware);
  ctx.consultations.start();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); ctx.consultations.stop(); server.close(); });

  // CSRF obrigatório
  const anon = browser(base);
  await anon.req('/cadastro');
  anon.setCsrf('token-falso');
  assert.equal((await anon.req('/contato', { form: { name: 'x', email: 'x@x.com', message: 'oi' } })).status, 403);

  // Cadastro (menor de idade é recusado)
  const client = browser(base);
  await client.req('/cadastro');
  const minor = await client.req('/cadastro', { form: { name: 'Jovem Teste', email: 'jovem@t.com', password: 'segredo1', birth_date: '2015-01-01', terms: '1' } });
  assert.equal(minor.location, '/cadastro');
  await client.req('/cadastro');
  const reg = await client.req('/cadastro', { form: { name: 'Maria Teste', email: 'maria@t.com', password: 'segredo1', birth_date: '1990-04-04', terms: '1', country_code: 'BR', phone: '999' } });
  assert.equal(reg.status, 302);
  assert.equal(reg.location, '/comprar-creditos');

  // Compra de créditos no simulador
  await client.req('/comprar-creditos');
  const pkg = ctx.db.prepare('SELECT id FROM packages WHERE price_cents = 1000').get();
  const buy = await client.req('/comprar', { form: { package_id: String(pkg.id) } });
  const orderPath = buy.location;
  assert.match(orderPath, /^\/pagamento\/\d+$/);
  const checkout = await client.req(orderPath);
  assert.match(checkout.text, /Gerar Pix/);
  const orderId = orderPath.split('/').pop();
  const pix = await client.req(`/pagamento/${orderId}/pix`, { json: {} });
  assert.match(pix.json().qr, /SANDBOX-PIX/);
  await client.req(`/pagamento/simulador/${orderId}`, { json: { result: 'approve' } });
  const maria = ctx.db.prepare("SELECT * FROM users WHERE email = 'maria@t.com'").get();
  assert.equal(maria.balance_cents, 1500, 'R$ 10 + R$ 5 de bônus de primeira compra');

  // Tarólogo entra e fica online
  const reader = browser(base);
  await reader.req('/entrar');
  const login = await reader.req('/entrar', { form: { email: 'luna.arcana@exemplo.com', password: 'tarot123' } });
  assert.equal(login.location, '/atendente');
  await reader.req('/atendente');
  assert.equal((await reader.req('/atendente/status', { json: { status: 'online' } })).status, 200);
  const r = ctx.db.prepare("SELECT * FROM readers WHERE slug = 'luna-arcana'").get();
  assert.equal(r.status, 'online');

  const rs = ioClient(base, { extraHeaders: { cookie: reader.cookie() }, transports: ['websocket'] });
  const cs = ioClient(base, { extraHeaders: { cookie: client.cookie() }, transports: ['websocket'] });
  sockets.push(rs, cs);
  await Promise.all([once(rs, 'connect'), once(cs, 'connect')]);

  // Cliente chama; tarólogo recebe o alerta
  await client.req(`/tarologo/${r.slug}`);
  const incoming = once(rs, 'call:incoming');
  const call = await client.req('/consultar', { json: { reader_id: r.id, type: 'chat' } });
  const { code } = call.json();
  assert.equal((await incoming).clientName, 'Maria Teste');
  assert.equal((await client.req(`/chamando/${code}`)).status, 200);

  // Tarólogo aceita; cliente é levado à sala
  const accepted = once(cs, 'call:accepted');
  const acc = await reader.req(`/atendente/chamadas/${code}/aceitar`, { json: {} });
  assert.equal(acc.json().url, `/sala/${code}`);
  assert.equal((await accepted).url, `/sala/${code}`);
  assert.equal((await client.req(`/sala/${code}`)).status, 200);

  // Ambos entram na sala; mensagem chega ao outro lado
  const join = (s) => new Promise((res) => s.emit('session:join', code, res));
  const [j1, j2] = await Promise.all([join(cs), join(rs)]);
  assert.equal(j1.role, 'client');
  assert.equal(j2.role, 'reader');
  const msg = once(rs, 'session:message');
  cs.emit('session:send', { code, text: 'Olá! Quero falar sobre trabalho.' });
  assert.equal((await msg).body, 'Olá! Quero falar sobre trabalho.');

  // O primeiro minuto é cobrado no próximo tick
  const tick = await once(cs, 'session:tick', 3000);
  assert.equal(tick.minutesCharged, 1);
  assert.equal(ctx.wallet.balance(maria.id), 1500 - 199);

  // Cliente encerra
  const ended = once(rs, 'session:ended');
  await client.req(`/sala/${code}/encerrar`, { json: {} });
  const summary = await ended;
  assert.equal(summary.chargedCents, 199);
  assert.equal(ctx.db.prepare('SELECT status FROM readers WHERE id = ?').get(r.id).status, 'online');

  // Avaliação e histórico
  assert.equal((await client.req(`/minha-conta/avaliar/${code}`)).status, 200);
  const rev = await client.req(`/minha-conta/avaliar/${code}`, { form: { rating: '5', body: 'Muito acolhedora, recomendo.' } });
  assert.equal(rev.location, '/minha-conta/depoimentos');
  assert.match((await client.req('/minha-conta/atendimentos')).text, /Luna Arcana/);
  assert.match((await reader.req('/atendente/financeiro')).text, /Consulta/);

  // Isolamento de papéis
  assert.equal((await client.req('/admin')).status, 403);
  assert.equal((await reader.req(`/minha-conta/atendimentos/${code}`)).status, 403);
});
