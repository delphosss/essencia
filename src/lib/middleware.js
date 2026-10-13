const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { HttpError, safeEqual } = require('./util');

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!token || !safeEqual(token, req.session.csrf)) return next(new HttpError(403, 'Sessão expirada. Recarregue a página e tente de novo.'));
  return next();
}

function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.method === 'GET') return res.redirect(`/entrar?next=${encodeURIComponent(req.originalUrl)}`);
      return next(new HttpError(401, 'Faça login para continuar'));
    }
    if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'Acesso negado'));
    return next();
  };
}

// Limitador simples em memória (login, cadastro, contato).
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return next(new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.'));
    return next();
  };
}

function uploader(uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new HttpError(400, 'Envie uma imagem JPG, PNG, WEBP ou GIF'));
    },
  });
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

// Executa handler async e converte erros de negócio em flash + redirect (forms) ou JSON (fetch).
function action(fn, { back } = {}) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (!err.status || err.status >= 500) return next(err);
      if (req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.status(err.status).json({ error: err.message });
      }
      flash(req, 'error', err.message);
      const target = typeof back === 'function' ? back(req) : back || req.get('referer') || '/';
      return res.redirect(target);
    }
  };
}

module.exports = { csrf, requireAuth, rateLimit, uploader, flash, action };
