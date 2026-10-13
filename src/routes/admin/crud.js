const express = require('express');
const { action, flash } = require('../../lib/middleware');
const { HttpError, toInt, parseMoney, uniqueSlug, money, fmtDateTime } = require('../../lib/util');

// CRUD genérico para tabelas simples do admin. Cada recurso declara colunas da lista e campos do formulário.
// Somente os nomes declarados aqui chegam ao SQL.
function resources(db) {
  const opt = (sql) => () => db.prepare(sql).all().map((r) => [r.id, r.name]);
  return {
    pacotes: {
      table: 'packages', title: 'Pacotes de créditos', singular: 'pacote', order: 'sort_order, price_cents',
      columns: [['name', 'Nome'], ['price_cents', 'Preço', money], ['bonus_cents', 'Bônus', money], ['badge', 'Selo'], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'name', label: 'Nome', required: true },
        { name: 'price_cents', label: 'Preço (R$)', type: 'money', required: true },
        { name: 'bonus_cents', label: 'Bônus em créditos (R$)', type: 'money', help: 'Somado ao bônus de primeira compra, quando houver.' },
        { name: 'badge', label: 'Selo', help: 'Ex.: "Mais escolhido"' },
        { name: 'sort_order', label: 'Ordem', type: 'number' },
        { name: 'active', label: 'Ativo', type: 'checkbox', default: 1 },
      ],
    },
    cupons: {
      table: 'coupons', title: 'Cupons', singular: 'cupom', order: 'id DESC',
      columns: [['code', 'Código'], ['kind', 'Tipo', (k) => ({ percent: '% desconto', fixed: 'R$ desconto', bonus: 'Bônus em créditos' }[k])],
        ['value', 'Valor'], ['uses', 'Usos'], ['max_uses', 'Limite'], ['ends_at', 'Validade', fmtDateTime], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'code', label: 'Código', required: true, transform: (v) => String(v).trim().toUpperCase() },
        { name: 'kind', label: 'Tipo', type: 'select', options: () => [['percent', 'Percentual de desconto'], ['fixed', 'Desconto em R$'], ['bonus', 'Bônus em créditos (R$)']] },
        { name: 'value', label: 'Valor', type: 'number', required: true, help: 'Percentual: 0 a 100. Desconto/bônus: valor em centavos (ex.: 500 = R$ 5,00).' },
        { name: 'min_cents', label: 'Compra mínima (R$)', type: 'money' },
        { name: 'max_uses', label: 'Limite total de usos', type: 'number', nullable: true },
        { name: 'per_user_once', label: 'Uma vez por cliente', type: 'checkbox', default: 1 },
        { name: 'first_purchase_only', label: 'Só na primeira compra', type: 'checkbox' },
        { name: 'starts_at', label: 'Início', type: 'datetime' },
        { name: 'ends_at', label: 'Fim', type: 'datetime' },
        { name: 'active', label: 'Ativo', type: 'checkbox', default: 1 },
      ],
    },
    categorias: {
      table: 'categories', title: 'Categorias de tarólogos', singular: 'categoria', order: 'sort_order, name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['slug', 'Slug'], ['sort_order', 'Ordem']],
      fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'sort_order', label: 'Ordem', type: 'number' }],
    },
    banners: {
      table: 'banners', title: 'Banners da home', singular: 'banner', order: 'sort_order',
      columns: [['title', 'Título'], ['link', 'Link'], ['sort_order', 'Ordem'], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'title', label: 'Título' }, { name: 'subtitle', label: 'Subtítulo', type: 'textarea' },
        { name: 'image', label: 'Imagem (1600×600 recomendado)', type: 'image' }, { name: 'link', label: 'Link do botão' },
        { name: 'sort_order', label: 'Ordem', type: 'number' }, { name: 'active', label: 'Ativo', type: 'checkbox', default: 1 },
      ],
    },
    faq: {
      table: 'faqs', title: 'Perguntas frequentes', singular: 'pergunta', order: 'sort_order',
      columns: [['question', 'Pergunta'], ['sort_order', 'Ordem'], ['active', 'Ativa', yesNo]],
      fields: [
        { name: 'question', label: 'Pergunta', required: true }, { name: 'answer', label: 'Resposta', type: 'textarea', required: true },
        { name: 'sort_order', label: 'Ordem', type: 'number' }, { name: 'active', label: 'Ativa', type: 'checkbox', default: 1 },
      ],
    },
    'blog-categorias': {
      table: 'blog_categories', title: 'Categorias do blog', singular: 'categoria', order: 'name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['slug', 'Slug']],
      fields: [{ name: 'name', label: 'Nome', required: true }],
    },
    posts: {
      table: 'blog_posts', title: 'Posts do blog', singular: 'post', order: 'published_at DESC', slugFrom: 'title',
      columns: [['title', 'Título'], ['published_at', 'Publicado em', fmtDateTime], ['published', 'Publicado', yesNo]],
      fields: [
        { name: 'title', label: 'Título', required: true },
        { name: 'category_id', label: 'Categoria', type: 'select', options: opt('SELECT id, name FROM blog_categories ORDER BY name'), nullable: true },
        { name: 'cover', label: 'Imagem de capa', type: 'image' },
        { name: 'excerpt', label: 'Resumo', type: 'textarea' },
        { name: 'body', label: 'Conteúdo (HTML)', type: 'html' },
        { name: 'published_at', label: 'Data de publicação', type: 'datetime' },
        { name: 'published', label: 'Publicado', type: 'checkbox', default: 1 },
      ],
    },
    'loja-categorias': {
      table: 'product_categories', title: 'Categorias da loja', singular: 'categoria', order: 'name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['slug', 'Slug']],
      fields: [{ name: 'name', label: 'Nome', required: true }],
    },
    produtos: {
      table: 'products', title: 'Produtos da loja', singular: 'produto', order: 'sort_order, name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['sku', 'Código'], ['price_cents', 'Preço', money], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'name', label: 'Nome', required: true }, { name: 'sku', label: 'Código' },
        { name: 'category_id', label: 'Categoria', type: 'select', options: opt('SELECT id, name FROM product_categories ORDER BY name'), nullable: true },
        { name: 'price_cents', label: 'Preço (R$)', type: 'money', required: true },
        { name: 'compare_at_cents', label: 'Preço "de" (oferta)', type: 'money', nullable: true },
        { name: 'image', label: 'Imagem', type: 'image' },
        { name: 'summary', label: 'Resumo', type: 'textarea' }, { name: 'description', label: 'Descrição (HTML)', type: 'html' },
        { name: 'sort_order', label: 'Ordem', type: 'number' }, { name: 'active', label: 'Ativo', type: 'checkbox', default: 1 },
      ],
    },
  };
}

function yesNo(v) {
  return v ? 'Sim' : 'Não';
}

const brt = (v) => (v ? new Date(`${v}:00-03:00`).toISOString() : null);

function parseField(f, body, file) {
  const raw = body[f.name];
  switch (f.type) {
    case 'money': return raw === '' && f.nullable ? null : parseMoney(raw);
    case 'number': return raw === '' || raw == null ? (f.nullable ? null : 0) : toInt(raw);
    case 'checkbox': return raw ? 1 : 0;
    case 'datetime': return brt(raw);
    case 'select': return raw === '' || raw == null ? null : raw;
    case 'image': return file ? `/uploads/${file.filename}` : undefined;
    default: {
      const v = raw == null ? '' : String(raw);
      return f.transform ? f.transform(v) : v;
    }
  }
}

function crudRouter(ctx, upload) {
  const { db } = ctx;
  const all = resources(db);
  const router = express.Router();

  router.param('res', (req, res, next, key) => {
    req.resource = all[key];
    if (!req.resource) return next('route');
    req.resource.key = key;
    return next();
  });

  router.get('/:res', (req, res) => {
    const r = req.resource;
    res.render('admin/crud-list', { title: r.title, r, rows: db.prepare(`SELECT * FROM ${r.table} ORDER BY ${r.order} LIMIT 500`).all() });
  });

  router.get('/:res/novo', (req, res) => {
    const row = Object.fromEntries(req.resource.fields.map((f) => [f.name, f.default ?? '']));
    res.render('admin/crud-form', { title: `Novo ${req.resource.singular}`, r: req.resource, row, isNew: true });
  });

  router.get('/:res/:id(\\d+)', (req, res, next) => {
    const row = db.prepare(`SELECT * FROM ${req.resource.table} WHERE id = ?`).get(toInt(req.params.id));
    if (!row) return next();
    return res.render('admin/crud-form', { title: `Editar ${req.resource.singular}`, r: req.resource, row, isNew: false });
  });

  function save(req, id) {
    const r = req.resource;
    const values = {};
    for (const f of r.fields) {
      const v = parseField(f, req.body, req.file && req.file.fieldname === f.name ? req.file : null);
      if (v === undefined) continue;
      if (f.required && (v === '' || v == null)) throw new HttpError(400, `Preencha: ${f.label}`);
      values[f.name] = v;
    }
    if (r.slugFrom) values.slug = uniqueSlug(db, r.table, req.body.slug || values[r.slugFrom], id);
    if ('published_at' in values && !values.published_at) delete values.published_at;
    const keys = Object.keys(values);
    try {
      if (id) {
        db.prepare(`UPDATE ${r.table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => values[k]), id);
        return id;
      }
      return db.prepare(`INSERT INTO ${r.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => values[k])).lastInsertRowid;
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(400, 'Já existe um registro com esse valor (código/slug).');
      throw err;
    }
  }

  router.post('/:res', upload.any(), action(async (req, res) => {
    req.file = (req.files || [])[0];
    save(req, null);
    flash(req, 'success', 'Salvo.');
    res.redirect(`/admin/${req.resource.key}`);
  }));

  router.post('/:res/:id(\\d+)', upload.any(), action(async (req, res) => {
    req.file = (req.files || [])[0];
    save(req, toInt(req.params.id));
    flash(req, 'success', 'Alterações salvas.');
    res.redirect(`/admin/${req.resource.key}`);
  }));

  router.post('/:res/:id(\\d+)/excluir', action(async (req, res) => {
    try {
      db.prepare(`DELETE FROM ${req.resource.table} WHERE id = ?`).run(toInt(req.params.id));
      flash(req, 'success', 'Excluído.');
    } catch (err) {
      if (!/FOREIGN KEY/.test(err.message)) throw err;
      flash(req, 'error', 'Este registro está em uso. Desative-o em vez de excluir.');
    }
    res.redirect(`/admin/${req.resource.key}`);
  }));

  return router;
}

module.exports = { crudRouter, resources };
