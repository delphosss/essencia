const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Otimização de imagens enviadas: converte para WebP (ou PNG para ícones), limita o tamanho
// e gera variantes de 400 e 800 px para srcset. Arquivos gerados começam com "i-".
const VARIANTS = [400, 800];

module.exports = function createImages(ctx) {
  const dir = ctx.config.uploadDir;

  async function store(file, { maxWidth = 1600, square = 0, format = 'webp', quality = 82 } = {}) {
    if (!file) return null;
    const id = `i-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    const input = sharp(file.path, { animated: false }).rotate(); // respeita a orientação EXIF
    const meta = await input.metadata();
    const ext = format === 'png' ? 'png' : 'webp';
    const encode = (img) => (ext === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality }));
    const out = `${id}.${ext}`;
    let width = Math.min(meta.width || maxWidth, maxWidth);
    if (square) {
      width = square;
      await encode(input.clone().resize(square, square, { fit: 'cover', position: 'attention' })).toFile(path.join(dir, out));
    } else {
      await encode(input.clone().resize({ width, withoutEnlargement: true })).toFile(path.join(dir, out));
      for (const w of VARIANTS) {
        if (w < width) await encode(input.clone().resize({ width: w })).toFile(path.join(dir, `${id}-${w}.${ext}`));
      }
    }
    fs.promises.unlink(file.path).catch(() => {});
    return `/uploads/${out}`;
  }

  // srcset para imagens geradas por store(); vazio para as demais.
  function srcset(src, fullWidth = 1600) {
    const m = /^\/uploads\/(i-[\w-]+?)\.(webp|png)$/.exec(src || '');
    if (!m) return '';
    const parts = VARIANTS.filter((w) => fs.existsSync(path.join(dir, `${m[1]}-${w}.${m[2]}`)))
      .map((w) => `/uploads/${m[1]}-${w}.${m[2]} ${w}w`);
    return parts.length ? [...parts, `${src} ${fullWidth}w`].join(', ') : '';
  }

  return { store, srcset };
};
