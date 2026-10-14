// Dados estruturados (schema.org / JSON-LD) e utilidades de SEO.
const { truncate } = require('./util');

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function metaDescription(...candidates) {
  const text = candidates.map(stripHtml).find(Boolean) || '';
  return truncate(text, 158);
}

function createSeo(ctx) {
  const base = () => ctx.config.baseUrl;
  const abs = (u) => (!u ? undefined : /^https?:\/\//.test(u) ? u : `${base()}${u.startsWith('/') ? '' : '/'}${u}`);
  const site = () => ctx.settings.all();

  function organization() {
    const s = site();
    const sameAs = [s.instagram_url, s.facebook_url].filter(Boolean);
    return {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${base()}/#organization`,
      name: s.site_name,
      url: `${base()}/`,
      logo: abs(s.site_logo),
      ...(s.support_email ? { email: s.support_email } : {}),
      ...(sameAs.length ? { sameAs } : {}),
    };
  }

  function website() {
    return { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${base()}/#website`, name: site().site_name, url: `${base()}/`, inLanguage: 'pt-BR', publisher: { '@id': `${base()}/#organization` } };
  }

  // items: [[nome, caminho], ...] — o último é a página atual.
  function breadcrumbs(items) {
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(path) })),
    };
  }

  function reader(r, categories) {
    return {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: r.display_name,
      url: abs(`/tarologo/${r.slug}`),
      image: abs(r.photo),
      jobTitle: 'Taróloga(o) e oraculista',
      description: metaDescription(r.meta_description, r.bio),
      knowsAbout: [r.oracles, ...categories.map((c) => c.name)].filter(Boolean),
      worksFor: { '@id': `${base()}/#organization` },
      makesOffer: r.chat_enabled ? {
        '@type': 'Offer',
        name: 'Consulta de tarot por chat (por minuto)',
        price: (r.price_chat_cents / 100).toFixed(2),
        priceCurrency: 'BRL',
      } : undefined,
    };
  }

  function blogPosting(p) {
    return {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description: metaDescription(p.meta_description, p.excerpt, p.body),
      image: p.cover ? [abs(p.cover)] : undefined,
      datePublished: p.published_at,
      dateModified: p.updated_at || p.published_at,
      author: { '@type': p.author ? 'Person' : 'Organization', name: p.author || site().site_name },
      publisher: { '@id': `${base()}/#organization` },
      mainEntityOfPage: abs(`/blog/${p.slug}`),
      inLanguage: 'pt-BR',
    };
  }

  function product(p) {
    return {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.name,
      sku: p.sku || undefined,
      image: [p.image, ...JSON.parse(p.gallery || '[]')].filter(Boolean).map(abs),
      description: metaDescription(p.meta_description, p.summary, p.description),
      brand: { '@type': 'Brand', name: site().site_name },
      offers: {
        '@type': 'Offer',
        url: abs(`/loja/produto/${p.slug}`),
        price: (p.price_cents / 100).toFixed(2),
        priceCurrency: 'BRL',
        availability: 'https://schema.org/InStock',
        seller: { '@id': `${base()}/#organization` },
      },
    };
  }

  function faq(items) {
    return {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: stripHtml(f.answer) } })),
    };
  }

  return { abs, organization, website, breadcrumbs, reader, blogPosting, product, faq };
}

module.exports = { createSeo, metaDescription, stripHtml };
