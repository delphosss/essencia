const crypto = require('crypto');
const { HttpError, money, nowIso } = require('../lib/util');

const MP_API = 'https://api.mercadopago.com';

// Pedidos de crédito e da loja + integrações de pagamento.
// Fluxo: createCreditOrder (pedido "pending", como no original ao abrir o checkout)
//        → startPayment(método) → webhook/IPN confirma → markPaid credita a carteira.
module.exports = function createPayments(ctx) {
  const { db, config, settings } = ctx;
  const sandbox = () => !config.mercadoPago.accessToken && !config.isProduction;

  function hasPaidCreditOrder(userId) {
    return !!db.prepare("SELECT 1 FROM orders WHERE user_id = ? AND kind = 'credits' AND status = 'paid' LIMIT 1").get(userId);
  }

  function findCoupon(code) {
    if (!code) return null;
    return db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(String(code).trim());
  }

  function validateCoupon(coupon, userId, subtotal) {
    if (!coupon || !coupon.active) throw new HttpError(400, 'Cupom inválido');
    const now = nowIso();
    if (coupon.starts_at && now < coupon.starts_at) throw new HttpError(400, 'Cupom ainda não está válido');
    if (coupon.ends_at && now > coupon.ends_at) throw new HttpError(400, 'Cupom expirado');
    if (coupon.max_uses != null && coupon.uses >= coupon.max_uses) throw new HttpError(400, 'Cupom esgotado');
    if (subtotal < coupon.min_cents) throw new HttpError(400, `Cupom válido para compras a partir de ${money(coupon.min_cents)}`);
    if (coupon.first_purchase_only && hasPaidCreditOrder(userId)) throw new HttpError(400, 'Cupom válido só na primeira compra');
    if (coupon.per_user_once && db.prepare('SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?').get(coupon.id, userId)) {
      throw new HttpError(400, 'Você já usou este cupom');
    }
  }

  // Calcula valores de um pacote de créditos para o cliente (sem gravar nada).
  function quoteCredits(userId, packageId, couponCode) {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
    if (!pkg) throw new HttpError(400, 'Escolha um pacote de créditos');
    const subtotal = pkg.price_cents;
    const firstPurchaseBonus = hasPaidCreditOrder(userId) ? 0 : settings.get('first_purchase_bonus_cents');
    let discount = 0;
    let couponBonus = 0;
    let coupon = null;
    if (couponCode) {
      coupon = findCoupon(couponCode);
      validateCoupon(coupon, userId, subtotal);
      if (coupon.kind === 'percent') discount = Math.round((subtotal * Math.min(coupon.value, 100)) / 100);
      else if (coupon.kind === 'fixed') discount = Math.min(coupon.value, subtotal);
      else couponBonus = coupon.value;
    }
    const bonus = pkg.bonus_cents + firstPurchaseBonus + couponBonus;
    return {
      pkg, coupon, subtotal, discount, total: subtotal - discount,
      packageBonus: pkg.bonus_cents, firstPurchaseBonus, couponBonus, bonus, credit: subtotal + bonus,
    };
  }

  function createCreditOrder(userId, packageId, couponCode) {
    const q = quoteCredits(userId, packageId, couponCode);
    const { lastInsertRowid } = db.prepare(`INSERT INTO orders
      (user_id, kind, package_id, subtotal_cents, discount_cents, total_cents, bonus_cents, credit_cents, coupon_id)
      VALUES (?, 'credits', ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, q.pkg.id, q.subtotal, q.discount, q.total, q.bonus, q.credit, q.coupon ? q.coupon.id : null,
    );
    if (q.total === 0) markPaid(lastInsertRowid, { method: 'coupon' });
    return getOrder(lastInsertRowid);
  }

  // Reaplica (ou remove) cupom num pedido ainda pendente.
  function applyCoupon(orderId, userId, couponCode) {
    const order = getOrder(orderId);
    if (!order || order.user_id !== userId || order.status !== 'pending' || order.kind !== 'credits') {
      throw new HttpError(400, 'Pedido indisponível');
    }
    const q = quoteCredits(userId, order.package_id, couponCode || null);
    db.prepare(`UPDATE orders SET discount_cents = ?, total_cents = ?, bonus_cents = ?, credit_cents = ?, coupon_id = ?,
      method = NULL, gateway_ref = NULL, pix_qr = NULL, pix_qr_base64 = NULL, checkout_url = NULL WHERE id = ?`)
      .run(q.discount, q.total, q.bonus, q.credit, q.coupon ? q.coupon.id : null, orderId);
    if (q.total === 0) markPaid(orderId, { method: 'coupon' });
    return getOrder(orderId);
  }

  function createStoreOrder(userId, items, shipping) {
    if (!items.length) throw new HttpError(400, 'Carrinho vazio');
    const products = items.map(({ productId, quantity }) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
      if (!p) throw new HttpError(400, 'Produto indisponível');
      return { p, quantity: Math.max(1, Math.min(99, quantity | 0)) };
    });
    const total = products.reduce((s, { p, quantity }) => s + p.price_cents * quantity, 0);
    return db.transaction(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO orders (user_id, kind, subtotal_cents, total_cents, shipping_json)
        VALUES (?, 'store', ?, ?, ?)`).run(userId, total, total, shipping ? JSON.stringify(shipping) : null);
      const ins = db.prepare('INSERT INTO order_items (order_id, product_id, name, price_cents, quantity) VALUES (?, ?, ?, ?, ?)');
      for (const { p, quantity } of products) ins.run(lastInsertRowid, p.id, p.name, p.price_cents, quantity);
      return getOrder(lastInsertRowid);
    })();
  }

  function getOrder(id) {
    return db.prepare(`SELECT o.*, p.name AS package_name, u.name AS user_name, u.email AS user_email
      FROM orders o LEFT JOIN packages p ON p.id = o.package_id JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(id);
  }

  function orderItems(orderId) {
    return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  }

  function describe(order) {
    if (order.kind === 'credits') return `Créditos para consulta — ${money(order.subtotal_cents)} (${order.package_name || 'pacote'})`;
    return `Pedido da loja #${order.id}`;
  }

  // ---- Confirmação (idempotente) -----------------------------------------
  const settle = db.transaction((orderId, method, gatewayRef) => {
    const order = getOrder(orderId);
    if (!order) throw new HttpError(404, 'Pedido não encontrado');
    if (order.status === 'paid') return { order, already: true };
    if (order.status !== 'pending' && order.status !== 'failed') throw new HttpError(400, `Pedido está ${order.status}`);
    db.prepare("UPDATE orders SET status = 'paid', method = COALESCE(?, method), gateway_ref = COALESCE(?, gateway_ref), paid_at = ? WHERE id = ?")
      .run(method || null, gatewayRef || null, nowIso(), orderId);
    if (order.kind === 'credits') {
      ctx.wallet.credit(order.user_id, order.subtotal_cents, 'purchase', `Compra de créditos #${order.id}`, { type: 'order', id: order.id });
      if (order.bonus_cents > 0) {
        ctx.wallet.credit(order.user_id, order.bonus_cents, 'bonus', `Bônus da compra #${order.id}`, { type: 'order', id: order.id });
      }
    }
    if (order.coupon_id) {
      db.prepare('UPDATE coupons SET uses = uses + 1 WHERE id = ?').run(order.coupon_id);
      db.prepare('INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, ?)').run(order.coupon_id, order.user_id, order.id);
    }
    return { order: getOrder(orderId), already: false };
  });

  function markPaid(orderId, { method, gatewayRef } = {}) {
    const { order, already } = settle(orderId, method, gatewayRef);
    if (!already) {
      if (order.kind === 'credits') {
        ctx.notifications.notify(order.user_id, {
          title: 'Compra aprovada',
          body: `${money(order.credit_cents)} em créditos adicionados à sua conta.`,
          link: '/tarologos',
        });
        ctx.rt.toUser(order.user_id, 'payment:approved', { orderId: order.id, creditCents: order.credit_cents });
      } else {
        ctx.notifications.notify(order.user_id, { title: 'Pedido da loja aprovado', body: `Pedido #${order.id}`, link: '/minha-conta/pedidos-loja' });
        ctx.notifications.notifyAdmins({ title: 'Novo pedido na loja', body: `#${order.id} — ${money(order.total_cents)}`, link: `/admin/pedidos/${order.id}` });
      }
    }
    return order;
  }

  function cancel(orderId) {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status IN ('pending','failed')").run(orderId);
  }

  // Estorno feito pelo admin: retira da carteira o crédito concedido (se ainda houver saldo).
  // A devolução do dinheiro no gateway é feita no painel do Mercado Pago/PayPal.
  const refund = db.transaction((orderId) => {
    const order = getOrder(orderId);
    if (!order || order.status !== 'paid') throw new HttpError(400, 'Só pedidos pagos podem ser estornados');
    if (order.kind === 'credits') {
      ctx.wallet.debit(order.user_id, order.credit_cents, 'refund', `Estorno do pedido #${order.id}`, { type: 'order', id: order.id });
    }
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);
    return getOrder(orderId);
  });

  // ---- Gateways ----------------------------------------------------------
  async function mpRequest(method, path, body, idempotencyKey) {
    const res = await fetch(`${MP_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.mercadoPago.accessToken}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      ctx.logError('mercadopago', `${method} ${path} → ${res.status}`, data);
      throw new HttpError(502, 'Não foi possível falar com o Mercado Pago. Tente novamente.');
    }
    return data;
  }

  async function startPix(order) {
    if (order.pix_qr && order.method === 'pix') return order;
    if (sandbox()) {
      const code = `00020126SANDBOX-PIX-${order.id}-${crypto.randomBytes(6).toString('hex')}`;
      db.prepare("UPDATE orders SET method = 'pix', pix_qr = ?, gateway_ref = ? WHERE id = ?").run(code, `sandbox-${order.id}`, order.id);
      return getOrder(order.id);
    }
    const [first, ...rest] = order.user_name.split(' ');
    const payment = await mpRequest('POST', '/v1/payments', {
      transaction_amount: order.total_cents / 100,
      description: describe(order),
      payment_method_id: 'pix',
      external_reference: String(order.id),
      notification_url: `${config.baseUrl}/webhooks/mercadopago`,
      payer: { email: order.user_email, first_name: first, last_name: rest.join(' ') || first },
    }, `order-${order.id}-pix-${order.total_cents}`);
    const tx = payment.point_of_interaction && payment.point_of_interaction.transaction_data;
    db.prepare("UPDATE orders SET method = 'pix', gateway_ref = ?, pix_qr = ?, pix_qr_base64 = ? WHERE id = ?")
      .run(String(payment.id), tx ? tx.qr_code : null, tx ? tx.qr_code_base64 : null, order.id);
    return getOrder(order.id);
  }

  // Cartão: Checkout Pro (redireciona para o ambiente do Mercado Pago).
  async function startCard(order) {
    if (sandbox()) {
      const url = `/pagamento/simulador/${order.id}`;
      db.prepare("UPDATE orders SET method = 'card', checkout_url = ? WHERE id = ?").run(url, order.id);
      return getOrder(order.id);
    }
    const pref = await mpRequest('POST', '/checkout/preferences', {
      items: [{ title: describe(order), quantity: 1, unit_price: order.total_cents / 100, currency_id: 'BRL' }],
      payer: { email: order.user_email, name: order.user_name },
      external_reference: String(order.id),
      notification_url: `${config.baseUrl}/webhooks/mercadopago`,
      back_urls: {
        success: `${config.baseUrl}/pagamento/${order.id}/retorno`,
        pending: `${config.baseUrl}/pagamento/${order.id}/retorno`,
        failure: `${config.baseUrl}/pagamento/${order.id}`,
      },
      auto_return: 'approved',
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }] },
    });
    db.prepare("UPDATE orders SET method = 'card', checkout_url = ? WHERE id = ?").run(pref.init_point, order.id);
    return getOrder(order.id);
  }

  // PayPal Payments Standard: formulário POST para o PayPal; confirmação por IPN.
  function paypalForm(order) {
    if (!config.paypal.businessEmail) return null;
    return {
      action: config.paypal.sandbox ? 'https://www.sandbox.paypal.com/cgi-bin/webscr' : 'https://www.paypal.com/cgi-bin/webscr',
      fields: {
        cmd: '_xclick',
        business: config.paypal.businessEmail,
        item_name: describe(order),
        amount: (order.total_cents / 100).toFixed(2),
        currency_code: config.paypal.currency,
        custom: String(order.id),
        invoice: `order-${order.id}`,
        notify_url: `${config.baseUrl}/webhooks/paypal`,
        return: `${config.baseUrl}/pagamento/${order.id}/retorno`,
        cancel_return: `${config.baseUrl}/pagamento/${order.id}`,
        no_shipping: '1',
        charset: 'utf-8',
      },
    };
  }

  // Webhook do Mercado Pago: valida assinatura (se configurada), consulta o pagamento e confirma.
  function verifyMpSignature(headers, dataId) {
    const secret = config.mercadoPago.webhookSecret;
    if (!secret) return true;
    const sig = String(headers['x-signature'] || '');
    const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=')));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${headers['x-request-id'] || ''};ts:${parts.ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return ctx.util.safeEqual(expected, parts.v1);
  }

  async function handleMercadoPagoWebhook({ query, body, headers }) {
    const type = body.type || body.topic || query.type || query.topic;
    const id = (body.data && body.data.id) || query['data.id'] || query.id;
    if (!id || (type && type !== 'payment')) return { ignored: true };
    if (!verifyMpSignature(headers, id)) throw new HttpError(401, 'Assinatura inválida');
    if (!config.mercadoPago.accessToken) return { ignored: true };
    const payment = await mpRequest('GET', `/v1/payments/${encodeURIComponent(id)}`);
    const order = getOrder(Number(payment.external_reference));
    if (!order) return { ignored: true };
    if (payment.status === 'approved') {
      if (Math.round(payment.transaction_amount * 100) < order.total_cents) {
        ctx.logError('mercadopago', 'Valor pago menor que o pedido', { orderId: order.id, paymentId: id });
        return { mismatch: true };
      }
      const method = payment.payment_method_id === 'pix' ? 'pix' : 'card';
      markPaid(order.id, { method, gatewayRef: String(payment.id) });
      return { paid: true };
    }
    if (['rejected', 'cancelled'].includes(payment.status) && order.status === 'pending') {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
    }
    return { status: payment.status };
  }

  async function handlePaypalIpn(rawBody, fields) {
    const verifyUrl = config.paypal.sandbox
      ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
      : 'https://ipnpb.paypal.com/cgi-bin/webscr';
    const res = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'arcano-ipn' },
      body: `cmd=_notify-validate&${rawBody}`,
    });
    const verdict = (await res.text()).trim();
    if (verdict !== 'VERIFIED') throw new HttpError(400, 'IPN não verificado');
    const order = getOrder(Number(fields.custom));
    if (!order) return { ignored: true };
    if (String(fields.receiver_email || '').toLowerCase() !== config.paypal.businessEmail.toLowerCase()) {
      throw new HttpError(400, 'Recebedor inválido');
    }
    if (fields.payment_status !== 'Completed') return { status: fields.payment_status };
    if (Math.round(Number(fields.mc_gross) * 100) < order.total_cents) return { mismatch: true };
    markPaid(order.id, { method: 'paypal', gatewayRef: fields.txn_id });
    return { paid: true };
  }

  return {
    sandbox, quoteCredits, createCreditOrder, applyCoupon, createStoreOrder, getOrder, orderItems, describe,
    markPaid, cancel, refund, startPix, startCard, paypalForm, handleMercadoPagoWebhook, handlePaypalIpn,
    hasPaidCreditOrder, verifyMpSignature,
  };
};
