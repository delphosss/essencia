const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestCtx, makeClient, firstReader } = require('./helpers');

test('pergunta paga: debita, responde, gera ganho; reembolso devolve', () => {
  const ctx = createTestCtx();
  const client = makeClient(ctx, { balance: 1200 });
  const reader = firstReader(ctx);
  const id = ctx.questions.ask(client, reader.id, {
    questions: ['Vou mudar de emprego?', 'E o amor?'], people: [{ name: 'Ana', birth_date: '1991-02-03' }],
  });
  assert.equal(ctx.wallet.balance(client.id), 200);
  assert.throws(() => ctx.questions.ask(client, reader.id, { questions: ['Mais uma'] }), /Saldo insuficiente/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM questions').get().n, 1, 'pergunta sem saldo não fica gravada');
  ctx.questions.answer(reader.user_id, id, 'As cartas mostram um bom momento para mudanças.');
  assert.equal(ctx.questions.get(id).status, 'answered');
  assert.equal(ctx.earnings.summary(reader.id).balanceCents, 500);
  const other = makeClient(ctx, { balance: 500 });
  const id2 = ctx.questions.ask(other, reader.id, { questions: ['Teste'] });
  ctx.questions.refund(id2);
  assert.equal(ctx.questions.get(id2).status, 'refunded');
  assert.equal(ctx.wallet.balance(other.id), 500);
});

test('agenda: reserva dentro da janela e regra de cancelamento com antecedência', () => {
  const ctx = createTestCtx();
  const client = makeClient(ctx);
  const reader = firstReader(ctx);
  const start = new Date(ctx.now() + 2 * 86400000);
  const end = new Date(start.getTime() + 4 * 3600000);
  ctx.appointments.addSlot(reader.id, start.toISOString(), end.toISOString());
  const slot = ctx.appointments.upcomingSlots(reader.id)[0];
  assert.throws(() => ctx.appointments.book(client, slot.id, new Date(end.getTime() + 60000).toISOString()), /dentro da janela/);
  const id = ctx.appointments.book(client, slot.id, new Date(start.getTime() + 3600000).toISOString(), 'tema: trabalho');
  const readerUser = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(reader.user_id);
  ctx.appointments.setStatus(id, readerUser, 'confirmed');
  ctx.advance(30 * 3600000); // faltam menos de 24 h
  assert.throws(() => ctx.appointments.setStatus(id, client, 'cancelled'), /antecedência/);
  ctx.appointments.setStatus(id, readerUser, 'cancelled', 'imprevisto');
  assert.equal(ctx.appointments.get(id).status, 'cancelled');
});

test('depoimento: só após consulta cobrada, um por consulta, com moderação', () => {
  const ctx = createTestCtx();
  const client = makeClient(ctx, { balance: 1000 });
  const reader = firstReader(ctx);
  ctx.consultations.setReaderStatus(reader.id, 'online');
  const { code } = ctx.consultations.startCall(client, reader.id, 'chat');
  ctx.consultations.acceptCall(reader.user_id, code);
  assert.throws(() => ctx.reviews.create(client, code, 5, 'Ótima leitura'), /não pode ser avaliada/);
  ctx.consultations.join(code, 'client');
  ctx.consultations.join(code, 'reader');
  ctx.consultations.tick(ctx.advance(1000));
  ctx.consultations.endByUser(code, client.id);
  assert.equal(ctx.reviews.create(client, code, 5, 'Leitura certeira e acolhedora.'), 'pending');
  assert.throws(() => ctx.reviews.create(client, code, 4, 'De novo'), /não pode ser avaliada/);
  assert.equal(ctx.reviews.forReader(reader.id).length, 0);
  const review = ctx.db.prepare('SELECT id FROM reviews').get();
  ctx.reviews.moderate(review.id, 'approved');
  assert.equal(ctx.reviews.forReader(reader.id).length, 1);
});

test('saque: respeita mínimo e saldo; pago vira lançamento negativo', () => {
  const ctx = createTestCtx();
  const reader = firstReader(ctx);
  ctx.earnings.adjust(reader.id, 8000, 'crédito de teste');
  assert.throws(() => ctx.earnings.requestWithdrawal(reader.id, 1000, 'pix@x.com'), /mínimo/);
  assert.throws(() => ctx.earnings.requestWithdrawal(reader.id, 9000, 'pix@x.com'), /maior que o saldo/);
  const id = ctx.earnings.requestWithdrawal(reader.id, 6000, 'pix@x.com');
  assert.equal(ctx.earnings.summary(reader.id).availableCents, 2000);
  ctx.earnings.process(id, 'paid', 'E2E123');
  const s = ctx.earnings.summary(reader.id);
  assert.equal(s.balanceCents, 2000);
  assert.equal(s.paidOutCents, 6000);
});

test('mensagens internas: cliente só escreve para suporte ou tarólogo com quem consultou', () => {
  const ctx = createTestCtx();
  const client = makeClient(ctx);
  const reader = firstReader(ctx);
  assert.throws(() => ctx.inbox.send(client, reader.user_id, 'Oi', 'Olá'), /não permitido/);
  ctx.inbox.send(client, 'support', 'Dúvida', 'Como compro créditos?');
  const admin = ctx.db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  assert.equal(ctx.inbox.folder(admin, 'inbox').length, 1);
  assert.equal(ctx.inbox.unread(admin), 1);
});

test('notificação em massa chega a todos os clientes', () => {
  const ctx = createTestCtx();
  makeClient(ctx);
  makeClient(ctx);
  const n = ctx.notifications.broadcast('clients', { title: 'Promoção', body: 'Bônus em dobro hoje' });
  assert.equal(n, ctx.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'client'").get().n);
});
