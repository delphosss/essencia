/* Sala da consulta: chat em tempo real, cronômetro e cobrança. */
(function () {
  const room = document.querySelector('[data-room]');
  if (!room || !window.App) return;
  const { api, toast, esc, fmtClock, brl } = window.App;
  const code = room.dataset.room;
  const role = room.dataset.role;
  const log = room.querySelector('[data-chat-log]');
  const form = room.querySelector('[data-chat-form]');
  const input = room.querySelector('[data-chat-input]');
  const banner = room.querySelector('[data-room-banner]');
  const typing = room.querySelector('[data-typing]');
  const socket = window.appSocket;
  let active = room.dataset.status === 'active';
  let videoStarted = false;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  scroll();

  function addMessage(m) {
    const el = document.createElement('div');
    el.className = `msg msg-${m.role} ${m.role === role ? 'mine' : ''}`;
    const time = new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    el.innerHTML = `<div class="msg-body">${esc(m.body)}</div><time>${time}</time>`;
    log.appendChild(el);
    scroll();
    if (m.role !== role && m.role !== 'system' && window.App.Ring) window.App.Ring.beep();
  }

  function showBanner(html) {
    banner.innerHTML = html;
    banner.hidden = !html;
  }

  function applySnapshot(s) {
    if (!s) return;
    room.querySelector('[data-elapsed]').textContent = fmtClock(s.elapsedSeconds);
    room.querySelector('[data-remaining]').textContent = fmtClock(s.remainingSeconds);
    const bal = room.querySelector('[data-room-balance]');
    if (bal) bal.textContent = brl.format(s.balanceCents / 100);
    if (s.paused) showBanner('Consulta pausada — o tempo não está sendo cobrado.');
    else if (s.waiting) showBanner(role === 'client' ? 'Aguardando o tarólogo entrar na sala… o tempo ainda não está contando.' : 'Aguardando o cliente entrar na sala… o tempo ainda não está contando.');
    else if (s.lowBalance && role === 'client') showBanner(`Seu saldo está acabando (${fmtClock(s.remainingSeconds)} restantes). <a href="/comprar-creditos" target="_blank">Recarregar sem sair da consulta</a>`);
    else if (s.lowBalance && role === 'reader') showBanner(`O saldo do cliente termina em ${fmtClock(s.remainingSeconds)}.`);
    else showBanner('');
    const pause = room.querySelector('[data-pause]');
    const resume = room.querySelector('[data-resume]');
    if (pause) { pause.hidden = s.paused; resume.hidden = !s.paused; }
    if (!videoStarted && !s.waiting) startVideo();
  }

  function ended(summary) {
    active = false;
    if (form) form.hidden = true;
    room.querySelector('[data-end]').hidden = true;
    const box = room.querySelector('[data-ended]');
    box.hidden = false;
    if (summary) {
      room.querySelector('[data-ended-text]').textContent = `${summary.reasonLabel} · ${summary.minutes} min · ${brl.format(summary.chargedCents / 100)}`;
      const review = room.querySelector('[data-review-link]');
      if (review && summary.minutes > 0) review.hidden = false;
    }
    showBanner('');
    const video = room.querySelector('[data-video]');
    if (video) video.innerHTML = '<p class="muted center">Vídeo encerrado.</p>';
  }

  function startVideo() {
    const wrap = room.querySelector('[data-video]');
    if (!wrap || videoStarted || !active || typeof window.JitsiMeetExternalAPI !== 'function') return;
    videoStarted = true;
    wrap.innerHTML = '';
    // eslint-disable-next-line no-new
    new window.JitsiMeetExternalAPI(wrap.dataset.domain, {
      roomName: wrap.dataset.roomName,
      parentNode: wrap,
      userInfo: { displayName: wrap.dataset.displayName },
      configOverwrite: { prejoinPageEnabled: false, disableDeepLinking: true },
      interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false },
    });
  }

  if (socket) {
    const join = () => socket.emit('session:join', code, (r) => {
      if (r && r.error) toast('Não foi possível entrar na sala.');
      else if (r) applySnapshot(r.snapshot);
    });
    socket.on('connect', join);
    if (socket.connected) join();
    socket.on('session:message', addMessage);
    socket.on('session:tick', applySnapshot);
    socket.on('session:paused', ({ paused }) => {
      const pause = room.querySelector('[data-pause]');
      if (pause) { pause.hidden = paused; room.querySelector('[data-resume]').hidden = !paused; }
      if (!paused) showBanner('');
    });
    socket.on('session:ended', (s) => { if (s.code === code) ended(s); });
    socket.on('session:low_balance', () => { if (role === 'client') toast('Seu saldo está acabando. Recarregue para continuar a consulta.'); });
    let typingTimer;
    socket.on('session:typing', (d) => {
      if (d.role === role) return;
      typing.hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typing.hidden = true; }, 2500);
    });
  }

  if (form) {
    let lastTyping = 0;
    input.addEventListener('input', () => {
      if (socket && Date.now() - lastTyping > 1500) { socket.emit('session:typing', { code }); lastTyping = Date.now(); }
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !active) return;
      input.value = '';
      input.style.height = 'auto';
      const fallback = () => api(`/sala/${code}/mensagem`, { body: { text } }).catch((err) => toast(esc(err.message)));
      if (socket && socket.connected) {
        socket.emit('session:send', { code, text }, (r) => { if (r && r.error) toast(esc(r.error)); });
      } else fallback();
    });
  }

  room.querySelector('[data-end]').addEventListener('click', async () => {
    if (!window.confirm('Encerrar a consulta agora?')) return;
    try { await api(`/sala/${code}/encerrar`); } catch (err) { toast(esc(err.message)); }
  });
  const pause = room.querySelector('[data-pause]');
  if (pause) {
    pause.addEventListener('click', () => api(`/sala/${code}/pausar`).catch((err) => toast(esc(err.message))));
    room.querySelector('[data-resume]').addEventListener('click', () => api(`/sala/${code}/retomar`).catch((err) => toast(esc(err.message))));
  }
  if (!active) ended(null);
}());
