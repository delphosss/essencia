/* Admin: visitantes em tempo real e status dos tarólogos no dashboard. */
(function () {
  const socket = window.appSocket;
  if (!socket || !window.App) return;
  const { esc } = window.App;
  const tbody = document.querySelector('[data-visitors]');
  const count = document.querySelector('[data-visitor-count]');
  const roles = { visitor: 'Visitante', client: 'Cliente', reader: 'Tarólogo', admin: 'Admin' };
  socket.on('visitors', (list) => {
    if (!tbody) return;
    count.textContent = list.length;
    tbody.innerHTML = list.length ? list.map((v) => `<tr><td>${esc(v.name)} <span class="muted small">${roles[v.role] || ''}</span></td>
      <td><a href="${esc(v.path)}" target="_blank">${esc(v.title || v.path)}</a></td>
      <td class="small">${new Date(v.since).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">Ninguém no site agora.</td></tr>';
  });
  const labels = { online: ['Online', 'ok'], busy: ['Ocupado', 'warn'], offline: ['Offline', 'muted'] };
  socket.on('reader:status', ({ readerId, status }) => {
    const cell = document.querySelector(`[data-reader-row="${readerId}"] [data-reader-status-cell]`);
    if (cell) {
      const [l, c] = labels[status] || [status, 'muted'];
      cell.innerHTML = `<span class="pill pill-${c}">${l}</span>`;
    }
    const online = document.querySelector('[data-online-count]');
    if (online) online.textContent = document.querySelectorAll('[data-reader-status-cell] .pill-ok, [data-reader-status-cell] .pill-warn').length;
  });
}());
