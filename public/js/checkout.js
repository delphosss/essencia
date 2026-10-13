/* Checkout: gera Pix, acompanha a confirmação e simula pagamento em desenvolvimento. */
(function () {
  if (!window.App) return;
  const { api, toast, esc } = window.App;
  const gen = document.querySelector('[data-pix-generate]');
  const box = document.querySelector('[data-pix-box]');
  const orderId = (box && box.dataset.order) || (document.querySelector('[data-order]') || {}).dataset?.order;

  if (gen) {
    gen.addEventListener('click', async () => {
      gen.disabled = true;
      try {
        const r = await api(`/pagamento/${gen.dataset.pixGenerate}/pix`);
        box.querySelector('[data-pix-code]').value = r.qr || '';
        const img = box.querySelector('[data-pix-img]');
        if (r.qrBase64) { img.src = `data:image/png;base64,${r.qrBase64}`; img.hidden = false; }
        box.hidden = false;
        gen.hidden = true;
      } catch (err) { toast(esc(err.message)); gen.disabled = false; }
    });
  }

  const sim = document.querySelector('[data-sandbox-approve]');
  if (sim) {
    sim.addEventListener('click', async () => {
      await api(`/pagamento/simulador/${sim.dataset.sandboxApprove}`, { body: { result: 'approve' } }).catch((err) => toast(esc(err.message)));
    });
  }

  // Confirmação: evento em tempo real + consulta periódica.
  const done = () => { window.location = `/pagamento/${orderId}/retorno`; };
  if (window.appSocket) window.appSocket.on('payment:approved', (d) => { if (String(d.orderId) === String(orderId)) done(); });
  const waiting = box || document.querySelector('[data-order-status="pending"]');
  if (orderId && waiting) {
    setInterval(async () => {
      try {
        const r = await api(`/pagamento/${orderId}/status`, { method: 'GET' });
        if (r.status === 'paid') done();
      } catch (_) { /* tenta de novo */ }
    }, 5000);
  }
}());
