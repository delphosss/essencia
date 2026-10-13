const { HttpError } = require('../lib/util');

// Carteira de créditos do cliente (em centavos). Toda movimentação gera uma linha no extrato.
module.exports = function createWallet(ctx) {
  const { db } = ctx;
  const getBalance = db.prepare('SELECT balance_cents FROM users WHERE id = ?');
  const setBalance = db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?');
  const insertTx = db.prepare(`INSERT INTO wallet_transactions
    (user_id, type, amount_cents, balance_after_cents, description, ref_type, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const move = db.transaction((userId, amount, type, description, refType, refId) => {
    const row = getBalance.get(userId);
    if (!row) throw new HttpError(404, 'Usuário não encontrado');
    const next = row.balance_cents + amount;
    if (next < 0) throw new HttpError(402, 'Saldo insuficiente');
    setBalance.run(next, userId);
    insertTx.run(userId, type, amount, next, description || null, refType || null, refId || null);
    return next;
  });

  function balance(userId) {
    const row = getBalance.get(userId);
    return row ? row.balance_cents : 0;
  }

  function credit(userId, cents, type, description, ref = {}) {
    if (cents <= 0) return balance(userId);
    const next = move(userId, cents, type, description, ref.type, ref.id);
    ctx.rt.toUser(userId, 'wallet:balance', { balanceCents: next });
    return next;
  }

  function debit(userId, cents, type, description, ref = {}) {
    if (cents <= 0) return balance(userId);
    const next = move(userId, -cents, type, description, ref.type, ref.id);
    ctx.rt.toUser(userId, 'wallet:balance', { balanceCents: next });
    return next;
  }

  function history(userId, limit = 100) {
    return db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }

  return { balance, credit, debit, history };
};
