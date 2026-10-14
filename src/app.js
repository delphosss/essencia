const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const { createAssets } = require('./lib/assets');
const SqliteStore = require('./lib/session-store');
const { redirects } = require('./lib/redirects');
const { createSeo } = require('./lib/seo');
const { csrf } = require('./lib/middleware');
const util = require('./lib/util');

function createApp(ctx) {
  const app = express();
  const { db, settings, config } = ctx;
  const seo = createSeo(ctx);
  ctx.seo = seo;
  // Áreas que não devem aparecer no Google.
  const PRIVATE = /^\/(admin|atendente|minha-conta|pagamento|sala|chamando|mensagens|carrinho|entrar|cadastro|esqueci-senha|redefinir-senha|auth)(\/|$)/;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression()); // gzip/brotli em HTML, CSS, JS e JSON
  const asset = createAssets(config.root);
  // Arquivos versionados (?v=hash) podem ficar 1 ano em cache; o nome muda quando o conteúdo muda.
  app.use('/public', express.static(path.join(config.root, 'public'), {
    setHeaders: (res, file, stat) => res.setHeader('Cache-Control', config.isProduction ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  // Uploads têm nome único por arquivo gerado: também podem ser imutáveis.
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '365d', immutable: true }));

  app.use(redirects(db));

  // Webhooks antes do CSRF e com corpo bruto (PayPal IPN exige o corpo original).
  app.use('/webhooks', require('./routes/webhooks')(ctx));

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  const sessionMiddleware = session({
    store: new SqliteStore(db),
    secret: config.sessionSecret,
    name: 'sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 30 * 24 * 3600 * 1000 },
  });
  app.sessionMiddleware = sessionMiddleware;
  app.use(sessionMiddleware);

  // Usuário logado + dados comuns às views.
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const getReaderByUser = db.prepare('SELECT * FROM readers WHERE user_id = ?');
  app.use((req, res, next) => {
    // Garante o token CSRF já na primeira visita (a sessão é salva por isso).
    if (req.session.userId) {
      const user = getUser.get(req.session.userId);
      if (!user || user.blocked) {
        req.session.userId = null;
      } else {
        req.user = user;
        if (user.role === 'reader') req.reader = getReaderByUser.get(user.id);
      }
    }
    const flash = req.session.flash || [];
    if (req.session.flash) req.session.flash = [];
    Object.assign(res.locals, util, {
      user: req.user || null,
      reader: req.reader || null,
      site: settings.all(),
      settings,
      srcset: ctx.images.srcset,
      seo,
      asset,
      baseUrl: config.baseUrl,
      jsonld: [],
      breadcrumbs: null,
      ogImage: null,
      ogType: 'website',
      canonical: null,
      noindex: PRIVATE.test(req.path),
      flash,
      path: req.path,
      originalPath: req.originalUrl.split('?')[0].replace(/\/$/, '') || '/',
      query: req.query,
      config: { googleClientId: config.googleClientId, sandbox: ctx.payments.sandbox() },
      unreadNotifications: req.user ? ctx.notifications.unread(req.user.id) : 0,
      cartCount: (req.session.cart || []).reduce((s, i) => s + i.quantity, 0),
      cookiesAccepted: req.get('cookie') ? /(?:^|;\s*)cookies_ok=1/.test(req.get('cookie')) : false,
      title: '',
      description: '',
    });
    next();
  });
  app.use(csrf);

  app.use(require('./routes/auth')(ctx));
  app.use(require('./routes/public')(ctx));
  app.use(require('./routes/checkout')(ctx));
  app.use(require('./routes/consult')(ctx));
  app.use(require('./routes/api')(ctx));
  app.use(require('./routes/inbox')(ctx));
  app.use('/minha-conta', require('./routes/client')(ctx));
  app.use('/atendente', require('./routes/reader')(ctx));
  app.use('/admin', require('./routes/admin')(ctx));

  app.use((req, res) => {
    res.status(404).render('public/error', { title: 'Página não encontrada', status: 404, message: 'Não encontramos o que você procurava.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
    const message = status >= 500 ? 'Ocorreu um erro inesperado.' : err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande (máx. 4 MB)' : err.message;
    if (status >= 500) ctx.logError('http', err.stack || err.message, { url: req.originalUrl });
    if (req.xhr || (req.get('accept') || '').includes('application/json') || req.path.startsWith('/api/')) {
      return res.status(status).json({ error: message });
    }
    return res.status(status).render('public/error', { title: 'Erro', status, message });
  });

  return app;
}

module.exports = { createApp };
