const { HttpError, money, nowIso } = require('../lib/util');

// Perguntas pagas: o cliente paga um valor fixo por pergunta e o tarólogo responde depois.
module.exports = function createQuestions(ctx) {
  const { db, settings } = ctx;

  const ask = (client, readerId, { questions, people }) => {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ? AND active = 1').get(readerId);
    if (!reader || !reader.questions_enabled) throw new HttpError(400, 'Este tarólogo não está recebendo perguntas');
    const list = (questions || []).map((q) => String(q || '').trim()).filter(Boolean).map((q) => q.slice(0, 1000));
    if (!list.length) throw new HttpError(400, 'Escreva pelo menos uma pergunta');
    const max = settings.get('question_max_per_order');
    if (list.length > max) throw new HttpError(400, `Máximo de ${max} perguntas por envio`);
    const peopleList = (people || [])
      .map((p) => ({ name: String(p.name || '').trim().slice(0, 120), birth_date: String(p.birth_date || '').slice(0, 10) }))
      .filter((p) => p.name);
    const total = reader.price_question_cents * list.length;
    const id = db.transaction(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO questions
        (client_id, reader_id, quantity, price_each_cents, total_cents, people_json, questions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        client.id, readerId, list.length, reader.price_question_cents, total, JSON.stringify(peopleList), JSON.stringify(list),
      );
      ctx.wallet.debit(client.id, total, 'question', `Perguntas para ${reader.display_name}`, { type: 'question', id: lastInsertRowid });
      return lastInsertRowid;
    })();
    ctx.notifications.notify(reader.user_id, {
      title: 'Nova pergunta paga', body: `${client.name} enviou ${list.length} pergunta(s).`, link: `/atendente/perguntas/${id}`,
    });
    if (reader.whatsapp) {
      ctx.messaging.sendWhatsapp(reader.whatsapp, `📩 ${settings.get('site_name')}: nova pergunta paga de ${client.name}. Responda em ${ctx.config.baseUrl}/atendente/perguntas/${id}`);
    }
    return id;
  };

  function get(id) {
    const q = db.prepare(`SELECT q.*, r.display_name AS reader_name, r.slug AS reader_slug, r.user_id AS reader_user_id,
      u.name AS client_name, u.email AS client_email FROM questions q
      JOIN readers r ON r.id = q.reader_id JOIN users u ON u.id = q.client_id WHERE q.id = ?`).get(id);
    if (!q) return null;
    q.questions = JSON.parse(q.questions_json || '[]');
    q.people = JSON.parse(q.people_json || '[]');
    return q;
  }

  function answer(readerUserId, id, text) {
    const q = get(id);
    if (!q || q.reader_user_id !== readerUserId) throw new HttpError(404, 'Pergunta não encontrada');
    if (q.status !== 'pending') throw new HttpError(409, 'Pergunta já respondida');
    const body = String(text || '').trim();
    if (body.length < 10) throw new HttpError(400, 'Escreva a resposta');
    db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(body, nowIso(), id);
    ctx.earnings.record(q.reader_id, { sourceType: 'question', sourceId: id, grossCents: q.total_cents, description: `${q.quantity} pergunta(s) de ${q.client_name}` });
    ctx.notifications.notify(q.client_id, { title: 'Sua pergunta foi respondida', body: q.reader_name, link: `/minha-conta/perguntas/${id}` });
    ctx.messaging.sendEmail({
      to: q.client_email,
      subject: `${q.reader_name} respondeu sua pergunta`,
      text: `Olá, ${q.client_name}!\n\nSua pergunta foi respondida. Leia em ${ctx.config.baseUrl}/minha-conta/perguntas/${id}`,
    });
  }

  const refund = db.transaction((id) => {
    const q = get(id);
    if (!q || q.status !== 'pending') throw new HttpError(400, 'Só perguntas pendentes podem ser reembolsadas');
    db.prepare("UPDATE questions SET status = 'refunded' WHERE id = ?").run(id);
    ctx.wallet.credit(q.client_id, q.total_cents, 'refund', `Reembolso de perguntas #${id}`, { type: 'question', id });
    ctx.notifications.notify(q.client_id, { title: 'Pergunta reembolsada', body: `${money(q.total_cents)} devolvidos ao seu saldo.`, link: '/minha-conta/perguntas' });
  });

  function forClient(clientId) {
    return db.prepare(`SELECT q.*, r.display_name AS reader_name FROM questions q JOIN readers r ON r.id = q.reader_id
      WHERE q.client_id = ? ORDER BY q.id DESC`).all(clientId);
  }

  function forReader(readerId) {
    return db.prepare(`SELECT q.*, u.name AS client_name FROM questions q JOIN users u ON u.id = q.client_id
      WHERE q.reader_id = ? ORDER BY q.status = 'pending' DESC, q.id DESC`).all(readerId);
  }

  return { ask, get, answer, refund, forClient, forReader };
};
