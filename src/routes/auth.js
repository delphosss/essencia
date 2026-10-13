const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { action, rateLimit, flash } = require('../lib/middleware');
const { HttpError, nowIso } = require('../lib/util');

const COUNTRIES = [
  ['BR', 'Brasil', '55'], ['PT', 'Portugal', '351'], ['US', 'Estados Unidos', '1'], ['ES', 'Espanha', '34'],
  ['FR', 'França', '33'], ['IT', 'Itália', '39'], ['DE', 'Alemanha', '49'], ['GB', 'Reino Unido', '44'],
  ['MX', 'México', '52'], ['PY', 'Paraguai', '595'], ['UY', 'Uruguai', '598'], ['NO', 'Noruega', '47'],
];

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'reader') return '/atendente';
  return '/minha-conta';
}

function isAdult(birthDate) {
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return false;
  const limit = new Date();
  limit.setFullYear(limit.getFullYear() - 18);
  return d <= limit;
}

module.exports = function authRoutes(ctx) {
  const { db, config } = ctx;
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

  function login(req, user) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = user.id;
        db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
        return req.session.save((e) => (e ? reject(e) : resolve()));
      });
    });
  }

  router.get(['/entrar', '/cadastro'], (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    return res.render('public/auth', {
      title: req.path === '/cadastro' ? 'Criar conta' : 'Entrar',
      mode: req.path === '/cadastro' ? 'register' : 'login',
      next: safeNext(req.query.next) || '',
      countries: COUNTRIES,
      form: {},
    });
  });

  router.post('/entrar', limiter, action(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.password_hash || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      throw new HttpError(400, 'E-mail ou senha incorretos');
    }
    if (user.blocked) throw new HttpError(403, 'Sua conta está suspensa. Fale com o suporte.');
    await login(req, user);
    res.redirect(safeNext(req.body.next) || homeFor(user));
  }, { back: (req) => `/entrar${req.body.next ? `?next=${encodeURIComponent(req.body.next)}` : ''}` }));

  router.post('/cadastro', limiter, action(async (req, res) => {
    const b = req.body;
    if (b.website) throw new HttpError(400, 'Cadastro inválido'); // honeypot
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (name.length < 3) throw new HttpError(400, 'Informe seu nome completo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail inválido');
    if (password.length < 6) throw new HttpError(400, 'A senha precisa de pelo menos 6 caracteres');
    if (!isAdult(b.birth_date)) throw new HttpError(400, 'O cadastro é permitido apenas para maiores de 18 anos');
    if (!b.terms) throw new HttpError(400, 'Aceite os termos de uso para continuar');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(400, 'Este e-mail já tem cadastro. Faça login.');
    const country = COUNTRIES.find((c) => c[0] === b.country_code) ? b.country_code : 'BR';
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (role, name, email, password_hash, birth_date, country_code, area_code, phone, notify_opt_in)
      VALUES ('client', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      name, email, await bcrypt.hash(password, 10), b.birth_date, country,
      String(b.area_code || '').replace(/\D/g, '').slice(0, 4), String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20),
      b.notify_opt_in ? 1 : 0,
    );
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    await login(req, user);
    ctx.messaging.sendEmail({
      to: email,
      subject: `Bem-vindo(a) ao ${ctx.settings.get('site_name')}`,
      text: `Olá, ${name}!\n\nSua conta foi criada. Compre créditos e escolha seu tarólogo: ${config.baseUrl}/tarologos`,
    });
    flash(req, 'success', 'Conta criada! Agora é só comprar créditos e escolher seu tarólogo.');
    res.redirect(safeNext(b.next) || '/comprar-creditos');
  }, { back: '/cadastro' }));

  // Login com Google (Google Identity Services envia um ID token JWT).
  router.post('/auth/google', limiter, action(async (req, res) => {
    if (!config.googleClientId) throw new HttpError(400, 'Login com Google não configurado');
    const token = String(req.body.credential || '');
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    const info = await r.json().catch(() => ({}));
    if (!r.ok || info.aud !== config.googleClientId || info.email_verified !== 'true') throw new HttpError(400, 'Não foi possível validar o login com Google');
    let user = db.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').get(info.sub, info.email);
    if (!user) {
      const { lastInsertRowid } = db.prepare("INSERT INTO users (role, name, email, google_id) VALUES ('client', ?, ?, ?)")
        .run(info.name || info.email.split('@')[0], info.email, info.sub);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
      flash(req, 'info', 'Complete sua data de nascimento em "Meus dados".');
    } else if (!user.google_id) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(info.sub, user.id);
    }
    if (user.blocked) throw new HttpError(403, 'Sua conta está suspensa.');
    await login(req, user);
    res.redirect(safeNext(req.body.next) || homeFor(user));
  }, { back: '/entrar' }));

  router.post('/sair', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // Recuperação de senha por link (mais seguro que enviar nova senha por e-mail).
  router.get('/esqueci-senha', (req, res) => res.render('public/forgot', { title: 'Recuperar senha' }));

  router.post('/esqueci-senha', limiter, action(async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email || '').trim());
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(user.id, hash, new Date(Date.now() + 3600 * 1000).toISOString());
      ctx.messaging.sendEmail({
        to: user.email,
        subject: 'Redefinição de senha',
        text: `Olá, ${user.name}!\n\nPara criar uma nova senha, acesse (válido por 1 hora):\n${config.baseUrl}/redefinir-senha/${token}\n\nSe não foi você, ignore este e-mail.`,
      });
    }
    flash(req, 'success', 'Se o e-mail estiver cadastrado, você vai receber um link para criar uma nova senha.');
    res.redirect('/entrar');
  }));

  function findReset(token) {
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hash);
    if (!row || row.used_at || row.expires_at < nowIso()) return null;
    return row;
  }

  router.get('/redefinir-senha/:token', (req, res) => {
    if (!findReset(req.params.token)) {
      flash(req, 'error', 'Link inválido ou expirado. Peça um novo.');
      return res.redirect('/esqueci-senha');
    }
    return res.render('public/reset', { title: 'Nova senha', token: req.params.token });
  });

  router.post('/redefinir-senha/:token', limiter, action(async (req, res) => {
    const row = findReset(req.params.token);
    if (!row) throw new HttpError(400, 'Link inválido ou expirado');
    const password = String(req.body.password || '');
    if (password.length < 6) throw new HttpError(400, 'A senha precisa de pelo menos 6 caracteres');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), row.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
    flash(req, 'success', 'Senha alterada. Faça login com a nova senha.');
    res.redirect('/entrar');
  }));

  return router;
};

module.exports.COUNTRIES = COUNTRIES;
module.exports.isAdult = isAdult;
