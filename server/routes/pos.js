const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryAll, queryOne, runSql, withTransaction, logAudit, ensureOrdersPaymentNoteColumn } = require('../database');
const kardexInventory = require('../services/kardexInventoryService');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { assertPaymentMethodAllowed, normalizePaymentMethod, getPaymentMethodOptionsPayload, isPosTerminalEnabled, isCourtesyDiscountReason, COURTESY_PAYMENT_METHOD } = require('../businessRules');
const { getActiveCajaById, listCajasWithIds, getOpenRegistersOnActiveStations } = require('../cajaSettings');
const { print } = require('../printing/printerService');
const { getOrderWithItems } = require('../orderCreateService');
const { emitInventoryUpdate, emitBillingDocumentUpdate, emitStaffDataUpdate } = require('../socketBroadcast');
const { recordWorkActivityEvent } = require('../services/workActivityTracker');
const {
  parsePaymentBreakdown,
  splitBreakdownAcrossOrders,
  dominantPaymentMethod,
  round2,
} = require('../utils/paymentBreakdown');
const {
  queryRegisterSessionSales,
  getMovementTotals,
  getCashNoteTotals,
  computeExpectedCash,
  SALES_EVENT_AT_SQL,
} = require('../services/registerSessionSales');
const {
  queryPaidSalesOrders,
  countSalesAccounts,
  sumSalesAccountsByHour,
  summarizePaymentMethodsByAccount,
  metricsFromPaidOrdersWhere,
} = require('../utils/salesAccountGrouping');
const { sendCashCloseNotification, getCashCloseRecipient } = require('../services/cashCloseNotifyService');
const { getOrderChargeBase } = require('../utils/orderChargeBase');
const { getOpenRegisterForUser, openStationShift, closeOtherShiftsOfStation, resolveOpenStationForActor } = require('../utils/openCashRegister');
const { materializePartialItemQuantitiesTx } = require('../services/orderItemQuantitySplit');

const router = express.Router();

function roundMoneySoles(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Reparte la propina del cobro entre los pedidos según su total (cuadratura en céntimos). */
function distributeTipAcrossOrders(tipGross, orderTotals) {
  const tip = round2(Math.max(0, Number(tipGross || 0)));
  const n = orderTotals.length;
  if (tip <= 0 || !n) return Array(n).fill(0);
  const T = round2(orderTotals.reduce((acc, ti) => acc + round2(Number(ti) || 0), 0));
  if (T <= 0) {
    const each = round2(tip / n);
    const out = orderTotals.map(() => each);
    const drift = round2(tip - round2(out.reduce((a, b) => a + b, 0)));
    out[0] = round2(out[0] + drift);
    return out;
  }
  const out = orderTotals.map((ti) => {
    const tii = round2(Number(ti) || 0);
    if (tii <= 0) return 0;
    return round2((tip * tii) / T);
  });
  const sumO = round2(out.reduce((a, b) => a + b, 0));
  let drift = round2(tip - sumO);
  if (drift !== 0) {
    let bi = 0;
    let best = -1;
    for (let i = 0; i < n; i += 1) {
      const tii = round2(orderTotals[i] || 0);
      if (tii > best) {
        best = tii;
        bi = i;
      }
    }
    out[bi] = round2(out[bi] + drift);
  }
  return out;
}

function getChargeBase(order, items) {
  return getOrderChargeBase(order, items);
}

function lineItemSubtotal(it) {
  const qty = Number(it.quantity || 0);
  const unit = Number(it.unit_price ?? 0);
  return Number(it.subtotal != null ? it.subtotal : unit * qty);
}

function sumLinesSubtotal(items) {
  return (items || []).reduce((s, it) => s + lineItemSubtotal(it), 0);
}

function bumpOrderSequenceTx(tx) {
  tx.run('UPDATE order_sequence SET current_number = current_number + 1 WHERE id = 1');
  const r = tx.queryOne('SELECT current_number FROM order_sequence WHERE id = 1');
  return Number(r?.current_number || 0);
}

/**
 * Recalcula subtotal/total desde order_items. Si no quedan ítems, borra el pedido (y comprobantes asociados).
 * @returns {boolean} true si el pedido sigue existiendo
 */
function recalcOrderMoneyTx(tx, orderId) {
  const items = tx.queryAll('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  const subtotal = sumLinesSubtotal(items);
  const o = tx.queryOne('SELECT delivery_fee, discount FROM orders WHERE id = ?', [orderId]);
  if (!o) return false;
  if (!items.length) {
    tx.run('DELETE FROM electronic_documents WHERE order_id = ?', [orderId]);
    tx.run('DELETE FROM orders WHERE id = ?', [orderId]);
    return false;
  }
  const delivery = Number(o.delivery_fee || 0);
  const base = Math.max(0, subtotal + delivery);
  const disc = Math.min(Number(o.discount || 0), base);
  const total = Math.max(0, base - disc);
  tx.run(
    `UPDATE orders SET subtotal = ?, tax = 0, discount = ?, total = ?, updated_at = datetime('now') WHERE id = ?`,
    [subtotal, disc, total, orderId]
  );
  return true;
}

function cloneOrderForItemSplitTx(tx, sourceId, newOrderId, newOrderNumber, childDiscount) {
  const saleDocumentNumber = `001-${String(newOrderNumber).padStart(8, '0')}`;
  tx.run(
    `INSERT INTO orders (
      id, order_number, customer_id, customer_name, restaurant_id, type, status,
      subtotal, tax, discount, delivery_fee, total,
      payment_method, payment_status, table_number, delivery_address, delivery_lat, delivery_lng,
      notes, sale_document_type, sale_document_number, created_by_user_id, created_by_user_name,
      delivery_driver_started_at, delivery_driver_completed_at, delivery_route_driver_id,
      delivery_payment_modality, cancellation_reason, payment_breakdown
    )
    SELECT
      ?, ?, customer_id, customer_name, restaurant_id, type, status,
      0, 0, ?, 0, 0,
      payment_method, 'pending', table_number, delivery_address, delivery_lat, delivery_lng,
      notes, sale_document_type, ?, created_by_user_id, created_by_user_name,
      delivery_driver_started_at, delivery_driver_completed_at, delivery_route_driver_id,
      delivery_payment_modality, cancellation_reason, NULL
    FROM orders WHERE id = ?`,
    [newOrderId, newOrderNumber, childDiscount, saleDocumentNumber, sourceId]
  );
}

/**
 * Mueve líneas seleccionadas a un pedido nuevo y devuelve el id del pedido a cobrar (el nuevo).
 * Reparte el descuento previo del pedido fuente entre padre e hijo según subtotales de líneas.
 */
function splitOrderItemsForPartialCheckoutTx(tx, sourceOrderId, selectedItemIds) {
  const order = tx.queryOne('SELECT * FROM orders WHERE id = ?', [sourceOrderId]);
  if (!order) throw new Error(`Pedido no encontrado: ${sourceOrderId}`);
  if (order.status === 'cancelled') throw new Error(`Pedido anulado: ${order.order_number}`);
  if (order.status === 'delivered' && order.payment_status === 'paid') {
    throw new Error(`El pedido #${order.order_number} ya está cobrado`);
  }

  const allItems = tx.queryAll('SELECT * FROM order_items WHERE order_id = ?', [sourceOrderId]);
  const selSet = new Set(selectedItemIds);
  const moving = allItems.filter((it) => selSet.has(it.id));
  if (!moving.length) throw new Error('No hay líneas seleccionadas para dividir');
  if (moving.length === allItems.length) return sourceOrderId;

  const oldSub = sumLinesSubtotal(allItems);
  const childSub = sumLinesSubtotal(moving);
  const oldDisc = Number(order.discount || 0);
  const childDisc = oldSub > 0 ? round2(oldDisc * (childSub / oldSub)) : 0;
  const parentDisc = round2(Math.max(0, oldDisc - childDisc));

  const newOrderId = uuidv4();
  const newOrderNumber = bumpOrderSequenceTx(tx);
  cloneOrderForItemSplitTx(tx, sourceOrderId, newOrderId, newOrderNumber, childDisc);

  const ph = moving.map(() => '?').join(',');
  tx.run(`UPDATE order_items SET order_id = ? WHERE id IN (${ph})`, [newOrderId, ...moving.map((m) => m.id)]);

  tx.run('UPDATE orders SET discount = ? WHERE id = ?', [parentDisc, sourceOrderId]);
  recalcOrderMoneyTx(tx, sourceOrderId);
  recalcOrderMoneyTx(tx, newOrderId);

  return newOrderId;
}

/**
 * A partir de order_item_ids (+ cantidades opcionales), prepara pedidos a cobrar
 * (divide cantidad parcial y/o pedidos parciales en uno nuevo).
 */
function prepareCheckoutOrderIdsFromItemLinesTx(tx, orderItemIdsRaw, quantitiesByItemId = {}) {
  let uniq = [...new Set((orderItemIdsRaw || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uniq.length) throw new Error('Debes enviar al menos una línea de producto para cobrar');

  const ph = uniq.map(() => '?').join(',');
  const rows = tx.queryAll(
    `SELECT oi.id as item_id, oi.order_id, oi.quantity as item_qty,
            o.status as order_status, o.payment_status, o.order_number
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.id IN (${ph})`,
    uniq
  );
  // Sync offline: tras eliminar productos, pueden quedar IDs viejos en la cola.
  // Cobramos solo las líneas que aún existen; no bloqueamos toda la sincronización.
  if (!rows.length) {
    const err = new Error('Una o más líneas de pedido no existen o no coinciden');
    err.code = 'STALE_ORDER_ITEMS';
    throw err;
  }
  if (rows.length !== uniq.length) {
    uniq = rows.map((r) => String(r.item_id));
  }

  const byOrder = new Map();
  for (const r of rows) {
    if (r.order_status === 'cancelled') {
      throw new Error(`No puedes cobrar ítems del pedido anulado #${r.order_number}`);
    }
    if (r.order_status === 'delivered' && r.payment_status === 'paid') {
      throw new Error(`El pedido #${r.order_number} ya está cobrado`);
    }
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r.item_id);
  }

  const qtyMap = quantitiesByItemId && typeof quantitiesByItemId === 'object' ? quantitiesByItemId : {};

  const chargeIds = [];
  for (const [orderId, itemIdsForOrder] of byOrder) {
    const allItems = tx.queryAll('SELECT id, quantity FROM order_items WHERE order_id = ?', [orderId]);
    const allFullSelected =
      allItems.length > 0 &&
      allItems.every((row) => {
        if (!uniq.includes(row.id)) return false;
        const maxQ = Math.max(1, Math.floor(Number(row.quantity) || 1));
        const raw = qtyMap[row.id];
        const chargeQ = raw == null || raw === '' ? maxQ : Math.floor(Number(raw));
        return Number.isFinite(chargeQ) && chargeQ >= maxQ;
      });

    if (allFullSelected) {
      chargeIds.push(orderId);
    } else {
      const movingIds = materializePartialItemQuantitiesTx(tx, orderId, itemIdsForOrder, qtyMap);
      const newId = splitOrderItemsForPartialCheckoutTx(tx, orderId, movingIds);
      chargeIds.push(newId);
    }
  }
  return [...new Set(chargeIds)];
}

function buildExtraDiscountsByOrderTx(tx, orderIds, totalExtraRaw, anchorOrderItemId) {
  const out = {};
  const orderList = [...new Set(orderIds)];
  orderList.forEach((id) => {
    out[id] = 0;
  });
  const t = round2(Math.max(0, Number(totalExtraRaw || 0)));
  if (t <= 0 || !orderList.length) return out;

  const anchor = String(anchorOrderItemId || '').trim();
  if (anchor) {
    const row = tx.queryOne('SELECT order_id FROM order_items WHERE id = ?', [anchor]);
    const oid = row?.order_id ? String(row.order_id) : '';
    if (oid && orderList.includes(oid)) {
      const o = tx.queryOne('SELECT * FROM orders WHERE id = ?', [oid]);
      const items = tx.queryAll('SELECT quantity, unit_price, subtotal FROM order_items WHERE order_id = ?', [oid]);
      const cap = getChargeBase(o, items);
      out[oid] = Math.max(0, Math.min(t, cap));
      return out;
    }
  }

  const weights = orderList.map((id) => {
    const o = tx.queryOne('SELECT * FROM orders WHERE id = ?', [id]);
    const items = tx.queryAll('SELECT quantity, unit_price, subtotal FROM order_items WHERE order_id = ?', [id]);
    return { id, w: getChargeBase(o, items) };
  });
  const sumW = round2(weights.reduce((s, x) => s + x.w, 0));
  if (sumW <= 0) return out;

  let remaining = t;
  weights.forEach((row, idx) => {
    const isLast = idx === weights.length - 1;
    const raw = isLast ? Math.min(row.w, remaining) : round2(t * (row.w / sumW));
    const extra = Math.max(0, Math.min(row.w, raw));
    out[row.id] = extra;
    remaining = round2(remaining - extra);
  });
  return out;
}

function getOpenRegister(userId) {
  return queryOne(
    `SELECT * FROM cash_registers
     WHERE user_id = ? AND closed_at IS NULL
     ORDER BY datetime(opened_at) DESC
     LIMIT 1`,
    [userId],
  );
}

/**
 * Multimétodo con vuelto: si el desglose excede el total, el excedente se descuenta del efectivo
 * (vuelto entregado). Los métodos que no son efectivo no pueden superar el total.
 */
function applyCashChangeToBreakdown(breakdown, total) {
  const t = round2(total);
  const sum = round2(Object.values(breakdown).reduce((acc, v) => acc + round2(Number(v) || 0), 0));
  const excess = round2(sum - t);
  if (excess <= 0.05) return;
  const cash = round2(Number(breakdown.efectivo) || 0);
  if (cash <= 0 || excess - cash > 0.05) {
    throw new Error('Los pagos sin efectivo superan el total a cobrar. Solo el efectivo puede dar vuelto.');
  }
  const applied = round2(cash - excess);
  if (applied > 0) breakdown.efectivo = applied;
  else delete breakdown.efectivo;
}

function pickRegisterId(req) {
  const q = String(req.query?.register_id || '').trim();
  if (q) return q;
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.register_id : undefined;
  return String(b || '').trim();
}

/**
 * Cajero: su turno abierto o el de su caja asignada aunque lo haya abierto otro usuario
 * (no acepta register_id de la URL).
 * Admin: si envía register_id, opera esa sesión (cualquier usuario); si no, solo la suya propia.
 */
/** Un turno solo opera caja si su estación sigue activa. Si no, el mapa y el monitoreo coinciden: no hay turno. */
function onlyActiveStationRegister(register) {
  if (!register) return null;
  const sid = String(register.caja_station_id || '').trim();
  if (!getActiveCajaById(sid)) return null;
  return register;
}

function resolvePosRegister(req) {
  const user = req.user;
  const role = String(user?.role || '').toLowerCase();
  if (role === 'cajero') {
    return getOpenRegisterForUser(user);
  }
  if (role === 'admin' || role === 'master_admin') {
    const rid = pickRegisterId(req);
    if (rid) {
      return onlyActiveStationRegister(
        queryOne('SELECT * FROM cash_registers WHERE id = ? AND closed_at IS NULL', [rid]) || null,
      );
    }
    return onlyActiveStationRegister(getOpenRegister(user.id) || null);
  }
  return onlyActiveStationRegister(getOpenRegister(user.id) || null);
}

/**
 * Ingresos/egresos/notas: si el cliente indica el turno (register_id) y ya no es el abierto
 * (p. ej. cola offline sincronizada tras el cierre), se rechaza para no cargarlo a otro turno.
 */
function resolveCashFlowRegister(req) {
  const register = resolvePosRegister(req);
  const rid = pickRegisterId(req);
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'cajero' && rid && register && String(register.id) !== rid) {
    return { register: null, error: 'Solo puede registrar movimientos en su caja' };
  }
  if (rid && (!register || String(register.id) !== rid)) {
    return {
      register: null,
      error: 'El turno de caja indicado ya no está abierto. Registre el movimiento en el turno actual.',
    };
  }
  if (!register) return { register: null, error: 'No tienes una caja abierta' };
  return { register, error: null };
}

function buildRegisterSnapshot(register) {
  const sales = queryRegisterSessionSales(register);
  const movements = getMovementTotals(register.id);
  const notes = getCashNoteTotals(register.id);
  const expectedCash = roundMoneySoles(computeExpectedCash(register, sales, movements, notes));
  return { sales, movements, notes, expectedCash };
}

router.get('/caja-stations', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  let stations = listCajasWithIds().filter((c) => c.active);
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'cajero') {
    const row = queryOne('SELECT caja_station_id FROM users WHERE id = ?', [req.user.id]);
    const sid = String(row?.caja_station_id || '').trim();
    stations = sid ? stations.filter((s) => s.id === sid) : [];
  }
  const bySid = new Map(
    getOpenRegistersOnActiveStations().map((row) => [
      String(row.caja_station_id || '').trim(),
      {
        id: row.id,
        user_id: row.user_id,
        caja_station_id: row.caja_station_id,
        opened_at: row.opened_at,
        cajero_name: row.user_name || '',
      },
    ]),
  );
  res.json({
    stations: stations.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      open_register: bySid.get(s.id) || null,
    })),
  });
});

router.post('/open-register', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { opening_amount } = req.body || {};
  if (opening_amount === undefined || opening_amount === null || Number.isNaN(Number(opening_amount))) {
    return res.status(400).json({ error: 'Debes ingresar el monto inicial de caja' });
  }
  if (Number(opening_amount) < 0) {
    return res.status(400).json({ error: 'El monto inicial no puede ser negativo' });
  }

  const dbUser = queryOne('SELECT role, caja_station_id FROM users WHERE id = ?', [req.user.id]);
  const role = String(dbUser?.role || req.user.role || '').toLowerCase();
  const requested = String(req.body?.caja_station_id || '').trim();
  const decision = resolveOpenStationForActor({
    role,
    assignedStationId: dbUser?.caja_station_id,
    requestedStationId: requested,
    isActiveStation: Boolean(requested && getActiveCajaById(requested)),
  });
  if (decision.error) return res.status(decision.status).json({ error: decision.error });
  const stationId = decision.stationId;

  const restaurant = queryOne('SELECT id FROM restaurants LIMIT 1');
  const opened = openStationShift({
    stationId,
    openerUserId: req.user.id,
    openingAmount: Number(opening_amount),
    restaurantId: restaurant?.id,
  });
  if (opened.already_open) {
    return res.json({ ...opened.register, already_open: true });
  }
  const id = opened.register.id;
  /** Nuevo turno de caja: la numeración de pedidos vuelve a empezar desde #1. */
  runSql('UPDATE order_sequence SET current_number = 0 WHERE id = 1');
  logAudit({
    actorUserId: req.user.id,
    actorName: req.user.full_name || req.user.username || '',
    action: 'cash_register.open',
    resourceType: 'cash_register',
    resourceId: id,
    details: { opening_amount: Number(opening_amount), caja_station_id: stationId },
  });
  const io = req.app.get('io');
  if (io) io.emit('register-update', { action: 'open', registerId: id, caja_station_id: stationId });
  res.status(201).json(queryOne('SELECT * FROM cash_registers WHERE id = ?', [id]));
});

router.get('/current-register', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const register = resolvePosRegister(req);
    if (!register) return res.json(null);

    const { sales, movements, notes, expectedCash } = buildRegisterSnapshot(register);

    res.json({ ...register, ...sales, ...movements, ...notes, expected_cash: expectedCash });
  } catch (err) {
    console.error('[pos/current-register]', err?.message || err);
    return res.status(500).json({ error: err.message || 'No se pudo leer el turno de caja' });
  }
});

/** Solo administrador maestro: corrige el monto de apertura de un turno aún abierto. */
router.put('/register/:id/opening-amount', authenticateToken, (req, res) => {
  if (String(req.user?.role || '').toLowerCase() !== 'master_admin') {
    return res.status(403).json({ error: 'Solo el administrador maestro puede editar el monto de apertura' });
  }
  const raw = req.body?.opening_amount;
  if (raw === undefined || raw === null || raw === '' || Number.isNaN(Number(raw))) {
    return res.status(400).json({ error: 'Ingrese un monto de apertura válido' });
  }
  const nextAmount = roundMoneySoles(Number(raw));
  if (nextAmount < 0) {
    return res.status(400).json({ error: 'El monto de apertura no puede ser negativo' });
  }
  const registerId = String(req.params.id || '').trim();
  const register = queryOne('SELECT * FROM cash_registers WHERE id = ?', [registerId]);
  if (!register) return res.status(404).json({ error: 'Turno de caja no encontrado' });
  if (register.closed_at) {
    return res.status(400).json({ error: 'El turno ya está cerrado; solo se puede editar un turno abierto' });
  }
  const previousAmount = Number(register.opening_amount || 0);
  runSql('UPDATE cash_registers SET opening_amount = ? WHERE id = ?', [nextAmount, registerId]);
  logAudit({
    actorUserId: req.user.id,
    actorName: req.user.full_name || req.user.username || '',
    action: 'cash_register.opening_amount_edit',
    resourceType: 'cash_register',
    resourceId: registerId,
    details: { previous_opening_amount: previousAmount, opening_amount: nextAmount },
  });
  const io = req.app.get('io');
  if (io) io.emit('register-update', { action: 'opening-edit', registerId });

  const updated = queryOne('SELECT * FROM cash_registers WHERE id = ?', [registerId]);
  try {
    const { sales, movements, notes, expectedCash } = buildRegisterSnapshot(updated);
    return res.json({ ...updated, ...sales, ...movements, ...notes, expected_cash: expectedCash });
  } catch (_) {
    return res.json(updated);
  }
});

router.post('/close-register', authenticateToken, requireRole('admin', 'cajero'), async (req, res) => {
  try {
  const { closing_amount, notes: closingNotesText, arqueo } = req.body;
  const register = resolvePosRegister(req);
  if (!register) return res.status(400).json({ error: 'No tienes una caja abierta' });
  if (closing_amount === undefined || closing_amount === null || Number.isNaN(Number(closing_amount))) {
    return res.status(400).json({ error: 'Debes ingresar el efectivo contado para cerrar caja' });
  }
  if (Number(closing_amount) < 0) {
    return res.status(400).json({ error: 'El efectivo contado no puede ser negativo' });
  }

  let sales;
  let movements;
  let cashNotes;
  let expectedCash;
  try {
    ({ sales, movements, notes: cashNotes, expectedCash } = buildRegisterSnapshot(register));
  } catch (err) {
    console.error('[pos/close-register] snapshot', err?.message || err);
    return res.status(500).json({
      error: 'No se pudieron calcular las ventas del turno. No cierre caja hasta reintentar.',
    });
  }
  const countedCash = roundMoneySoles(Number(closing_amount));
  const diff = roundMoneySoles(countedCash - expectedCash);
  const closedAtIso = new Date().toISOString();
  const { computeRegisterBusinessDateKey } = require('../utils/registerBusinessDate');
  const businessDate = computeRegisterBusinessDateKey(register.opened_at, closedAtIso, queryOne);
  const denominationSummary = arqueo?.denominations || {};
  const nonCashExpectedBy = {
    yape: roundMoneySoles(Number(sales.total_yape || 0) + Number(sales.tips_yape || 0)),
    plin: roundMoneySoles(Number(sales.total_plin || 0) + Number(sales.tips_plin || 0)),
    tarjeta: roundMoneySoles(Number(sales.total_card || 0) + Number(sales.tips_card || 0)),
    online: roundMoneySoles(Number(sales.total_online || 0) + Number(sales.tips_online || 0)),
  };
  const nonCashCounted = {};
  for (const [method, raw] of Object.entries(arqueo?.non_cash_counted || {})) {
    if (!(method in nonCashExpectedBy) || raw === '' || raw == null || Number.isNaN(Number(raw))) continue;
    const counted = roundMoneySoles(Math.max(0, Number(raw)));
    const expected = roundMoneySoles(nonCashExpectedBy[method]);
    nonCashCounted[method] = { expected, counted, difference: roundMoneySoles(counted - expected) };
  }
  const nonCashExpectedTotal = roundMoneySoles(Object.values(nonCashExpectedBy).reduce((s, v) => s + v, 0));
  const rawTotalPos = arqueo?.non_cash_total_pos;
  const nonCashTotalPos = rawTotalPos === '' || rawTotalPos == null || Number.isNaN(Number(rawTotalPos))
    ? null
    : roundMoneySoles(Math.max(0, Number(rawTotalPos)));
  const nonCashCountedTotal = nonCashTotalPos != null
    ? nonCashTotalPos
    : roundMoneySoles(
      Object.entries(nonCashExpectedBy).reduce(
        (s, [m, exp]) => s + (nonCashCounted[m] ? nonCashCounted[m].counted : exp),
        0,
      ),
    );
  const arqueoData = JSON.stringify({
    register_id: register.id,
    opened_at: register.opened_at,
    opening_amount: Number(register.opening_amount || 0),
    expected_cash: expectedCash,
    counted_cash: countedCash,
    difference: diff,
    denominations: denominationSummary,
    non_cash_check: nonCashCounted,
    non_cash_total_pos: nonCashTotalPos != null
      ? { expected: nonCashExpectedTotal, counted: nonCashTotalPos, difference: roundMoneySoles(nonCashTotalPos - nonCashExpectedTotal) }
      : null,
    total_check: {
      expected: roundMoneySoles(expectedCash + nonCashExpectedTotal),
      counted: roundMoneySoles(countedCash + nonCashCountedTotal),
      difference: roundMoneySoles(countedCash + nonCashCountedTotal - expectedCash - nonCashExpectedTotal),
    },
    payment_breakdown: {
      efectivo: Number(sales.total_cash || 0),
      yape: Number(sales.total_yape || 0),
      plin: Number(sales.total_plin || 0),
      tarjeta: Number(sales.total_card || 0),
      online: Number(sales.total_online || 0),
    },
    cash_movements: {
      income: Number(movements.total_income || 0),
      expense: Number(movements.total_expense || 0),
    },
    cash_notes: {
      credit: Number(cashNotes.notes_credit || 0),
      debit: Number(cashNotes.notes_debit || 0),
    },
    total_sales: Number(sales.total_sales || 0),
    total_tips: Number(sales.total_tips || 0),
    tips_by_method: {
      efectivo: Number(sales.tips_cash || 0),
      yape: Number(sales.tips_yape || 0),
      plin: Number(sales.tips_plin || 0),
      tarjeta: Number(sales.tips_card || 0),
      online: Number(sales.tips_online || 0),
    },
    order_count: Number(sales.order_count || 0),
    observations: arqueo?.observations || closingNotesText || '',
    closed_by: req.user.id,
    closed_by_name: req.user.full_name,
    closed_at: closedAtIso,
  });

  runSql("UPDATE cash_registers SET closed_at = datetime('now'), closing_amount = ?, total_sales = ?, total_cash = ?, total_yape = ?, total_plin = ?, total_card = ?, notes = ?, arqueo_data = ?, business_date = ? WHERE id = ?",
    [countedCash, sales.total_sales, sales.total_cash, sales.total_yape, sales.total_plin, sales.total_card, closingNotesText || '', arqueoData, businessDate, register.id]);
  const stationId = String(register.caja_station_id || '').trim();
  closeOtherShiftsOfStation(register.id, stationId);
  /** Cierre de caja: reinicio de numeración para el próximo turno / apertura. */
  runSql('UPDATE order_sequence SET current_number = 0 WHERE id = 1');
  logAudit({
    actorUserId: req.user.id,
    actorName: req.user.full_name || req.user.username || '',
    action: 'cash_register.close',
    resourceType: 'cash_register',
    resourceId: register.id,
    details: { closing_amount: countedCash, expected_cash: expectedCash, difference: diff },
  });

  const closedRegister = queryOne('SELECT * FROM cash_registers WHERE id = ?', [register.id]);

  const io = req.app.get('io');
  if (io) io.emit('register-update', { action: 'close', registerId: register.id, caja_station_id: stationId });

  res.json(closedRegister);

  const stationRow = listCajasWithIds().find((c) => c.id === stationId);
  const responsible = queryOne('SELECT full_name FROM users WHERE id = ?', [register.user_id]);
  sendCashCloseNotification({
    register: closedRegister || register,
    sales,
    movements,
    expectedCash,
    countedCash,
    difference: diff,
    notes: closingNotesText || '',
    closedByName: req.user.full_name || req.user.username || '',
    stationName: stationRow?.name || stationId,
    responsibleName: String(responsible?.full_name || '').trim(),
  }).catch((notifyErr) => {
    console.error('[close-register] aviso externo fallido:', notifyErr.message);
  });
  } catch (err) {
    console.error('[pos/close-register]', err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'No se pudo cerrar caja. Reintente.' });
    }
  }
});

router.post('/send-close-email', authenticateToken, requireRole('admin', 'cajero'), async (req, res) => {
  const { closing_amount, notes: closingNotesText, arqueo } = req.body || {};
  const register = resolvePosRegister(req);
  if (!register) return res.status(400).json({ error: 'No tienes una caja abierta' });
  if (closing_amount === undefined || closing_amount === null || Number.isNaN(Number(closing_amount))) {
    return res.status(400).json({ error: 'Debes ingresar el efectivo contado para enviar el reporte' });
  }
  if (Number(closing_amount) < 0) {
    return res.status(400).json({ error: 'El efectivo contado no puede ser negativo' });
  }

  const { sales, movements, expectedCash } = buildRegisterSnapshot(register);
  const countedCash = roundMoneySoles(Number(closing_amount));
  const diff = roundMoneySoles(countedCash - expectedCash);

  try {
    const { email } = getCashCloseRecipient();
    const stationId = String(register.caja_station_id || '').trim();
    const stationRow = listCajasWithIds().find((c) => c.id === stationId);
    const responsible = queryOne('SELECT full_name FROM users WHERE id = ?', [register.user_id]);
    const result = await sendCashCloseNotification({
      register,
      sales,
      movements,
      expectedCash,
      countedCash,
      difference: diff,
      notes: String(arqueo?.observations || closingNotesText || '').trim(),
      closedByName: req.user.full_name || req.user.username || '',
      stationName: stationRow?.name || stationId,
      responsibleName: String(responsible?.full_name || '').trim(),
    });
    if (result?.skipped) {
      return res.json({
        success: false,
        skipped: true,
        message: 'El aviso de cierre está desactivado. No se envió correo.',
      });
    }
    if (result?.warning) {
      return res.json({
        success: true,
        message: `Reporte enviado vía Formspree. Para recibirlo en ${email}, configure SMTP en el servidor.`,
        notify_email: email,
        notify_warning: result.warning,
      });
    }
    return res.json({
      success: true,
      message: `Reporte enviado a ${result?.to || email}`,
      notify_email: result?.to || email,
      notify_channel: result?.channel,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'No se pudo enviar el reporte por correo' });
  }
});

router.post('/checkout-table', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const body = req.body || {};
  const {
    order_ids: orderIdsRaw,
    payment_method: paymentMethodRaw,
    payment_breakdown: paymentBreakdownBody,
    discount_reason: discountReason = '',
    discounts_by_order: discountsByOrderBody = {},
    order_item_ids: orderItemIdsBody,
    order_item_quantities: orderItemQuantitiesBody,
    checkout_discount_total: checkoutDiscountTotalRaw,
    checkout_discount_anchor_order_item_id: checkoutDiscountAnchorItemRaw,
    tip_amount: tipAmountRaw,
    charge_to_customer_account: chargeToAccountRaw,
    customer_id: customerIdRaw,
    payment_note: paymentNoteRaw,
  } = body;
  const paymentNote = String(paymentNoteRaw || '').trim().slice(0, 300);
  const canSavePaymentNote = paymentNote ? ensureOrdersPaymentNoteColumn() : false;
  const chargeToCustomerAccount = chargeToAccountRaw === true || chargeToAccountRaw === 1 || chargeToAccountRaw === '1';
  const customerIdForAccount = String(customerIdRaw || '').trim();
  const orderItemIds = [
    ...new Set(
      (Array.isArray(orderItemIdsBody) ? orderItemIdsBody : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    ),
  ];
  const orderItemQuantities = {};
  if (orderItemQuantitiesBody && typeof orderItemQuantitiesBody === 'object' && !Array.isArray(orderItemQuantitiesBody)) {
    for (const [k, v] of Object.entries(orderItemQuantitiesBody)) {
      const id = String(k || '').trim();
      const q = Math.floor(Number(v));
      if (id && Number.isFinite(q) && q > 0) orderItemQuantities[id] = q;
    }
  }
  const orderIdsFromBody = Array.isArray(orderIdsRaw) ? orderIdsRaw.filter(Boolean) : [];
  const checkoutDiscountTotal = Math.max(0, Number(checkoutDiscountTotalRaw || 0));
  const checkoutDiscountAnchorOrderItemId = String(checkoutDiscountAnchorItemRaw || '').trim();
  const discountsByOrderInput =
    discountsByOrderBody && typeof discountsByOrderBody === 'object' && !Array.isArray(discountsByOrderBody)
      ? { ...discountsByOrderBody }
      : {};

  if (!orderItemIds.length && !orderIdsFromBody.length) {
    return res.status(400).json({ error: 'Debes enviar pedidos o líneas de producto para cobrar' });
  }

  const discountReasonText = String(discountReason || '').trim();
  const isCourtesyCheckout = isCourtesyDiscountReason(discountReasonText);
  const hasExplicitCheckoutDiscount = checkoutDiscountTotal > 0;
  const hasDiscountsByOrder = Object.values(discountsByOrderInput).some((v) => Number(v) > 0);
  if ((hasExplicitCheckoutDiscount || hasDiscountsByOrder || isCourtesyCheckout) && discountReasonText.length < 3) {
    return res.status(400).json({ error: 'Debe indicar el motivo del descuento o cortesía (mínimo 3 caracteres)' });
  }

  let paymentBreakdownObj = null;
  if (paymentBreakdownBody != null && typeof paymentBreakdownBody === 'object' && !Array.isArray(paymentBreakdownBody)) {
    paymentBreakdownObj = parsePaymentBreakdown(JSON.stringify(paymentBreakdownBody));
  } else if (typeof paymentBreakdownBody === 'string' && paymentBreakdownBody.trim()) {
    paymentBreakdownObj = parsePaymentBreakdown(paymentBreakdownBody);
  }

  const paymentMethod = normalizePaymentMethod(paymentMethodRaw, { allowOnline: true, fallback: 'efectivo' });
  const register = resolvePosRegister(req);
  if (!register) return res.status(400).json({ error: 'No tienes una caja abierta para cobrar' });

  const formatCheckoutSoles = (n) => `S/ ${Number(n || 0).toFixed(2)}`;

  let accountCustomer = null;
  if (chargeToCustomerAccount) {
    if (!customerIdForAccount) {
      return res.status(400).json({ error: 'Seleccione un cliente de Mi Clientes' });
    }
    accountCustomer = queryOne('SELECT id, name FROM customers WHERE id = ?', [customerIdForAccount]);
    if (!accountCustomer) return res.status(400).json({ error: 'Cliente no encontrado en Mi Clientes' });
  } else if (paymentBreakdownObj) {
    try {
      for (const k of Object.keys(paymentBreakdownObj)) {
        assertPaymentMethodAllowed(k, { allowOnline: true });
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else if (!isCourtesyCheckout) {
    try {
      assertPaymentMethodAllowed(paymentMethod, { allowOnline: true });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    const txResult = withTransaction((tx) => {
      let effectiveOrderIds;
      let discountsByOrder = { ...discountsByOrderInput };

      if (orderItemIds.length) {
        try {
          effectiveOrderIds = prepareCheckoutOrderIdsFromItemLinesTx(tx, orderItemIds, orderItemQuantities);
        } catch (prepErr) {
          // Cola offline: líneas eliminadas / IDs regenerados → cobrar pedidos enteros si vinieron.
          if (prepErr?.code === 'STALE_ORDER_ITEMS' && orderIdsFromBody.length) {
            effectiveOrderIds = orderIdsFromBody;
          } else if (prepErr?.code === 'STALE_ORDER_ITEMS') {
            // Nada que cobrar con esos IDs: no bloquear sync (efecto ya aplicado en cliente o líneas borradas).
            return {
              chargedOrderIds: [],
              discountsAppliedByOrder: {},
              skipped_stale_items: true,
            };
          } else {
            throw prepErr;
          }
        }
        if ((!effectiveOrderIds || !effectiveOrderIds.length) && orderIdsFromBody.length) {
          effectiveOrderIds = orderIdsFromBody;
        }
        discountsByOrder = buildExtraDiscountsByOrderTx(
          tx,
          effectiveOrderIds,
          checkoutDiscountTotal,
          checkoutDiscountAnchorOrderItemId
        );
      } else {
        // Cobro de cuenta de mesa completa: incluir todas las comandas pendientes de esa mesa.
        const { expandPendingTableOrderIdsTx } = require('../services/saleNumberService');
        effectiveOrderIds = expandPendingTableOrderIdsTx(tx, orderIdsFromBody);
      }

      const chargedRows = [];
      const discountsAppliedByOrder = {};

      [...new Set(effectiveOrderIds)].forEach((orderId) => {
        const order = tx.queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
        if (!order) throw new Error(`Pedido no encontrado: ${orderId}`);
        if (order.status === 'cancelled') throw new Error(`No puedes cobrar un pedido anulado: ${order.order_number}`);
        if (order.status === 'delivered' && order.payment_status === 'paid') {
          return;
        }
        if (String(order.payment_status || '').toLowerCase() === 'paid') {
          return;
        }
        const extraDiscountRaw = Math.max(0, Number(discountsByOrder[orderId] || 0));
        let extraDiscount = extraDiscountRaw;
        if (isCourtesyCheckout) {
          const items = tx.queryAll('SELECT quantity, unit_price, subtotal FROM order_items WHERE order_id = ?', [orderId]);
          const baseTotal = getChargeBase(order, items);
          extraDiscount = Math.max(extraDiscount, Math.max(0, baseTotal - Number(order.discount || 0)));
        }
        if (extraDiscount > 0) {
          discountsAppliedByOrder[orderId] = extraDiscount;
          const items = tx.queryAll('SELECT quantity, unit_price, subtotal FROM order_items WHERE order_id = ?', [orderId]);
          const baseTotal = getChargeBase(order, items);
          const nextDiscount = Math.max(0, Math.min(baseTotal, Number(order.discount || 0) + extraDiscount));
          const nextTotal = Math.max(0, baseTotal - nextDiscount);
          const note = discountReasonText ? ` [DESCUENTO: ${discountReasonText}]` : '';
          tx.run(
            "UPDATE orders SET discount = ?, total = ?, notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?",
            [nextDiscount, nextTotal, note, order.id]
          );
        }
        const refreshed = tx.queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
        chargedRows.push({ id: orderId, total: round2(Number(refreshed?.total || 0)) });
      });

      const toCharge = chargedRows;
      if (!toCharge.length && effectiveOrderIds.length) {
        const replayIds = [...new Set(effectiveOrderIds)].filter((id) => {
          const o = tx.queryOne('SELECT payment_status FROM orders WHERE id = ?', [id]);
          return String(o?.payment_status || '').toLowerCase() === 'paid';
        });
        if (replayIds.length === [...new Set(effectiveOrderIds)].length) {
          const { assignSaleNumberToOrderIdsTx, unifyTableSaleNumbersTx } = require('../services/saleNumberService');
          assignSaleNumberToOrderIdsTx(tx, replayIds);
          unifyTableSaleNumbersTx(tx, replayIds);
          return { chargedOrderIds: replayIds, discountsAppliedByOrder, replayed: true };
        }
      }
      const batchTotal = round2(toCharge.reduce((s, r) => s + r.total, 0));

      let primaryMethod = isCourtesyCheckout ? COURTESY_PAYMENT_METHOD : paymentMethod;
      let perOrderBreakdown = null;

      if (isCourtesyCheckout) {
        if (batchTotal > 0.05) {
          throw new Error('La cortesía debe dejar el total en S/ 0.00. Revise el descuento aplicado.');
        }
      } else if (paymentBreakdownObj) {
        applyCashChangeToBreakdown(paymentBreakdownObj, batchTotal);
        if (Object.keys(paymentBreakdownObj).length < 2) {
          throw new Error('Los otros métodos ya cubren el total: cobre con un solo método.');
        }
        const splitSum = round2(
          Object.values(paymentBreakdownObj).reduce((acc, v) => acc + round2(Number(v) || 0), 0)
        );
        if (Math.abs(splitSum - batchTotal) > 0.05) {
          throw new Error(
            `El multipago (${formatCheckoutSoles(splitSum)}) debe coincidir con el total a cobrar (${formatCheckoutSoles(batchTotal)})`
          );
        }
        primaryMethod = dominantPaymentMethod(paymentBreakdownObj);
        perOrderBreakdown = splitBreakdownAcrossOrders(
          paymentBreakdownObj,
          toCharge.map((r) => r.total),
          batchTotal
        );
      }

      const tipGross = isCourtesyCheckout ? 0 : round2(Math.max(0, Number(tipAmountRaw || 0)));
      const tipsPerOrder = distributeTipAcrossOrders(tipGross, toCharge.map((r) => r.total));

      const chargedOrderIds = [];
      toCharge.forEach((row, idx) => {
        const br = perOrderBreakdown ? perOrderBreakdown[idx] : null;
        const tipForOrder = round2(Number(tipsPerOrder[idx] || 0));
        const current = tx.queryOne('SELECT status FROM orders WHERE id = ?', [row.id]);
        const st = String(current?.status || '');
        let nextStatus = 'delivered';
        if (chargeToCustomerAccount && ['pending', 'preparing', 'ready'].includes(st)) {
          nextStatus = st;
        }
        if (chargeToCustomerAccount) {
          tx.run(
            `UPDATE orders SET payment_method = 'cuenta_cliente', payment_status = 'pending', status = ?,
              customer_id = ?, customer_name = ?, payment_breakdown = NULL, tip_amount = 0, updated_at = datetime('now') WHERE id = ?`,
            [nextStatus, accountCustomer.id, accountCustomer.name, row.id]
          );
        } else {
          tx.run(
            `UPDATE orders SET payment_method = ?, payment_status = 'paid', status = ?,
              payment_breakdown = ?, tip_amount = ?, cash_register_id = ?,
              paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
            [primaryMethod, nextStatus, br, tipForOrder, register.id, row.id]
          );
          if (primaryMethod !== COURTESY_PAYMENT_METHOD) {
            tx.run(
              "UPDATE electronic_documents SET payment_method = ?, updated_at = datetime('now') WHERE order_id = ?",
              [primaryMethod, row.id]
            );
          }
        }
        if (canSavePaymentNote) {
          tx.run('UPDATE orders SET payment_note = ? WHERE id = ?', [paymentNote, row.id]);
        }
        kardexInventory.aplicarSalidasVentaPedido(
          tx,
          row.id,
          req.user.id,
          tx.queryOne('SELECT COALESCE(updated_at, created_at) AS event_at FROM orders WHERE id = ?', [row.id])?.event_at
        );
        chargedOrderIds.push(row.id);
      });

      if (!chargeToCustomerAccount && chargedOrderIds.length) {
        const { assignSaleNumberToOrderIdsTx, unifyTableSaleNumbersTx } = require('../services/saleNumberService');
        const saleN = assignSaleNumberToOrderIdsTx(tx, chargedOrderIds);
        unifyTableSaleNumbersTx(tx, chargedOrderIds);
        if (saleN > 0) {
          const docNum = `001-${String(saleN).padStart(8, '0')}`;
          const ph = chargedOrderIds.map(() => '?').join(',');
          tx.run(
            `UPDATE orders SET sale_document_number = ?
             WHERE id IN (${ph})
               AND IFNULL(NULLIF(trim(sale_document_type), ''), 'nota_venta') = 'nota_venta'`,
            [docNum, ...chargedOrderIds],
          );
        }
      }

      return { chargedOrderIds, discountsAppliedByOrder };
    });

    const { chargedOrderIds, discountsAppliedByOrder, replayed, skipped_stale_items: skippedStale } = txResult;
    if (skippedStale && !(chargedOrderIds || []).length) {
      return res.json({
        success: true,
        orders: [],
        discounts_applied_by_order: {},
        skipped_stale_items: true,
      });
    }
    const courtesyIds = new Set(
      chargedOrderIds.filter((id) => {
        const row = queryOne('SELECT payment_method FROM orders WHERE id = ?', [id]);
        return String(row?.payment_method || '') === COURTESY_PAYMENT_METHOD;
      })
    );
    const salesOrderIds = chargedOrderIds.filter((id) => !courtesyIds.has(id));
    if (!replayed && !chargeToCustomerAccount && salesOrderIds.length) {
      try {
        const { markProductsSoldOnPaidOrders } = require('../services/productSalesTrackingService');
        markProductsSoldOnPaidOrders(salesOrderIds);
      } catch (err) {
        console.warn('[product-sales-idle] venta cobrada no registrada:', err.message || err);
      }
    }
    const paidOrders = chargedOrderIds
      .map((id) => {
        const o = queryOne('SELECT * FROM orders WHERE id = ?', [id]);
        if (!o) return null;
        return { ...o, items: queryAll('SELECT * FROM order_items WHERE order_id = ?', [id]) };
      })
      .filter(Boolean);
    const primaryForAudit = isCourtesyCheckout
      ? COURTESY_PAYMENT_METHOD
      : (paymentBreakdownObj ? dominantPaymentMethod(paymentBreakdownObj) : paymentMethod);
    const salesOrdersForCount = paidOrders.filter((o) => !courtesyIds.has(o.id));
    const accountCount = countSalesAccounts(salesOrdersForCount);
    if (salesOrderIds.length) {
      recordWorkActivityEvent(req.user?.id, 'sale_closed', {
        module: 'caja',
        refId: salesOrderIds[0] || paidOrders[0]?.id,
        meta: { order_count: accountCount, comanda_count: salesOrderIds.length },
      });
    }
    logAudit({
      actorUserId: req.user.id,
      actorName: req.user.full_name || req.user.username || '',
      action: 'table.checkout',
      resourceType: 'order_batch',
      resourceId: paidOrders.map((o) => o.id).join(','),
      details: {
        order_count: accountCount,
        comanda_count: paidOrders.length,
        payment_method: primaryForAudit,
        payment_breakdown: paymentBreakdownObj || null,
        tip_amount: round2(Math.max(0, Number(tipAmountRaw || 0))),
        payment_note: paymentNote || undefined,
      },
    });
    const paidItems = paidOrders.flatMap((o) => (Array.isArray(o.items) ? o.items : []));
    print('caja', {
      title: 'VENTA CERRADA',
      mesa: paidOrders[0]?.table_number || '',
      items: paidItems,
      text: `Cuenta(s) cobrada(s): ${accountCount}${paidOrders.length > accountCount ? ` (${paidOrders.length} comanda(s))` : ''}`,
    }).catch((err) => console.error('[printing] caja cierre:', err.message || err));
    const io = req.app.get('io');
    if (io) {
      for (const o of paidOrders) {
        const full = getOrderWithItems(o.id);
        if (full) io.emit('order-update', full);
      }
      const tableNums = [
        ...new Set(paidOrders.map((o) => String(o.table_number || '').trim()).filter(Boolean)),
      ];
      if (tableNums.length) io.emit('table-update', { table_numbers: tableNums });
    }
    try {
      const { completeReservationsAfterCheckout } = require('../services/reservationCheckoutService');
      completeReservationsAfterCheckout(paidOrders);
    } catch (err) {
      console.warn('[reservations] completar tras cobro:', err.message || err);
    }
    for (const oid of chargedOrderIds) {
      const docRow = queryOne('SELECT * FROM electronic_documents WHERE order_id = ? LIMIT 1', [oid]);
      if (docRow?.id) {
        emitBillingDocumentUpdate({
          id: docRow.id,
          order_id: docRow.order_id,
          order_number: docRow.order_number,
          doc_type: docRow.doc_type,
          full_number: docRow.full_number,
          provider_status: docRow.provider_status,
          provider_message: docRow.provider_message,
          pdf_url: docRow.pdf_url,
          updated_at: docRow.updated_at,
        });
      }
    }
    if (chargedOrderIds.length > 0) emitInventoryUpdate({});
    if (chargeToCustomerAccount) emitStaffDataUpdate({ domain: 'customers' });
    res.json({
      success: true,
      orders: paidOrders,
      discounts_applied_by_order: discountsAppliedByOrder,
      charged_to_customer_account: chargeToCustomerAccount,
      customer_id: chargeToCustomerAccount ? customerIdForAccount : null,
      skipped_stale_items: Boolean(txResult?.skipped_stale_items),
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || 'No se pudo cobrar la mesa',
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.get('/payment-methods', authenticateToken, requireRole('admin', 'cajero', 'mozo'), (req, res) => {
  res.json({
    options: getPaymentMethodOptionsPayload({ includeOnline: false }),
    pos_enabled: isPosTerminalEnabled(),
  });
});

router.get('/register-status', authenticateToken, requireRole('admin', 'cajero', 'mozo'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const role = String(req.user?.role || '').toLowerCase();
  let mozoCajaId = '';
  if (role === 'mozo' || role === 'cajero') {
    const u = queryOne('SELECT caja_station_id FROM users WHERE id = ?', [req.user.id]);
    mozoCajaId = String(u?.caja_station_id || '').trim();
  }
  let openCount;
  let openRegister;
  if (mozoCajaId) {
    openCount = queryOne(
      `SELECT COUNT(*) as c FROM cash_registers
       WHERE closed_at IS NULL AND trim(coalesce(caja_station_id, '')) = ?`,
      [mozoCajaId]
    );
    openRegister = queryOne(
      `SELECT cr.id, cr.user_id, cr.opened_at, cr.caja_station_id, u.full_name as cajero_name
       FROM cash_registers cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.closed_at IS NULL AND trim(coalesce(cr.caja_station_id, '')) = ?
       ORDER BY datetime(cr.opened_at) DESC
       LIMIT 1`,
      [mozoCajaId]
    );
  } else {
    const opens = getOpenRegistersOnActiveStations();
    openCount = { c: opens.length };
    const first = opens[0] || null;
    openRegister = first
      ? {
        id: first.id,
        user_id: first.user_id,
        opened_at: first.opened_at,
        caja_station_id: first.caja_station_id,
        cajero_name: first.user_name || '',
      }
      : null;
  }
  res.json({
    is_open: Number(openCount?.c || 0) > 0,
    register: openRegister || null,
    open_count: Number(openCount?.c || 0),
    caja_station_id: mozoCajaId || null,
  });
});

router.get('/history', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.json(queryAll('SELECT cr.*, u.full_name as user_name FROM cash_registers cr JOIN users u ON u.id = cr.user_id ORDER BY cr.opened_at DESC LIMIT 30'));
});

router.post('/movements', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { type, amount, concept } = req.body;
  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Tipo de movimiento inválido' });
  if (amount === undefined || amount === null || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  const { register, error: registerError } = resolveCashFlowRegister(req);
  if (!register) return res.status(400).json({ error: registerError });
  const id = uuidv4();
  runSql(
    'INSERT INTO cash_movements (id, register_id, user_id, type, amount, concept) VALUES (?, ?, ?, ?, ?, ?)',
    [id, register.id, req.user.id, type, Number(amount), concept || '']
  );
  if (type === 'expense') {
    emitStaffDataUpdate({ domain: 'finance_ops' });
  }
  res.status(201).json(queryOne('SELECT * FROM cash_movements WHERE id = ?', [id]));
});

router.get('/movements', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { type } = req.query;
  const register = resolvePosRegister(req);
  if (!register) return res.json([]);
  let sql = `SELECT cm.*, u.full_name as user_name
             FROM cash_movements cm
             LEFT JOIN users u ON u.id = cm.user_id
             WHERE cm.register_id = ?`;
  const params = [register.id];
  if (type && ['income', 'expense'].includes(type)) {
    sql += ' AND cm.type = ?';
    params.push(type);
  }
  sql += ' ORDER BY cm.created_at DESC LIMIT 100';
  res.json(queryAll(sql, params));
});

router.post('/notes', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { note_type, amount, reason } = req.body;
  if (!['credit', 'debit'].includes(note_type)) return res.status(400).json({ error: 'Tipo de nota inválido' });
  if (amount === undefined || amount === null || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  const { register, error: registerError } = resolveCashFlowRegister(req);
  if (!register) return res.status(400).json({ error: registerError });
  const id = uuidv4();
  runSql(
    'INSERT INTO cash_notes (id, register_id, user_id, note_type, amount, reason) VALUES (?, ?, ?, ?, ?, ?)',
    [id, register.id, req.user.id, note_type, Number(amount), reason || '']
  );
  res.status(201).json(queryOne('SELECT * FROM cash_notes WHERE id = ?', [id]));
});

router.get('/notes', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { note_type } = req.query;
  const register = resolvePosRegister(req);
  if (!register) return res.json([]);
  let sql = `SELECT cn.*, u.full_name as user_name
             FROM cash_notes cn
             LEFT JOIN users u ON u.id = cn.user_id
             WHERE cn.register_id = ?`;
  const params = [register.id];
  if (note_type && ['credit', 'debit'].includes(note_type)) {
    sql += ' AND cn.note_type = ?';
    params.push(note_type);
  }
  sql += ' ORDER BY cn.created_at DESC LIMIT 100';
  res.json(queryAll(sql, params));
});

router.get('/sales-monitor', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const register = resolvePosRegister(req);
  if (!register) return res.json({ hourly: [], by_payment: [], order_count: 0, total_sales: 0 });
  const registerId = String(register.id || '').trim();
  const openedAt = register.opened_at;
  const endAt = register.closed_at || new Date().toISOString();
  let where = '1=1';
  const params = [];
  if (registerId) {
    where = `(IFNULL(o.cash_register_id, '') = ? OR (IFNULL(o.cash_register_id, '') = '' AND COALESCE(o.paid_at, o.updated_at, o.created_at) >= ? AND COALESCE(o.paid_at, o.updated_at, o.created_at) <= ?))`;
    params.push(registerId, openedAt, endAt);
  } else {
    where = `COALESCE(o.paid_at, o.updated_at, o.created_at) >= ? AND COALESCE(o.paid_at, o.updated_at, o.created_at) <= ?`;
    params.push(openedAt, endAt);
  }
  const paidOrders = queryPaidSalesOrders(where, params);
  const byHour = sumSalesAccountsByHour(paidOrders);
  const hourly = Object.entries(byHour)
    .map(([hour, data]) => ({ hour, orders: data.accounts, total: data.total }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  const byPayment = summarizePaymentMethodsByAccount(paidOrders);
  const summary = metricsFromPaidOrdersWhere(where, params);
  res.json({
    hourly,
    by_payment: byPayment,
    order_count: summary.orders,
    total_sales: summary.sales,
  });
});

router.get('/price-lookup', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const { q } = req.query;
  let sql = `SELECT p.id, p.name, p.price, p.stock, c.name as category_name
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.is_active = 1`;
  const params = [];
  if (q) {
    sql += ' AND (p.name LIKE ? OR c.name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY p.name ASC LIMIT 100';
  res.json(queryAll(sql, params));
});

router.get('/z-report', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const register = queryOne(
    `SELECT cr.*, u.full_name as user_name
     FROM cash_registers cr
     LEFT JOIN users u ON u.id = cr.user_id
     WHERE cr.closed_at IS NOT NULL
     ORDER BY datetime(cr.closed_at) DESC, cr.rowid DESC
     LIMIT 1`
  );
  if (!register) return res.status(404).json({ error: 'No hay cierre Z disponible' });
  let arqueo = {};
  try { arqueo = JSON.parse(register.arqueo_data || '{}'); } catch (_) { arqueo = {}; }
  const movements = queryAll(
    'SELECT * FROM cash_movements WHERE register_id = ? ORDER BY created_at ASC',
    [register.id]
  );
  const notes = queryAll(
    'SELECT * FROM cash_notes WHERE register_id = ? ORDER BY created_at ASC',
    [register.id]
  );
  res.json({ ...register, arqueo, movements, notes });
});

module.exports = router;
