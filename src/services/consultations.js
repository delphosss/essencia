const { HttpError, randomCode, nowIso, money, hmac } = require('../lib/util');

// Motor das consultas ao vivo (chat e vídeo).
//
// Ciclo: calling → active → ended  (ou rejected | cancelled | missed)
// Cobrança: por minuto iniciado. O 1º minuto é debitado quando cliente e tarólogo estão na sala;
// os seguintes, a cada 60 s de tempo faturável. Sem saldo para o próximo minuto → a sala termina.
// O tempo só corre com as duas partes conectadas e sem pausa; se alguém some por mais que
// `disconnect_grace_seconds`, a consulta é encerrada.
module.exports = function createConsultations(ctx) {
  const { db, settings } = ctx;
  const clock = () => ctx.clock();
  const pending = new Map(); // code → { id, readerId, readerUserId, clientId, timeoutAt, waCount, nextWaAt }
  const live = new Map(); // code → estado da sessão em andamento
  const readerSockets = new Map(); // readerId → nº de sockets do tarólogo conectados
  const readerAbsentSince = new Map(); // readerId → ms
  let timer = null;
  let tickCount = 0;

  const getReader = db.prepare('SELECT r.*, u.name AS user_name FROM readers r JOIN users u ON u.id = r.user_id WHERE r.id = ?');
  const getByCode = db.prepare('SELECT * FROM consultations WHERE code = ?');

  function log(consultationId, event, data) {
    db.prepare('INSERT INTO call_events (consultation_id, event, data) VALUES (?, ?, ?)')
      .run(consultationId, event, data ? JSON.stringify(data) : null);
  }

  function sysMessage(consultationId, body) {
    db.prepare("INSERT INTO chat_messages (consultation_id, sender_role, body) VALUES (?, 'system', ?)").run(consultationId, body);
  }

  // ---- Status do tarólogo --------------------------------------------------
  function setReaderStatus(readerId, status) {
    const reader = getReader.get(readerId);
    if (!reader) throw new HttpError(404, 'Tarólogo não encontrado');
    if (reader.status === status) return reader;
    if (status !== 'busy' && activeFor({ readerId })) throw new HttpError(409, 'Encerre a consulta em andamento primeiro');
    db.prepare('UPDATE readers SET status = ?, status_changed_at = ? WHERE id = ?').run(status, nowIso(), readerId);
    ctx.rt.toAll('reader:status', { readerId, status });
    if (status === 'online') fireAvailabilityAlerts(reader);
    if (status === 'offline') readerAbsentSince.delete(readerId);
    return { ...reader, status };
  }

  function fireAvailabilityAlerts(reader) {
    const alerts = db.prepare(`SELECT a.id, u.id AS user_id, u.email, u.name, u.notify_opt_in FROM availability_alerts a
      JOIN users u ON u.id = a.client_id WHERE a.reader_id = ? AND a.notified_at IS NULL`).all(reader.id);
    if (!alerts.length) return;
    const mark = db.prepare('UPDATE availability_alerts SET notified_at = ? WHERE id = ?');
    const at = nowIso();
    for (const a of alerts) {
      mark.run(at, a.id);
      ctx.notifications.notify(a.user_id, {
        title: `${reader.display_name} está online`,
        body: 'Quem você pediu para avisar acabou de ficar disponível.',
        link: `/tarologo/${reader.slug}`,
      });
      if (a.notify_opt_in) {
        ctx.messaging.sendEmail({
          to: a.email,
          subject: `${reader.display_name} está online agora`,
          text: `Olá, ${a.name}!\n\n${reader.display_name} acabou de ficar online.\nConsulte agora: ${ctx.config.baseUrl}/tarologo/${reader.slug}`,
        });
      }
    }
  }

  function readerConnected(readerId) {
    readerSockets.set(readerId, (readerSockets.get(readerId) || 0) + 1);
    readerAbsentSince.delete(readerId);
  }

  function readerDisconnected(readerId) {
    const n = Math.max(0, (readerSockets.get(readerId) || 0) - 1);
    readerSockets.set(readerId, n);
    if (n === 0) readerAbsentSince.set(readerId, clock());
  }

  // ---- Chamada -------------------------------------------------------------
  function activeFor({ clientId, readerId }) {
    if (clientId) return db.prepare("SELECT * FROM consultations WHERE client_id = ? AND status IN ('calling','active') LIMIT 1").get(clientId);
    return db.prepare("SELECT * FROM consultations WHERE reader_id = ? AND status IN ('calling','active') LIMIT 1").get(readerId);
  }

  function acceptLinkToken(code) {
    return hmac(ctx.config.sessionSecret, `accept:${code}`);
  }

  function startCall(client, readerId, type = 'chat', { appointmentId } = {}) {
    if (client.role !== 'client') throw new HttpError(403, 'Apenas clientes podem iniciar consultas');
    if (client.blocked) throw new HttpError(403, 'Conta bloqueada');
    const reader = getReader.get(readerId);
    if (!reader || !reader.active) throw new HttpError(404, 'Tarólogo não encontrado');
    if (type === 'video' && !reader.video_enabled) throw new HttpError(400, 'Este tarólogo não atende por vídeo');
    if (type === 'chat' && !reader.chat_enabled) throw new HttpError(400, 'Este tarólogo não atende por chat');
    if (reader.status === 'offline') throw new HttpError(409, 'Tarólogo offline no momento');
    if (reader.status === 'busy' || activeFor({ readerId })) throw new HttpError(409, 'Tarólogo em atendimento. Use o "Avise-me".');
    const existing = activeFor({ clientId: client.id });
    if (existing) throw new HttpError(409, 'Você já tem uma consulta em andamento');

    const price = type === 'video' ? reader.price_video_cents : reader.price_chat_cents;
    const balance = ctx.wallet.balance(client.id);
    const minMinutes = Math.max(1, settings.get('min_balance_minutes'));
    if (balance < price * minMinutes) {
      throw new HttpError(402, `Saldo insuficiente. Você precisa de pelo menos ${money(price * minMinutes)} para iniciar.`);
    }

    const code = randomCode(12);
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO consultations
      (code, client_id, reader_id, type, price_per_min_cents, balance_start_cents, appointment_id, video_room)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, client.id, readerId, type, price, balance, appointmentId || null,
      type === 'video' ? `${reader.slug}-${randomCode(8)}`.replace(/[^a-zA-Z0-9-]/g, '') : null,
    );
    const now = clock();
    const call = {
      id, code, readerId, readerUserId: reader.user_id, clientId: client.id,
      timeoutAt: now + settings.get('call_timeout_seconds') * 1000, waCount: 0, nextWaAt: now,
    };
    pending.set(code, call);
    log(id, 'call_started', { type, price });
    ctx.rt.toUser(reader.user_id, 'call:incoming', {
      code, clientName: client.name, type, priceCents: price, balanceCents: balance,
      timeoutAt: call.timeoutAt, ringSeconds: settings.get('ring_seconds'),
    });
    sendCallWhatsapp(call, reader, client);
    return { id, code };
  }

  function sendCallWhatsapp(call, reader, client) {
    if (!reader.whatsapp) return;
    call.waCount += 1;
    call.nextWaAt = clock() + settings.get('whatsapp_repeat_seconds') * 1000;
    const link = `${ctx.config.baseUrl}/atendente/aceitar/${call.code}?t=${acceptLinkToken(call.code)}`;
    ctx.messaging.sendWhatsapp(reader.whatsapp,
      `🔔 ${settings.get('site_name')}: ${client.name} está chamando você para uma consulta.\nAceitar: ${link}`);
    log(call.id, 'whatsapp_sent', { n: call.waCount });
  }

  function loadForReader(readerUserId, code) {
    const c = getByCode.get(code);
    if (!c) throw new HttpError(404, 'Consulta não encontrada');
    const reader = getReader.get(c.reader_id);
    if (reader.user_id !== readerUserId) throw new HttpError(403, 'Esta chamada não é sua');
    return { c, reader };
  }

  function acceptCall(readerUserId, code) {
    const { c, reader } = loadForReader(readerUserId, code);
    if (c.status === 'active') return c;
    if (c.status !== 'calling') throw new HttpError(409, 'A chamada não está mais disponível');
    const at = nowIso();
    db.prepare("UPDATE consultations SET status = 'active', accepted_at = ? WHERE id = ?").run(at, c.id);
    pending.delete(code);
    db.prepare('UPDATE readers SET status = ?, status_changed_at = ? WHERE id = ?').run('busy', at, reader.id);
    ctx.rt.toAll('reader:status', { readerId: reader.id, status: 'busy' });
    const now = clock();
    live.set(code, {
      id: c.id, code, clientId: c.client_id, readerId: reader.id, readerUserId: reader.user_id,
      price: c.price_per_min_cents, billableMs: 0, minutesCharged: 0, chargedCents: 0,
      lastTickAt: now, paused: false, pausedAt: null,
      present: { client: 0, reader: 0 }, absentSince: { client: now, reader: now }, warned: false,
    });
    sysMessage(c.id, `${reader.display_name} aceitou a consulta. O tempo começa a contar quando os dois estiverem na sala.`);
    log(c.id, 'call_accepted');
    ctx.rt.toUser(c.client_id, 'call:accepted', { code, url: `/sala/${code}` });
    return getByCode.get(code);
  }

  function rejectCall(readerUserId, code, reason) {
    const { c } = loadForReader(readerUserId, code);
    if (c.status !== 'calling') throw new HttpError(409, 'A chamada não está mais disponível');
    db.prepare("UPDATE consultations SET status = 'rejected', reject_reason = ?, ended_at = ? WHERE id = ?")
      .run(reason || null, nowIso(), c.id);
    pending.delete(code);
    log(c.id, 'call_rejected', { reason });
    ctx.rt.toUser(c.client_id, 'call:rejected', { code, reason: reason || '' });
  }

  function cancelCall(clientId, code) {
    const c = getByCode.get(code);
    if (!c || c.client_id !== clientId) throw new HttpError(404, 'Consulta não encontrada');
    if (c.status !== 'calling') return;
    db.prepare("UPDATE consultations SET status = 'cancelled', ended_at = ? WHERE id = ?").run(nowIso(), c.id);
    const call = pending.get(code);
    pending.delete(code);
    log(c.id, 'call_cancelled');
    if (call) ctx.rt.toUser(call.readerUserId, 'call:cancelled', { code });
  }

  function missCall(code) {
    pending.delete(code);
    const c = getByCode.get(code);
    if (!c || c.status !== 'calling') return;
    db.prepare("UPDATE consultations SET status = 'missed', ended_at = ? WHERE id = ?").run(nowIso(), c.id);
    log(c.id, 'call_missed');
    const client = db.prepare('SELECT name FROM users WHERE id = ?').get(c.client_id);
    const reader = getReader.get(c.reader_id);
    ctx.rt.toUser(c.client_id, 'call:missed', { code });
    ctx.rt.toUser(reader.user_id, 'call:missed', { code });
    ctx.notifications.notify(reader.user_id, {
      title: 'Consulta perdida',
      body: `${client.name} chamou e não foi atendido(a). Saldo do cliente: ${money(ctx.wallet.balance(c.client_id))}.`,
      link: '/atendente/atendimentos?status=missed',
    });
  }

  // ---- Sessão em andamento ---------------------------------------------------
  function participantRole(c, userId) {
    if (c.client_id === userId) return 'client';
    const reader = getReader.get(c.reader_id);
    if (reader.user_id === userId) return 'reader';
    return null;
  }

  function join(code, role) {
    const s = live.get(code);
    if (!s) return;
    s.present[role] += 1;
    s.absentSince[role] = null;
    log(s.id, 'joined', { role });
  }

  function leave(code, role) {
    const s = live.get(code);
    if (!s) return;
    s.present[role] = Math.max(0, s.present[role] - 1);
    if (s.present[role] === 0) {
      s.absentSince[role] = clock();
      log(s.id, 'left', { role });
    }
  }

  function remainingSeconds(s, balance) {
    const paidUntil = s.minutesCharged * 60;
    const inMinute = Math.max(0, paidUntil - Math.floor(s.billableMs / 1000));
    return inMinute + Math.floor(balance / s.price) * 60;
  }

  function snapshot(s) {
    const balance = ctx.wallet.balance(s.clientId);
    const remaining = remainingSeconds(s, balance);
    return {
      code: s.code,
      elapsedSeconds: Math.floor(s.billableMs / 1000),
      remainingSeconds: remaining,
      minutesCharged: s.minutesCharged,
      chargedCents: s.chargedCents,
      balanceCents: balance,
      paused: s.paused,
      waiting: s.present.client === 0 || s.present.reader === 0,
      lowBalance: remaining <= settings.get('low_balance_warning_seconds'),
    };
  }

  function chargeMinute(s) {
    try {
      ctx.wallet.debit(s.clientId, s.price, 'consultation', `Consulta ${s.code} — minuto ${s.minutesCharged + 1}`, { type: 'consultation', id: s.id });
    } catch (err) {
      if (err.status === 402) return false;
      throw err;
    }
    s.minutesCharged += 1;
    s.chargedCents += s.price;
    db.prepare('UPDATE consultations SET minutes_charged = ?, charged_cents = ?, billable_seconds = ? WHERE id = ?')
      .run(s.minutesCharged, s.chargedCents, Math.floor(s.billableMs / 1000), s.id);
    return true;
  }

  function tickSession(s, now) {
    const grace = settings.get('disconnect_grace_seconds') * 1000;
    for (const role of ['client', 'reader']) {
      if (s.absentSince[role] && now - s.absentSince[role] > grace) {
        endSession(s.code, 'system', role === 'client' ? 'client_disconnected' : 'reader_disconnected');
        return;
      }
    }
    if (s.paused && now - s.pausedAt > settings.get('max_pause_seconds') * 1000) resume(s.code, 'system');
    const running = !s.paused && s.present.client > 0 && s.present.reader > 0;
    if (running) s.billableMs += now - s.lastTickAt;
    s.lastTickAt = now;
    if (running) {
      while (s.minutesCharged * 60000 <= s.billableMs) {
        if (!chargeMinute(s)) {
          endSession(s.code, 'system', 'insufficient_balance');
          return;
        }
      }
    }
    const snap = snapshot(s);
    if (snap.lowBalance && !s.warned && s.minutesCharged > 0) {
      s.warned = true;
      ctx.rt.toUser(s.clientId, 'session:low_balance', snap);
    }
    if (!snap.lowBalance) s.warned = false;
    ctx.rt.toRoom(`s:${s.code}`, 'session:tick', snap);
    if (tickCount % 10 === 0) ctx.rt.toAll('reader:busy', { readerId: s.readerId, remainingSeconds: snap.remainingSeconds });
  }

  function pause(code, readerUserId) {
    const s = live.get(code);
    if (!s || s.readerUserId !== readerUserId) throw new HttpError(404, 'Sessão não encontrada');
    if (s.paused) return;
    s.paused = true;
    s.pausedAt = clock();
    db.prepare('UPDATE consultations SET paused = 1 WHERE id = ?').run(s.id);
    sysMessage(s.id, 'Consulta pausada pelo tarólogo. O tempo não está sendo cobrado.');
    log(s.id, 'paused');
    ctx.rt.toRoom(`s:${code}`, 'session:paused', { paused: true });
  }

  function resume(code, by) {
    const s = live.get(code);
    if (!s) throw new HttpError(404, 'Sessão não encontrada');
    if (by !== 'system' && s.readerUserId !== by) throw new HttpError(403, 'Apenas o tarólogo pode retomar');
    if (!s.paused) return;
    s.paused = false;
    s.pausedAt = null;
    s.lastTickAt = clock();
    db.prepare('UPDATE consultations SET paused = 0 WHERE id = ?').run(s.id);
    sysMessage(s.id, 'Consulta retomada.');
    log(s.id, 'resumed', { by: by === 'system' ? 'system' : 'reader' });
    ctx.rt.toRoom(`s:${code}`, 'session:paused', { paused: false });
  }

  const END_REASONS = {
    client: 'Encerrada pelo cliente',
    reader: 'Encerrada pelo tarólogo',
    admin: 'Encerrada pela administração',
    insufficient_balance: 'Saldo esgotado',
    client_disconnected: 'Cliente desconectado',
    reader_disconnected: 'Tarólogo desconectado',
    server_restart: 'Reinício do servidor',
  };

  function endSession(code, by, reason) {
    const c = getByCode.get(code);
    if (!c || c.status !== 'active') return c;
    const s = live.get(code);
    live.delete(code);
    const billable = s ? Math.floor(s.billableMs / 1000) : c.billable_seconds;
    const charged = s ? s.chargedCents : c.charged_cents;
    const minutes = s ? s.minutesCharged : c.minutes_charged;
    const balanceEnd = ctx.wallet.balance(c.client_id);
    const endReason = reason || by;
    db.prepare(`UPDATE consultations SET status = 'ended', ended_at = ?, ended_by = ?, end_reason = ?, billable_seconds = ?,
      minutes_charged = ?, charged_cents = ?, balance_end_cents = ?, paused = 0 WHERE id = ?`)
      .run(nowIso(), by, endReason, billable, minutes, charged, balanceEnd, c.id);
    sysMessage(c.id, `Consulta encerrada: ${END_REASONS[endReason] || endReason}.`);
    log(c.id, 'session_ended', { by, reason: endReason, charged });
    const reader = getReader.get(c.reader_id);
    if (charged > 0) {
      ctx.earnings.record(reader.id, { sourceType: 'consultation', sourceId: c.id, grossCents: charged, description: `Consulta ${c.code} (${minutes} min)` });
    }
    if (reader.status === 'busy') {
      db.prepare('UPDATE readers SET status = ?, status_changed_at = ? WHERE id = ?').run('online', nowIso(), reader.id);
    }
    ctx.rt.toAll('reader:status', { readerId: reader.id, status: reader.status === 'busy' ? 'online' : reader.status });
    const summary = { code, reason: endReason, reasonLabel: END_REASONS[endReason] || endReason, minutes, chargedCents: charged, balanceCents: balanceEnd };
    ctx.rt.toRoom(`s:${code}`, 'session:ended', summary);
    ctx.rt.toUser(c.client_id, 'session:ended', summary);
    ctx.rt.toUser(reader.user_id, 'session:ended', summary);
    if (minutes > 0) {
      ctx.notifications.notify(c.client_id, {
        title: 'Como foi sua consulta?',
        body: `Conte como foi o atendimento com ${reader.display_name}.`,
        link: `/minha-conta/avaliar/${code}`,
      });
    }
    if (c.appointment_id) db.prepare("UPDATE appointments SET status = 'done' WHERE id = ?").run(c.appointment_id);
    return getByCode.get(code);
  }

  function endByUser(code, userId) {
    const c = getByCode.get(code);
    if (!c) throw new HttpError(404, 'Consulta não encontrada');
    const role = participantRole(c, userId);
    if (!role) throw new HttpError(403, 'Acesso negado');
    return endSession(code, role, role);
  }

  // ---- Mensagens do chat ---------------------------------------------------
  const CONTACT_PATTERNS = [
    /[\w.+-]+@[\w-]+\.[\w.]+/g, // e-mail
    /(https?:\/\/|www\.)\S+/gi, // links
    /(?:\+?\d[\s().-]*){8,}/g, // telefones (8+ dígitos)
    /(^|\s)@[\w.]{3,}/g, // @perfil
    /\b(whats\s?app|zap|telegram|insta(gram)?|pix)\b/gi,
  ];

  function filterContacts(text) {
    if (!settings.get('chat_block_contacts')) return text;
    let out = text;
    for (const re of CONTACT_PATTERNS) out = out.replace(re, (m, lead) => `${typeof lead === 'string' && /^\s$/.test(lead) ? lead : ''}[contato removido]`);
    return out;
  }

  function sendMessage(code, userId, text) {
    const c = getByCode.get(code);
    if (!c) throw new HttpError(404, 'Consulta não encontrada');
    const role = participantRole(c, userId);
    if (!role) throw new HttpError(403, 'Acesso negado');
    if (c.status !== 'active') throw new HttpError(409, 'A consulta não está ativa');
    const body = filterContacts(String(text || '').trim().slice(0, 2000));
    if (!body) return null;
    const { lastInsertRowid } = db.prepare('INSERT INTO chat_messages (consultation_id, sender_role, sender_id, body) VALUES (?, ?, ?, ?)')
      .run(c.id, role, userId, body);
    const msg = { id: lastInsertRowid, role, body, at: nowIso() };
    ctx.rt.toRoom(`s:${code}`, 'session:message', msg);
    return msg;
  }

  function messages(consultationId) {
    return db.prepare('SELECT * FROM chat_messages WHERE consultation_id = ? ORDER BY id').all(consultationId);
  }

  // ---- Loop --------------------------------------------------------------
  function tick(now = clock()) {
    tickCount += 1;
    for (const call of [...pending.values()]) {
      if (now >= call.timeoutAt) {
        missCall(call.code);
        continue;
      }
      if (call.waCount < settings.get('whatsapp_max_repeats') && now >= call.nextWaAt) {
        const reader = getReader.get(call.readerId);
        const client = db.prepare('SELECT name FROM users WHERE id = ?').get(call.clientId);
        sendCallWhatsapp(call, reader, client);
      }
    }
    for (const s of [...live.values()]) {
      try {
        tickSession(s, now);
      } catch (err) {
        ctx.logError('session', err.message, { code: s.code });
      }
    }
    const offlineGrace = settings.get('reader_offline_grace_seconds') * 1000;
    for (const [readerId, since] of [...readerAbsentSince.entries()]) {
      if (now - since > offlineGrace) {
        readerAbsentSince.delete(readerId);
        const r = getReader.get(readerId);
        if (r && r.status === 'online') setReaderStatus(readerId, 'offline');
      }
    }
  }

  // Ao subir o servidor: fecha o que ficou aberto (os minutos já cobrados estão gravados).
  function recover() {
    for (const c of db.prepare("SELECT * FROM consultations WHERE status = 'calling'").all()) {
      db.prepare("UPDATE consultations SET status = 'missed', ended_at = ? WHERE id = ?").run(nowIso(), c.id);
    }
    for (const c of db.prepare("SELECT * FROM consultations WHERE status = 'active'").all()) {
      endSession(c.code, 'system', 'server_restart');
    }
    db.prepare("UPDATE readers SET status = 'online' WHERE status = 'busy'").run();
    const now = clock();
    for (const r of db.prepare("SELECT id FROM readers WHERE status = 'online'").all()) readerAbsentSince.set(r.id, now);
  }

  function start() {
    recover();
    timer = setInterval(() => tick(), 1000);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function liveSessions() {
    return [...live.values()].map((s) => ({ ...snapshot(s), readerId: s.readerId, clientId: s.clientId }));
  }

  return {
    setReaderStatus, readerConnected, readerDisconnected, startCall, acceptCall, rejectCall, cancelCall, missCall,
    join, leave, pause, resume, endSession, endByUser, sendMessage, messages, participantRole, filterContacts,
    tick, start, stop, recover, snapshot: (code) => (live.get(code) ? snapshot(live.get(code)) : null),
    liveSessions, acceptLinkToken, activeFor, END_REASONS, pending,
  };
};
