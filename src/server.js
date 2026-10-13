const http = require('http');
const { createContext } = require('./context');
const { createApp } = require('./app');
const { attachRealtime } = require('./realtime');
const { seed } = require('./db/seed');

const ctx = createContext();
seed(ctx, { demo: process.env.SEED_DEMO !== 'false' });
const app = createApp(ctx);
const server = http.createServer(app);
attachRealtime(ctx, server, app.sessionMiddleware);
ctx.consultations.start();

server.listen(ctx.config.port, () => {
  console.log(`${ctx.settings.get('site_name')} rodando em ${ctx.config.baseUrl}`);
  if (ctx.payments.sandbox()) console.log('Pagamentos em modo simulador (defina MP_ACCESS_TOKEN para usar o Mercado Pago).');
});

function shutdown() {
  ctx.consultations.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
