const express = require('express');
const bcrypt = require('bcryptjs');
const { action, requireAuth, flash, uploader } = require('../../lib/middleware');
const { HttpError, toInt, parseMoney, uniqueSlug } = require('../../lib/util');
const q = require('../../lib/queries');
const { crudRouter } = require('./crud');

module.exports = function adminRoutes(ctx) {
  const { db, settings } = ctx;
  const router = express.Router();
  const upload = uploader(ctx.config.uploadDir);
  router.use(requireAuth('admin'));
  router.use((req, res, next) => {
    res.locals.pendingCounts = {
      reviews: db.prepare("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'").get().n,
      withdrawals: db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE status = 'requested'").get().n,
      applications: db.prepare("SELECT COUNT(*) n FROM applications WHERE status = 'new'").get().n,
      contacts: db.prepare('SELECT COUNT(*) n FROM contacts WHERE handled = 0').get().n,
      comments: db.prepare("SELECT COUNT(*) n FROM blog_comments WHERE status = 'pending'").get().n,
      messages: ctx.inbox.unread(req.user),
    };
    next();
  });

  // ---- Dashboard ---------------------------------------------------------------
  router.get('/', (req, res) => {
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const since = (days) => new Date(Date.now() - days * 86400000).toISOString();
    const today = new Date(new Date().setUTCHours(3, 0, 0, 0)).toISOString();
    const kpi = {
      salesToday: one("SELECT COALESCE(SUM(total_cents),0) s FROM orders WHERE status = 'paid' AND paid_at >= ?", today).s,
      salesMonth: one("SELECT COALESCE(SUM(total_cents),0) s FROM orders WHERE status = 'paid' AND paid_at >= strftime('%Y-%m-01T00:00:00Z','now')").s,
      creditsSold30: one("SELECT COALESCE(SUM(credit_cents),0) s FROM orders WHERE status = 'paid' AND kind = 'credits' AND paid_at >= ?", since(30)).s,
      consumed30: one("SELECT COALESCE(SUM(-amount_cents),0) s FROM wallet_transactions WHERE type IN ('consultation','question') AND created_at >= ?", since(30)).s,
      consultations30: one("SELECT COUNT(*) n, COALESCE(SUM(minutes_charged),0) m FROM consultations WHERE status = 'ended' AND ended_at >= ?", since(30)),
      missed30: one("SELECT COUNT(*) n FROM consultations WHERE status = 'missed' AND called_at >= ?", since(30)).n,
      newClients30: one("SELECT COUNT(*) n FROM users WHERE role = 'client' AND created_at >= ?", since(30)).n,
      walletTotal: one("SELECT COALESCE(SUM(balance_cents),0) s FROM users WHERE role = 'client'").s,
      payable: one('SELECT COALESCE(SUM(net_cents),0) s FROM reader_earnings').s,
      readersOnline: one("SELECT COUNT(*) n FROM readers WHERE status != 'offline' AND active = 1").n,
      pendingOrders: one("SELECT COUNT(*) n FROM orders WHERE status = 'pending' AND created_at >= ?", since(2)).n,
    };
    const daily = db.prepare(`SELECT substr(paid_at, 1, 10) day, SUM(total_cents) total FROM orders
      WHERE status = 'paid' AND paid_at >= ? GROUP BY day ORDER BY day`).all(since(30));
    const days = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, total: (daily.find((x) => x.day === d) || {}).total || 0 });
    }
    res.render('admin/dashboard', {
      title: 'Dashboard',
      kpi,
      days,
      live: ctx.consultations.liveSessions().map((s) => ({
        ...s,
        reader: db.prepare('SELECT display_name FROM readers WHERE id = ?').get(s.readerId).display_name,
        client: db.prepare('SELECT name FROM users WHERE id = ?').get(s.clientId).name,
      })),
      readers: db.prepare("SELECT id, display_name, status, slug FROM readers WHERE active = 1 ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, display_name").all(),
      lastOrders: db.prepare(`SELECT o.*, u.name AS user_name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8`).all(),
    });
  });

  // ---- Tarólogos ---------------------------------------------------------------
  router.get('/tarologos', (req, res) => {
    res.render('admin/readers', {
      title: 'Tarólogos',
      readers: q.readerList(db, { includeInactive: true }).map((r) => ({
        ...r,
        email: db.prepare('SELECT email FROM users WHERE id = ?').get(r.user_id).email,
        earnings: ctx.earnings.summary(r.id),
      })),
    });
  });

  router.get('/tarologos/novo', (req, res) => res.render('admin/reader-form', {
    title: 'Novo tarólogo', r: {
      price_chat_cents: settings.get('default_price_chat_cents'), price_video_cents: settings.get('default_price_video_cents'),
      price_question_cents: settings.get('default_price_question_cents'), commission_percent: settings.get('default_commission_percent'),
      chat_enabled: 1, questions_enabled: 1, active: 1,
    }, u: {}, categories: q.categories(db), selected: [], isNew: true,
  }));

  router.get('/tarologos/:id(\\d+)', (req, res, next) => {
    const r = db.prepare('SELECT * FROM readers WHERE id = ?').get(toInt(req.params.id));
    if (!r) return next();
    return res.render('admin/reader-form', {
      title: r.display_name, r, u: db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id), categories: q.categories(db),
      selected: q.readerCategories(db, r.id).map((c) => c.id), isNew: false, earnings: ctx.earnings.summary(r.id),
    });
  });

  function saveReader(req, readerId) {
    const b = req.body;
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.display_name || '').trim();
    if (!name || !email) throw new HttpError(400, 'Nome artístico e e-mail são obrigatórios');
    return db.transaction(() => {
      let reader = readerId ? db.prepare('SELECT * FROM readers WHERE id = ?').get(readerId) : null;
      let userId = reader && reader.user_id;
      const dup = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (dup && dup.id !== userId) throw new HttpError(400, 'Já existe um usuário com este e-mail');
      if (!userId) {
        if (String(b.password || '').length < 6) throw new HttpError(400, 'Defina uma senha inicial (mín. 6 caracteres)');
        userId = db.prepare("INSERT INTO users (role, name, email, password_hash, phone) VALUES ('reader', ?, ?, ?, ?)")
          .run(String(b.legal_name || name), email, bcrypt.hashSync(b.password, 10), String(b.whatsapp || '')).lastInsertRowid;
      } else {
        db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(String(b.legal_name || name), email, userId);
        if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(b.password), 10), userId);
      }
      const fields = {
        display_name: name,
        slug: uniqueSlug(db, 'readers', b.slug || name, readerId || undefined),
        oracles: String(b.oracles || ''),
        bio: String(b.bio || ''),
        price_chat_cents: Math.max(1, parseMoney(b.price_chat)),
        price_video_cents: Math.max(1, parseMoney(b.price_video)),
        price_question_cents: Math.max(1, parseMoney(b.price_question)),
        chat_enabled: b.chat_enabled ? 1 : 0,
        video_enabled: b.video_enabled ? 1 : 0,
        questions_enabled: b.questions_enabled ? 1 : 0,
        commission_percent: Math.min(100, Math.max(0, toInt(b.commission_percent, 50))),
        whatsapp: String(b.whatsapp || '').replace(/[^\d+]/g, ''),
        pix_key: String(b.pix_key || ''),
        featured: b.featured ? 1 : 0,
        sort_order: toInt(b.sort_order),
        active: b.active ? 1 : 0,
      };
      if (req.file) fields.photo = `/uploads/${req.file.filename}`;
      const keys = Object.keys(fields);
      if (reader) {
        db.prepare(`UPDATE readers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), reader.id);
      } else {
        const id = db.prepare(`INSERT INTO readers (user_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`)
          .run(userId, ...keys.map((k) => fields[k])).lastInsertRowid;
        reader = { id };
      }
      db.prepare('DELETE FROM reader_categories WHERE reader_id = ?').run(reader.id);
      const ins = db.prepare('INSERT OR IGNORE INTO reader_categories (reader_id, category_id) VALUES (?, ?)');
      [].concat(b.categories || []).map(Number).filter(Boolean).forEach((c) => ins.run(reader.id, c));
      return reader.id;
    })();
  }

  router.post('/tarologos', upload.single('photo'), action(async (req, res) => {
    const id = saveReader(req, null);
    flash(req, 'success', 'Tarólogo cadastrado.');
    res.redirect(`/admin/tarologos/${id}`);
  }));

  router.post('/tarologos/:id(\\d+)', upload.single('photo'), action(async (req, res) => {
    const id = saveReader(req, toInt(req.params.id));
    const r = db.prepare('SELECT * FROM readers WHERE id = ?').get(id);
    if (!r.active && r.status !== 'offline' && !ctx.consultations.activeFor({ readerId: id })) ctx.consultations.setReaderStatus(id, 'offline');
    flash(req, 'success', 'Alterações salvas.');
    res.redirect(`/admin/tarologos/${id}`);
  }));

  router.post('/tarologos/:id(\\d+)/status', action(async (req, res) => {
    ctx.consultations.setReaderStatus(toInt(req.params.id), req.body.status === 'online' ? 'online' : 'offline');
    res.redirect(req.get('referer') || '/admin/tarologos');
  }));

  router.post('/tarologos/:id(\\d+)/ajuste', action(async (req, res) => {
    const cents = parseMoney(req.body.amount);
    if (!cents) throw new HttpError(400, 'Informe o valor');
    ctx.earnings.adjust(toInt(req.params.id), cents, String(req.body.description || 'Ajuste manual'));
    flash(req, 'success', 'Ajuste lançado.');
    res.redirect(`/admin/tarologos/${req.params.id}`);
  }));

  // ---- Clientes ----------------------------------------------------------------
  router.get('/clientes', (req, res) => {
    const s = String(req.query.busca || '').trim();
    const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM consultations c WHERE c.client_id = u.id AND c.status = 'ended') AS consults,
      (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS spent
      FROM users u WHERE u.role = 'client' ${s ? 'AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)' : ''}
      ORDER BY u.id DESC LIMIT 300`).all(...(s ? [`%${s}%`, `%${s}%`, `%${s}%`] : []));
    res.render('admin/clients', { title: 'Clientes', rows, search: s });
  });

  router.get('/clientes/:id(\\d+)', (req, res, next) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(toInt(req.params.id));
    if (!u) return next();
    return res.render('admin/client', {
      title: u.name, u,
      orders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id),
      consultations: db.prepare(`SELECT c.*, r.display_name AS reader_name FROM consultations c JOIN readers r ON r.id = c.reader_id
        WHERE c.client_id = ? ORDER BY c.id DESC LIMIT 50`).all(u.id),
      wallet: ctx.wallet.history(u.id, 100),
    });
  });

  router.post('/clientes/:id(\\d+)/saldo', action(async (req, res) => {
    const id = toInt(req.params.id);
    const cents = parseMoney(req.body.amount);
    const reason = String(req.body.reason || 'Ajuste manual').slice(0, 200);
    if (!cents) throw new HttpError(400, 'Informe o valor');
    if (cents > 0) ctx.wallet.credit(id, cents, 'adjustment', reason);
    else ctx.wallet.debit(id, -cents, 'adjustment', reason);
    if (cents > 0 && req.body.notify) ctx.notifications.notify(id, { title: 'Créditos adicionados', body: `${ctx.util.money(cents)} — ${reason}`, link: '/minha-conta' });
    flash(req, 'success', 'Saldo ajustado.');
    res.redirect(`/admin/clientes/${id}`);
  }));

  router.post('/clientes/:id(\\d+)/bloqueio', action(async (req, res) => {
    const id = toInt(req.params.id);
    db.prepare("UPDATE users SET blocked = ? WHERE id = ? AND role = 'client'").run(req.body.blocked === '1' ? 1 : 0, id);
    flash(req, 'success', req.body.blocked === '1' ? 'Cliente bloqueado.' : 'Cliente desbloqueado.');
    res.redirect(`/admin/clientes/${id}`);
  }));

  // ---- Consultas -------------------------------------------------------------
  router.get('/consultas', (req, res) => {
    const status = String(req.query.status || '');
    const rows = db.prepare(`SELECT c.*, r.display_name AS reader_name, u.name AS client_name FROM consultations c
      JOIN readers r ON r.id = c.reader_id JOIN users u ON u.id = c.client_id
      ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.id DESC LIMIT 300`).all(...(status ? [status] : []));
    res.render('admin/consultations', { title: 'Consultas', rows, status });
  });

  router.get('/consultas/:code', (req, res, next) => {
    const c = db.prepare(`SELECT c.*, r.display_name AS reader_name, u.name AS client_name FROM consultations c
      JOIN readers r ON r.id = c.reader_id JOIN users u ON u.id = c.client_id WHERE c.code = ?`).get(req.params.code);
    if (!c) return next();
    return res.render('admin/consultation', {
      title: `Consulta ${c.code}`, c, messages: ctx.consultations.messages(c.id),
      events: db.prepare('SELECT * FROM call_events WHERE consultation_id = ? ORDER BY id').all(c.id),
    });
  });

  router.post('/consultas/:code/reembolso', action(async (req, res) => {
    const c = db.prepare('SELECT * FROM consultations WHERE code = ?').get(req.params.code);
    if (!c || c.status !== 'ended') throw new HttpError(400, 'Só consultas encerradas podem ser reembolsadas');
    const cents = Math.min(parseMoney(req.body.amount) || c.charged_cents, c.charged_cents);
    const already = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM wallet_transactions WHERE type = 'refund' AND ref_type = 'consultation' AND ref_id = ?").get(c.id).s;
    if (already + cents > c.charged_cents) throw new HttpError(400, 'Valor maior que o cobrado nesta consulta');
    ctx.wallet.credit(c.client_id, cents, 'refund', `Reembolso da consulta ${c.code}`, { type: 'consultation', id: c.id });
    if (req.body.debit_reader) {
      const reader = db.prepare('SELECT commission_percent FROM readers WHERE id = ?').get(c.reader_id);
      ctx.earnings.adjust(c.reader_id, -Math.round((cents * reader.commission_percent) / 100), `Estorno da consulta ${c.code}`);
    }
    ctx.notifications.notify(c.client_id, { title: 'Créditos devolvidos', body: `${ctx.util.money(cents)} da consulta ${c.code}`, link: '/minha-conta' });
    flash(req, 'success', 'Créditos devolvidos ao cliente.');
    res.redirect(`/admin/consultas/${c.code}`);
  }));

  // ---- Pedidos -------------------------------------------------------------------
  router.get('/pedidos', (req, res) => {
    const status = String(req.query.status || '');
    const kind = String(req.query.tipo || '');
    const where = [];
    const p = [];
    if (status) { where.push('o.status = ?'); p.push(status); }
    if (kind) { where.push('o.kind = ?'); p.push(kind); }
    const rows = db.prepare(`SELECT o.*, u.name AS user_name, u.email AS user_email, pk.name AS package_name FROM orders o
      JOIN users u ON u.id = o.user_id LEFT JOIN packages pk ON pk.id = o.package_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`).all(...p);
    res.render('admin/orders', { title: 'Pedidos e pagamentos', rows, status, kind });
  });

  router.get('/pedidos/:id(\\d+)', (req, res, next) => {
    const order = ctx.payments.getOrder(toInt(req.params.id));
    if (!order) return next();
    return res.render('admin/order', { title: `Pedido #${order.id}`, order, items: ctx.payments.orderItems(order.id) });
  });

  router.post('/pedidos/:id(\\d+)/:acao', action(async (req, res) => {
    const id = toInt(req.params.id);
    if (req.params.acao === 'aprovar') ctx.payments.markPaid(id, { method: 'manual', gatewayRef: String(req.body.ref || 'manual') });
    else if (req.params.acao === 'cancelar') ctx.payments.cancel(id);
    else if (req.params.acao === 'estornar') ctx.payments.refund(id);
    else if (req.params.acao === 'nota') ctx.db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(String(req.body.notes || ''), id);
    else throw new HttpError(400, 'Ação inválida');
    flash(req, 'success', 'Pedido atualizado.');
    res.redirect(`/admin/pedidos/${id}`);
  }));

  // ---- Saques --------------------------------------------------------------------
  router.get('/saques', (req, res) => {
    res.render('admin/withdrawals', {
      title: 'Saques',
      rows: db.prepare(`SELECT w.*, r.display_name FROM withdrawals w JOIN readers r ON r.id = w.reader_id
        ORDER BY w.status = 'requested' DESC, w.id DESC LIMIT 300`).all(),
    });
  });

  router.post('/saques/:id(\\d+)', action(async (req, res) => {
    ctx.earnings.process(toInt(req.params.id), req.body.status === 'paid' ? 'paid' : 'rejected', String(req.body.note || ''));
    flash(req, 'success', 'Saque atualizado.');
    res.redirect('/admin/saques');
  }));

  // ---- Moderação ---------------------------------------------------------------
  router.get('/depoimentos', (req, res) => {
    const status = ['pending', 'approved', 'hidden'].includes(req.query.status) ? req.query.status : 'pending';
    res.render('admin/reviews', {
      title: 'Depoimentos', status,
      rows: db.prepare(`SELECT v.*, r.display_name AS reader_name, u.name AS client_name FROM reviews v
        JOIN readers r ON r.id = v.reader_id JOIN users u ON u.id = v.client_id WHERE v.status = ? ORDER BY v.id DESC LIMIT 300`).all(status),
    });
  });

  router.post('/depoimentos/:id(\\d+)', action(async (req, res) => {
    if (req.body.status === 'delete') db.prepare('DELETE FROM reviews WHERE id = ?').run(toInt(req.params.id));
    else ctx.reviews.moderate(toInt(req.params.id), req.body.status === 'approved' ? 'approved' : 'hidden');
    res.redirect(req.get('referer') || '/admin/depoimentos');
  }));

  router.get('/comentarios', (req, res) => {
    res.render('admin/comments', {
      title: 'Comentários do blog',
      rows: db.prepare(`SELECT c.*, p.title AS post_title, p.slug AS post_slug FROM blog_comments c JOIN blog_posts p ON p.id = c.post_id
        ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 300`).all(),
    });
  });

  router.post('/comentarios/:id(\\d+)', action(async (req, res) => {
    if (req.body.status === 'delete') db.prepare('DELETE FROM blog_comments WHERE id = ?').run(toInt(req.params.id));
    else db.prepare('UPDATE blog_comments SET status = ? WHERE id = ?').run(req.body.status === 'approved' ? 'approved' : 'hidden', toInt(req.params.id));
    res.redirect('/admin/comentarios');
  }));

  router.get('/perguntas', (req, res) => {
    res.render('admin/questions', {
      title: 'Perguntas pagas',
      rows: db.prepare(`SELECT q.*, r.display_name AS reader_name, u.name AS client_name FROM questions q
        JOIN readers r ON r.id = q.reader_id JOIN users u ON u.id = q.client_id ORDER BY q.id DESC LIMIT 300`).all(),
    });
  });

  router.get('/perguntas/:id(\\d+)', (req, res, next) => {
    const question = ctx.questions.get(toInt(req.params.id));
    if (!question) return next();
    return res.render('shared/question', { title: 'Pergunta', q: question, back: '/admin/perguntas', canRefund: question.status === 'pending' });
  });

  router.post('/perguntas/:id(\\d+)/reembolsar', action(async (req, res) => {
    ctx.questions.refund(toInt(req.params.id));
    flash(req, 'success', 'Valor devolvido ao cliente.');
    res.redirect('/admin/perguntas');
  }));

  router.get('/agendamentos', (req, res) => {
    res.render('admin/appointments', {
      title: 'Agendamentos',
      rows: db.prepare(`SELECT a.*, r.display_name AS reader_name, u.name AS client_name FROM appointments a
        JOIN readers r ON r.id = a.reader_id JOIN users u ON u.id = a.client_id ORDER BY a.scheduled_at DESC LIMIT 300`).all(),
    });
  });

  router.post('/agendamentos/:id(\\d+)/cancelar', action(async (req, res) => {
    ctx.appointments.setStatus(toInt(req.params.id), req.user, 'cancelled', String(req.body.reason || 'Cancelado pela administração'));
    res.redirect('/admin/agendamentos');
  }));

  router.get('/candidaturas', (req, res) => {
    res.render('admin/applications', { title: 'Candidaturas', rows: db.prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 300').all() });
  });

  router.post('/candidaturas/:id(\\d+)', action(async (req, res) => {
    const status = ['new', 'reviewing', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : 'reviewing';
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, toInt(req.params.id));
    res.redirect('/admin/candidaturas');
  }));

  router.get('/contatos', (req, res) => {
    res.render('admin/contacts', { title: 'Fale conosco', rows: db.prepare('SELECT * FROM contacts ORDER BY handled, id DESC LIMIT 300').all() });
  });

  router.post('/contatos/:id(\\d+)', action(async (req, res) => {
    db.prepare('UPDATE contacts SET handled = ? WHERE id = ?').run(req.body.handled === '1' ? 1 : 0, toInt(req.params.id));
    res.redirect('/admin/contatos');
  }));

  // ---- Notificações em massa --------------------------------------------------
  router.get('/notificacoes', (req, res) => res.render('admin/broadcast', { title: 'Enviar notificação' }));

  router.post('/notificacoes', action(async (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) throw new HttpError(400, 'Informe o título');
    const n = ctx.notifications.broadcast(req.body.target, { title, body: String(req.body.body || ''), link: String(req.body.link || '') });
    flash(req, 'success', `Notificação enviada para ${n} usuário(s).`);
    res.redirect('/admin/notificacoes');
  }));

  // ---- Páginas institucionais ----------------------------------------------------
  router.get('/paginas', (req, res) => res.render('admin/pages', { title: 'Páginas', pages: db.prepare('SELECT * FROM pages ORDER BY title').all() }));

  router.get('/paginas/:slug', (req, res, next) => {
    const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
    if (!page) return next();
    return res.render('admin/page-form', { title: page.title, page });
  });

  router.post('/paginas/:slug', action(async (req, res) => {
    db.prepare("UPDATE pages SET title = ?, body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = ?")
      .run(String(req.body.title || ''), String(req.body.body || ''), req.params.slug);
    flash(req, 'success', 'Página salva.');
    res.redirect('/admin/paginas');
  }));

  // ---- Configurações -------------------------------------------------------------
  router.get('/configuracoes', (req, res) => res.render('admin/settings', { title: 'Configurações', values: settings.all(), env: ctx.config }));

  router.post('/configuracoes', action(async (req, res) => {
    const values = {};
    for (const key of Object.keys(settings.DEFAULTS)) {
      if (!(key in req.body) && !/_enabled$|^reviews_|^comments_|^readers_can|^chat_block/.test(key)) continue;
      let v = req.body[key];
      if (/_cents$/.test(key)) v = parseMoney(v);
      else if (/_enabled$|^reviews_|^comments_|^readers_can|^chat_block/.test(key)) v = v ? '1' : '0';
      else if (settings.isNumeric(key)) v = toInt(v);
      values[key] = v;
    }
    settings.set(values);
    flash(req, 'success', 'Configurações salvas.');
    res.redirect('/admin/configuracoes');
  }));

  router.get('/logs', (req, res) => res.render('admin/logs', {
    title: 'Logs',
    errors: db.prepare('SELECT * FROM error_logs ORDER BY id DESC LIMIT 200').all(),
    events: db.prepare(`SELECT e.*, c.code FROM call_events e LEFT JOIN consultations c ON c.id = e.consultation_id ORDER BY e.id DESC LIMIT 200`).all(),
    outbox: ctx.messaging.outbox.slice().reverse(),
  }));

  router.use(crudRouter(ctx, upload));
  return router;
};
