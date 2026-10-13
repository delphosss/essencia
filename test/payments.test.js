const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTestCtx, makeClient } = require('./helpers');

const pkg = (ctx, price) => ctx.db.prepare('SELECT * FROM packages WHERE price_cents = ?').get(price);

test('primeira compra recebe bônus de 1ª compra + bônus do pacote', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  const q = ctx.payments.quoteCredits(c.id, pkg(ctx, 4000).id);
  assert.equal(q.total, 4000);
  assert.equal(q.firstPurchaseBonus, 500);
  assert.equal(q.packageBonus, 800);
  assert.equal(q.credit, 5300);
});

test('pagamento aprovado credita a carteira uma única vez (idempotente)', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  const order = ctx.payments.createCreditOrder(c.id, pkg(ctx, 1000).id);
  assert.equal(order.status, 'pending');
  assert.equal(ctx.wallet.balance(c.id), 0);
  ctx.payments.markPaid(order.id, { method: 'pix', gatewayRef: 'x1' });
  ctx.payments.markPaid(order.id, { method: 'pix', gatewayRef: 'x1' });
  assert.equal(ctx.wallet.balance(c.id), 1500);
  const types = ctx.wallet.history(c.id).map((t) => t.type).sort();
  assert.deepEqual(types, ['bonus', 'purchase']);
  // Segunda compra: sem bônus de primeira compra.
  const q2 = ctx.payments.quoteCredits(c.id, pkg(ctx, 1000).id);
  assert.equal(q2.firstPurchaseBonus, 0);
  assert.equal(q2.credit, 1000);
});

test('cupom percentual reduz o valor pago, mas não os créditos', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  ctx.db.prepare("INSERT INTO coupons (code, kind, value) VALUES ('LUA10', 'percent', 10)").run();
  const order = ctx.payments.createCreditOrder(c.id, pkg(ctx, 2000).id, 'lua10');
  assert.equal(order.discount_cents, 200);
  assert.equal(order.total_cents, 1800);
  assert.equal(order.credit_cents, 2000 + 200 + 500);
  ctx.payments.markPaid(order.id);
  assert.equal(ctx.db.prepare("SELECT uses FROM coupons WHERE code = 'LUA10'").get().uses, 1);
  assert.throws(() => ctx.payments.quoteCredits(c.id, pkg(ctx, 2000).id, 'LUA10'), /já usou/);
});

test('cupom inválido, expirado ou esgotado é recusado', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  ctx.db.prepare("INSERT INTO coupons (code, kind, value, ends_at) VALUES ('VELHO', 'fixed', 300, '2020-01-01T00:00:00Z')").run();
  ctx.db.prepare("INSERT INTO coupons (code, kind, value, max_uses, uses) VALUES ('FIM', 'fixed', 300, 1, 1)").run();
  assert.throws(() => ctx.payments.quoteCredits(c.id, pkg(ctx, 1000).id, 'NAOEXISTE'), /inválido/);
  assert.throws(() => ctx.payments.quoteCredits(c.id, pkg(ctx, 1000).id, 'VELHO'), /expirado/);
  assert.throws(() => ctx.payments.quoteCredits(c.id, pkg(ctx, 1000).id, 'FIM'), /esgotado/);
});

test('cupom de 100% aprova o pedido na hora', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  ctx.db.prepare("INSERT INTO coupons (code, kind, value) VALUES ('CORTESIA', 'percent', 100)").run();
  const order = ctx.payments.createCreditOrder(c.id, pkg(ctx, 1000).id, 'CORTESIA');
  assert.equal(order.status, 'paid');
  assert.equal(ctx.wallet.balance(c.id), 1500);
});

test('estorno retira os créditos concedidos', () => {
  const ctx = createTestCtx();
  const c = makeClient(ctx);
  const order = ctx.payments.createCreditOrder(c.id, pkg(ctx, 1000).id);
  ctx.payments.markPaid(order.id);
  ctx.payments.refund(order.id);
  assert.equal(ctx.wallet.balance(c.id), 0);
  assert.equal(ctx.payments.getOrder(order.id).status, 'refunded');
});

test('assinatura do webhook do Mercado Pago é validada', () => {
  const ctx = createTestCtx();
  ctx.config.mercadoPago = { ...ctx.config.mercadoPago, webhookSecret: 'segredo' };
  const ts = '1700000000';
  const v1 = crypto.createHmac('sha256', 'segredo').update(`id:123;request-id:abc;ts:${ts};`).digest('hex');
  assert.equal(ctx.payments.verifyMpSignature({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'abc' }, '123'), true);
  assert.equal(ctx.payments.verifyMpSignature({ 'x-signature': `ts=${ts},v1=errado`, 'x-request-id': 'abc' }, '123'), false);
});
