const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestCtx, makeClient, firstReader, eventsOf } = require('./helpers');

function setup(balance = 1000) {
  const ctx = createTestCtx();
  const client = makeClient(ctx, { balance });
  const reader = firstReader(ctx);
  ctx.consultations.setReaderStatus(reader.id, 'online');
  return { ctx, client, reader };
}

function startAndJoin({ ctx, client, reader }) {
  const { code } = ctx.consultations.startCall(client, reader.id, 'chat');
  ctx.consultations.acceptCall(reader.user_id, code);
  ctx.consultations.join(code, 'client');
  ctx.consultations.join(code, 'reader');
  return code;
}

const consultation = (ctx, code) => ctx.db.prepare('SELECT * FROM consultations WHERE code = ?').get(code);

test('não inicia sem saldo para 1 minuto nem com tarólogo offline', () => {
  const { ctx, client, reader } = setup(100);
  assert.throws(() => ctx.consultations.startCall(client, reader.id, 'chat'), /Saldo insuficiente/);
  ctx.wallet.credit(client.id, 1000, 'adjustment', 'x');
  ctx.consultations.setReaderStatus(reader.id, 'offline');
  assert.throws(() => ctx.consultations.startCall(client, reader.id, 'chat'), /offline/);
});

test('cobra por minuto iniciado enquanto os dois estão na sala', () => {
  const env = setup(1000);
  const { ctx, client, reader } = env;
  const code = startAndJoin(env);
  ctx.consultations.tick(ctx.advance(1000));
  assert.equal(ctx.wallet.balance(client.id), 1000 - 199, 'primeiro minuto debitado ao começar');
  ctx.consultations.tick(ctx.advance(58000));
  assert.equal(ctx.wallet.balance(client.id), 801);
  ctx.consultations.tick(ctx.advance(2000)); // passou de 60 s
  assert.equal(ctx.wallet.balance(client.id), 602);
  const snap = ctx.consultations.snapshot(code);
  assert.equal(snap.minutesCharged, 2);
  assert.ok(snap.remainingSeconds > 0);
  assert.equal(ctx.db.prepare('SELECT status FROM readers WHERE id = ?').get(reader.id).status, 'busy');
  ctx.consultations.endByUser(code, client.id);
  const c = consultation(ctx, code);
  assert.equal(c.status, 'ended');
  assert.equal(c.charged_cents, 398);
  assert.equal(c.balance_end_cents, 602);
  assert.equal(ctx.db.prepare('SELECT status FROM readers WHERE id = ?').get(reader.id).status, 'online');
  // Repasse de 30% para o tarólogo (R$ 3,98 × 30% = R$ 1,19); 70% fica com o site.
  assert.equal(ctx.earnings.summary(reader.id).balanceCents, 119);
});

test('encerra sozinha quando o saldo não cobre o próximo minuto', () => {
  const env = setup(450); // 2 minutos de R$ 1,99
  const { ctx } = env;
  const code = startAndJoin(env);
  for (let i = 0; i < 125; i += 1) ctx.consultations.tick(ctx.advance(1000));
  const c = consultation(ctx, code);
  assert.equal(c.status, 'ended');
  assert.equal(c.end_reason, 'insufficient_balance');
  assert.equal(c.minutes_charged, 2);
  assert.ok(eventsOf(ctx, 'session:low_balance').length >= 1, 'avisou saldo baixo');
});

test('não cobra enquanto alguém está fora da sala e encerra após a tolerância', () => {
  const env = setup(2000);
  const { ctx, client } = env;
  const code = startAndJoin(env);
  ctx.consultations.tick(ctx.advance(1000));
  const after1 = ctx.wallet.balance(client.id);
  ctx.consultations.leave(code, 'reader');
  ctx.consultations.tick(ctx.advance(80000));
  assert.equal(ctx.wallet.balance(client.id), after1, 'sem cobrança durante a ausência');
  ctx.consultations.tick(ctx.advance(15000)); // passou dos 90 s de tolerância
  assert.equal(consultation(ctx, code).end_reason, 'reader_disconnected');
});

test('pausa do tarólogo para a cobrança', () => {
  const env = setup(2000);
  const { ctx, client, reader } = env;
  const code = startAndJoin(env);
  ctx.consultations.tick(ctx.advance(1000));
  ctx.consultations.pause(code, reader.user_id);
  const before = ctx.wallet.balance(client.id);
  for (let i = 0; i < 120; i += 1) ctx.consultations.tick(ctx.advance(1000));
  assert.equal(ctx.wallet.balance(client.id), before);
  ctx.consultations.resume(code, reader.user_id);
  for (let i = 0; i < 61; i += 1) ctx.consultations.tick(ctx.advance(1000));
  assert.equal(ctx.wallet.balance(client.id), before - 199);
});

test('chamada sem resposta vira "perdida" e notifica o tarólogo', () => {
  const { ctx, client, reader } = setup(1000);
  const { code } = ctx.consultations.startCall(client, reader.id, 'chat');
  assert.equal(eventsOf(ctx, 'call:incoming').length, 1);
  ctx.consultations.tick(ctx.advance(241000));
  assert.equal(consultation(ctx, code).status, 'missed');
  assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Consulta perdida'").get(reader.user_id));
  assert.equal(ctx.wallet.balance(client.id), 1000, 'nada cobrado');
});

test('WhatsApp de chamada repete no intervalo configurado, até o limite', () => {
  const { ctx, client, reader } = setup(1000);
  ctx.db.prepare("UPDATE readers SET whatsapp = '11999990000' WHERE id = ?").run(reader.id);
  ctx.consultations.startCall(client, reader.id, 'chat');
  for (let i = 0; i < 200; i += 1) ctx.consultations.tick(ctx.advance(1000));
  const sent = ctx.messaging.outbox.filter((m) => m.channel === 'whatsapp');
  assert.equal(sent.length, ctx.settings.get('whatsapp_max_repeats'));
  assert.match(sent[0].text, /\/atendente\/aceitar\//);
});

test('recusa e cancelamento não cobram nada', () => {
  const { ctx, client, reader } = setup(1000);
  const a = ctx.consultations.startCall(client, reader.id, 'chat');
  ctx.consultations.rejectCall(reader.user_id, a.code, 'Ocupada');
  assert.equal(eventsOf(ctx, 'call:rejected')[0].data.reason, 'Ocupada');
  const b = ctx.consultations.startCall(client, reader.id, 'chat');
  ctx.consultations.cancelCall(client.id, b.code);
  assert.equal(consultation(ctx, b.code).status, 'cancelled');
  assert.equal(ctx.wallet.balance(client.id), 1000);
});

test('tarólogo ocupado não recebe segunda chamada', () => {
  const env = setup(1000);
  const { ctx, reader } = env;
  startAndJoin(env);
  const other = makeClient(ctx, { balance: 1000 });
  assert.throws(() => ctx.consultations.startCall(other, reader.id, 'chat'), /atendimento/);
});

test('dados de contato são removidos das mensagens', () => {
  const env = setup(1000);
  const { ctx, client } = env;
  const code = startAndJoin(env);
  const m = ctx.consultations.sendMessage(code, client.id, 'me chama no whatsapp 11 98765-4321 ou ana@mail.com');
  assert.doesNotMatch(m.body, /98765|ana@mail|whatsapp/i);
  assert.match(m.body, /\[contato removido\]/);
});

test('"avise-me" notifica quando o tarólogo fica online', () => {
  const { ctx, client, reader } = setup(0);
  ctx.consultations.setReaderStatus(reader.id, 'offline');
  ctx.db.prepare('INSERT INTO availability_alerts (client_id, reader_id) VALUES (?, ?)').run(client.id, reader.id);
  ctx.consultations.setReaderStatus(reader.id, 'online');
  assert.ok(ctx.db.prepare('SELECT notified_at FROM availability_alerts WHERE client_id = ?').get(client.id).notified_at);
  assert.ok(ctx.messaging.outbox.some((m) => m.channel === 'email' && m.to === client.email));
});

test('tarólogo sem painel aberto fica offline após a tolerância', () => {
  const { ctx, reader } = setup(0);
  ctx.consultations.readerConnected(reader.id);
  ctx.consultations.readerDisconnected(reader.id);
  ctx.consultations.tick(ctx.advance(121000));
  assert.equal(ctx.db.prepare('SELECT status FROM readers WHERE id = ?').get(reader.id).status, 'offline');
});

test('reinício do servidor encerra sessões abertas sem perder o que foi cobrado', () => {
  const env = setup(1000);
  const { ctx } = env;
  const code = startAndJoin(env);
  ctx.consultations.tick(ctx.advance(1000));
  const fresh = require('../src/services/consultations')(ctx);
  fresh.recover();
  const c = consultation(ctx, code);
  assert.equal(c.status, 'ended');
  assert.equal(c.end_reason, 'server_restart');
  assert.equal(c.charged_cents, 199);
});

test('perfil da dona (Dama da Noite) fica com 100%, sem repasse', () => {
  const ctx = createTestCtx();
  const client = makeClient(ctx, { balance: 1000 });
  const owner = ctx.db.prepare("SELECT * FROM readers WHERE slug = 'dama-da-noite'").get();
  assert.equal(owner.is_owner, 1);
  assert.equal(owner.commission_percent, 100);
  assert.equal(ctx.db.prepare('SELECT commission_percent FROM readers WHERE is_owner = 0 LIMIT 1').get().commission_percent, 30);
  ctx.consultations.setReaderStatus(owner.id, 'online');
  const { code } = ctx.consultations.startCall(client, owner.id, 'chat');
  ctx.consultations.acceptCall(owner.user_id, code);
  ctx.consultations.join(code, 'client');
  ctx.consultations.join(code, 'reader');
  ctx.consultations.tick(ctx.advance(1000));
  ctx.consultations.endByUser(code, client.id);
  assert.equal(ctx.earnings.summary(owner.id).balanceCents, 199);
});
