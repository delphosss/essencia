/* Editor visual (Quill) para campos de conteúdo do admin. O HTML continua sendo salvo no textarea. */
(function () {
  if (typeof Quill !== 'function') return;
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  document.querySelectorAll('textarea[data-rich]').forEach((ta) => {
    const holder = document.createElement('div');
    holder.className = 'rich-editor';
    ta.after(holder);
    ta.hidden = true;
    const quill = new Quill(holder, {
      theme: 'snow',
      modules: {
        toolbar: {
          container: [[{ header: [2, 3, false] }], ['bold', 'italic', 'underline', 'blockquote'], [{ list: 'ordered' }, { list: 'bullet' }], ['link', 'image'], ['clean']],
          handlers: {
            // Envia a imagem para o servidor (otimizada em WebP) em vez de embutir em base64.
            image() {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*';
              input.onchange = async () => {
                const fd = new FormData();
                fd.append('image', input.files[0]);
                const res = await fetch('/admin/upload-imagem', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' } });
                const data = await res.json();
                if (data.url) {
                  const range = quill.getSelection(true);
                  quill.insertEmbed(range.index, 'image', data.url);
                } else alert(data.error || 'Falha no envio');
              };
              input.click();
            },
          },
        },
      },
    });
    quill.clipboard.dangerouslyPasteHTML(ta.value);
    const sync = () => { ta.value = quill.getSemanticHTML(); };
    quill.on('text-change', sync);
    ta.form.addEventListener('submit', sync);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-outline btn-sm';
    toggle.textContent = 'Editar HTML';
    toggle.onclick = () => {
      if (ta.hidden) { sync(); ta.hidden = false; holder.hidden = true; holder.previousElementSibling && (holder.previousElementSibling.hidden = true); toggle.textContent = 'Editor visual'; } else { quill.clipboard.dangerouslyPasteHTML(ta.value); ta.hidden = true; holder.hidden = false; holder.previousElementSibling && (holder.previousElementSibling.hidden = false); toggle.textContent = 'Editar HTML'; }
    };
    holder.after(toggle);
  });
}());
