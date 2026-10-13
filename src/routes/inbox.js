const express = require('express');
const { action, requireAuth, flash } = require('../lib/middleware');
const { toInt } = require('../lib/util');

// Mensagens internas — a mesma tela serve cliente, tarólogo e admin.
module.exports = function inboxRoutes(ctx) {
  const router = express.Router();
  const FOLDERS = { entrada: 'inbox', enviadas: 'sent', lixeira: 'trash' };

  router.get('/mensagens', requireAuth(), (req, res) => {
    const folderKey = FOLDERS[req.query.pasta] ? req.query.pasta : 'entrada';
    res.render('shared/inbox', {
      title: 'Mensagens',
      folderKey,
      messages: ctx.inbox.folder(req.user, FOLDERS[folderKey]),
      contacts: ctx.inbox.contactsFor(req.user),
      to: req.query.para || '',
      subject: req.query.assunto || '',
    });
  });

  router.get('/mensagens/:id', requireAuth(), action(async (req, res) => {
    const m = ctx.inbox.open(req.user, toInt(req.params.id));
    res.render('shared/inbox-message', { title: m.subject, m });
  }, { back: '/mensagens' }));

  router.post('/mensagens', requireAuth(), action(async (req, res) => {
    ctx.inbox.send(req.user, req.body.to, req.body.subject, req.body.body);
    flash(req, 'success', 'Mensagem enviada.');
    res.redirect('/mensagens?pasta=enviadas');
  }, { back: '/mensagens' }));

  router.post('/mensagens/:id/lixeira', requireAuth(), action(async (req, res) => {
    ctx.inbox.trash(req.user, toInt(req.params.id), req.body.restore === '1');
    res.redirect('/mensagens');
  }, { back: '/mensagens' }));

  return router;
};
