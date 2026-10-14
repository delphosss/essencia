const path = require('path');
require('dotenv').config();

const root = path.resolve(__dirname, '..');
const env = process.env;

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  // No Render, RENDER_EXTERNAL_URL já traz o endereço público (https://...onrender.com).
  baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  isProduction: env.NODE_ENV === 'production',
  // Ambiente de demonstração: pagamentos simulados, faixa de aviso e fora do Google.
  demoMode: env.DEMO_MODE === 'true',
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  databasePath: env.DATABASE_PATH || path.join(root, 'data', 'essencia.db'),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || 'public/uploads'),
  admin: {
    email: env.ADMIN_EMAIL || 'admin@exemplo.com',
    password: env.ADMIN_PASSWORD || 'admin123',
  },
  // Perfil de atendimento da dona do site (100% do valor fica com a casa).
  owner: {
    email: env.OWNER_EMAIL || 'damadanoite@exemplo.com',
    password: env.OWNER_PASSWORD || 'tarot123',
  },
  mercadoPago: {
    accessToken: env.MP_ACCESS_TOKEN || '',
    webhookSecret: env.MP_WEBHOOK_SECRET || '',
  },
  paypal: {
    businessEmail: env.PAYPAL_BUSINESS_EMAIL || '',
    sandbox: env.PAYPAL_SANDBOX !== 'false',
    currency: env.PAYPAL_CURRENCY || 'BRL',
  },
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'no-reply@exemplo.com',
  },
  whatsapp: {
    url: env.WHATSAPP_API_URL || '',
    token: env.WHATSAPP_API_TOKEN || '',
  },
};
