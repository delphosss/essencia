// Consultas reutilizadas entre rotas públicas, painel e admin.
const STATUS_ORDER = "CASE r.status WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END";

function readerList(db, { categoryId, limit = 200, includeInactive = false } = {}) {
  const where = [includeInactive ? '1 = 1' : 'r.active = 1'];
  const params = [];
  if (categoryId) {
    where.push('r.id IN (SELECT reader_id FROM reader_categories WHERE category_id = ?)');
    params.push(categoryId);
  }
  params.push(limit);
  return db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM reviews v WHERE v.reader_id = r.id AND v.status = 'approved') AS review_count,
      (SELECT ROUND(AVG(rating), 1) FROM reviews v WHERE v.reader_id = r.id AND v.status = 'approved') AS rating_avg
    FROM readers r WHERE ${where.join(' AND ')}
    ORDER BY ${STATUS_ORDER}, r.featured DESC, r.sort_order, r.display_name LIMIT ?`).all(...params);
}

// Top 3: destaque manual primeiro, depois quem mais atendeu nos últimos 30 dias.
function topReaders(db, n = 3) {
  return db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM reviews v WHERE v.reader_id = r.id AND v.status = 'approved') AS review_count,
      (SELECT COUNT(*) FROM consultations c WHERE c.reader_id = r.id AND c.status = 'ended'
        AND c.ended_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')) AS recent
    FROM readers r WHERE r.active = 1 ORDER BY r.featured DESC, recent DESC, review_count DESC, r.sort_order LIMIT ?`).all(n);
}

function readerCategories(db, readerId) {
  return db.prepare(`SELECT c.* FROM categories c JOIN reader_categories rc ON rc.category_id = c.id
    WHERE rc.reader_id = ? ORDER BY c.sort_order`).all(readerId);
}

function categories(db) {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
}

function packages(db) {
  return db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order, price_cents').all();
}

function recentReviews(db, limit = 12) {
  return db.prepare(`SELECT v.*, r.display_name AS reader_name, r.slug AS reader_slug, r.photo AS reader_photo
    FROM reviews v JOIN readers r ON r.id = v.reader_id WHERE v.status = 'approved' ORDER BY v.id DESC LIMIT ?`).all(limit);
}

function recentPosts(db, limit = 3) {
  return db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM blog_posts p
    LEFT JOIN blog_categories c ON c.id = p.category_id WHERE p.published = 1 ORDER BY p.published_at DESC LIMIT ?`).all(limit);
}

module.exports = { readerList, topReaders, readerCategories, categories, packages, recentReviews, recentPosts };
