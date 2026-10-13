const { HttpError, nowIso, fmtDateTime } = require('../lib/util');

// Agenda: o tarólogo abre janelas de disponibilidade; o cliente escolhe uma janela e um horário.
module.exports = function createAppointments(ctx) {
  const { db, settings } = ctx;

  function addSlot(readerId, startsAt, endsAt) {
    const s = new Date(startsAt);
    const e = new Date(endsAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw new HttpError(400, 'Período inválido');
    if (e.getTime() < ctx.clock()) throw new HttpError(400, 'O período já passou');
    db.prepare('INSERT INTO availability_slots (reader_id, starts_at, ends_at) VALUES (?, ?, ?)').run(readerId, s.toISOString(), e.toISOString());
  }

  function removeSlot(readerId, slotId) {
    db.prepare('DELETE FROM availability_slots WHERE id = ? AND reader_id = ?').run(slotId, readerId);
  }

  function upcomingSlots(readerId) {
    return db.prepare('SELECT * FROM availability_slots WHERE reader_id = ? AND ends_at > ? ORDER BY starts_at')
      .all(readerId, new Date(ctx.clock()).toISOString());
  }

  function book(client, slotId, scheduledAt, notes) {
    const slot = db.prepare('SELECT s.*, r.user_id AS reader_user_id, r.display_name FROM availability_slots s JOIN readers r ON r.id = s.reader_id WHERE s.id = ?').get(slotId);
    if (!slot) throw new HttpError(404, 'Horário indisponível');
    const at = new Date(scheduledAt || slot.starts_at);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Horário inválido');
    if (at.toISOString() < slot.starts_at || at.toISOString() > slot.ends_at) throw new HttpError(400, 'Escolha um horário dentro da janela');
    if (at.getTime() < ctx.clock()) throw new HttpError(400, 'Escolha um horário futuro');
    const { lastInsertRowid } = db.prepare(`INSERT INTO appointments (slot_id, client_id, reader_id, scheduled_at, notes)
      VALUES (?, ?, ?, ?, ?)`).run(slot.id, client.id, slot.reader_id, at.toISOString(), String(notes || '').slice(0, 500));
    ctx.notifications.notify(slot.reader_user_id, {
      title: 'Novo agendamento', body: `${client.name} — ${fmtDateTime(at.toISOString())}`, link: '/atendente/agenda',
    });
    return lastInsertRowid;
  }

  function get(id) {
    return db.prepare(`SELECT a.*, r.display_name AS reader_name, r.slug AS reader_slug, r.user_id AS reader_user_id, u.name AS client_name
      FROM appointments a JOIN readers r ON r.id = a.reader_id JOIN users u ON u.id = a.client_id WHERE a.id = ?`).get(id);
  }

  function setStatus(id, actor, status, reason) {
    const a = get(id);
    if (!a) throw new HttpError(404, 'Agendamento não encontrado');
    const isReader = actor.id === a.reader_user_id;
    const isClient = actor.id === a.client_id;
    const isAdmin = actor.role === 'admin';
    if (!isReader && !isClient && !isAdmin) throw new HttpError(403, 'Acesso negado');
    if (['cancelled', 'done'].includes(a.status)) throw new HttpError(409, 'Agendamento já finalizado');
    if (status === 'confirmed' && !isReader && !isAdmin) throw new HttpError(403, 'Apenas o tarólogo confirma');
    if (status === 'done' && !isReader && !isAdmin) throw new HttpError(403, 'Apenas o tarólogo conclui');
    if (status === 'cancelled' && isClient && !isAdmin) {
      const hours = settings.get('appointment_cancel_hours');
      if (new Date(a.scheduled_at).getTime() - ctx.clock() < hours * 3600 * 1000) {
        throw new HttpError(400, `Cancelamentos pelo site só com ${hours}h de antecedência. Fale com o suporte.`);
      }
    }
    db.prepare('UPDATE appointments SET status = ?, cancel_reason = ? WHERE id = ?').run(status, reason || null, id);
    const label = { confirmed: 'confirmado', cancelled: 'cancelado', done: 'concluído' }[status];
    const notifyUser = isClient ? a.reader_user_id : a.client_id;
    ctx.notifications.notify(notifyUser, {
      title: `Agendamento ${label}`,
      body: `${isClient ? a.client_name : a.reader_name} — ${fmtDateTime(a.scheduled_at)}${reason ? ` (${reason})` : ''}`,
      link: isClient ? '/atendente/agenda' : '/minha-conta/agendadas',
    });
  }

  function forClient(clientId) {
    return db.prepare(`SELECT a.*, r.display_name AS reader_name, r.slug AS reader_slug FROM appointments a
      JOIN readers r ON r.id = a.reader_id WHERE a.client_id = ? ORDER BY a.scheduled_at DESC`).all(clientId);
  }

  function forReader(readerId) {
    return db.prepare(`SELECT a.*, u.name AS client_name FROM appointments a JOIN users u ON u.id = a.client_id
      WHERE a.reader_id = ? ORDER BY a.status IN ('requested','confirmed') DESC, a.scheduled_at`).all(readerId);
  }

  return { addSlot, removeSlot, upcomingSlots, book, get, setStatus, forClient, forReader, now: nowIso };
};
