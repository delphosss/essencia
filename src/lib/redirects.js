// Redirecionamentos 301: preserva o ranking das URLs do site antigo no Google.
// Ordem: tabela "redirects" (admin) → mapa fixo das URLs antigas → remoção da barra final.
const LEGACY = [
  [/^\/home\/?$/, () => '/'],
  [/^\/terapeutas\/?$/, () => '/tarologos'],
  [/^\/terapeuta\/([^/]+)\/?$/, (m) => `/tarologo/${m[1]}`],
  [/^\/aviseme-quando-disponivel\/([^/]+)\/?$/, (m) => `/tarologo/${m[1]}`],
  [/^\/(comprar-saldo|contratar)\/?$/, () => '/comprar-creditos'],
  [/^\/faleconosco\/?$/, () => '/contato'],
  [/^\/depoimentos-terapeutas\/?$/, () => '/depoimentos'],
  [/^\/registre-se\/?$/, () => '/cadastro'],
  [/^\/fazer-login\/?$/, () => '/entrar'],
  [/^\/lembrar-senha\/?$/, () => '/esqueci-senha'],
  [/^\/carrinho-compras\/?$/, () => '/carrinho'],
  [/^\/loja\/servicos\/?$/, () => '/loja/categoria/servicos'],
  [/^\/loja-item\/[^/]+\/([^/]+)\/?$/, (m) => `/loja/produto/${m[1]}`],
  [/^\/blog-artigo\/[^/]+\/([^/]+)\/?$/, (m) => `/blog/${m[1]}`],
  [/^\/consultar\/?$/, () => '/tarologos'],
];

function redirects(db) {
  const custom = db.prepare('SELECT * FROM redirects WHERE from_path = ?');
  const hit = db.prepare('UPDATE redirects SET hits = hits + 1 WHERE id = ?');
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path;
    const qs = req.originalUrl.slice(req.path.length);
    const row = custom.get(p) || (p.length > 1 && p.endsWith('/') ? custom.get(p.slice(0, -1)) : null);
    if (row) {
      hit.run(row.id);
      return res.redirect(301, row.to_path);
    }
    for (const [re, to] of LEGACY) {
      const m = re.exec(p);
      if (m) return res.redirect(301, to(m) + (p.startsWith('/minha-conta') ? '' : qs));
    }
    if (p.startsWith('/minha-conta') && req.query.pg) return res.redirect(301, '/minha-conta');
    if (p.length > 1 && p.endsWith('/') && !p.startsWith('/socket.io')) return res.redirect(301, p.replace(/\/+$/, '') + qs);
    return next();
  };
}

module.exports = { redirects, LEGACY };
