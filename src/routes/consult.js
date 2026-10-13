const express = require('express');
const { action, requireAuth, flash } = require('../lib/middleware');
const { HttpError, toInt, safeEqual } = require('../lib/util');

module.exports = function consultRoutes(ctx) {
  const { db, consultations } = ctx;
  const router = express.Router();
  const getByCode = db.prepare('SELECT * FROM consultations WHERE code = ?');

  function wantsJson(req) {
    return req.xhr || (req.get('accept') || '').includes('application/json');
  }

  // Cliente inicia a chamada (botão Chat/Vídeo).
  router.post('/consultar', requireAuth('client'), action(async (req, res) => {
    const readerId = toInt(req.body.reader_id);
    const type = req.body.type === 'video' ? 'video' : 'chat';
    const { code } = consultations.startCall(req.user, readerId, type, { appointmentId: toInt(req.body.appointment_id) || null });
    if (wantsJson(req)) return res.json({ code, url: `/chamando/${code}` });
    return res.redirect(`/chamando/${code}`);
  }));

  // Sala de espera "Chamando o tarólogo".
  router.get('/chamando/:code', requireAuth('client'), (req, res, next) => {
    const c = getByCode.get(req.params.code);
    if (!c || c.client_id !== req.user.id) return next();
    if (c.status === 'active') return res.redirect(`/sala/${c.code}`);
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(c.reader_id);
    const timeout = ctx.settings.get('call_timeout_seconds');
    const elapsed = Math.floor((ctx.clock() - new Date(c.called_at).getTime()) / 1000);
    return res.render('chat/calling', { title: 'Chamando', c, r: reader, remaining: Math.max(0, timeout - elapsed), timeout });
  });

  router.post('/chamando/:code/cancelar', requireAuth('client'), action(async (req, res) => {
    consultations.cancelCall(req.user.id, req.params.code);
    const c = getByCode.get(req.params.code);
    const reader = c && db.prepare('SELECT slug FROM readers WHERE id = ?').get(c.reader_id);
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect(reader ? `/tarologo/${reader.slug}` : '/tarologos');
  }));

  // Sala da consulta (cliente, tarólogo ou admin acompanhando).
  router.get('/sala/:code', requireAuth(), (req, res, next) => {
    const c = getByCode.get(req.params.code);
    if (!c) return next();
    const role = consultations.participantRole(c, req.user.id) || (req.user.role === 'admin' ? 'admin' : null);
    if (!role) return next(new HttpError(403, 'Acesso negado'));
    if (c.status === 'calling' && role === 'client') return res.redirect(`/chamando/${c.code}`);
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(c.reader_id);
    const client = db.prepare('SELECT id, name, birth_date FROM users WHERE id = ?').get(c.client_id);
    return res.render('chat/room', {
      title: `Consulta com ${role === 'reader' ? client.name : reader.display_name}`,
      c, r: reader, client, role,
      messages: consultations.messages(c.id),
      snapshot: consultations.snapshot(c.code),
      jitsiDomain: ctx.settings.get('jitsi_domain'),
      canReview: role === 'client' && !!ctx.reviews.canReview(req.user.id, c.code),
    });
  });

  router.get('/sala/:code/mensagens', requireAuth(), action(async (req, res) => {
    const c = getByCode.get(req.params.code);
    if (!c) throw new HttpError(404, 'Consulta não encontrada');
    if (!consultations.participantRole(c, req.user.id) && req.user.role !== 'admin') throw new HttpError(403, 'Acesso negado');
    res.json({ status: c.status, messages: consultations.messages(c.id) });
  }));

  router.post('/sala/:code/mensagem', requireAuth(), action(async (req, res) => {
    res.json({ message: consultations.sendMessage(req.params.code, req.user.id, req.body.text) });
  }));

  router.post('/sala/:code/encerrar', requireAuth(), action(async (req, res) => {
    if (req.user.role === 'admin' && !consultations.participantRole(getByCode.get(req.params.code) || {}, req.user.id)) {
      consultations.endSession(req.params.code, 'admin', 'admin');
    } else {
      consultations.endByUser(req.params.code, req.user.id);
    }
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect(`/sala/${req.params.code}`);
  }));

  router.post('/sala/:code/pausar', requireAuth('reader'), action(async (req, res) => {
    consultations.pause(req.params.code, req.user.id);
    res.json({ ok: true });
  }));

  router.post('/sala/:code/retomar', requireAuth('reader'), action(async (req, res) => {
    consultations.resume(req.params.code, req.user.id);
    res.json({ ok: true });
  }));

  // Tarólogo aceita/recusa pelo painel.
  router.post('/atendente/chamadas/:code/aceitar', requireAuth('reader'), action(async (req, res) => {
    consultations.acceptCall(req.user.id, req.params.code);
    if (wantsJson(req)) return res.json({ url: `/sala/${req.params.code}` });
    return res.redirect(`/sala/${req.params.code}`);
  }));

  router.post('/atendente/chamadas/:code/recusar', requireAuth('reader'), action(async (req, res) => {
    consultations.rejectCall(req.user.id, req.params.code, String(req.body.reason || '').slice(0, 200));
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect('/atendente');
  }));

  // Link enviado por WhatsApp: aceita com token assinado e leva o tarólogo para a sala.
  router.get('/atendente/aceitar/:code', action(async (req, res) => {
    const { code } = req.params;
    if (!safeEqual(String(req.query.t || ''), consultations.acceptLinkToken(code))) throw new HttpError(403, 'Link inválido');
    const c = getByCode.get(code);
    if (!c) throw new HttpError(404, 'Chamada não encontrada');
    const reader = db.prepare('SELECT user_id FROM readers WHERE id = ?').get(c.reader_id);
    if (c.status === 'calling') consultations.acceptCall(reader.user_id, code);
    else if (c.status !== 'active') {
      flash(req, 'error', 'Essa chamada não está mais disponível.');
      return res.redirect('/atendente');
    }
    return res.redirect(req.user ? `/sala/${code}` : `/entrar?next=${encodeURIComponent(`/sala/${code}`)}`);
  }, { back: '/atendente' }));

  return router;
};
