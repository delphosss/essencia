const http = require('http');
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

// Sobe o app completo (HTTP + Socket.io) numa porta livre, com banco em memória.
async function startServer(t) {
  const ctx = createContext({ databasePath: ':memory:', quiet: true });
  seed(ctx, { demo: true });
  const app = createApp(ctx);
  const server = http.createServer(app);
  attachRealtime(ctx, server, app.sessionMiddleware);
  ctx.consultations.start();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { ctx.consultations.stop(); server.close(); });
  return { ctx, base };
}

async function loginAs(base, email, password) {
  const b = browser(base);
  await b.req('/entrar');
  await b.req('/entrar', { form: { email, password } });
  return b;
}

module.exports = { browser, startServer, loginAs };
