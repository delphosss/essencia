-- Valores monetários sempre em centavos (INTEGER). Datas em ISO-8601 UTC (TEXT).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  role            TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','reader','admin')),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT,
  birth_date      TEXT,
  cpf             TEXT,
  cep             TEXT,
  country_code    TEXT DEFAULT 'BR',
  area_code       TEXT,
  phone           TEXT,
  notify_opt_in   INTEGER NOT NULL DEFAULT 1,
  referral_source TEXT,
  balance_cents   INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  google_id       TEXT UNIQUE,
  blocked         INTEGER NOT NULL DEFAULT 0,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS readers (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug                 TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  photo                TEXT,
  oracles              TEXT,             -- "Tarot de Marselha, Baralho Cigano..."
  bio                  TEXT,
  price_chat_cents     INTEGER NOT NULL DEFAULT 199,
  price_video_cents    INTEGER NOT NULL DEFAULT 590,
  price_question_cents INTEGER NOT NULL DEFAULT 500,
  chat_enabled         INTEGER NOT NULL DEFAULT 1,
  video_enabled        INTEGER NOT NULL DEFAULT 0,
  questions_enabled    INTEGER NOT NULL DEFAULT 1,
  commission_percent   INTEGER NOT NULL DEFAULT 30, -- % do valor bruto que fica com o tarólogo (o resto é do site)
  whatsapp             TEXT,
  pix_key              TEXT,
  status               TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','busy','offline')),
  status_changed_at    TEXT,
  featured             INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reader_categories (
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (reader_id, category_id)
);

CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  bonus_cents INTEGER NOT NULL DEFAULT 0,
  badge       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coupons (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind          TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','fixed','bonus')),
  value         INTEGER NOT NULL,          -- percent: 0-100; fixed/bonus: centavos
  min_cents     INTEGER NOT NULL DEFAULT 0,
  max_uses      INTEGER,                   -- NULL = ilimitado
  uses          INTEGER NOT NULL DEFAULT 0,
  per_user_once INTEGER NOT NULL DEFAULT 1,
  first_purchase_only INTEGER NOT NULL DEFAULT 0,
  starts_at     TEXT,
  ends_at       TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL DEFAULT 'credits' CHECK (kind IN ('credits','store')),
  package_id      INTEGER REFERENCES packages(id),
  subtotal_cents  INTEGER NOT NULL,
  discount_cents  INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL,
  bonus_cents     INTEGER NOT NULL DEFAULT 0,  -- bônus do pacote + 1ª compra + cupom bônus
  credit_cents    INTEGER NOT NULL DEFAULT 0,  -- valor creditado na carteira ao pagar
  coupon_id       INTEGER REFERENCES coupons(id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded','failed')),
  method          TEXT,                        -- pix | card | paypal | manual | sandbox
  gateway_ref     TEXT,
  pix_qr          TEXT,
  pix_qr_base64   TEXT,
  checkout_url    TEXT,
  shipping_json   TEXT,
  notes           TEXT,
  paid_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id        INTEGER PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  type                TEXT NOT NULL,  -- purchase | bonus | consultation | question | refund | adjustment | store
  amount_cents        INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  description         TEXT,
  ref_type            TEXT,
  ref_id              INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id);

CREATE TABLE IF NOT EXISTS consultations (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,
  client_id             INTEGER NOT NULL REFERENCES users(id),
  reader_id             INTEGER NOT NULL REFERENCES readers(id),
  type                  TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat','video')),
  price_per_min_cents   INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'calling'
                        CHECK (status IN ('calling','active','ended','rejected','cancelled','missed')),
  reject_reason         TEXT,
  end_reason            TEXT,
  ended_by              TEXT,
  called_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  accepted_at           TEXT,
  ended_at              TEXT,
  billable_seconds      INTEGER NOT NULL DEFAULT 0,
  minutes_charged       INTEGER NOT NULL DEFAULT 0,
  charged_cents         INTEGER NOT NULL DEFAULT 0,
  balance_start_cents   INTEGER,
  balance_end_cents     INTEGER,
  paused                INTEGER NOT NULL DEFAULT 0,
  video_room            TEXT,
  appointment_id        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consult_client ON consultations(client_id);
CREATE INDEX IF NOT EXISTS idx_consult_reader ON consultations(reader_id);
CREATE INDEX IF NOT EXISTS idx_consult_status ON consultations(status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  sender_role     TEXT NOT NULL CHECK (sender_role IN ('client','reader','system')),
  sender_id       INTEGER,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_consult ON chat_messages(consultation_id);

CREATE TABLE IF NOT EXISTS call_events (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER REFERENCES consultations(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  data            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY,
  consultation_id INTEGER UNIQUE REFERENCES consultations(id),
  client_id       INTEGER NOT NULL REFERENCES users(id),
  reader_id       INTEGER NOT NULL REFERENCES readers(id),
  rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_reader ON reviews(reader_id, status);

CREATE TABLE IF NOT EXISTS questions (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES users(id),
  reader_id        INTEGER NOT NULL REFERENCES readers(id),
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  price_each_cents INTEGER NOT NULL,
  total_cents      INTEGER NOT NULL,
  people_json      TEXT,   -- [{name, birth_date}]
  questions_json   TEXT NOT NULL, -- ["pergunta 1", ...]
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','refunded')),
  answer           TEXT,
  answered_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS availability_slots (
  id         INTEGER PRIMARY KEY,
  reader_id  INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY,
  slot_id       INTEGER REFERENCES availability_slots(id) ON DELETE SET NULL,
  client_id     INTEGER NOT NULL REFERENCES users(id),
  reader_id     INTEGER NOT NULL REFERENCES readers(id),
  scheduled_at  TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'chat',
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','cancelled','done')),
  cancel_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS availability_alerts (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES users(id),
  reader_id   INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  notified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- Mensagens internas (caixa de entrada). recipient_id NULL + to_support = 1 → caixa do suporte (admins).
CREATE TABLE IF NOT EXISTS inbox_messages (
  id                INTEGER PRIMARY KEY,
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  recipient_id      INTEGER REFERENCES users(id),
  to_support        INTEGER NOT NULL DEFAULT 0,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  read_at           TEXT,
  sender_deleted    INTEGER NOT NULL DEFAULT 0,
  recipient_deleted INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY,
  reader_id    INTEGER NOT NULL REFERENCES readers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  pix_key      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  admin_note   TEXT,
  processed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reader_earnings (
  id                 INTEGER PRIMARY KEY,
  reader_id          INTEGER NOT NULL REFERENCES readers(id),
  source_type        TEXT NOT NULL,   -- consultation | question | adjustment | withdrawal
  source_id          INTEGER,
  gross_cents        INTEGER NOT NULL,
  commission_percent INTEGER NOT NULL,
  net_cents          INTEGER NOT NULL, -- negativo para saques
  description        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_earn_reader ON reader_earnings(reader_id);

CREATE TABLE IF NOT EXISTS product_categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY,
  category_id      INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  sku              TEXT,
  price_cents      INTEGER NOT NULL,
  compare_at_cents INTEGER,          -- preço "de" quando em oferta
  summary          TEXT,
  description      TEXT,
  image            TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blog_categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER REFERENCES blog_categories(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  cover        TEXT,
  excerpt      TEXT,
  body         TEXT,
  published    INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS blog_comments (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS banners (
  id         INTEGER PRIMARY KEY,
  title      TEXT,
  subtitle   TEXT,
  image      TEXT,
  link       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS faqs (
  id         INTEGER PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  birth_date       TEXT,
  location         TEXT,
  phone            TEXT,
  social           TEXT,
  professional_name TEXT,
  experience       TEXT,
  schedule         TEXT,
  oracles          TEXT,
  profile          TEXT,
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','approved','rejected')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS error_logs (
  id         INTEGER PRIMARY KEY,
  source     TEXT,
  message    TEXT,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Redirecionamentos 301 personalizados (migração de URLs antigas).
CREATE TABLE IF NOT EXISTS redirects (
  id        INTEGER PRIMARY KEY,
  from_path TEXT NOT NULL UNIQUE,
  to_path   TEXT NOT NULL,
  hits      INTEGER NOT NULL DEFAULT 0
);
