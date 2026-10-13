const express = require('express');
const bcrypt = require('bcryptjs');
const { action, requireAuth, flash } = require('../lib/middleware');
const { HttpError, toInt } = require('../lib/util');
const { COUNTRIES, isAdult } = require('./auth');

// Área do cliente: /minha-conta
module.exports = function clientRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();
  router.use(requireAuth('client'));

  const recentOrders = (userId, limit) => db.prepare(`SELECT o.*, p.name AS package_name FROM orders o
    LEFT JOIN packages p ON p.id = o.package_id WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`).all(userId, limit);
  const consultationsOf = (userId, limit) => db.prepare(`SELECT c.*, r.display_name AS reader_name, r.slug AS reader_slug,
      (SELECT 1 FROM reviews v WHERE v.consultation_id = c.id) AS reviewed
    FROM consultations c JOIN readers r ON r.id = c.reader_id WHERE c.client_id = ? ORDER BY c.id DESC LIMIT ?`).all(userId, limit);

  router.get('/', (req, res) => {
    res.render('client/summary', {
      title: 'Minha conta',
      balance: ctx.wallet.balance(req.user.id),
      orders: recentOrders(req.user.id, 5),
      consultations: consultationsOf(req.user.id, 5),
      active: ctx.consultations.activeFor({ clientId: req.user.id }),
    });
  });

  router.get('/meus-dados', (req, res) => res.render('client/profile', { title: 'Meus dados', countries: COUNTRIES }));

  router.post('/meus-dados', action(async (req, res) => {
    const b = req.body;
    const name = String(b.name || '').trim();
    if (name.length < 3) throw new HttpError(400, 'Informe seu nome');
    if (b.birth_date && !isAdult(b.birth_date)) throw new HttpError(400, 'Data de nascimento inválida');
    db.prepare(`UPDATE users SET name = ?, birth_date = ?, cpf = ?, cep = ?, country_code = ?, area_code = ?, phone = ?,
      notify_opt_in = ?, referral_source = ? WHERE id = ?`).run(
      name, b.birth_date || null, String(b.cpf || '').replace(/\D/g, '').slice(0, 11) || null, String(b.cep || '').replace(/\D/g, '').slice(0, 8) || null,
      COUNTRIES.some((c) => c[0] === b.country_code) ? b.country_code : 'BR',
      String(b.area_code || '').replace(/\D/g, '').slice(0, 4), String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20),
      b.notify_opt_in === '1' ? 1 : 0, String(b.referral_source || '').slice(0, 100), req.user.id,
    );
    flash(req, 'success', 'Dados atualizados.');
    res.redirect('/minha-conta/meus-dados');
  }));

  router.post('/senha', action(async (req, res) => {
    const { current, password } = req.body;
    if (req.user.password_hash && !(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw new HttpError(400, 'Senha atual incorreta');
    if (String(password || '').length < 6) throw new HttpError(400, 'A nova senha precisa de pelo menos 6 caracteres');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), req.user.id);
    flash(req, 'success', 'Senha alterada.');
    res.redirect('/minha-conta/meus-dados');
  }));

  router.get('/compras', (req, res) => res.render('client/orders', { title: 'Compras', orders: recentOrders(req.user.id, 200) }));

  router.get('/extrato', (req, res) => res.render('client/statement', {
    title: 'Extrato de créditos', rows: ctx.wallet.history(req.user.id, 300), balance: ctx.wallet.balance(req.user.id),
  }));

  router.get('/atendimentos', (req, res) => res.render('client/consultations', {
    title: 'Atendimentos', consultations: consultationsOf(req.user.id, 300),
  }));

  router.get('/atendimentos/:code', (req, res, next) => {
    const c = db.prepare(`SELECT c.*, r.display_name AS reader_name, r.slug AS reader_slug FROM consultations c
      JOIN readers r ON r.id = c.reader_id WHERE c.code = ? AND c.client_id = ?`).get(req.params.code, req.user.id);
    if (!c) return next();
    return res.render('shared/transcript', { title: 'Conversa', c, messages: ctx.consultations.messages(c.id), back: '/minha-conta/atendimentos' });
  });

  router.get('/avaliar/:code', (req, res) => {
    const c = ctx.reviews.canReview(req.user.id, req.params.code);
    if (!c) {
      flash(req, 'info', 'Esta consulta já foi avaliada ou não pode ser avaliada.');
      return res.redirect('/minha-conta/atendimentos');
    }
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(c.reader_id);
    return res.render('client/review', { title: 'Avaliar consulta', c, r: reader });
  });

  router.post('/avaliar/:code', action(async (req, res) => {
    const status = ctx.reviews.create(req.user, req.params.code, req.body.rating, req.body.body);
    flash(req, 'success', status === 'approved' ? 'Obrigado! Seu depoimento foi publicado.' : 'Obrigado! Seu depoimento será publicado após revisão.');
    res.redirect('/minha-conta/depoimentos');
  }));

  router.get('/perguntas', (req, res) => res.render('client/questions', { title: 'Perguntas', questions: ctx.questions.forClient(req.user.id) }));

  router.get('/perguntas/:id', (req, res, next) => {
    const q = ctx.questions.get(toInt(req.params.id));
    if (!q || q.client_id !== req.user.id) return next();
    return res.render('shared/question', { title: 'Pergunta', q, back: '/minha-conta/perguntas' });
  });

  router.get('/agendadas', (req, res) => res.render('client/appointments', {
    title: 'Consultas agendadas', appointments: ctx.appointments.forClient(req.user.id), cancelHours: ctx.settings.get('appointment_cancel_hours'),
  }));

  router.post('/agendadas/:id/cancelar', action(async (req, res) => {
    ctx.appointments.setStatus(toInt(req.params.id), req.user, 'cancelled', 'Cancelado pelo cliente');
    flash(req, 'success', 'Agendamento cancelado.');
    res.redirect('/minha-conta/agendadas');
  }));

  router.get('/depoimentos', (req, res) => res.render('client/reviews', {
    title: 'Meus depoimentos',
    reviews: db.prepare(`SELECT v.*, r.display_name AS reader_name, r.slug AS reader_slug FROM reviews v
      JOIN readers r ON r.id = v.reader_id WHERE v.client_id = ? ORDER BY v.id DESC`).all(req.user.id),
    pending: db.prepare(`SELECT c.code, c.ended_at, r.display_name AS reader_name FROM consultations c JOIN readers r ON r.id = c.reader_id
      WHERE c.client_id = ? AND c.status = 'ended' AND c.minutes_charged > 0
      AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.consultation_id = c.id) ORDER BY c.id DESC LIMIT 10`).all(req.user.id),
  }));

  router.get('/pedidos-loja', (req, res) => {
    const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? AND kind = 'store' ORDER BY id DESC").all(req.user.id)
      .map((o) => ({ ...o, items: ctx.payments.orderItems(o.id) }));
    res.render('client/store-orders', { title: 'Pedidos da loja', orders });
  });

  router.get('/alertas', (req, res) => res.render('client/alerts', {
    title: 'Avise-me',
    alerts: db.prepare(`SELECT a.*, r.display_name AS reader_name, r.slug AS reader_slug, r.status AS reader_status FROM availability_alerts a
      JOIN readers r ON r.id = a.reader_id WHERE a.client_id = ? ORDER BY a.id DESC LIMIT 50`).all(req.user.id),
  }));

  router.post('/alertas/:id/remover', action(async (req, res) => {
    db.prepare('DELETE FROM availability_alerts WHERE id = ? AND client_id = ?').run(toInt(req.params.id), req.user.id);
    res.redirect('/minha-conta/alertas');
  }));

  return router;
};
