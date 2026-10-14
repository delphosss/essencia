const bcrypt = require('bcryptjs');
const { createContext } = require('../src/context');
const { seed } = require('../src/db/seed');

// Contexto isolado: banco em memória, relógio controlável, sem logs.
function createTestCtx() {
  let now = Date.parse('2026-10-13T15:00:00Z');
  const ctx = createContext({ databasePath: ':memory:', quiet: true, clock: () => now });
  ctx.advance = (ms) => { now += ms; return now; };
  ctx.now = () => now;
  seed(ctx, { demo: true });
  ctx.events = [];
  ctx.rt = {
    toUser: (id, event, data) => ctx.events.push({ to: `u:${id}`, event, data }),
    toAll: (event, data) => ctx.events.push({ to: 'all', event, data }),
    toAdmins: (event, data) => ctx.events.push({ to: 'admins', event, data }),
    toRoom: (room, event, data) => ctx.events.push({ to: room, event, data }),
  };
  return ctx;
}

function makeClient(ctx, { email = `c${Math.random().toString(36).slice(2)}@t.com`, balance = 0 } = {}) {
  const { lastInsertRowid } = ctx.db.prepare("INSERT INTO users (role, name, email, password_hash, birth_date) VALUES ('client', 'Cliente Teste', ?, ?, '1990-01-01')")
    .run(email, bcrypt.hashSync('senha123', 4));
  if (balance) ctx.wallet.credit(lastInsertRowid, balance, 'adjustment', 'saldo inicial');
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}

function firstReader(ctx) {
  return ctx.db.prepare('SELECT r.*, u.email FROM readers r JOIN users u ON u.id = r.user_id WHERE r.is_owner = 0 ORDER BY r.id LIMIT 1').get();
}

function eventsOf(ctx, event) {
  return ctx.events.filter((e) => e.event === event);
}

module.exports = { createTestCtx, makeClient, firstReader, eventsOf };
