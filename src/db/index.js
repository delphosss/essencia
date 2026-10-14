const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Colunas adicionadas depois da primeira versão. Cada uma é aplicada uma vez
// em bancos existentes (CREATE TABLE IF NOT EXISTS não altera tabelas antigas).
const COLUMNS = [
  ['readers', 'is_owner', 'INTEGER NOT NULL DEFAULT 0'],
  ['readers', 'meta_title', 'TEXT'],
  ['readers', 'meta_description', 'TEXT'],
  ['categories', 'description', 'TEXT'],
  ['blog_categories', 'description', 'TEXT'],
  ['blog_posts', 'author', 'TEXT'],
  ['blog_posts', 'meta_title', 'TEXT'],
  ['blog_posts', 'meta_description', 'TEXT'],
  ['blog_posts', 'updated_at', 'TEXT'],
  ['products', 'gallery', 'TEXT'],
  ['products', 'requires_details', 'INTEGER NOT NULL DEFAULT 1'],
  ['products', 'delivery_days', 'INTEGER'],
  ['products', 'meta_title', 'TEXT'],
  ['products', 'meta_description', 'TEXT'],
  ['product_categories', 'description', 'TEXT'],
  ['orders', 'details_json', 'TEXT'],
  ['orders', 'fulfillment_status', 'TEXT'],
  ['orders', 'fulfillment_note', 'TEXT'],
];

function migrate(db) {
  for (const [table, column, type] of COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

module.exports = { openDatabase, migrate };
