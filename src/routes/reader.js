const express = require('express');
const { action, requireAuth, flash, uploader } = require('../lib/middleware');
const { HttpError, toInt, parseMoney } = require('../lib/util');
const q = require('../lib/queries');

// Painel do tarólogo: /atendente
module.exports = function readerRoutes(ctx) {
  const { db, settings } = ctx;
  const router = express.Router();
  const upload = uploader(ctx.config.uploadDir);

  router.use(requireAuth('reader'), (req, res, next) => {
    if (!req.reader) return next(new HttpError(403, 'Perfil de tarólogo não encontrado. Fale com a administração.'));
    return next();
  });

  router.get('/', (req, res) => {
    const r = req.reader;
    const today = new Date(new Date().setUTCHours(3, 0, 0, 0)).toISOString(); // 00:00 de Brasília
    const stats = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(minutes_charged),0) minutes, COALESCE(SUM(charged_cents),0) gross
      FROM consultations WHERE reader_id = ? AND status = 'ended' AND ended_at >= ?`).get(r.id, today);
    res.render('reader/dashboard', {
      title: 'Painel do tarólogo',
      stats,
      earnings: ctx.earnings.summary(r.id),
      pendingQuestions: db.prepare("SELECT COUNT(*) n FROM questions WHERE reader_id = ? AND status = 'pending'").get(r.id).n,
      upcoming: db.prepare(`SELECT a.*, u.name AS client_name FROM appointments a JOIN users u ON u.id = a.client_id
        WHERE a.reader_id = ? AND a.status IN ('requested','confirmed') AND a.scheduled_at >= ? ORDER BY a.scheduled_at LIMIT 5`).all(r.id, new Date().toISOString()),
      missed: db.prepare(`SELECT c.*, u.name AS client_name FROM consultations c JOIN users u ON u.id = c.client_id
        WHERE c.reader_id = ? AND c.status = 'missed' ORDER BY c.id DESC LIMIT 5`).all(r.id),
      active: ctx.consultations.activeFor({ readerId: r.id }),
      ringSeconds: settings.get('ring_seconds'),
    });
  });

  router.post('/status', action(async (req, res) => {
    const status = ['online', 'offline'].includes(req.body.status) ? req.body.status : null;
    if (!status) throw new HttpError(400, 'Status inválido');
    ctx.consultations.setReaderStatus(req.reader.id, status);
    if ((req.get('accept') || '').includes('json')) return res.json({ status });
    return res.redirect('/atendente');
  }));

  router.get('/atendimentos', (req, res) => {
    const status = ['ended', 'missed', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT c.*, u.name AS client_name FROM consultations c JOIN users u ON u.id = c.client_id
      WHERE c.reader_id = ? ${status ? 'AND c.status = ?' : "AND c.status != 'calling'"} ORDER BY c.id DESC LIMIT 300`)
      .all(...(status ? [req.reader.id, status] : [req.reader.id]));
    res.render('reader/consultations', { title: 'Atendimentos', rows, status });
  });

  router.get('/atendimentos/:code', (req, res, next) => {
    const c = db.prepare(`SELECT c.*, u.name AS client_name FROM consultations c JOIN users u ON u.id = c.client_id
      WHERE c.code = ? AND c.reader_id = ?`).get(req.params.code, req.reader.id);
    if (!c) return next();
    return res.render('shared/transcript', { title: 'Conversa', c, messages: ctx.consultations.messages(c.id), back: '/atendente/atendimentos' });
  });

  router.get('/perguntas', (req, res) => res.render('reader/questions', { title: 'Perguntas pagas', questions: ctx.questions.forReader(req.reader.id) }));

  router.get('/perguntas/:id', (req, res, next) => {
    const question = ctx.questions.get(toInt(req.params.id));
    if (!question || question.reader_id !== req.reader.id) return next();
    return res.render('shared/question', { title: 'Pergunta', q: question, back: '/atendente/perguntas', canAnswer: question.status === 'pending' });
  });

  router.post('/perguntas/:id', action(async (req, res) => {
    ctx.questions.answer(req.user.id, toInt(req.params.id), req.body.answer);
    flash(req, 'success', 'Resposta enviada ao cliente.');
    res.redirect('/atendente/perguntas');
  }));

  // ---- Agenda ----------------------------------------------------------------
  router.get('/agenda', (req, res) => res.render('reader/schedule', {
    title: 'Agenda', slots: ctx.appointments.upcomingSlots(req.reader.id), appointments: ctx.appointments.forReader(req.reader.id),
  }));

  // datetime-local chega sem fuso: interpretamos como horário de Brasília.
  const brt = (v) => (v ? new Date(`${v}:00-03:00`).toISOString() : '');

  router.post('/agenda/janelas', action(async (req, res) => {
    ctx.appointments.addSlot(req.reader.id, brt(req.body.starts_at), brt(req.body.ends_at));
    flash(req, 'success', 'Janela de disponibilidade adicionada.');
    res.redirect('/atendente/agenda');
  }));

  router.post('/agenda/janelas/:id/remover', action(async (req, res) => {
    ctx.appointments.removeSlot(req.reader.id, toInt(req.params.id));
    res.redirect('/atendente/agenda');
  }));

  router.post('/agenda/:id/:status', action(async (req, res) => {
    const status = { confirmar: 'confirmed', cancelar: 'cancelled', concluir: 'done' }[req.params.status];
    if (!status) throw new HttpError(400, 'Ação inválida');
    ctx.appointments.setStatus(toInt(req.params.id), req.user, status, req.body.reason);
    res.redirect('/atendente/agenda');
  }));

  // ---- Financeiro --------------------------------------------------------------
  router.get('/financeiro', (req, res) => res.render('reader/finance', {
    title: 'Financeiro',
    summary: ctx.earnings.summary(req.reader.id),
    rows: db.prepare('SELECT * FROM reader_earnings WHERE reader_id = ? ORDER BY id DESC LIMIT 300').all(req.reader.id),
    withdrawals: db.prepare('SELECT * FROM withdrawals WHERE reader_id = ? ORDER BY id DESC').all(req.reader.id),
    minWithdrawal: settings.get('withdrawal_min_cents'),
  }));

  router.post('/financeiro/saque', action(async (req, res) => {
    const pix = String(req.body.pix_key || req.reader.pix_key || '').trim().slice(0, 140);
    ctx.earnings.requestWithdrawal(req.reader.id, parseMoney(req.body.amount), pix);
    if (pix !== req.reader.pix_key) db.prepare('UPDATE readers SET pix_key = ? WHERE id = ?').run(pix, req.reader.id);
    flash(req, 'success', 'Saque solicitado. Você será avisado(a) quando for pago.');
    res.redirect('/atendente/financeiro');
  }));

  // ---- Perfil --------------------------------------------------------------------
  router.get('/perfil', (req, res) => res.render('reader/profile', {
    title: 'Meu perfil',
    categories: q.categories(db),
    selected: q.readerCategories(db, req.reader.id).map((c) => c.id),
    canSetPrices: !!settings.get('readers_can_set_prices'),
  }));

  router.post('/perfil', upload.single('photo'), action(async (req, res) => {
    const b = req.body;
    const r = req.reader;
    const fields = {
      oracles: String(b.oracles || '').slice(0, 300),
      bio: String(b.bio || '').slice(0, 4000),
      whatsapp: String(b.whatsapp || '').replace(/[^\d+]/g, '').slice(0, 20),
      pix_key: String(b.pix_key || '').slice(0, 140),
      chat_enabled: b.chat_enabled ? 1 : 0,
      questions_enabled: b.questions_enabled ? 1 : 0,
    };
    if (req.file) fields.photo = `/uploads/${req.file.filename}`;
    if (settings.get('readers_can_set_prices')) {
      Object.assign(fields, {
        price_chat_cents: Math.max(1, parseMoney(b.price_chat)),
        price_video_cents: Math.max(1, parseMoney(b.price_video)),
        price_question_cents: Math.max(1, parseMoney(b.price_question)),
        video_enabled: b.video_enabled ? 1 : 0,
      });
    }
    const keys = Object.keys(fields);
    db.prepare(`UPDATE readers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), r.id);
    const cats = [].concat(b.categories || []).map(Number).filter(Boolean);
    db.transaction(() => {
      db.prepare('DELETE FROM reader_categories WHERE reader_id = ?').run(r.id);
      const ins = db.prepare('INSERT OR IGNORE INTO reader_categories (reader_id, category_id) VALUES (?, ?)');
      cats.forEach((c) => ins.run(r.id, c));
    })();
    flash(req, 'success', 'Perfil atualizado.');
    res.redirect('/atendente/perfil');
  }));

  router.get('/depoimentos', (req, res) => res.render('reader/reviews', {
    title: 'Depoimentos recebidos', reviews: ctx.reviews.forReader(req.reader.id, { limit: 300 }),
  }));

  return router;
};
