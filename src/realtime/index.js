const { Server } = require('socket.io');

// Liga o Socket.io ao servidor HTTP e implementa ctx.rt (emissão para usuários, salas e todos).
// Salas: u:{userId}, admins, s:{code} (sala da consulta).
function attachRealtime(ctx, httpServer, sessionMiddleware) {
  const { db } = ctx;
  const io = new Server(httpServer, { serveClient: true });
  io.engine.use(sessionMiddleware);
  const visitors = new Map(); // socket.id → { name, role, path, title, since }
  let visitorsDirty = false;

  ctx.rt = {
    toUser: (userId, event, data) => io.to(`u:${userId}`).emit(event, data),
    toAll: (event, data) => io.emit(event, data),
    toAdmins: (event, data) => io.to('admins').emit(event, data),
    toRoom: (room, event, data) => io.to(room).emit(event, data),
  };

  const getUser = db.prepare('SELECT id, name, role, blocked FROM users WHERE id = ?');
  const getReader = db.prepare('SELECT id FROM readers WHERE user_id = ?');
  const getConsult = db.prepare('SELECT * FROM consultations WHERE code = ?');

  io.on('connection', (socket) => {
    const sess = socket.request.session || {};
    const user = sess.userId ? getUser.get(sess.userId) : null;
    const joinedSessions = new Map(); // code → role
    let readerId = null;

    if (user && !user.blocked) {
      socket.join(`u:${user.id}`);
      if (user.role === 'admin') {
        socket.join('admins');
        socket.emit('visitors', [...visitors.values()]);
      }
      if (user.role === 'reader') {
        const r = getReader.get(user.id);
        if (r) {
          readerId = r.id;
          ctx.consultations.readerConnected(readerId);
        }
      }
    }

    socket.on('page', (info = {}) => {
      visitors.set(socket.id, {
        id: socket.id,
        name: user ? user.name : 'Visitante',
        role: user ? user.role : 'visitor',
        path: String(info.path || '').slice(0, 200),
        title: String(info.title || '').slice(0, 120),
        since: new Date().toISOString(),
      });
      visitorsDirty = true;
    });

    socket.on('session:join', (code, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!user) return reply({ error: 'login' });
      const c = getConsult.get(String(code));
      if (!c) return reply({ error: 'not_found' });
      const role = ctx.consultations.participantRole(c, user.id);
      if (!role && user.role !== 'admin') return reply({ error: 'forbidden' });
      socket.join(`s:${c.code}`);
      if (role && !joinedSessions.has(c.code)) {
        joinedSessions.set(c.code, role);
        ctx.consultations.join(c.code, role);
      }
      return reply({ ok: true, role: role || 'admin', snapshot: ctx.consultations.snapshot(c.code) });
    });

    socket.on('session:send', ({ code, text } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!user) return reply({ error: 'login' });
      try {
        reply({ ok: true, message: ctx.consultations.sendMessage(String(code), user.id, text) });
      } catch (err) {
        reply({ error: err.message });
      }
    });

    socket.on('session:typing', ({ code } = {}) => {
      const role = joinedSessions.get(String(code));
      if (role) socket.to(`s:${code}`).emit('session:typing', { role });
    });

    socket.on('disconnect', () => {
      for (const [code, role] of joinedSessions) ctx.consultations.leave(code, role);
      if (readerId) ctx.consultations.readerDisconnected(readerId);
      if (visitors.delete(socket.id)) visitorsDirty = true;
    });
  });

  // Painel "visitantes em tempo real" do admin (agrupa atualizações a cada 3 s).
  const t = setInterval(() => {
    if (!visitorsDirty) return;
    visitorsDirty = false;
    io.to('admins').emit('visitors', [...visitors.values()]);
  }, 3000);
  t.unref();

  io.visitors = visitors;
  return io;
}

module.exports = { attachRealtime };
