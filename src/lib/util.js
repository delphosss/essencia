const crypto = require('crypto');

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function money(cents) {
  return brl.format((Number(cents) || 0) / 100);
}

// "19,90" | "19.90" | "1.234,56" → 1990
function parseMoney(input) {
  if (input == null || input === '') return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  let s = String(input).replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',');
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function uniqueSlug(db, table, base, ignoreId) {
  let slug = slugify(base);
  let n = 1;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`);
  for (;;) {
    const row = stmt.get(slug);
    if (!row || row.id === ignoreId) return slug;
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
}

function randomCode(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function fmtDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '';
}
function fmtDateTime(iso) {
  return iso ? dateTimeFmt.format(new Date(iso)) : '';
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}min ${String(r).padStart(2, '0')}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Texto simples → HTML seguro com parágrafos.
function nl2p(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function ratingLabel(r) {
  return ['', 'Ruim', 'Regular', 'Bom', 'Muito bom', 'Excelente'][r] || '';
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  money, parseMoney, centsToInput, slugify, uniqueSlug, randomCode, nowIso, fmtDate, fmtDateTime, fmtDuration,
  escapeHtml, nl2p, truncate, hmac, safeEqual, toInt, ratingLabel, HttpError,
};
