/* Sala de espera "Chamando o tarólogo". */
(function () {
  const root = document.querySelector('[data-calling]');
  if (!root || !window.App) return;
  const { api, fmtClock } = window.App;
  const code = root.dataset.calling;
  const timeout = Number(root.dataset.timeout);
  let remaining = Number(root.dataset.remaining);
  const bar = root.querySelector('[data-calling-bar]');
  const countdown = root.querySelector('[data-calling-countdown]');
  let finished = root.dataset.status !== 'calling';

  function finish(title, text) {
    finished = true;
    clearInterval(timer);
    root.querySelector('[data-calling-title]').textContent = title;
    root.querySelector('[data-calling-text]').textContent = text;
    root.querySelector('.progress').hidden = true;
    root.querySelector('[data-calling-actions]').hidden = true;
    root.querySelector('[data-calling-after]').hidden = false;
    countdown.textContent = '';
  }

  const timer = setInterval(() => {
    if (finished) return;
    remaining -= 1;
    bar.style.width = `${Math.max(0, (remaining / timeout) * 100)}%`;
    countdown.textContent = `Tempo para atender: ${fmtClock(remaining)}`;
    if (remaining <= -5) finish('Sem resposta', 'O tarólogo não atendeu a tempo. Nenhum crédito foi cobrado.');
  }, 1000);
  bar.style.width = `${(remaining / timeout) * 100}%`;

  const socket = window.appSocket;
  if (socket) {
    socket.on('call:accepted', (d) => { if (d.code === code) window.location = d.url; });
    socket.on('call:rejected', (d) => {
      if (d.code === code) finish('Chamada recusada', d.reason ? `Motivo: ${d.reason}. Nenhum crédito foi cobrado.` : 'O tarólogo não pôde atender agora. Nenhum crédito foi cobrado.');
    });
    socket.on('call:missed', (d) => { if (d.code === code) finish('Sem resposta', 'O tarólogo não atendeu a tempo. Nenhum crédito foi cobrado.'); });
  }

  // Fallback caso o socket caia: consulta o status a cada 5 s.
  setInterval(async () => {
    if (finished) return;
    try {
      const r = await fetch(`/sala/${code}/mensagens`, { headers: { Accept: 'application/json' } }).then((x) => x.json());
      if (r.status === 'active') window.location = `/sala/${code}`;
      else if (['rejected', 'missed', 'cancelled'].includes(r.status)) finish('Chamada encerrada', 'O tarólogo não pôde atender agora. Nenhum crédito foi cobrado.');
    } catch (_) { /* tenta de novo */ }
  }, 5000);

  const cancel = root.querySelector('[data-calling-cancel]');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await api(`/chamando/${code}/cancelar`); } catch (_) { /* ignora */ }
      finish('Chamada cancelada', 'Você cancelou a chamada. Nenhum crédito foi cobrado.');
    });
  }
}());
