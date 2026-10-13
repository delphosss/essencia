const { HttpError } = require('../lib/util');

// Ganhos do tarólogo: cada consulta/pergunta gera um lançamento líquido (bruto × comissão).
// Saques pagos entram como lançamento negativo; saques solicitados ficam reservados.
module.exports = function createEarnings(ctx) {
  const { db } = ctx;

  function record(readerId, { sourceType, sourceId, grossCents, description }) {
    if (!grossCents) return null;
    const reader = db.prepare('SELECT commission_percent FROM readers WHERE id = ?').get(readerId);
    const pct = reader ? reader.commission_percent : ctx.settings.get('default_commission_percent');
    const net = Math.round((grossCents * pct) / 100);
    db.prepare(`INSERT INTO reader_earnings (reader_id, source_type, source_id, gross_cents, commission_percent, net_cents, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(readerId, sourceType, sourceId || null, grossCents, pct, net, description || null);
    return net;
  }

  function summary(readerId) {
    const total = db.prepare('SELECT COALESCE(SUM(net_cents),0) s FROM reader_earnings WHERE reader_id = ?').get(readerId).s;
    const held = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM withdrawals WHERE reader_id = ? AND status = 'requested'").get(readerId).s;
    const month = db.prepare(`SELECT COALESCE(SUM(net_cents),0) s FROM reader_earnings
      WHERE reader_id = ? AND net_cents > 0 AND created_at >= strftime('%Y-%m-01T00:00:00Z','now')`).get(readerId).s;
    const paidOut = -db.prepare("SELECT COALESCE(SUM(net_cents),0) s FROM reader_earnings WHERE reader_id = ? AND source_type = 'withdrawal'").get(readerId).s;
    return { balanceCents: total, heldCents: held, availableCents: total - held, monthCents: month, paidOutCents: paidOut };
  }

  function requestWithdrawal(readerId, amountCents, pixKey) {
    const min = ctx.settings.get('withdrawal_min_cents');
    if (!pixKey) throw new HttpError(400, 'Informe a chave Pix');
    if (amountCents < min) throw new HttpError(400, `O valor mínimo de saque é ${ctx.util.money(min)}`);
    const { availableCents } = summary(readerId);
    if (amountCents > availableCents) throw new HttpError(400, 'Valor maior que o saldo disponível');
    const { lastInsertRowid } = db.prepare('INSERT INTO withdrawals (reader_id, amount_cents, pix_key) VALUES (?, ?, ?)')
      .run(readerId, amountCents, pixKey);
    ctx.notifications.notifyAdmins({ title: 'Novo pedido de saque', body: ctx.util.money(amountCents), link: '/admin/saques' });
    return lastInsertRowid;
  }

  const processWithdrawal = db.transaction((id, status, note) => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w || w.status !== 'requested') throw new HttpError(400, 'Saque já processado');
    db.prepare("UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(status, note || null, id);
    if (status === 'paid') {
      db.prepare(`INSERT INTO reader_earnings (reader_id, source_type, source_id, gross_cents, commission_percent, net_cents, description)
        VALUES (?, 'withdrawal', ?, 0, 0, ?, ?)`).run(w.reader_id, id, -w.amount_cents, `Saque Pix ${w.pix_key}`);
    }
    return w;
  });

  function process(id, status, note) {
    const w = processWithdrawal(id, status, note);
    const reader = db.prepare('SELECT user_id FROM readers WHERE id = ?').get(w.reader_id);
    ctx.notifications.notify(reader.user_id, {
      title: status === 'paid' ? 'Saque pago' : 'Saque recusado',
      body: `${ctx.util.money(w.amount_cents)}${note ? ` — ${note}` : ''}`,
      link: '/atendente/financeiro',
    });
  }

  function adjust(readerId, cents, description) {
    db.prepare(`INSERT INTO reader_earnings (reader_id, source_type, gross_cents, commission_percent, net_cents, description)
      VALUES (?, 'adjustment', 0, 0, ?, ?)`).run(readerId, cents, description || 'Ajuste manual');
  }

  return { record, summary, requestWithdrawal, process, adjust };
};
