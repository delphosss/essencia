// Notificações internas (sino) com entrega em tempo real via Socket.io.
module.exports = function createNotifications(ctx) {
  const { db } = ctx;
  const insert = db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)');
  const unreadStmt = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL');

  function unread(userId) {
    return unreadStmt.get(userId).n;
  }

  function notify(userId, { title, body = '', link = '' }) {
    const { lastInsertRowid } = insert.run(userId, title, body, link);
    ctx.rt.toUser(userId, 'notify', { id: lastInsertRowid, title, body, link, unread: unread(userId) });
    return lastInsertRowid;
  }

  function notifyAdmins(payload) {
    for (const { id } of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) notify(id, payload);
  }

  // target: clients | readers | admins | all
  function broadcast(target, payload) {
    const where = { clients: "role = 'client'", readers: "role = 'reader'", admins: "role = 'admin'", all: '1 = 1' }[target];
    if (!where) throw new Error('Destino inválido');
    const ids = db.prepare(`SELECT id FROM users WHERE ${where} AND blocked = 0`).all();
    db.transaction(() => {
      for (const { id } of ids) insert.run(id, payload.title, payload.body || '', payload.link || '');
    })();
    for (const { id } of ids) ctx.rt.toUser(id, 'notify', { ...payload, unread: unread(id) });
    return ids.length;
  }

  function list(userId, limit = 30) {
    return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }

  function markRead(userId, id) {
    if (id) db.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?").run(id, userId);
    else db.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND read_at IS NULL").run(userId);
    return unread(userId);
  }

  return { notify, notifyAdmins, broadcast, list, markRead, unread };
};
