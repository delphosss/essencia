/* Comportamento comum a todas as páginas. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const csrf = () => (document.querySelector('meta[name="csrf-token"]') || {}).content;
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const SITE = window.SITE || {};

  async function api(url, { method = 'POST', body } = {}) {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
    return data;
  }

  function toast(html, ms = 6000) {
    const box = $('[data-toasts]');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // Campainha gerada com Web Audio (dispensa arquivo mp3).
  const Ring = {
    ctx: null,
    timer: null,
    stopAt: 0,
    beep() {
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const t = this.ctx.currentTime;
        [0, 0.25].forEach((offset) => {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine';
          o.frequency.value = offset ? 880 : 660;
          g.gain.setValueAtTime(0.0001, t + offset);
          g.gain.exponentialRampToValueAtTime(0.35, t + offset + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.22);
          o.connect(g).connect(this.ctx.destination);
          o.start(t + offset);
          o.stop(t + offset + 0.25);
        });
      } catch (_) { /* navegador sem áudio */ }
    },
    start(seconds) {
      this.stop();
      this.stopAt = Date.now() + seconds * 1000;
      this.beep();
      this.timer = setInterval(() => {
        if (Date.now() > this.stopAt) return this.stop();
        return this.beep();
      }, 1500);
    },
    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    },
  };

  function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.hidden = false;
  }

  function closeModal(el) {
    const m = el.closest('.modal');
    if (m) m.hidden = true;
  }

  function browserNotify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    try { new Notification(title, { body, icon: '/public/img/icon.svg' }); } catch (_) { /* ignore */ }
  }

  // ---- UI geral ---------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const opener = t.closest('[data-open-modal]');
    if (opener) {
      e.preventDefault();
      openModal(opener.dataset.openModal);
    }
    if (t.matches('[data-close]') || t.classList.contains('modal')) closeModal(t);
    if (t.matches('[data-dismiss]')) t.parentElement.remove();
    const copy = t.closest('[data-copy]');
    if (copy) {
      const src = $(copy.dataset.copy);
      if (src) navigator.clipboard.writeText(src.value || src.textContent).then(() => toast('Código copiado!', 2500));
    }
    const confirmBtn = t.closest('[data-confirm-click]');
    if (confirmBtn && !window.confirm(confirmBtn.dataset.confirmClick)) e.preventDefault();
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) e.preventDefault();
    if (form.dataset.prompt) {
      const answer = window.prompt(form.dataset.prompt);
      if (answer === null) return e.preventDefault();
      form.querySelector(`[name="${form.dataset.promptField}"]`).value = answer;
    }
    return undefined;
  });

  const navToggle = $('[data-nav-toggle]');
  if (navToggle) navToggle.addEventListener('click', () => $('[data-nav]').classList.toggle('open'));
  const adminToggle = $('[data-admin-toggle]');
  if (adminToggle) adminToggle.addEventListener('click', () => $('[data-admin-side]').classList.toggle('open'));

  // Abas
  $$('[data-tabs]').forEach((tabs) => {
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (!tab) return;
      $$('[data-tab]', tabs).forEach((x) => x.classList.toggle('active', x === tab));
      $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  });

  // Slider da home
  const slider = $('[data-slider]');
  if (slider) {
    const slides = $$('.slide', slider);
    let i = 0;
    const show = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => s.classList.toggle('active', k === i));
    };
    if (slides.length > 1) {
      let auto = setInterval(() => show(i + 1), 7000);
      slider.addEventListener('click', (e) => {
        if (e.target.matches('[data-slide-prev]')) show(i - 1);
        if (e.target.matches('[data-slide-next]')) show(i + 1);
        clearInterval(auto);
        auto = setInterval(() => show(i + 1), 7000);
      });
    }
  }

  // Pop-up da home (uma vez por visitante)
  const popup = $('[data-popup]');
  if (popup) {
    try {
      if (!localStorage.getItem('popup_seen')) {
        setTimeout(() => { popup.hidden = false; }, 1500);
        localStorage.setItem('popup_seen', '1');
      }
    } catch (_) { /* storage indisponível */ }
  }

  // Cookies + rastreamento (só após aceite)
  function loadTracking() {
    const t = SITE.tracking || {};
    const add = (src, inline) => {
      const s = document.createElement('script');
      if (src) { s.src = src; s.async = true; }
      if (inline) s.text = inline;
      document.head.appendChild(s);
    };
    if (t.gtm) add(null, `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${t.gtm}');`);
    if (t.ga4) {
      add(`https://www.googletagmanager.com/gtag/js?id=${t.ga4}`);
      add(null, `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${t.ga4}');`);
    }
    if (t.pixel) add(null, `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${t.pixel}');fbq('track','PageView');`);
    if (t.clarity) add(null, `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${t.clarity}");`);
  }
  if (SITE.cookiesAccepted) loadTracking();
  const cookieBtn = $('[data-cookie-accept]');
  if (cookieBtn) {
    cookieBtn.addEventListener('click', () => {
      document.cookie = `cookies_ok=1; max-age=${365 * 86400}; path=/; samesite=lax`;
      $('[data-cookie-bar]').hidden = true;
      loadTracking();
    });
  }

  // Cadastro: DDD só para Brasil
  const country = $('[data-country]');
  if (country) {
    const toggle = () => { const ddd = $('[data-ddd]'); if (ddd) ddd.hidden = country.value !== 'BR'; };
    country.addEventListener('change', toggle);
    toggle();
  }

  // Notificações do navegador
  $$('[data-enable-notifications]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!('Notification' in window)) return toast('Seu navegador não suporta notificações.');
      const p = await Notification.requestPermission();
      toast(p === 'granted' ? 'Notificações ativadas.' : 'Permissão negada no navegador.');
      return undefined;
    });
  });

  // ---- Sino ---------------------------------------------------------------------
  function setBell(n) {
    $$('[data-bell-count]').forEach((el) => { el.textContent = n; el.hidden = !n; });
  }
  async function loadBell() {
    const list = $('[data-bell-list]');
    try {
      const data = await api('/api/notificacoes', { method: 'GET' });
      setBell(data.unread);
      list.innerHTML = data.items.length ? data.items.map((n) => `
        <li class="${n.read_at ? '' : 'unread'}"><a href="${esc(n.link || '#')}" data-notif="${n.id}">
          <strong>${esc(n.title)}</strong>${n.body ? `<small>${esc(n.body)}</small>` : ''}
          <small>${new Date(n.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</small></a></li>`).join('') : '<li class="muted">Nenhuma notificação.</li>';
    } catch (err) {
      list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
    }
  }
  $$('[data-bell]').forEach((bell) => {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = bell.parentElement.querySelector('[data-bell-panel]');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) loadBell();
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bell-wrap')) $$('[data-bell-panel]').forEach((p) => { p.hidden = true; });
    const n = e.target.closest('[data-notif]');
    if (n) api('/api/notificacoes/lidas', { body: { id: n.dataset.notif } }).catch(() => {});
    if (e.target.matches('[data-bell-readall]')) api('/api/notificacoes/lidas').then((d) => { setBell(d.unread); loadBell(); });
  });

  // ---- Ações de tarólogo nos cards e no perfil -----------------------------
  document.addEventListener('click', async (e) => {
    const alertBtn = e.target.closest('[data-alert]');
    if (alertBtn) {
      if (!SITE.user) { window.location = `/entrar?next=${encodeURIComponent(location.pathname)}`; return; }
      try {
        const r = await api(`/avise-me/${alertBtn.dataset.alert}`);
        toast(esc(r.message));
        alertBtn.textContent = 'Aviso ativado ✓';
      } catch (err) { toast(esc(err.message)); }
    }
    const consult = e.target.closest('[data-consult]');
    if (consult) {
      if (!SITE.user) { window.location = `/entrar?next=${encodeURIComponent(location.pathname)}`; return; }
      consult.disabled = true;
      try {
        const r = await api('/consultar', { body: { reader_id: consult.dataset.consult, type: consult.dataset.type } });
        window.location = r.url;
      } catch (err) {
        toast(`${esc(err.message)}${/Saldo/.test(err.message) ? ' <a href="/comprar-creditos">Comprar créditos</a>' : ''}`, 9000);
        consult.disabled = false;
      }
    }
  });

  // Modal de perguntas: soma e valida saldo
  const qForm = $('[data-question-form]');
  if (qForm) {
    const price = Number(qForm.dataset.price);
    const balance = Number(qForm.dataset.balance);
    const max = Number(qForm.dataset.max);
    const list = $('[data-question-list]', qForm);
    const update = () => {
      const n = $$('textarea[name="questions"]', qForm).length;
      $('[data-question-total]', qForm).textContent = brl.format((n * price) / 100);
      const insufficient = n * price > balance;
      $('[data-question-insufficient]', qForm).hidden = !insufficient;
      $('[data-question-submit]', qForm).disabled = insufficient;
      $('[data-question-add]', qForm).hidden = n >= max;
    };
    $('[data-question-add]', qForm).addEventListener('click', () => {
      const n = $$('textarea[name="questions"]', qForm).length + 1;
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML = `<span>Pergunta ${n}</span><textarea name="questions" class="input" rows="2" required maxlength="1000"></textarea>`;
      list.appendChild(label);
      update();
    });
    update();
  }
  if (location.hash === '#perguntar' && document.getElementById('modal-question')) openModal('modal-question');

  // ---- Tempo real -----------------------------------------------------------------
  if (typeof io !== 'function') return;
  const socket = io({ transports: ['websocket', 'polling'] });
  window.appSocket = socket;
  socket.on('connect', () => socket.emit('page', { path: location.pathname, title: document.title }));

  socket.on('reader:status', ({ readerId, status }) => {
    $$(`[data-reader-id="${readerId}"]`).forEach((el) => {
      el.dataset.status = status;
      if (status !== 'busy') $$('[data-busy-time]', el).forEach((t) => { t.textContent = ''; });
    });
  });
  socket.on('reader:busy', ({ readerId, remainingSeconds }) => {
    $$(`[data-reader-id="${readerId}"] [data-busy-time]`).forEach((t) => {
      t.textContent = remainingSeconds > 0 ? `Em atendimento · até ~${Math.ceil(remainingSeconds / 60)} min` : '';
    });
  });
  socket.on('wallet:balance', ({ balanceCents }) => {
    $$('[data-balance]').forEach((el) => { el.textContent = brl.format(balanceCents / 100); });
  });
  socket.on('notify', (n) => {
    setBell(n.unread);
    toast(`<strong>${esc(n.title)}</strong>${n.body ? `<br>${esc(n.body)}` : ''}${n.link ? ` <a href="${esc(n.link)}">Abrir</a>` : ''}`);
    browserNotify(n.title, n.body);
  });
  socket.on('payment:approved', () => {
    if (location.pathname.startsWith('/pagamento/')) return; // a página de pagamento trata
    openModal('modal-purchase');
  });

  // Chamadas recebidas (tarólogo)
  const callModal = document.getElementById('modal-call');
  if (callModal) {
    let current = null;
    let countdown = null;
    const close = () => {
      callModal.hidden = true;
      Ring.stop();
      clearInterval(countdown);
      current = null;
      document.title = document.title.replace(/^🔔 /, '');
    };
    socket.on('call:incoming', (call) => {
      current = call;
      $('[data-call-client]', callModal).textContent = call.clientName;
      $('[data-call-type]', callModal).textContent = call.type === 'video' ? 'vídeo' : 'chat';
      $('[data-call-balance]', callModal).textContent = `${brl.format(call.balanceCents / 100)} (~${Math.floor(call.balanceCents / call.priceCents)} min)`;
      $('[data-call-reject-form]', callModal).hidden = true;
      callModal.hidden = false;
      Ring.start(call.ringSeconds || 60);
      document.title = `🔔 ${document.title}`;
      browserNotify('Nova chamada!', `${call.clientName} quer uma consulta.`);
      clearInterval(countdown);
      const tick = () => {
        const left = Math.round((call.timeoutAt - Date.now()) / 1000);
        $('[data-call-countdown]', callModal).textContent = fmtClock(left);
        if (left <= 0) close();
      };
      tick();
      countdown = setInterval(tick, 1000);
    });
    socket.on('call:cancelled', ({ code }) => { if (current && current.code === code) { close(); toast('O cliente cancelou a chamada.'); } });
    socket.on('call:missed', ({ code }) => { if (current && current.code === code) close(); });
    $('[data-call-accept]', callModal).addEventListener('click', async () => {
      if (!current) return;
      try {
        const r = await api(`/atendente/chamadas/${current.code}/aceitar`);
        close();
        window.location = r.url;
      } catch (err) { toast(esc(err.message)); close(); }
    });
    $('[data-call-reject]', callModal).addEventListener('click', () => { $('[data-call-reject-form]', callModal).hidden = false; Ring.stop(); });
    $('[data-call-reject-form]', callModal).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!current) return;
      try {
        await api(`/atendente/chamadas/${current.code}/recusar`, { body: { reason: e.target.reason.value } });
      } catch (err) { toast(esc(err.message)); }
      close();
    });
  }

  // Status do tarólogo (painel)
  $$('[data-set-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/atendente/status', { body: { status: btn.dataset.setStatus } });
        if (btn.dataset.setStatus === 'online') Ring.beep(); // desbloqueia o áudio do navegador
        location.reload();
      } catch (err) { toast(esc(err.message)); btn.disabled = false; }
    });
  });
  const testRing = $('[data-test-ring]');
  if (testRing) testRing.addEventListener('click', () => { Ring.start(3); });

  window.App = { api, toast, esc, fmtClock, Ring, brl, openModal };
}());
