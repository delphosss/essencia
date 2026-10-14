const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Versão por conteúdo para CSS/JS/imagens de /public: permite cache de 1 ano no navegador
// e garante que uma nova versão do arquivo seja baixada assim que mudar.
function createAssets(root) {
  const cache = new Map();
  return function asset(url) {
    if (!url.startsWith('/public/')) return url;
    if (!cache.has(url)) {
      let v = '0';
      try { v = crypto.createHash('md5').update(fs.readFileSync(path.join(root, url))).digest('hex').slice(0, 10); } catch (_) { /* arquivo ausente */ }
      cache.set(url, `${url}?v=${v}`);
    }
    return cache.get(url);
  };
}

module.exports = { createAssets };
