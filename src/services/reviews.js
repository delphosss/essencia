const { HttpError } = require('../lib/util');

// Depoimentos: 1 por consulta concluída (com pelo menos 1 minuto cobrado).
module.exports = function createReviews(ctx) {
  const { db, settings } = ctx;

  function canReview(clientId, code) {
    const c = db.prepare('SELECT * FROM consultations WHERE code = ? AND client_id = ?').get(code, clientId);
    if (!c || c.status !== 'ended' || c.minutes_charged < 1) return null;
    if (db.prepare('SELECT 1 FROM reviews WHERE consultation_id = ?').get(c.id)) return null;
    return c;
  }

  function create(client, code, rating, body) {
    const c = canReview(client.id, code);
    if (!c) throw new HttpError(400, 'Esta consulta não pode ser avaliada');
    const r = Math.round(Number(rating));
    if (!(r >= 1 && r <= 5)) throw new HttpError(400, 'Escolha de 1 a 5 estrelas');
    const text = ctx.consultations.filterContacts(String(body || '').trim().slice(0, 1500));
    if (text.length < 5) throw new HttpError(400, 'Escreva um comentário');
    const status = settings.get('reviews_require_approval') ? 'pending' : 'approved';
    db.prepare('INSERT INTO reviews (consultation_id, client_id, reader_id, rating, body, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, client.id, c.reader_id, r, text, status);
    if (status === 'approved') notifyReader(c.reader_id);
    else ctx.notifications.notifyAdmins({ title: 'Depoimento aguardando aprovação', body: `${r} estrela(s)`, link: '/admin/depoimentos' });
    return status;
  }

  function notifyReader(readerId) {
    const reader = db.prepare('SELECT user_id FROM readers WHERE id = ?').get(readerId);
    ctx.notifications.notify(reader.user_id, { title: 'Novo depoimento publicado', link: '/atendente/depoimentos' });
  }

  function moderate(id, status) {
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!review) throw new HttpError(404, 'Depoimento não encontrado');
    db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, id);
    if (status === 'approved' && review.status !== 'approved') notifyReader(review.reader_id);
  }

  function forReader(readerId, { onlyApproved = true, limit = 50 } = {}) {
    return db.prepare(`SELECT * FROM reviews WHERE reader_id = ? ${onlyApproved ? "AND status = 'approved'" : ''}
      ORDER BY id DESC LIMIT ?`).all(readerId, limit);
  }

  return { canReview, create, moderate, forReader };
};
