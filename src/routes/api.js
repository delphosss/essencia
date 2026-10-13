const express = require('express');
const { action, requireAuth, flash } = require('../lib/middleware');
const { HttpError, toInt } = require('../lib/util');

// Endpoints usados pelo JavaScript das páginas (sino de notificações, status, avise-me).
module.exports = function apiRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  router.get('/api/notificacoes', requireAuth(), (req, res) => {
    res.json({ unread: ctx.notifications.unread(req.user.id), items: ctx.notifications.list(req.user.id, 20) });
  });

  router.post('/api/notificacoes/lidas', requireAuth(), (req, res) => {
    res.json({ unread: ctx.notifications.markRead(req.user.id, toInt(req.body.id) || null) });
  });

  router.get('/api/tarologos/status', (req, res) => {
    res.json(db.prepare('SELECT id, status FROM readers WHERE active = 1').all());
  });

  router.get('/api/saldo', requireAuth(), (req, res) => {
    res.json({ balanceCents: ctx.wallet.balance(req.user.id) });
  });

  // "Avise-me quando ficar online"
  router.post('/avise-me/:readerId', requireAuth('client'), action(async (req, res) => {
    const readerId = toInt(req.params.readerId);
    const reader = db.prepare('SELECT * FROM readers WHERE id = ? AND active = 1').get(readerId);
    if (!reader) throw new HttpError(404, 'Tarólogo não encontrado');
    const exists = db.prepare('SELECT 1 FROM availability_alerts WHERE client_id = ? AND reader_id = ? AND notified_at IS NULL').get(req.user.id, readerId);
    if (!exists) db.prepare('INSERT INTO availability_alerts (client_id, reader_id) VALUES (?, ?)').run(req.user.id, readerId);
    const msg = `Pronto! Avisaremos quando ${reader.display_name} ficar online.`;
    if ((req.get('accept') || '').includes('json')) return res.json({ ok: true, message: msg });
    flash(req, 'success', msg);
    return res.redirect(`/tarologo/${reader.slug}`);
  }));

  // Pergunta paga
  router.post('/perguntar/:readerId', requireAuth('client'), action(async (req, res) => {
    const readerId = toInt(req.params.readerId);
    const reader = db.prepare('SELECT slug FROM readers WHERE id = ?').get(readerId);
    const questions = [].concat(req.body.questions || []);
    const names = [].concat(req.body.person_name || []);
    const births = [].concat(req.body.person_birth || []);
    const people = names.map((name, i) => ({ name, birth_date: births[i] }));
    const id = ctx.questions.ask(req.user, readerId, { questions, people });
    flash(req, 'success', 'Pergunta enviada! Você será avisado(a) quando a resposta chegar.');
    res.redirect(`/minha-conta/perguntas/${id}`);
  }, { back: (req) => {
    const r = db.prepare('SELECT slug FROM readers WHERE id = ?').get(toInt(req.params.readerId));
    return r ? `/tarologo/${r.slug}#perguntar` : '/tarologos';
  } }));

  // Agendamento
  router.post('/agendar/:readerId', requireAuth('client'), action(async (req, res) => {
    const slotId = toInt(req.body.slot_id);
    const time = String(req.body.time || '');
    const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ? AND reader_id = ?').get(slotId, toInt(req.params.readerId));
    if (!slot) throw new HttpError(400, 'Escolha um horário disponível');
    let when = slot.starts_at;
    if (/^\d{2}:\d{2}$/.test(time)) {
      // A janela é exibida no horário de Brasília (UTC−3).
      const day = new Date(new Date(slot.starts_at).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      when = new Date(`${day}T${time}:00-03:00`).toISOString();
    }
    ctx.appointments.book(req.user, slotId, when, req.body.notes);
    flash(req, 'success', 'Agendamento enviado! O tarólogo vai confirmar e você será notificado(a).');
    res.redirect('/minha-conta/agendadas');
  }));

  return router;
};
