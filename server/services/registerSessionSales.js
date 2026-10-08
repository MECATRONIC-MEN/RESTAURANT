/**
 * Ventas cobradas asociadas a un turno de caja (apertura → cierre o ahora).
 */
const { queryAll, queryOne, ensureOrdersPaidAtColumns } = require('../database');
const { addOrderToSalesTotals } = require('../utils/paymentBreakdown');
const {
  countSalesAccounts,
  salesAccountOrderSelectSql,
  paidAtSql,
} = require('../utils/salesAccountGrouping');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeRegisterArg(registerOrOpenedAt) {
  if (registerOrOpenedAt && typeof registerOrOpenedAt === 'object') {
    return {
      id: String(registerOrOpenedAt.id || '').trim(),
      opened_at: registerOrOpenedAt.opened_at,
      closed_at: registerOrOpenedAt.closed_at || null,
    };
  }
  return {
    id: '',
    opened_at: registerOrOpenedAt,
    closed_at: null,
  };
}

function buildRegisterSalesSql(register) {
  ensureOrdersPaidAtColumns();
  const selectCols = salesAccountOrderSelectSql();
  const id = String(register?.id || '').trim();
  const openedAt = register?.opened_at;
  const closedAt = register?.closed_at || null;
  if (!openedAt) return null;

  const eventAtO = paidAtSql('o');
  const baseWhereO = `o.status != 'cancelled'
    AND o.payment_status = 'paid'
    AND IFNULL(o.payment_method, '') NOT IN ('cortesia', 'cuenta_cliente')`;

  if (id) {
    const params = [id, openedAt];
    let endSql = '';
    if (closedAt) {
      endSql = ` AND ${eventAtO} <= ?`;
      params.push(closedAt);
    }
    return {
      sql: `SELECT ${selectCols}
            FROM orders o
            WHERE ${baseWhereO}
              AND IFNULL(o.cash_register_id, '') = ?
              AND ${eventAtO} >= ?${endSql}
            ORDER BY ${eventAtO} ASC`,
      params,
    };
  }

  const params = [openedAt];
  let endSql = '';
  if (closedAt) {
    endSql = ` AND ${eventAtO} <= ?`;
    params.push(closedAt);
  }
  return {
    sql: `SELECT ${selectCols}
          FROM orders o
          WHERE ${baseWhereO}
            AND ${eventAtO} >= ?${endSql}
          ORDER BY ${eventAtO} ASC`,
    params,
  };
}

function emptySalesTotals() {
  return {
    total_sales: 0,
    total_cash: 0,
    total_yape: 0,
    total_plin: 0,
    total_card: 0,
    total_online: 0,
    total_tips: 0,
    ...emptyTipsByMethod(),
    order_count: 0,
  };
}

const TIP_METHOD_FIELDS = ['tips_cash', 'tips_yape', 'tips_plin', 'tips_card', 'tips_online'];

function emptyTipsByMethod() {
  return Object.fromEntries(TIP_METHOD_FIELDS.map((k) => [k, 0]));
}

/** Propina cobrada en efectivo; sin `tips_cash` (datos antiguos) es lo que no se atribuye a otros medios. */
function cashTipsOf(sales) {
  if (sales && sales.tips_cash != null) return Number(sales.tips_cash || 0);
  const nonCash = ['tips_yape', 'tips_plin', 'tips_card', 'tips_online']
    .reduce((s, k) => s + Number(sales?.[k] || 0), 0);
  return Math.max(0, round2(Number(sales?.total_tips || 0) - nonCash));
}

function aggregatePaidOrders(rows) {
  const totals = {
    total_sales: 0,
    total_cash: 0,
    total_yape: 0,
    total_plin: 0,
    total_card: 0,
    total_online: 0,
    total_tips: 0,
    ...emptyTipsByMethod(),
  };
  (rows || []).forEach((row) => {
    addOrderToSalesTotals(row, totals);
  });
  const accountCount = countSalesAccounts(rows || []);
  return {
    total_sales: round2(totals.total_sales),
    total_cash: round2(totals.total_cash),
    total_yape: round2(totals.total_yape),
    total_plin: round2(totals.total_plin),
    total_card: round2(totals.total_card),
    total_online: round2(totals.total_online),
    total_tips: round2(Number(totals.total_tips || 0)),
    ...Object.fromEntries(TIP_METHOD_FIELDS.map((k) => [k, round2(Number(totals[k] || 0))])),
    order_count: accountCount,
    comanda_count: (rows || []).length,
  };
}

function queryRegisterSessionOrderRows(registerOrOpenedAt) {
  const register = normalizeRegisterArg(registerOrOpenedAt);
  const built = buildRegisterSalesSql(register);
  if (!built) return [];
  return queryAll(built.sql, built.params) || [];
}

/** Pedidos pagados de este turno: solo su caja, desde la apertura hasta el cierre. */
function queryRegisterSessionSales(registerOrOpenedAt) {
  return aggregatePaidOrders(queryRegisterSessionOrderRows(registerOrOpenedAt));
}

/** Pedidos pagados dentro de un turno ya cerrado. */
function queryRegisterSessionSalesBetween(openedAt, closedAt, registerId = '') {
  const sales = queryRegisterSessionSales({
    id: registerId,
    opened_at: openedAt,
    closed_at: closedAt,
  });
  return {
    total_sales: sales.total_sales,
    order_count: sales.order_count,
  };
}

function getMovementTotals(registerId) {
  return queryOne(
    `SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as total_expense
     FROM cash_movements
     WHERE register_id = ?`,
    [registerId],
  ) || { total_income: 0, total_expense: 0 };
}

function getCashNoteTotals(registerId) {
  const row = queryOne(
    `SELECT
      COALESCE(SUM(CASE WHEN note_type = 'credit' THEN amount ELSE 0 END), 0) as notes_credit,
      COALESCE(SUM(CASE WHEN note_type = 'debit' THEN amount ELSE 0 END), 0) as notes_debit
     FROM cash_notes
     WHERE register_id = ?`,
    [registerId],
  ) || { notes_credit: 0, notes_debit: 0 };
  return {
    notes_credit: round2(Number(row.notes_credit || 0)),
    notes_debit: round2(Number(row.notes_debit || 0)),
  };
}

/** Efectivo que debe haber en caja al arqueo (solo efectivo físico + propinas en efectivo). */
function computeExpectedCash(register, sales, movements, notes) {
  return round2(
    Number(register?.opening_amount || 0)
      + Number(sales?.total_cash || 0)
      + cashTipsOf(sales)
      + Number(movements?.total_income || 0)
      - Number(movements?.total_expense || 0)
      + Number(notes?.notes_credit || 0)
      - Number(notes?.notes_debit || 0),
  );
}

module.exports = {
  queryRegisterSessionSales,
  queryRegisterSessionOrderRows,
  queryRegisterSessionSalesBetween,
  getMovementTotals,
  getCashNoteTotals,
  computeExpectedCash,
  cashTipsOf,
  get SALES_EVENT_AT_SQL() {
    return paidAtSql('');
  },
};
