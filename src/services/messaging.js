// Canais externos: e-mail (SMTP) e WhatsApp (API HTTP). Sem configuração, só registram no log.
const nodemailer = require('nodemailer');

module.exports = function createMessaging(ctx) {
  const { config } = ctx;
  const outbox = []; // últimas mensagens (útil em desenvolvimento e testes)
  let transport = null;
  if (config.smtp.host) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }

  function remember(entry) {
    outbox.push({ ...entry, at: new Date().toISOString() });
    if (outbox.length > 200) outbox.shift();
  }

  async function sendEmail({ to, subject, text, html }) {
    remember({ channel: 'email', to, subject, text });
    if (!transport) {
      if (!ctx.quiet) console.log(`[email] para=${to} assunto="${subject}"\n${text}`);
      return { logged: true };
    }
    try {
      await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
      return { sent: true };
    } catch (err) {
      ctx.logError('email', err.message, { to, subject });
      return { error: err.message };
    }
  }

  function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.length <= 11 ? `55${digits}` : digits;
  }

  async function sendWhatsapp(phone, message) {
    const to = normalizePhone(phone);
    if (!to) return { skipped: true };
    remember({ channel: 'whatsapp', to, text: message });
    if (!config.whatsapp.url) {
      if (!ctx.quiet) console.log(`[whatsapp] para=${to}\n${message}`);
      return { logged: true };
    }
    try {
      const res = await fetch(config.whatsapp.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.whatsapp.token ? { 'Client-Token': config.whatsapp.token } : {}),
        },
        body: JSON.stringify({ phone: to, message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { sent: true };
    } catch (err) {
      ctx.logError('whatsapp', err.message, { to });
      return { error: err.message };
    }
  }

  return { sendEmail, sendWhatsapp, outbox };
};
