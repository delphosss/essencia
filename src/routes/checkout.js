const express = require('express');
const { action, requireAuth, flash } = require('../lib/middleware');
const { HttpError, toInt } = require('../lib/util');

// Checkout: abrir o checkout já cria o pedido "pendente" (pode ser pago depois em Minha Conta → Compras).
module.exports = function checkoutRoutes(ctx) {
  const { payments, config } = ctx;
  const router = express.Router();

  function ownOrder(req) {
    const order = payments.getOrder(toInt(req.params.id));
    if (!order || (order.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Pedido não encontrado');
    return order;
  }

  router.post('/comprar', requireAuth('client'), action(async (req, res) => {
    const order = payments.createCreditOrder(req.user.id, toInt(req.body.package_id), String(req.body.coupon || '').trim() || null);
    res.redirect(`/pagamento/${order.id}`);
  }, { back: '/comprar-creditos' }));

  router.get('/pagamento/:id', requireAuth(), action(async (req, res) => {
    const order = ownOrder(req);
    if (order.status === 'paid') return res.redirect(`/pagamento/${order.id}/retorno`);
    return res.render('public/checkout', {
      title: 'Pagamento',
      order,
      items: order.kind === 'store' ? payments.orderItems(order.id) : [],
      description: payments.describe(order),
      coupon: order.coupon_id ? ctx.db.prepare('SELECT code FROM coupons WHERE id = ?').get(order.coupon_id) : null,
      paypal: payments.paypalForm(order),
      sandbox: payments.sandbox(),
    });
  }, { back: '/minha-conta/compras' }));

  router.post('/pagamento/:id/cupom', requireAuth('client'), action(async (req, res) => {
    const order = ownOrder(req);
    payments.applyCoupon(order.id, req.user.id, String(req.body.coupon || '').trim() || null);
    flash(req, 'success', req.body.coupon ? 'Cupom aplicado.' : 'Cupom removido.');
    res.redirect(`/pagamento/${order.id}`);
  }, { back: (req) => `/pagamento/${req.params.id}` }));

  router.post('/pagamento/:id/pix', requireAuth(), action(async (req, res) => {
    const order = ownOrder(req);
    if (order.status !== 'pending') throw new HttpError(409, 'Pedido não está pendente');
    const updated = await payments.startPix(order);
    res.json({ qr: updated.pix_qr, qrBase64: updated.pix_qr_base64 });
  }));

  router.post('/pagamento/:id/cartao', requireAuth(), action(async (req, res) => {
    const order = ownOrder(req);
    if (order.status !== 'pending') throw new HttpError(409, 'Pedido não está pendente');
    const updated = await payments.startCard(order);
    res.redirect(updated.checkout_url);
  }, { back: (req) => `/pagamento/${req.params.id}` }));

  router.get('/pagamento/:id/status', requireAuth(), action(async (req, res) => {
    const order = ownOrder(req);
    res.json({ status: order.status });
  }));

  router.get('/pagamento/:id/retorno', requireAuth(), action(async (req, res) => {
    const order = ownOrder(req);
    res.render('public/checkout-done', { title: 'Pagamento', order });
  }, { back: '/minha-conta/compras' }));

  // Simulador de pagamento (somente sem MP_ACCESS_TOKEN e fora de produção).
  router.get('/pagamento/simulador/:id', requireAuth(), action(async (req, res) => {
    if (!payments.sandbox()) throw new HttpError(404, 'Indisponível');
    const order = ownOrder(req);
    res.render('public/sandbox', { title: 'Simulador de pagamento', order });
  }));

  router.post('/pagamento/simulador/:id', requireAuth(), action(async (req, res) => {
    if (!payments.sandbox() || config.isProduction) throw new HttpError(404, 'Indisponível');
    const order = ownOrder(req);
    if (req.body.result === 'approve') payments.markPaid(order.id, { method: order.method || 'sandbox', gatewayRef: `sandbox-${order.id}` });
    else ctx.db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(order.id);
    if (req.xhr || (req.get('accept') || '').includes('json')) return res.json({ ok: true });
    return res.redirect(`/pagamento/${order.id}/retorno`);
  }));

  return router;
};
