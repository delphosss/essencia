const { HttpError } = require('../lib/util');

// Mensagens internas (caixa de entrada / enviadas / lixeira).
// Cliente ↔ suporte, cliente ↔ tarólogo com quem já consultou, admin ↔ qualquer um.
module.exports = function createInbox(ctx) {
  const { db } = ctx;

  function contactsFor(user) {
    const support = [{ id: 'support', label: 'Suporte' }];
    if (user.role === 'client') {
      return support.concat(db.prepare(`SELECT DISTINCT u.id, r.display_name AS label FROM consultations c
        JOIN readers r ON r.id = c.reader_id JOIN users u ON u.id = r.user_id
        WHERE c.client_id = ? AND c.status = 'ended'`).all(user.id));
    }
    if (user.role === 'reader') {
      return support.concat(db.prepare(`SELECT DISTINCT u.id, u.name AS label FROM consultations c
        JOIN readers r ON r.id = c.reader_id JOIN users u ON u.id = c.client_id
        WHERE r.user_id = ? AND c.status = 'ended'`).all(user.id));
    }
    return db.prepare("SELECT id, name || ' (' || email || ')' AS label FROM users WHERE id != ? ORDER BY name").all(user.id);
  }

  function send(sender, to, subject, body) {
    const toSupport = to === 'support';
    const recipientId = toSupport ? null : Number(to);
    if (!toSupport) {
      const allowed = contactsFor(sender).some((c) => c.id === recipientId);
      if (!allowed) throw new HttpError(403, 'Destinatário não permitido');
    }
    let text = String(body || '').trim().slice(0, 5000);
    const subj = String(subject || '').trim().slice(0, 150) || '(sem assunto)';
    if (!text) throw new HttpError(400, 'Escreva a mensagem');
    if (sender.role !== 'admin' && !toSupport) text = ctx.consultations.filterContacts(text);
    const { lastInsertRowid } = db.prepare('INSERT INTO inbox_messages (sender_id, recipient_id, to_support, subject, body) VALUES (?, ?, ?, ?, ?)')
      .run(sender.id, recipientId, toSupport ? 1 : 0, subj, text);
    const payload = { title: `Nova mensagem: ${subj}`, body: `De ${sender.name}` };
    if (toSupport) ctx.notifications.notifyAdmins({ ...payload, link: '/admin/mensagens' });
    else ctx.notifications.notify(recipientId, { ...payload, link: '/mensagens' });
    return lastInsertRowid;
  }

  const base = `SELECT m.*, s.name AS sender_name, s.role AS sender_role, r.name AS recipient_name FROM inbox_messages m
    JOIN users s ON s.id = m.sender_id LEFT JOIN users r ON r.id = m.recipient_id`;

  function folder(user, name) {
    const support = user.role === 'admin' ? ' OR m.to_support = 1' : '';
    if (name === 'sent') return db.prepare(`${base} WHERE m.sender_id = ? AND m.sender_deleted = 0 ORDER BY m.id DESC`).all(user.id);
    if (name === 'trash') {
      return db.prepare(`${base} WHERE (m.recipient_id = ?${support}) AND m.recipient_deleted = 1 ORDER BY m.id DESC`).all(user.id);
    }
    return db.prepare(`${base} WHERE (m.recipient_id = ?${support}) AND m.recipient_deleted = 0 ORDER BY m.id DESC`).all(user.id);
  }

  function open(user, id) {
    const m = db.prepare(`${base} WHERE m.id = ?`).get(id);
    if (!m) throw new HttpError(404, 'Mensagem não encontrada');
    const isRecipient = m.recipient_id === user.id || (m.to_support && user.role === 'admin');
    if (!isRecipient && m.sender_id !== user.id) throw new HttpError(403, 'Acesso negado');
    if (isRecipient && !m.read_at) db.prepare("UPDATE inbox_messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    return { ...m, isRecipient };
  }

  function trash(user, id, restore = false) {
    const m = open(user, id);
    if (m.isRecipient) db.prepare('UPDATE inbox_messages SET recipient_deleted = ? WHERE id = ?').run(restore ? 0 : 1, id);
    else db.prepare('UPDATE inbox_messages SET sender_deleted = 1 WHERE id = ?').run(id);
  }

  function unread(user) {
    const support = user.role === 'admin' ? ' OR to_support = 1' : '';
    return db.prepare(`SELECT COUNT(*) n FROM inbox_messages WHERE (recipient_id = ?${support}) AND read_at IS NULL AND recipient_deleted = 0`).get(user.id).n;
  }

  return { contactsFor, send, folder, open, trash, unread };
};
