const config = require('./config');
const util = require('./lib/util');
const { openDatabase } = require('./db');
const { createSettings } = require('./lib/settings');

// Monta o "contexto" compartilhado: banco, configurações e serviços.
// `rt` (tempo real) começa vazio e é ligado ao Socket.io em realtime/index.js.
function createContext(overrides = {}) {
  const cfg = { ...config, ...(overrides.config || {}) };
  const db = overrides.db || openDatabase(overrides.databasePath || cfg.databasePath);
  const ctx = {
    config: cfg,
    db,
    util,
    quiet: !!overrides.quiet,
    clock: overrides.clock || (() => Date.now()),
    rt: { toUser() {}, toAll() {}, toAdmins() {}, toRoom() {} },
  };
  ctx.settings = createSettings(db);
  ctx.logError = (source, message, data) => {
    try {
      db.prepare('INSERT INTO error_logs (source, message, data) VALUES (?, ?, ?)').run(source, String(message), data ? JSON.stringify(data) : null);
    } catch (_) { /* ignora falha de log */ }
    if (!ctx.quiet) console.error(`[${source}] ${message}`);
  };
  ctx.wallet = require('./services/wallet')(ctx);
  ctx.notifications = require('./services/notifications')(ctx);
  ctx.messaging = require('./services/messaging')(ctx);
  ctx.earnings = require('./services/earnings')(ctx);
  ctx.payments = require('./services/payments')(ctx);
  ctx.consultations = require('./services/consultations')(ctx);
  ctx.questions = require('./services/questions')(ctx);
  ctx.appointments = require('./services/appointments')(ctx);
  ctx.reviews = require('./services/reviews')(ctx);
  ctx.inbox = require('./services/inbox')(ctx);
  return ctx;
}

module.exports = { createContext };
