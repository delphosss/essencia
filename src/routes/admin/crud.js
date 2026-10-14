const express = require('express');
const { action, flash } = require('../../lib/middleware');
const { HttpError, toInt, parseMoney, uniqueSlug, money, fmtDateTime } = require('../../lib/util');

// CRUD genérico para tabelas simples do admin. Cada recurso declara colunas da lista e campos do formulário.
// Somente os nomes declarados aqui chegam ao SQL.
function resources(db) {
  const opt = (sql) => () => db.prepare(sql).all().map((r) => [r.id, r.name]);
  return {
    redirecionamentos: {
      table: 'redirects', title: 'Redirecionamentos 301', singular: 'redirecionamento', order: 'from_path',
      columns: [['from_path', 'De (URL antiga)'], ['to_path', 'Para'], ['hits', 'Acessos']],
      fields: [
        { name: 'from_path', label: 'De (caminho antigo, ex.: /terapeuta/maria)', required: true, transform: (v) => `/${String(v).trim().replace(/^https?:\/\/[^/]+/, '').replace(/^\/+|\/+$/g, '')}` },
        { name: 'to_path', label: 'Para (ex.: /tarologo/maria)', required: true },
      ],
    },
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
      fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'description', label: 'Texto de apresentação da categoria (aparece na página e ajuda no Google)', type: 'textarea' }, { name: 'sort_order', label: 'Ordem', type: 'number' }],
    },
    banners: {
      table: 'banners', title: 'Banners da home', singular: 'banner', order: 'sort_order',
      columns: [['title', 'Título'], ['link', 'Link'], ['sort_order', 'Ordem'], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'title', label: 'Título' }, { name: 'subtitle', label: 'Subtítulo', type: 'textarea' },
        { name: 'image', label: 'Imagem (1920×640 recomendado)', type: 'image', maxWidth: 1920 }, { name: 'link', label: 'Link do botão' },
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
      fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'description', label: 'Texto de apresentação (SEO)', type: 'textarea' }],
    },
    posts: {
      table: 'blog_posts', title: 'Posts do blog', singular: 'post', order: 'published_at DESC', slugFrom: 'title',
      columns: [['title', 'Título'], ['published_at', 'Publicado em', fmtDateTime], ['published', 'Publicado', yesNo]],
      fields: [
        { name: 'title', label: 'Título', required: true },
        { name: 'category_id', label: 'Categoria', type: 'select', options: opt('SELECT id, name FROM blog_categories ORDER BY name'), nullable: true },
        { name: 'cover', label: 'Imagem de capa (1200×630 ideal para redes sociais)', type: 'image', maxWidth: 1400 },
        { name: 'author', label: 'Autor(a)' },
        { name: 'excerpt', label: 'Resumo (aparece na lista e no Google)', type: 'textarea' },
        { name: 'body', label: 'Conteúdo', type: 'html' },
        { name: 'meta_title', label: 'Título para o Google (opcional, até 60 caracteres)', help: 'Se vazio, usa o nome.' },
        { name: 'meta_description', label: 'Descrição para o Google (opcional, até 155 caracteres)', type: 'textarea' },
        { name: 'published_at', label: 'Data de publicação', type: 'datetime' },
        { name: 'published', label: 'Publicado', type: 'checkbox', default: 1 },
      ],
    },
    'loja-categorias': {
      table: 'product_categories', title: 'Categorias da loja', singular: 'categoria', order: 'name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['slug', 'Slug']],
      fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'description', label: 'Texto de apresentação (SEO)', type: 'textarea' }],
    },
    produtos: {
      table: 'products', title: 'Produtos da loja', singular: 'produto', order: 'sort_order, name', slugFrom: 'name',
      columns: [['name', 'Nome'], ['sku', 'Código'], ['price_cents', 'Preço', money], ['active', 'Ativo', yesNo]],
      fields: [
        { name: 'name', label: 'Nome', required: true }, { name: 'sku', label: 'Código' },
        { name: 'category_id', label: 'Categoria', type: 'select', options: opt('SELECT id, name FROM product_categories ORDER BY name'), nullable: true },
        { name: 'price_cents', label: 'Preço (R$)', type: 'money', required: true },
        { name: 'compare_at_cents', label: 'Preço "de" (oferta)', type: 'money', nullable: true },
        { name: 'image', label: 'Imagem principal', type: 'image', maxWidth: 1200 },
        { name: 'gallery', label: 'Galeria (várias imagens)', type: 'gallery', maxWidth: 1200 },
        { name: 'summary', label: 'Resumo', type: 'textarea' }, { name: 'description', label: 'Descrição', type: 'html' },
        { name: 'delivery_days', label: 'Prazo de realização (dias)', type: 'number', nullable: true },
        { name: 'requires_details', label: 'Pedir dados do trabalho no checkout (nomes, datas de nascimento, intenção)', type: 'checkbox', default: 1 },
        { name: 'meta_title', label: 'Título para o Google (opcional, até 60 caracteres)', help: 'Se vazio, usa o nome.' },
        { name: 'meta_description', label: 'Descrição para o Google (opcional, até 155 caracteres)', type: 'textarea' },
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
    case 'image': return file ? file.stored : undefined;
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

  async function save(req, id) {
    const r = req.resource;
    const values = {};
    const files = req.files || [];
    for (const f of r.fields.filter((x) => x.type === 'image')) {
      const file = files.find((x) => x.fieldname === f.name);
      if (file) file.stored = await ctx.images.store(file, { maxWidth: f.maxWidth || 1600 });
    }
    for (const f of r.fields.filter((x) => x.type === 'gallery')) {
      const current = id ? JSON.parse(db.prepare(`SELECT ${f.name} AS g FROM ${r.table} WHERE id = ?`).get(id).g || '[]') : [];
      const keep = current.filter((src) => [].concat(req.body[`${f.name}_keep`] || []).includes(src));
      const added = [];
      for (const file of files.filter((x) => x.fieldname === f.name)) added.push(await ctx.images.store(file, { maxWidth: f.maxWidth || 1600 }));
      req.body[f.name] = JSON.stringify([...keep, ...added]);
    }
    for (const f of r.fields) {
      if (f.type === 'gallery') { values[f.name] = req.body[f.name]; continue; }
      const v = parseField(f, req.body, files.find((x) => x.fieldname === f.name) || null);
      if (v === undefined) continue;
      if (f.required && (v === '' || v == null)) throw new HttpError(400, `Preencha: ${f.label}`);
      values[f.name] = v;
    }
    if (r.slugFrom) values.slug = uniqueSlug(db, r.table, req.body.slug || values[r.slugFrom], id);
    if ('published_at' in values && !values.published_at) delete values.published_at;
    if (r.table === 'blog_posts' && id) values.updated_at = new Date().toISOString();
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
    await save(req, null);
    flash(req, 'success', 'Salvo.');
    res.redirect(`/admin/${req.resource.key}`);
  }));

  router.post('/:res/:id(\\d+)', upload.any(), action(async (req, res) => {
    await save(req, toInt(req.params.id));
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
