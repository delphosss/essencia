const express = require('express');

// Notificações dos gateways. Sem CSRF/sessão; validação é feita no serviço (assinatura MP / IPN PayPal).
module.exports = function webhookRoutes(ctx) {
  const router = express.Router();

  router.post('/mercadopago', express.json({ limit: '200kb' }), async (req, res) => {
    try {
      const result = await ctx.payments.handleMercadoPagoWebhook({ query: req.query, body: req.body || {}, headers: req.headers });
      res.json(result);
    } catch (err) {
      ctx.logError('webhook:mercadopago', err.message, { query: req.query });
      res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.message });
    }
  });

  router.post('/paypal', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
    const raw = req.body ? req.body.toString('utf8') : '';
    res.status(200).end(); // o PayPal exige 200 imediato; a verificação segue em seguida
    try {
      await ctx.payments.handlePaypalIpn(raw, Object.fromEntries(new URLSearchParams(raw)));
    } catch (err) {
      ctx.logError('webhook:paypal', err.message);
    }
  });

  return router;
};
