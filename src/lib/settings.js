// Configurações editáveis pelo admin (tabela settings). Os segredos ficam no .env.
const DEFAULTS = {
  site_name: 'Essência do Tarot',
  site_tagline: 'Consulta de tarot online por chat, ao vivo',
  site_logo: '/public/img/logo-essencia.webp',
  site_favicon: '/public/img/icon-essencia.png',
  support_email: 'contato@exemplo.com',
  support_phone: '',
  support_whatsapp: '',
  instagram_url: '',
  facebook_url: '',
  promo_strip: 'Primeira compra: ganhe R$ 5,00 de bônus em créditos',
  home_popup_enabled: '0',
  home_popup_title: '',
  home_popup_body: '',
  home_popup_link: '',
  first_purchase_bonus_cents: '500',
  default_price_chat_cents: '199',
  default_price_video_cents: '590',
  default_price_question_cents: '500',
  default_commission_percent: '30',
  min_balance_minutes: '1',
  call_timeout_seconds: '240',
  ring_seconds: '60',
  whatsapp_repeat_seconds: '30',
  whatsapp_max_repeats: '4',
  low_balance_warning_seconds: '120',
  disconnect_grace_seconds: '90',
  max_pause_seconds: '300',
  reader_offline_grace_seconds: '120',
  withdrawal_min_cents: '5000',
  reviews_require_approval: '1',
  comments_require_approval: '1',
  readers_can_set_prices: '0',
  chat_block_contacts: '1',
  question_max_per_order: '5',
  appointment_cancel_hours: '24',
  jitsi_domain: 'meet.jit.si',
  ga4_id: '',
  gtm_id: '',
  meta_pixel_id: '',
  clarity_id: '',
};

const NUMERIC = new Set(Object.keys(DEFAULTS).filter((k) => /_(cents|seconds|percent|minutes|repeats|hours|order)$|_enabled$|^reviews_|^comments_|^readers_can|^chat_block/.test(k)));

function createSettings(db) {
  const getStmt = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  let cache = null;

  function all() {
    if (!cache) {
      cache = { ...DEFAULTS };
      for (const row of getStmt.all()) cache[row.key] = row.value;
    }
    return cache;
  }

  function get(key) {
    const value = all()[key];
    return NUMERIC.has(key) ? Number(value || 0) : value;
  }

  function set(values) {
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) if (k in DEFAULTS) upsert.run(k, v == null ? '' : String(v));
    });
    tx(Object.entries(values));
    cache = null;
  }

  return { all, get, set, DEFAULTS, isNumeric: (k) => NUMERIC.has(k) };
}

module.exports = { createSettings, DEFAULTS };
