import { useState, useEffect, useRef, useMemo, useCallback } from 'react';

/** Redondeo a céntimos en soles; evita errores de coma flotante en arqueo vs esperado. */
function roundMoneySoles(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function parsePosTimestampMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  const hasZone = /Z|[+-]\d{2}:\d{2}$/i.test(raw);
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return new Date(hasZone ? raw : `${normalized}Z`).getTime();
}

function isPaidRegisterSaleOrder(order) {
  if (!order || String(order.status || '') === 'cancelled') return false;
  if (String(order.payment_status || '') !== 'paid') return false;
  const method = String(order.payment_method || '').toLowerCase();
  return method !== 'cortesia' && method !== 'cuenta_cliente';
}

function liveOpenRegister(reg) {
  if (!reg || typeof reg !== 'object') return null;
  if (!String(reg.id || '').trim()) return null;
  if (reg.closed_at) return null;
  return reg;
}

function orderBelongsToOpenRegister(order, register, endAt) {
  if (!isPaidRegisterSaleOrder(order) || !register?.opened_at) return false;
  const registerId = String(register.id || '').trim();
  const orderRegisterId = String(order.cash_register_id || '').trim();
  if (!registerId || orderRegisterId !== registerId) return false;
  const openedMs = parsePosTimestampMs(register.opened_at);
  const endMs = endAt instanceof Date ? endAt.getTime() : parsePosTimestampMs(endAt);
  const eventMs = parsePosTimestampMs(order.paid_at || order.updated_at || order.created_at);
  if (!Number.isFinite(openedMs) || !Number.isFinite(eventMs) || !Number.isFinite(endMs)) return false;
  return eventMs >= openedMs && eventMs <= endMs;
}

function addAmountToPaymentBucket(buckets, method, amount) {
  const n = roundMoneySoles(amount);
  const pm = String(method || 'efectivo').toLowerCase();
  if (pm === 'yape') buckets.yape += n;
  else if (pm === 'plin') buckets.plin += n;
  else if (pm === 'tarjeta') buckets.tarjeta += n;
  else if (pm === 'online') buckets.online += n;
  else buckets.efectivo += n;
}

/** Propina cobrada con el mismo medio de la venta; en multipago, proporcional a cada medio. */
function addTipToPaymentBuckets(tipBuckets, tip, breakdown, method) {
  const amt = roundMoneySoles(tip);
  if (amt <= 0) return;
  const entries = breakdown ? Object.entries(breakdown).filter(([, v]) => Number(v) > 0) : [];
  const sum = entries.reduce((s, [, v]) => s + Number(v), 0);
  if (!entries.length || sum <= 0) {
    addAmountToPaymentBucket(tipBuckets, method, amt);
    return;
  }
  let assigned = 0;
  entries.forEach(([k, v], idx) => {
    const part = idx === entries.length - 1
      ? roundMoneySoles(amt - assigned)
      : roundMoneySoles((amt * Number(v)) / sum);
    assigned = roundMoneySoles(assigned + part);
    addAmountToPaymentBucket(tipBuckets, k, part);
  });
}

function summarizePaidOrdersForRegister(orders, register, endAt) {
  const buckets = { efectivo: 0, yape: 0, plin: 0, tarjeta: 0, online: 0 };
  const tipBuckets = { efectivo: 0, yape: 0, plin: 0, tarjeta: 0, online: 0 };
  let total = 0;
  let tips = 0;
  const matched = [];
  for (const order of orders || []) {
    if (!orderBelongsToOpenRegister(order, register, endAt)) continue;
    matched.push(order);
    const amount = roundMoneySoles(order.total || 0);
    total = roundMoneySoles(total + amount);
    const tip = roundMoneySoles(Number(order.tip_amount || 0));
    tips = roundMoneySoles(tips + tip);
    let breakdown = null;
    const raw = order.payment_breakdown;
    if (raw && typeof raw === 'object') breakdown = raw;
    else if (typeof raw === 'string' && raw.trim()) {
      try { breakdown = JSON.parse(raw); } catch (_) { breakdown = null; }
    }
    const isMulti = breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)
      && Object.keys(breakdown).length >= 2;
    if (isMulti) {
      for (const [k, v] of Object.entries(breakdown)) addAmountToPaymentBucket(buckets, k, v);
    } else {
      addAmountToPaymentBucket(buckets, order.payment_method, amount);
    }
    addTipToPaymentBuckets(tipBuckets, tip, isMulti ? breakdown : null, order.payment_method);
  }
  return {
    total_sales: total,
    total_cash: roundMoneySoles(buckets.efectivo),
    total_yape: roundMoneySoles(buckets.yape),
    total_plin: roundMoneySoles(buckets.plin),
    total_card: roundMoneySoles(buckets.tarjeta),
    total_online: roundMoneySoles(buckets.online),
    total_tips: tips,
    tips_cash: roundMoneySoles(tipBuckets.efectivo),
    tips_yape: roundMoneySoles(tipBuckets.yape),
    tips_plin: roundMoneySoles(tipBuckets.plin),
    tips_card: roundMoneySoles(tipBuckets.tarjeta),
    tips_online: roundMoneySoles(tipBuckets.online),
    order_count: matched.length,
    orders: matched,
  };
}

function emptyMultiPaymentAmounts() {
  return { efectivo: '', yape: '', plin: '', tarjeta: '', online: '' };
}

const DENOM_AUTO_ADVANCE_MS = 900;

const EMPTY_DENOMINATIONS = {
  b200: '', b100: '', b50: '', b20: '', b10: '', m5: '', m2: '', m1: '', c50: '', c20: '', c10: '',
};

/** Borrador del arqueo por caja: permite cobrar a un cliente a mitad del cierre sin perder el conteo. */
function cashCloseDraftKey(registerId) {
  return registerId ? `rf_cash_close_draft_${registerId}` : '';
}

function readCashCloseDraft(registerId) {
  const key = cashCloseDraftKey(registerId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeCashCloseDraft(registerId, draft) {
  const key = cashCloseDraftKey(registerId);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch (_) {
    return false;
  }
}

function clearCashCloseDraft(registerId) {
  const key = cashCloseDraftKey(registerId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (_) {
    /* sin almacenamiento */
  }
}

function nonCashCheckLabel(value, label) {
  if (value === 'tarjeta') return `${label} (POS)`;
  if (value === 'yape' || value === 'plin') return `${label} (QR)`;
  return label;
}

/**
 * Multimétodo con vuelto: Yape/Plin/Tarjeta/Online se cobran exactos y no pueden superar el total;
 * el efectivo puede exceder el saldo restante y la diferencia se entrega como vuelto.
 * `breakdown` lleva el efectivo realmente aplicado a la venta (lo que queda en caja).
 */
function resolveMultiPayment(amounts, options, total) {
  const t = roundMoneySoles(total);
  const given = {};
  for (const opt of options || []) {
    const v = roundMoneySoles(parseFloat(amounts?.[opt.value]));
    if (Number.isFinite(v) && v > 0) given[opt.value] = v;
  }
  const sum = roundMoneySoles(Object.values(given).reduce((s, x) => s + x, 0));
  const cashGiven = given.efectivo || 0;
  const nonCash = roundMoneySoles(sum - cashGiven);
  const cashApplied = roundMoneySoles(Math.max(0, Math.min(cashGiven, t - nonCash)));
  const change = roundMoneySoles(Math.max(0, cashGiven - cashApplied));
  const missing = roundMoneySoles(Math.max(0, t - sum));
  const breakdown = { ...given };
  if (cashGiven > 0) {
    if (cashApplied > 0) breakdown.efectivo = cashApplied;
    else delete breakdown.efectivo;
  }
  let error = '';
  if (Object.keys(given).length < 2) {
    error = 'En multimétodo indica al menos dos métodos con monto mayor a cero.';
  } else if (nonCash - t > 0.05) {
    error = `Los pagos sin efectivo (${formatCurrency(nonCash)}) superan el total (${formatCurrency(t)}). Solo el efectivo puede dar vuelto.`;
  } else if (missing > 0.05) {
    error = `Monto insuficiente. Falta ${formatCurrency(missing)}`;
  } else if (Object.keys(breakdown).length < 2) {
    error = 'Los otros métodos ya cubren el total: quite el efectivo o use un solo método.';
  }
  return { given, sum, cashGiven, nonCash, cashApplied, change, missing, breakdown, error, valid: !error };
}

/** Verde si cuadra, naranja al activar (sin montos), rojo si hay montos pero no cuadran. */
function multiPayStatusClass(state) {
  if (state.valid) return 'text-[color:var(--ui-success)]';
  if (state.sum <= 0) return 'text-[color:var(--ui-warning)]';
  return 'text-[color:var(--ui-danger)]';
}

function dominantPaymentFromBreakdown(obj) {
  let best = 'efectivo';
  let bestAmt = -1;
  for (const [k, v] of Object.entries(obj || {})) {
    const a = roundMoneySoles(Number(v) || 0);
    if (a > bestAmt) {
      bestAmt = a;
      best = k;
    }
  }
  return bestAmt > 0 ? best : 'efectivo';
}
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  wakeRemoteApi,
  checkPrintingHealth,
  electronPrinting,
  formatCurrency,
  formatDate,
  formatPeDateTimeLine,
  formatPeDateTimeParts,
  getPaymentMethodOptions,
  isPosTerminalEnabledInConfig,
  orderMultiPaymentOptions,
  hasElectronPrinting,
  normalizeUsbPrinterList,
  PAYMENT_METHODS,
  printingUnreachableMessage,
  resolveMediaUrl,
} from '../../utils/api';
import { billingStatusLabel } from '../../utils/billingSunatStatus';
import {
  KITCHEN_TAKEOUT_NOTE,
  orderHasTakeoutNote,
  buildPrecuentaPlainText,
  buildNotaVentaPlainText,
  buildBoletaFacturaPlainText,
  getThermalPrintRevision,
  restaurantThermalBrandLine,
} from '../../utils/ticketPlainText';
import PrinterModulePanel from '../../components/printing/PrinterModulePanel';
import { getPrecuentaSurveyQrAttachment } from '../../utils/surveyQrPrint';
import {
  DEFAULT_PRINTING_CONFIG,
  fetchPrintingConfig,
  normalizePaperWidthMm,
} from '../../utils/printingConfig';
import { printKitchenBarOnComandaSend } from '../../utils/kitchenBarAutoPrint';
import { showStockInOrderingUI } from '../../utils/productStockDisplay';
import {
  mergeOrderingCatalog,
  filterVisibleOrderingProducts,
  buildOrderItemsPayload,
  filterOrderingProducts,
} from '../../utils/orderingCatalog';
import {
  billLineDisplayName,
  billLineKey,
  groupItemsByProductNameForBill,
  getOrderChargeTotal,
  sumOrderItemsChargeSubtotal,
  buildDineInOrderPayload,
} from '../../utils/mesaOrderLines';

function collectAllOrderItemIds(orders) {
  const ids = [];
  for (const o of orders || []) {
    for (const it of o.items || []) {
      if (it?.id) ids.push(it.id);
    }
  }
  return ids;
}

/** Cantidad a cobrar de una línea (por defecto 1 si qty > 1). */
function resolveSplitChargeQty(it, qtyByItemId) {
  const maxQ = Math.max(0, Math.floor(Number(it?.quantity || 0)));
  if (maxQ <= 1) return maxQ || 1;
  const raw = qtyByItemId?.[it.id];
  if (raw == null || raw === '') return 1;
  const q = Math.floor(Number(raw));
  if (!Number.isFinite(q) || q < 1) return 1;
  return Math.min(maxQ, q);
}

/** Subtotal cobrable de una línea según cantidad parcial. */
function splitLineChargeSubtotal(it, chargeQty) {
  const maxQ = Math.max(0, Math.floor(Number(it?.quantity || 0)));
  const unit = Number(it?.unit_price ?? 0);
  const fullSub = Number(it?.subtotal != null ? it.subtotal : unit * maxQ);
  if (maxQ <= 0) return 0;
  const q = Math.min(maxQ, Math.max(1, Math.floor(Number(chargeQty) || 1)));
  if (q >= maxQ) return fullSub;
  return roundMoneySoles((fullSub * q) / maxQ);
}

function itemWithSplitChargeQty(it, chargeQty) {
  const maxQ = Math.max(1, Math.floor(Number(it?.quantity || 1)));
  const q = Math.min(maxQ, Math.max(1, Math.floor(Number(chargeQty) || 1)));
  if (q >= maxQ) return it;
  return {
    ...it,
    quantity: q,
    subtotal: splitLineChargeSubtotal(it, q),
  };
}

/** Base imponible para total / descuento en modo dividir por línea (ítems marcados + delivery si el pedido queda entero). */
function computeTableSplitSelectionBase(orders, selectedItemIds, qtyByItemId = {}) {
  const set = selectedItemIds instanceof Set ? selectedItemIds : new Set(selectedItemIds);
  let lineSum = 0;
  for (const o of orders || []) {
    for (const it of o.items || []) {
      if (!set.has(it.id)) continue;
      const chargeQ = resolveSplitChargeQty(it, qtyByItemId);
      lineSum += splitLineChargeSubtotal(it, chargeQ);
    }
  }
  let deliveryExtra = 0;
  for (const o of orders || []) {
    const items = o.items || [];
    if (!items.length) continue;
    const allFull =
      items.every((it) => {
        if (!set.has(it.id)) return false;
        const maxQ = Math.max(1, Math.floor(Number(it.quantity || 1)));
        return resolveSplitChargeQty(it, qtyByItemId) >= maxQ;
      });
    if (allFull) deliveryExtra += Number(o.delivery_fee || 0);
  }
  return lineSum + deliveryExtra;
}

function getOrderItemSubtotalFromOrders(orders, itemId, qtyByItemId = {}) {
  const sid = String(itemId || '').trim();
  if (!sid) return 0;
  for (const o of orders || []) {
    const it = (o.items || []).find((x) => String(x.id) === sid);
    if (it) {
      const chargeQ = resolveSplitChargeQty(it, qtyByItemId);
      return splitLineChargeSubtotal(it, chargeQ);
    }
  }
  return 0;
}

function resolveAppliedDiscountBase(orders, selectedOrderItemIds, splitMode, discountConfig, fallbackTotal, qtyByItemId = {}) {
  if (!discountConfig?.applied) return fallbackTotal;
  if (discountConfig.target !== 'line' || !String(discountConfig.targetOrderItemId || '').trim() || !splitMode) {
    return fallbackTotal;
  }
  const sid = String(discountConfig.targetOrderItemId).trim();
  if (!selectedOrderItemIds.includes(sid)) return fallbackTotal;
  const lineSub = getOrderItemSubtotalFromOrders(orders, sid, qtyByItemId);
  return lineSub > 0 ? lineSub : fallbackTotal;
}

const EMPTY_DISCOUNT_CONFIG = {
  active: false,
  applied: false,
  type: 'amount',
  value: '',
  reason: '',
  target: 'whole',
  targetOrderItemId: '',
};

function isCourtesyDiscountReason(text) {
  return /^cortes[ií]a\s*:/i.test(String(text || '').trim());
}
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { useActiveInterval } from '../../hooks/useActiveInterval';
import { useStaffOrderCart } from '../../hooks/useStaffOrderCart';
import { useMesaOrderLock } from '../../hooks/useMesaOrderLock';
import { useShowDeliveryUi } from '../../hooks/useDeliveryEnabled';
import toast from 'react-hot-toast';
import {
  archiveReservationCajaAviso,
  dismissReservationCajaToast,
  isReservationCajaToastDismissed,
  reservationCajaToastId,
} from '../../utils/reservationCajaAvisosSession';
import { ReservaCajaToastBody } from '../../components/ReservaCajaToast';
import Modal from '../../components/Modal';
import MesaTransferModal from '../../components/MesaTransferModal';
import MesaMapTableTile from '../../components/MesaMapTableTile';
import StaffDineInOrderUI, { StaffDineInOrderCartPanel, VIEWPORT_CART_MAX_CLASS } from '../../components/StaffDineInOrderUI';
import { staffOrderModalProps } from '../../components/staffOrderModalLayout';
import StaffModifierPromptModal from '../../components/StaffModifierPromptModal';
import PosCustomerPickerModal from '../../components/PosCustomerPickerModal';
import NonCashArqueoSection from '../../components/pos/NonCashArqueoSection';
import CashCountSection from '../../components/pos/CashCountSection';
import { canPosDeleteOrReleaseTable, canAjusteBarAutoDismiss } from '../../utils/posPermissions';
import { buildTablesBySalon } from '../../utils/salonesUtils';
import {
  buildReservationByTableIdForToday,
  getMesaMapChairCount,
  getMesaMapVisualState,
  getTableDisplayLabel,
} from '../../utils/mesaMapTableVisual';
import { readGetCache, invalidateGetCache, REGISTER_STATE_CACHE_PATHS } from '../../utils/offlinePos';
import {
  MdPointOfSale, MdTableRestaurant, MdReceipt,
  MdCheckCircle, MdAttachMoney, MdPeople, MdClose,
  MdAccountBalanceWallet,
  MdRestaurantMenu,
  MdAccessTime, MdPersonAdd, MdSearch,
  MdDeliveryDining,
  MdEdit, MdDelete, MdPrint, MdSave,
  MdSwapHoriz, MdOpenWith, MdCallMerge,
  MdStorage, MdShoppingCart, MdCreditCard, MdPhoneIphone, MdLanguage,
} from 'react-icons/md';

/** Valor del selector de método que activa el cobro con varios medios. */
const MULTI_PAY_OPTION = '__multi__';

const CLOSE_SUMMARY_TONE = {
  total: { icon: MdStorage, box: 'border-emerald-500/25 bg-emerald-500/10', tile: 'bg-emerald-500/15 text-emerald-600' },
  efectivo: { icon: MdShoppingCart, box: 'border-blue-500/25 bg-blue-500/10', tile: 'bg-blue-500/15 text-blue-600' },
  tarjeta: { icon: MdCreditCard, box: 'border-violet-500/25 bg-violet-500/10', tile: 'bg-violet-500/15 text-violet-600' },
  yape: { icon: MdPhoneIphone, box: 'border-orange-500/25 bg-orange-500/10', tile: 'bg-orange-500/15 text-orange-600' },
  plin: { icon: MdPhoneIphone, box: 'border-sky-500/25 bg-sky-500/10', tile: 'bg-sky-500/15 text-sky-600' },
  online: { icon: MdLanguage, box: 'border-indigo-500/25 bg-indigo-500/10', tile: 'bg-indigo-500/15 text-indigo-600' },
};

function CloseSummaryCard({ tone, label, amount, sub }) {
  const ui = CLOSE_SUMMARY_TONE[tone] || CLOSE_SUMMARY_TONE.total;
  const Icon = ui.icon;
  return (
    <div className={`flex-1 basis-[calc(50%-0.375rem)] lg:basis-0 min-w-0 rounded-2xl border p-2.5 flex items-center gap-2.5 shadow-sm ${ui.box}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${ui.tile}`}>
        <Icon className="text-xl" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--ui-body-text)] truncate">{label}</p>
        <p className="text-base xl:text-lg font-bold tabular-nums text-[var(--ui-body-text)] leading-tight whitespace-nowrap">{formatCurrency(amount)}</p>
        {sub ? <p className="text-[11px] text-[var(--ui-muted)] tabular-nums truncate">{sub}</p> : null}
      </div>
    </div>
  );
}

/** Mesa sintética al cobrar cuenta desde Clientes (no existe fila en `tables`). */
const POS_ADMIN_REGISTER_KEY = 'posAdminRegisterId';
const POS_CAJA_LOCKED_CLOSED_KEY = 'posCajaLockedClosed';
const POS_CLOSED_REGISTER_IDS_KEY = 'posClosedRegisterIds';

function readCajaLockedClosed() {
  try {
    return sessionStorage.getItem(POS_CAJA_LOCKED_CLOSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistCajaLockedClosed(locked) {
  try {
    if (locked) sessionStorage.setItem(POS_CAJA_LOCKED_CLOSED_KEY, '1');
    else sessionStorage.removeItem(POS_CAJA_LOCKED_CLOSED_KEY);
  } catch {
    /* noop */
  }
}

function readClosedRegisterIds() {
  try {
    const raw = sessionStorage.getItem(POS_CLOSED_REGISTER_IDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set((Array.isArray(arr) ? arr : []).map((id) => String(id || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function persistClosedRegisterIds(ids) {
  try {
    sessionStorage.setItem(POS_CLOSED_REGISTER_IDS_KEY, JSON.stringify([...ids].slice(-30)));
  } catch {
    /* noop */
  }
}

function readPersistedAdminRegisterId() {
  try {
    return String(
      localStorage.getItem(POS_ADMIN_REGISTER_KEY)
        || sessionStorage.getItem(POS_ADMIN_REGISTER_KEY)
        || '',
    ).trim();
  } catch {
    return '';
  }
}

function persistAdminRegisterId(registerId) {
  const rid = String(registerId || '').trim();
  try {
    if (rid) {
      localStorage.setItem(POS_ADMIN_REGISTER_KEY, rid);
      sessionStorage.setItem(POS_ADMIN_REGISTER_KEY, rid);
    } else {
      localStorage.removeItem(POS_ADMIN_REGISTER_KEY);
      sessionStorage.removeItem(POS_ADMIN_REGISTER_KEY);
    }
  } catch {
    /* noop */
  }
}

const PRIMARY_POS_CAJA_ID = 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001';

function scopeTablesAndSalonesForCaja(tablesData, salonesRaw, scopedCaja, posRole) {
  let scopedTables =
    posRole === 'admin' && !scopedCaja ? [] : (Array.isArray(tablesData) ? tablesData : []);
  let scopedSalones =
    posRole === 'admin' && !scopedCaja
      ? []
      : (Array.isArray(salonesRaw) ? salonesRaw : []);
  if (!scopedCaja) return { tables: scopedTables, salones: scopedSalones };
  const salonCaja = (s) => String(s?.caja_station_id || '').trim() || PRIMARY_POS_CAJA_ID;
  scopedSalones = scopedSalones.filter((s) => salonCaja(s) === scopedCaja);
  const salonByZone = new Map(scopedSalones.map((s) => [String(s.id), s]));
  scopedTables = scopedTables.filter((t) => {
    const direct = String(t?.caja_station_id || '').trim();
    if (direct) return direct === scopedCaja;
    const salon = salonByZone.get(String(t?.zone || 'principal'));
    return salonCaja(salon) === scopedCaja;
  });
  return { tables: scopedTables, salones: scopedSalones };
}

const CLIENT_CHECKOUT_TABLE_PREFIX = 'client-checkout:';
function isClientCheckoutTable(table) {
  return Boolean(table && String(table.id || '').startsWith(CLIENT_CHECKOUT_TABLE_PREFIX));
}

/** Recuadro sintético en caja: un slot por pedido delivery pendiente de cobro (misma UX que mesa). */
const POS_DELIVERY_SLOT_PREFIX = 'pos-delivery-slot:';
/** Venta rápida: se cobra con el mismo modal que una mesa; si no se cobra queda como recuadro en caja. */
const POS_QUICK_SALE_SLOT_PREFIX = 'pos-quick-sale:';
const QUICK_SALE_CUSTOMER_NAME = 'VENTA RAPIDA';
function isQuickSaleCheckoutTable(table) {
  return Boolean(table && String(table.id || '').startsWith(POS_QUICK_SALE_SLOT_PREFIX));
}
/** Recuadro sintético de un solo pedido (delivery o venta rápida), sin mesa física. */
function isDeliveryCheckoutTable(table) {
  return Boolean(
    table
    && (String(table.id || '').startsWith(POS_DELIVERY_SLOT_PREFIX) || isQuickSaleCheckoutTable(table)),
  );
}
function deliveryOrderIdFromSlotTable(table) {
  return String(table?.id || '').slice(POS_DELIVERY_SLOT_PREFIX.length);
}
const CAJA_OPTIONS_CAJERO_IDS = new Set([
  'cobrar',
  'ingresos',
  'egresos',
  'impresora',
]);
const CAJA_OPTIONS = [
  { id: 'cobrar', label: 'Cobrar' },
  { id: 'reservas', label: 'Reservas' },
  { id: 'apertura_cierre', label: 'Apertura y cierre' },
  { id: 'cierres_caja', label: 'Cierres de caja' },
  { id: 'ingresos', label: 'Ingresos' },
  { id: 'egresos', label: 'Egresos' },
  { id: 'impresora', label: 'Impresora' },
];
const BAR_AUTO_DISMISS_MINUTE_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

/** En caja el administrador maestro opera con los mismos flujos que el admin dueño. */
function posRoleOf(u) {
  const role = String(u?.role || '').toLowerCase();
  return role === 'master_admin' ? 'admin' : role;
}

async function printCajaTicket(payload) {
  try {
    if (hasElectronPrinting()) {
      await electronPrinting.printModule('caja', payload);
    } else {
      await api.printing.post('/printing/print/caja', payload);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'No se pudo imprimir' };
  }
}

const WAREHOUSE_CATEGORY_NAMES = new Set(['PRODUCTOS ALMACEN', 'INSUMOS']);
const DEFAULT_BILLING_FORM = {
  enabled: false,
  doc_type: 'nota_venta',
  customer_doc_type: '0',
  customer_doc_number: '',
  customer_name: '',
  customer_address: '',
  customer_phone: '',
  /** Comprobante: cada ítem del pedido vs una sola línea por consumo */
  invoice_lines_mode: 'detallado',
};
const EMPTY_CUSTOMER_FORM = {
  doc_type: '1',
  doc_number: '',
  name: '',
  phone: '',
  address: '',
  email: '',
};

const normalizeCustomerEmail = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === '@gmail.com') return '';
  if (raw.includes('@')) return raw;
  return `${raw}@gmail.com`;
};

/** Reconstruye nota y modificador desde `order_items.notes` (mismo formato que al crear el pedido). */
function parseOrderItemNotes(notesStr, product) {
  const s = String(notesStr || '').trim();
  const modId = String(product?.modifier_id || '').trim();
  if (!s) return { itemNote: '', modifierId: modId, modifierOption: '' };
  const parts = s.split(' | ').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1) {
    const m = parts[0].match(/^([^:]+):\s*(.+)$/);
    if (m && modId) {
      return { itemNote: '', modifierId: modId, modifierOption: m[2].trim() };
    }
    return { itemNote: parts[0], modifierId: modId, modifierOption: '' };
  }
  const itemNote = parts[0];
  const last = parts[parts.length - 1];
  const m = last.match(/^([^:]+):\s*(.+)$/);
  if (m && modId) {
    return { itemNote, modifierId: modId, modifierOption: m[2].trim() };
  }
  return { itemNote: s, modifierId: modId, modifierOption: '' };
}

function buildMesaOrderNotes(paraLlevar, observation) {
  const parts = [];
  if (paraLlevar) parts.push(KITCHEN_TAKEOUT_NOTE);
  const obs = String(observation || '').trim();
  if (obs) parts.push(obs);
  return parts.join('\n');
}

function parseMesaOrderObservation(notes) {
  return String(notes || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.toUpperCase() !== KITCHEN_TAKEOUT_NOTE)
    .join('\n')
    .trim();
}

function formatOrderBadge(orderNumber) {
  const n = Number(orderNumber);
  if (!Number.isFinite(n)) return '';
  return `# ${String(n).padStart(7, '0')}`;
}

function canEditOrderLines(order) {
  return (
    order &&
    ['pending', 'preparing', 'ready'].includes(String(order.status || '')) &&
    String(order.payment_status || 'pending') === 'pending'
  );
}

function cartRemovalSignature(cart) {
  const rows = (cart || []).map((i) => ({
    k: [
      String(i.source_order_id || ''),
      String(i.product_id || ''),
      String(i.modifier_option || '').trim().toLowerCase(),
      String(i.notes || '').trim(),
    ].join('\0'),
    q: Number(i.quantity || 0),
  }));
  rows.sort((a, b) => a.k.localeCompare(b.k));
  return rows;
}

function cartHasProductRemovals(initialCart, currentCart) {
  const sumRows = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.k, (m.get(r.k) || 0) + r.q);
    return m;
  };
  const before = sumRows(cartRemovalSignature(initialCart));
  const after = sumRows(cartRemovalSignature(currentCart));
  for (const [key, qty] of before) {
    if (qty > 0 && (after.get(key) || 0) <= 0) return true;
  }
  return false;
}

function formatMesaRemovalReason(prefix, reason) {
  const text = String(reason || '').trim();
  if (!text) return prefix;
  const prefixRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*`, 'i');
  return prefixRe.test(text) ? text : `${prefix}: ${text}`;
}

/** Completa nombre/precio desde el catálogo local (caja sin conexión). */
function hydratePosOrderItem(it, productsById) {
  if (!it) return it;
  const named = String(it.product_name || it.name || '').trim();
  const hasName = named && named !== 'Producto' && named !== '—';
  const hasPrice = Number(it.unit_price ?? it.price ?? 0) > 0;
  if (hasName && hasPrice) return it;
  const comboId = String(it.combo_id || '').trim();
  const p = (comboId && productsById.get(`combo:${comboId}`)) || productsById.get(it.product_id);
  if (!p) return it;
  const qty = Number(it.quantity || 1);
  const unit = hasPrice ? Number(it.unit_price ?? it.price) : Number(p.price || 0);
  return {
    ...it,
    product_name: hasName ? named : (p.name || named || 'Producto'),
    unit_price: unit,
    subtotal: it.subtotal != null && hasPrice ? Number(it.subtotal) : unit * qty,
  };
}

/** Todos los productos de la mesa agrupados por línea de producto (misma lógica que precuenta/cobro). */
function mergedProductsOnTable(table, productsById) {
  const allItems = (table?.orders || []).flatMap((o) =>
    (o.items || []).map((it) => (productsById ? hydratePosOrderItem(it, productsById) : it))
  );
  return groupItemsByProductNameForBill(allItems);
}

/** Al editar comanda: una fila por línea de producto — ítems iguales (producto/variante/notas/P.unit.) suman cantidad. */
function orderItemsToCart(order, productsById) {
  const m = new Map();
  for (const it of order.items || []) {
    const product = productsById.get(it.product_id);
    const parsed = parseOrderItemNotes(it.notes, product);
    const modId = parsed.modifierId || String(it.modifier_id || '').trim();
    const modOpt = parsed.modifierOption || String(it.modifier_option || '').trim();
    const k = billLineKey(it);
    const qty = Number(it.quantity || 0);
    if (!m.has(k)) {
      m.set(k, {
        line_key: `mg:${order.id}:${k}`,
        bill_key: k,
        source_order_id: order.id,
        product_id: it.product_id,
        name: billLineDisplayName(it),
        price: Number(it.original_unit_price) > 0
          ? Number(it.original_unit_price)
          : Number(it.unit_price ?? product?.price ?? 0),
        quantity: 0,
        modifier_id: modId,
        modifier_name: '',
        modifier_option: modOpt,
        note_required: product ? Number(product.note_required || 0) : 0,
        notes: parsed.itemNote,
      });
    }
    const row = m.get(k);
    row.quantity += qty;
  }
  return [...m.values()];
}

/**
 * Modificar pedido: la mesa es una sola cuenta, así que la misma línea de producto de varias comandas
 * se muestra en una fila. `source_allocations` guarda cuánto aporta cada comanda para repartir al guardar.
 */
function mergeEditCartAcrossOrders(orders, productsById) {
  const sorted = [...(orders || [])].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
  const m = new Map();
  for (const order of sorted) {
    for (const row of orderItemsToCart(order, productsById)) {
      const prev = m.get(row.bill_key);
      if (!prev) {
        m.set(row.bill_key, {
          ...row,
          line_key: `mg:${row.bill_key}`,
          source_allocations: [{ order_id: order.id, quantity: row.quantity }],
        });
        continue;
      }
      prev.quantity += row.quantity;
      prev.source_order_id = order.id;
      prev.source_allocations.push({ order_id: order.id, quantity: row.quantity });
    }
  }
  return [...m.values()];
}

/**
 * Reparte cada fila agrupada entre sus comandas: los aumentos van a la comanda más reciente
 * y las reducciones se descuentan desde la más reciente hacia la más antigua.
 */
function expandEditCartToOrders(cart) {
  const out = [];
  for (const line of cart || []) {
    const allocs = line.source_allocations;
    if (!allocs?.length) {
      out.push(line);
      continue;
    }
    const { source_allocations: _allocs, ...base } = line;
    const qtys = allocs.map((a) => Number(a.quantity || 0));
    let diff = Number(line.quantity || 0) - qtys.reduce((s, q) => s + q, 0);
    if (diff > 0) qtys[qtys.length - 1] += diff;
    for (let i = qtys.length - 1; i >= 0 && diff < 0; i -= 1) {
      const take = Math.min(qtys[i], -diff);
      qtys[i] -= take;
      diff += take;
    }
    allocs.forEach((a, i) => {
      if (qtys[i] <= 0) return;
      out.push({
        ...base,
        line_key: `${line.line_key}:${a.order_id}`,
        source_order_id: a.order_id,
        quantity: qtys[i],
      });
    });
  }
  return out;
}

function filterUnpaidDeliveryOrdersForCaja(orders) {
  return (orders || [])
    .filter(
      (o) =>
        o.type === 'delivery' &&
        String(o.payment_status || '') !== 'paid' &&
        ['pending', 'preparing', 'ready'].includes(String(o.status || ''))
    )
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}
function buildDeliveryCajaSlots(orders) {
  return filterUnpaidDeliveryOrdersForCaja(orders).map((o, idx) => ({
    id: `${POS_DELIVERY_SLOT_PREFIX}${o.id}`,
    number: o.order_number,
    name: `DELIVERY ${idx + 1}`,
    zone: 'delivery',
    orders: [o],
    status: 'occupied',
    order_total: getOrderChargeTotal(o),
    order_count: 1,
  }));
}
function quickSaleSlotForOrder(o, idx = 0) {
  return {
    id: `${POS_QUICK_SALE_SLOT_PREFIX}${o.id}`,
    number: o.order_number,
    name: idx > 0 ? `VENTA RÁPIDA ${idx + 1}` : 'VENTA RÁPIDA',
    zone: 'venta_rapida',
    orders: [o],
    status: 'occupied',
    order_total: getOrderChargeTotal(o),
    order_count: 1,
  };
}
function buildQuickSaleCajaSlots(orders) {
  return (orders || [])
    .filter(
      (o) =>
        String(o.type || '') === 'pickup' &&
        String(o.customer_name || '').trim().toUpperCase() === QUICK_SALE_CUSTOMER_NAME &&
        !String(o.table_id || '').trim() &&
        String(o.payment_status || '') !== 'paid' &&
        String(o.status || '') !== 'cancelled'
    )
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map((o, idx) => quickSaleSlotForOrder(o, idx));
}
function buildOrderCajaSlots(orders) {
  return [...buildDeliveryCajaSlots(orders), ...buildQuickSaleCajaSlots(orders)];
}

function PosInlineLoading({ title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 gap-3" role="status" aria-live="polite">
      <div className="animate-spin w-10 h-10 border-4 border-gold-500 border-t-transparent rounded-full" aria-hidden="true" />
      <p className="text-sm font-semibold text-[var(--ui-body-text)]">{title}</p>
      {subtitle ? (
        <p className="text-xs text-[var(--ui-muted)] text-center max-w-xs">{subtitle}</p>
      ) : null}
    </div>
  );
}

export default function POSPanel() {
  const showDeliveryUi = useShowDeliveryUi();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const clientCheckoutOpenedKeyRef = useRef('');
  const selectedTableIdRef = useRef(null);
  const tableDetailIdRef = useRef(null);
  const checkoutInFlightRef = useRef(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const showBillRef = useRef(false);
  const showMenuRef = useRef(false);
  const editSessionInitialParaLlevarRef = useRef(false);
  const [tables, setTables] = useState([]);
  const [salonesConfig, setSalonesConfig] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [register, setRegister] = useState(null);
  const [registerStatus, setRegisterStatus] = useState({ is_open: false, register: null });
  const loadDataGenRef = useRef(0);
  const closedRegisterIdsRef = useRef(readClosedRegisterIds());
  const cajaLockedClosedRef = useRef(readCajaLockedClosed());
  const registerIdRef = useRef('');
  const [dailySales, setDailySales] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workAreaLoading, setWorkAreaLoading] = useState(false);
  const [preparingCloseModal, setPreparingCloseModal] = useState(false);
  const [closingRegisterBusy, setClosingRegisterBusy] = useState(false);
  const prepareCloseGenRef = useRef(0);
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableDetail, setTableDetail] = useState(null);
  /** Detalle de mesa (productos + acciones) en ventana superpuesta. */
  const [mesaDetailModalOpen, setMesaDetailModalOpen] = useState(false);
  /** Modal mover mesa / mover pedidos. */
  const [mesaTransfer, setMesaTransfer] = useState(null);
  /** Modo selección múltiple para unir mesas en el mapa. */
  const [mesaUniteMode, setMesaUniteMode] = useState(false);
  const [mesaUniteSelection, setMesaUniteSelection] = useState([]);
  const [mesaUniteBusy, setMesaUniteBusy] = useState(false);
  /** Pregunta «¿Desunir mesa?» al cobrar una mesa unida. */
  const [mesaUnionCheckoutPrompt, setMesaUnionCheckoutPrompt] = useState(null);
  const [dissolveUnionAfterCheckout, setDissolveUnionAfterCheckout] = useState(false);
  const [mesaDesunirBusy, setMesaDesunirBusy] = useState(false);
  /** Mesas con precuenta impresa (estado morado en el mapa). */
  const [precuentaTableIds, setPrecuentaTableIds] = useState(() => new Set());
  /** Zona/salón activo en mapa de mesas (pestañas tipo categoría). */
  const [selectedPosSalon, setSelectedPosSalon] = useState('');
  const [showBill, setShowBill] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  /** En dividir cuenta: ids de `order_items` incluidos en este cobro. */
  const [selectedOrderItemIds, setSelectedOrderItemIds] = useState([]);
  /** En dividir cuenta: cantidad a cobrar por línea cuando qty > 1 (default 1). */
  const [selectedOrderItemQtys, setSelectedOrderItemQtys] = useState({});
  const [discountConfig, setDiscountConfig] = useState({
    active: false,
    applied: false,
    type: 'amount',
    value: '',
    reason: '',
    target: 'whole',
    targetOrderItemId: '',
  });
  const [showMenu, setShowMenu] = useState(false);
  const [viewOrdersModal, setViewOrdersModal] = useState(null);
  const [quickSaleMode, setQuickSaleMode] = useState(false);
  const [products, setProducts] = useState([]);
  const [modifiers, setModifiers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState('all');
  const [paymentMethod, setPaymentMethod] = useState('efectivo');
  const [paymentOptions, setPaymentOptions] = useState(getPaymentMethodOptions(null, { includeOnline: false }));
  const [posTerminalEnabled, setPosTerminalEnabled] = useState(true);
  const [multiPayEnabled, setMultiPayEnabled] = useState(false);
  const [multiPayAmounts, setMultiPayAmounts] = useState(() => emptyMultiPaymentAmounts());
  const [tipPayEnabled, setTipPayEnabled] = useState(false);
  const [checkoutTipAmount, setCheckoutTipAmount] = useState('');
  const [checkoutPaymentNote, setCheckoutPaymentNote] = useState('');
  const [paymentNoteOpen, setPaymentNoteOpen] = useState(false);
  const [amountReceived, setAmountReceived] = useState('');
  const [billingForm, setBillingForm] = useState(DEFAULT_BILLING_FORM);
  const [billingResult, setBillingResult] = useState(null);
  const {
    cart,
    noteEditorLineKey,
    setNoteEditorLineKey,
    modifierPrompt,
    setModifierPrompt,
    addToCart,
    confirmModifierForCart,
    addProductWithoutOptionalModifier,
    updateQty,
    removeFromCart,
    updateItemNote,
    cartTotal,
    resetCart,
    setCart,
  } = useStaffOrderCart(modifiers);
  const {
    lockMesa,
    clearMesaLock,
    syncLockRenumber,
    validateMesaForSubmit,
    resolveLockedTable,
    getMesaLock,
  } = useMesaOrderLock();
  const [editingOrderId, setEditingOrderId] = useState('');
  /** Comanda “principal” (nuevas líneas sin `source_order_id` y nota para llevar). */
  const [editingSessionOrderIds, setEditingSessionOrderIds] = useState([]);
  const editSessionInitialCartRef = useRef([]);
  const mesaRemovalConfirmRef = useRef(null);
  const [mesaRemovalModal, setMesaRemovalModal] = useState(null);
  const [mesaRemovalReason, setMesaRemovalReason] = useState('');
  const [mesaRemovalSubmitting, setMesaRemovalSubmitting] = useState(false);
  /** Comanda cocina/bar: «PARA LLEVAR» en mayúsculas (orders.notes). Solo mesa/salón, no venta rápida. */
  const [paraLlevarMesa, setParaLlevarMesa] = useState(false);
  const [mesaOrderObservation, setMesaOrderObservation] = useState('');
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [customerForm, setCustomerForm] = useState(EMPTY_CUSTOMER_FORM);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [matchedCustomer, setMatchedCustomer] = useState(null);
  const [selectedBillingCustomerId, setSelectedBillingCustomerId] = useState('');
  const [showCustomerPickerModal, setShowCustomerPickerModal] = useState(false);
  const [addToAccountEnabled, setAddToAccountEnabled] = useState(false);
  const [searchingCustomer, setSearchingCustomer] = useState(false);
  const [consultaPadronLoading, setConsultaPadronLoading] = useState(false);
  /** Tras una consulta exitosa con cupo, el /auth/me no se refresca al instante. */
  const [padronUsedBump, setPadronUsedBump] = useState(0);
  const [openingAmount, setOpeningAmount] = useState('');
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [activeCajaOption, setActiveCajaOption] = useState(searchParams.get('view') || 'cobrar');
  const [printingConfig, setPrintingConfig] = useState(DEFAULT_PRINTING_CONFIG);
  const cajaPaperWidthMm = useMemo(() => {
    return normalizePaperWidthMm(printingConfig?.caja?.anchoPapel ?? printingConfig?.caja?.paperWidth ?? 80);
  }, [printingConfig?.caja?.anchoPapel, printingConfig?.caja?.paperWidth]);
  const [closingData, setClosingData] = useState(null);
  /** Momento fijo al abrir el cierre (misma referencia que “Cierre” en el arqueo). */
  const [closingAtPreview, setClosingAtPreview] = useState(null);
  const [closingAmount, setClosingAmount] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [denominations, setDenominations] = useState({
    b200: '',
    b100: '',
    b50: '',
    b20: '',
    b10: '',
    m5: '',
    m2: '',
    m1: '',
    c50: '',
    c20: '',
    c10: '',
  });
  /** Monto verificado en POS / QR por método no efectivo (tarjeta, yape, plin, online). */
  const [nonCashCounted, setNonCashCounted] = useState({});
  const [closeDraftSavedAt, setCloseDraftSavedAt] = useState('');
  const closeFieldRefs = useRef({});
  const denomAdvanceTimerRef = useRef(null);
  useEffect(() => () => window.clearTimeout(denomAdvanceTimerRef.current), []);
  const closeAutoFocusDoneRef = useRef(false);
  const [registerHistory, setRegisterHistory] = useState([]);
  const [billingStatus, setBillingStatus] = useState({
    billing_enabled: 0,
    offline_mode: 1,
    auto_retry_enabled: 1,
    provider_reachable: false,
    pending_documents: 0,
    checked_at: '',
  });
  const [incomes, setIncomes] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [debitNotes, setDebitNotes] = useState([]);
  const [movementForm, setMovementForm] = useState({ amount: '', concept: '' });
  const [noteForm, setNoteForm] = useState({ amount: '', reason: '' });
  const printRef = useRef(null);
  const [printRestaurantInfo, setPrintRestaurantInfo] = useState({
    name: '',
    logo: '',
    legal_name: '',
    billing_nombre_comercial: '',
    billing_emisor_direccion: '',
    address: '',
    phone: '',
    email: '',
    company_ruc: '',
  });
  const { user } = useAuth();
  const posCanDeleteRelease = canPosDeleteOrReleaseTable(user);
  const posCanBarAutoDismiss = canAjusteBarAutoDismiss(user);
  const cajaOptionsForRole = useMemo(() => {
    let opts;
    if (posRoleOf(user) === 'cajero') {
      opts = CAJA_OPTIONS.filter((o) => CAJA_OPTIONS_CAJERO_IDS.has(o.id));
    } else {
      opts = CAJA_OPTIONS;
    }
    if (posCanBarAutoDismiss) {
      opts = [...opts, { id: 'bar_ajuste', label: 'Bar: auto 30 min' }];
    }
    return opts;
  }, [user?.role, posCanBarAutoDismiss]);
  useEffect(() => {
    setPadronUsedBump(0);
  }, [user?.padron_quota?.month, user?.id]);
  const padronQuotaUi = useMemo(() => {
    const pq = user?.padron_quota;
    const limit = pq?.limit != null && pq.limit !== '' ? Number(pq.limit) : null;
    if (limit == null || !Number.isFinite(limit) || limit < 1) {
      return { exhausted: false, label: '' };
    }
    const used = (Number(pq?.used) || 0) + padronUsedBump;
    return {
      exhausted: used >= limit,
      label: `Consultas padrón: ${used}/${limit} este mes`,
    };
  }, [user?.padron_quota, padronUsedBump]);
  const [cajaStations, setCajaStations] = useState([]);
  const [adminRegisterId, setAdminRegisterId] = useState(() => readPersistedAdminRegisterId());
  const adminRegisterIdRef = useRef(adminRegisterId);
  adminRegisterIdRef.current = adminRegisterId;
  const posUserRef = useRef(user);
  posUserRef.current = user;
  registerIdRef.current = String(register?.id || '').trim();

  const rememberClosedRegister = (registerId) => {
    const rid = String(registerId || '').trim();
    if (rid) closedRegisterIdsRef.current.add(rid);
    persistClosedRegisterIds(closedRegisterIdsRef.current);
  };

  const lockCajaClosed = (registerId) => {
    rememberClosedRegister(registerId);
    cajaLockedClosedRef.current = true;
    persistCajaLockedClosed(true);
  };

  const unlockCajaClosed = () => {
    cajaLockedClosedRef.current = false;
    persistCajaLockedClosed(false);
  };

  const filterStationsAfterClose = (stations) => {
    const closed = closedRegisterIdsRef.current;
    if (!closed.size) return stations;
    return (Array.isArray(stations) ? stations : []).map((s) => {
      const oid = String(s?.open_register?.id || '').trim();
      if (oid && closed.has(oid)) return { ...s, open_register: null };
      return s;
    });
  };

  const resolveLiveRegister = (raw) => liveOpenRegister(raw);
  const [barAutoDismiss, setBarAutoDismiss] = useState(false);
  const [barAutoDismissMinutes, setBarAutoDismissMinutes] = useState(30);
  const [barSettingsLoaded, setBarSettingsLoaded] = useState(false);
  const [barSettingsSaving, setBarSettingsSaving] = useState(false);

  const appendPosRegisterId = useCallback(
    (path) => {
      const rid = String(adminRegisterId || '').trim();
      if (posRoleOf(user) !== 'admin' || !rid) return path;
      const sep = path.includes('?') ? '&' : '?';
      return `${path}${sep}register_id=${encodeURIComponent(rid)}`;
    },
    [user?.role, adminRegisterId]
  );

  const posRegisterBody = useCallback(() => {
    const rid = String(adminRegisterId || '').trim();
    if (posRoleOf(user) !== 'admin' || !rid) return {};
    return { register_id: rid };
  }, [user?.role, adminRegisterId]);

  const isPosAdmin = posRoleOf(user) === 'admin';
  const isMasterAdmin = user?.role === 'master_admin';
  const [openingEdit, setOpeningEdit] = useState(null);
  const [savingOpening, setSavingOpening] = useState(false);
  const adminAttachedRegisterId = String(adminRegisterId || '').trim();
  const adminAttachedStation = useMemo(() => {
    if (!adminAttachedRegisterId) return null;
    return (
      cajaStations.find((s) => String(s.open_register?.id || '') === adminAttachedRegisterId) || null
    );
  }, [cajaStations, adminAttachedRegisterId]);
  const adminRegisterContextLive = Boolean(adminAttachedStation?.open_register?.id);
  /** Solo con 2+ cajas activas el admin puede cambiar de caja. */
  const canSwitchCaja = isPosAdmin && cajaStations.length > 1 && Boolean(adminAttachedRegisterId);
  /** Admin opera el mapa solo con caja elegida; cajero con su turno abierto. */
  const posRegisterReady = isPosAdmin ? (adminRegisterContextLive || Boolean(register)) : Boolean(register);
  const openCajaView = useCallback(
    (view) => {
      const allowed = cajaOptionsForRole.some((o) => o.id === view);
      const v = allowed ? view : 'cobrar';
      setActiveCajaOption(v);
      setSearchParams({ view: v }, { replace: true });
    },
    [cajaOptionsForRole, setSearchParams]
  );

  const prefetchTablesForCaja = useCallback(async (cajaStationId, posRole) => {
    const scopedCaja = String(cajaStationId || '').trim();
    if (!scopedCaja) return;
    const qs = `?caja_station_id=${encodeURIComponent(scopedCaja)}`;
    try {
      const [tablesData, salonesRes] = await Promise.all([
        api.get(`/tables${qs}`),
        api.get(`/tables/salones${qs}`).catch(() => ({ salones: [] })),
      ]);
      const salonesList = Array.isArray(salonesRes?.salones) ? salonesRes.salones : [];
      const scoped = scopeTablesAndSalonesForCaja(tablesData, salonesList, scopedCaja, posRole);
      setTables(scoped.tables);
      setSalonesConfig(scoped.salones);
      setLoading(false);
    } catch (_) {
      /* loadData completa el refresco */
    }
  }, []);

  const loadData = async (opts = {}) => {
    const gen = loadDataGenRef.current + 1;
    loadDataGenRef.current = gen;
    try {
      const posRole = posRoleOf(posUserRef.current);
      let adminRid =
        opts.adminRegisterOverride !== undefined
          ? String(opts.adminRegisterOverride || '').trim()
          : String(adminRegisterIdRef.current || '').trim();
      const staffCajaId =
        posRole === 'cajero' || posRole === 'mozo'
          ? String(posUserRef.current?.caja_station_id || '').trim()
          : '';
      const currentRegPath =
        posRole === 'admin'
          ? (adminRid
            ? `/pos/current-register?register_id=${encodeURIComponent(adminRid)}`
            : null)
          : '/pos/current-register';
      const staffTablesQs = staffCajaId
        ? `?caja_station_id=${encodeURIComponent(staffCajaId)}`
        : '';
      let regFetchFailed = false;

      const [
        stationsResEarly,
        regPreview,
        tablesStaff,
        salonesStaff,
        status,
        ordersData,
      ] = await Promise.all([
        api.get('/pos/caja-stations', { skipOffline: true }).catch(() => null),
        currentRegPath
          ? api.get(currentRegPath, { skipOffline: true }).catch(() => {
            regFetchFailed = true;
            return null;
          })
          : Promise.resolve(null),
        staffCajaId ? api.get(`/tables${staffTablesQs}`) : Promise.resolve(null),
        staffCajaId
          ? api.get(`/tables/salones${staffTablesQs}`).catch(() => ({ salones: [] }))
          : Promise.resolve(null),
        api.get('/pos/register-status', { skipOffline: true }).catch(() => null),
        api.get('/orders?limit=600').catch(() => []),
      ]);

      if (gen !== loadDataGenRef.current) return;

      const stationsList = Array.isArray(stationsResEarly?.stations) ? stationsResEarly.stations : [];
      setCajaStations((prev) => (stationsList.length ? stationsList : prev));
      if (posRole === 'admin' && !adminRid && stationsList.length === 1) {
        const onlyOpenId = String(stationsList[0]?.open_register?.id || '').trim();
        if (onlyOpenId) {
          adminRid = onlyOpenId;
          persistAdminRegisterId(onlyOpenId);
          setAdminRegisterId(onlyOpenId);
        }
      }

      let previewCajaId = String(regPreview?.caja_station_id || '').trim();
      if (!previewCajaId && posRole === 'admin' && adminRid) {
        const st = stationsList.find((s) => String(s.open_register?.id || '') === adminRid);
        previewCajaId = String(st?.id || '').trim();
      }
      if (!previewCajaId && staffCajaId) previewCajaId = staffCajaId;

      let tablesData = tablesStaff;
      let salonesList = Array.isArray(salonesStaff?.salones) ? salonesStaff.salones : [];
      if (!tablesData) {
        const tablesQs = previewCajaId
          ? `?caja_station_id=${encodeURIComponent(previewCajaId)}`
          : '';
        const [t, s] = await Promise.all([
          api.get(`/tables${tablesQs}`),
          api.get(`/tables/salones${tablesQs}`).catch(() => ({ salones: [] })),
        ]);
        tablesData = t;
        salonesList = Array.isArray(s?.salones) ? s.salones : [];
      } else if (previewCajaId && previewCajaId !== staffCajaId) {
        const tablesQs = `?caja_station_id=${encodeURIComponent(previewCajaId)}`;
        const [t, s] = await Promise.all([
          api.get(`/tables${tablesQs}`),
          api.get(`/tables/salones${tablesQs}`).catch(() => ({ salones: [] })),
        ]);
        tablesData = t;
        salonesList = Array.isArray(s?.salones) ? s.salones : [];
      }

      let regResolved = resolveLiveRegister(regPreview);
      let adminRegisterStillOpen = false;
      if (posRole === 'admin' && adminRid && !regResolved) {
        adminRegisterStillOpen = stationsList.some((s) => String(s.open_register?.id || '') === adminRid);
        if (adminRegisterStillOpen) {
          const st = stationsList.find((s) => String(s.open_register?.id || '') === adminRid);
          const op = st?.open_register;
          if (op) {
            regResolved = resolveLiveRegister({
              id: adminRid,
              caja_station_id: st.id,
              user_id: op.user_id,
              cajero_name: op.cajero_name,
              opened_at: op.opened_at,
            });
          }
        }
        if (!regResolved && stationsResEarly != null && !adminRegisterStillOpen) {
          persistAdminRegisterId('');
          setAdminRegisterId('');
        }
      }
      if (posRole === 'admin' && !adminRid) {
        regResolved = null;
      }
      if (posRole === 'cajero' && !regResolved) {
        const mine = stationsList.find((s) => s?.open_register?.id);
        const op = mine?.open_register;
        if (op) {
          regResolved = resolveLiveRegister({
            id: op.id,
            caja_station_id: mine.id,
            user_id: op.user_id,
            cajero_name: op.cajero_name,
            opened_at: op.opened_at,
          });
        }
      }
      if (!regResolved && opts.preferRegister) {
        regResolved = resolveLiveRegister(opts.preferRegister);
      }

      const scopedCaja = String(regResolved?.caja_station_id || previewCajaId || '').trim();
      const { tables: scopedTables, salones: scopedSalones } = scopeTablesAndSalonesForCaja(
        tablesData,
        salonesList,
        scopedCaja,
        posRole,
      );

      if (gen !== loadDataGenRef.current) return;

      setTables(scopedTables);
      setSalonesConfig(scopedSalones);
      setAllOrders(ordersData || []);
      const statusRegister = resolveLiveRegister(status?.register);
      const statusLooksOpen = Boolean(status?.is_open) && Boolean(statusRegister);
      setRegisterStatus({
        ...(status && typeof status === 'object' ? status : { is_open: false, register: null }),
        is_open: statusLooksOpen,
        register: statusRegister,
      });
      setRegister((prev) => {
        if (regResolved) return regResolved;
        if (regFetchFailed) return resolveLiveRegister(prev);
        return null;
      });
      setLoading(false);

      const [
        prods,
        cats,
        modifiersData,
        combosData,
        cfg,
        paymentMethodsRes,
        daily,
        reservationsData,
        restaurantRes,
      ] = await Promise.all([
        api.get('/products?active_only=true&available_now=true'),
        api.get('/categories/active'),
        api.get('/admin-modules/modifiers').catch(() => []),
        api.get('/admin-modules/combos').catch(() => []),
        api.get('/admin-modules/config/app').catch(() => null),
        api.get('/pos/payment-methods').catch(() => null),
        api.get('/reports/daily').catch(() => null),
        api.get('/admin-modules/reservations').catch(() => []),
        api.get('/restaurant').catch(() => null),
      ]);

      if (gen !== loadDataGenRef.current) return;

      setPrintRestaurantInfo({
        name: String(restaurantRes?.name || '').trim(),
        logo: resolveMediaUrl(restaurantRes?.logo || ''),
        legal_name: String(restaurantRes?.legal_name || '').trim(),
        billing_nombre_comercial: String(restaurantRes?.billing_nombre_comercial || '').trim(),
        billing_emisor_direccion: String(restaurantRes?.billing_emisor_direccion || '').trim(),
        address: String(restaurantRes?.address || '').trim(),
        phone: String(restaurantRes?.phone || '').trim(),
        email: String(restaurantRes?.email || '').trim(),
        company_ruc: String(restaurantRes?.company_ruc || '').trim(),
        profile:
          restaurantRes?.profile && typeof restaurantRes.profile === 'object'
            ? restaurantRes.profile
            : undefined,
      });
      const visibleCategories = cats.filter((c) => !WAREHOUSE_CATEGORY_NAMES.has((c.name || '').toUpperCase()));
      const mergedCatalog = mergeOrderingCatalog(prods, visibleCategories, combosData || []);
      const visibleCategoryIds = new Set(mergedCatalog.categories.map((c) => c.id));
      const visibleProducts = filterVisibleOrderingProducts(mergedCatalog.products, visibleCategoryIds);
      setProducts(visibleProducts);
      setModifiers(Array.isArray(modifiersData) ? modifiersData : []);
      setCategories(mergedCatalog.categories);
      setPaymentOptions(
        Array.isArray(paymentMethodsRes?.options) && paymentMethodsRes.options.length
          ? paymentMethodsRes.options
          : getPaymentMethodOptions(cfg, { includeOnline: false }),
      );
      setPosTerminalEnabled(
        typeof paymentMethodsRes?.pos_enabled === 'boolean'
          ? paymentMethodsRes.pos_enabled
          : isPosTerminalEnabledInConfig(cfg),
      );
      setDailySales(
        daily?.sales?.total_sales === undefined || daily?.sales?.total_sales === null
          ? null
          : Number(daily.sales.total_sales || 0)
      );
      setReservations(reservationsData || []);

      if (selectedTableIdRef.current) {
        const selId = selectedTableIdRef.current;
        if (isClientCheckoutTable({ id: selId })) {
          const cid = String(selId).slice(CLIENT_CHECKOUT_TABLE_PREFIX.length);
          const fresh = (ordersData || []).filter(
            (o) =>
              String(o.customer_id || '') === cid &&
              String(o.payment_status || '') !== 'paid' &&
              String(o.status || '') !== 'cancelled'
          );
          setSelectedTable((prev) =>
            prev && prev.id === selId && isClientCheckoutTable(prev) ? { ...prev, orders: fresh } : prev
          );
        } else if (isDeliveryCheckoutTable({ id: selId })) {
          const slots = buildOrderCajaSlots(ordersData);
          const next = slots.find((s) => s.id === selId);
          setSelectedTable((prev) => {
            if (!prev || prev.id !== selId) return prev;
            if (next) return next;
            setShowBill(false);
            setSplitMode(false);
            setSelectedOrderItemIds([]);
            setSelectedOrderItemQtys({});
            return null;
          });
        } else {
          const updated = scopedTables.find((t) => t.id === selId);
          setSelectedTable((prev) => {
            if (!prev || prev.id !== selId) return prev;
            if (updated) {
              syncLockRenumber(updated);
              return updated;
            }
            return prev;
          });
        }
      }
      if (tableDetailIdRef.current) {
        const detailId = tableDetailIdRef.current;
        if (isDeliveryCheckoutTable({ id: detailId })) {
          const slots = buildOrderCajaSlots(ordersData);
          const next = slots.find((s) => s.id === detailId);
          setTableDetail((prev) => (prev && prev.id === detailId ? (next || null) : prev));
        } else {
          const updatedDetail = scopedTables.find((t) => t.id === detailId);
          setTableDetail((prev) => {
            if (!prev || prev.id !== detailId) return prev;
            if (updatedDetail) {
              syncLockRenumber(updatedDetail);
              return updatedDetail;
            }
            return prev;
          });
        }
      }
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const reservationAlertToastIdsRef = useRef(new Set());
  const printedSunatPdfRef = useRef(new Set());

  const openAcceptedSunatPdf = useCallback((doc) => {
    if (!doc?.id) return;
    if (String(doc.provider_status || '').toLowerCase() !== 'accepted') return;
    const pdf = String(doc.pdf_url || '').trim();
    if (!pdf) return;
    if (printedSunatPdfRef.current.has(doc.id)) return;
    printedSunatPdfRef.current.add(doc.id);
    window.open(resolveMediaUrl(pdf), '_blank', 'noopener,noreferrer');
    toast.success(`SUNAT aceptó ${doc.full_number || 'el comprobante'}. Se abrió el PDF para imprimir.`);
  }, []);

  const syncReservationAlertToasts = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const data = await api.get('/reports/reservation-caja-alerts');
      const alerts = (data?.alerts || []).filter((a) => String(a?.id || '').startsWith('reserva_caja_'));
      const nextIds = new Set();

      for (const alert of alerts) {
        const id = reservationCajaToastId(alert.id);
        if (!id) continue;
        archiveReservationCajaAviso({
          id,
          title: alert.title,
          message: alert.message,
        });
        if (isReservationCajaToastDismissed(id)) {
          toast.dismiss(id);
          continue;
        }
        nextIds.add(id);
        toast.custom(
          (t) => (
            <ReservaCajaToastBody
              visible={t.visible}
              title={alert.title}
              message={alert.message}
              onClose={() => {
                dismissReservationCajaToast(t.id);
                toast.dismiss(t.id);
              }}
            />
          ),
          { id, duration: Infinity }
        );
      }

      for (const id of reservationAlertToastIdsRef.current) {
        if (!nextIds.has(id)) {
          // Fuera de la ventana T−20: se oculta sin marcarlo cerrado, para que vuelva a tiempo.
          toast.dismiss(id);
        }
      }
      reservationAlertToastIdsRef.current = nextIds;
    } catch (_) {
      /* noop */
    }
  }, []);

  const loadPrinterConfig = async () => {
    try {
      const cfg = await fetchPrintingConfig();
      setPrintingConfig(cfg);
    } catch (err) {
      console.warn('[printing] fallback POS config por error de carga:', err?.message || err);
      setPrintingConfig(DEFAULT_PRINTING_CONFIG);
    }
  };

  useEffect(() => {
    selectedTableIdRef.current = selectedTable?.id ?? null;
  }, [selectedTable?.id]);

  useEffect(() => {
    const posRole = posRoleOf(user);
    if (posRole !== 'cajero' && posRole !== 'mozo') return;
    const cajaId = String(user?.caja_station_id || '').trim();
    if (!cajaId) return;
    const qs = `?caja_station_id=${encodeURIComponent(cajaId)}`;
    const cachedTables = readGetCache(`/tables${qs}`) ?? readGetCache('/tables');
    const cachedSalones = readGetCache(`/tables/salones${qs}`) ?? readGetCache('/tables/salones');
    if (!Array.isArray(cachedTables) || !cachedTables.length) return;
    const salonesList = Array.isArray(cachedSalones?.salones)
      ? cachedSalones.salones
      : (Array.isArray(cachedSalones) ? cachedSalones : []);
    const scoped = scopeTablesAndSalonesForCaja(cachedTables, salonesList, cajaId, posRole);
    if (!scoped.tables.length) return;
    setTables(scoped.tables);
    setSalonesConfig(scoped.salones);
    setLoading(false);
  }, [user?.id, user?.caja_station_id, user?.role]);

  useEffect(() => {
    tableDetailIdRef.current = tableDetail?.id ?? null;
  }, [tableDetail?.id]);

  useEffect(() => {
    showBillRef.current = showBill;
  }, [showBill]);

  useEffect(() => {
    showMenuRef.current = showMenu;
  }, [showMenu]);

  const mesaDetailModalOpenRef = useRef(mesaDetailModalOpen);
  mesaDetailModalOpenRef.current = mesaDetailModalOpen;

  const pollPosData = () => {
    if (
      checkoutInFlightRef.current
      || showBillRef.current
      || showMenuRef.current
      || mesaDetailModalOpenRef.current
    ) {
      return;
    }
    void loadData();
  };

  useEffect(() => {
    void loadData();
    void loadPrinterConfig();
  }, []);
  useActiveInterval(pollPosData, 10000);
  useSocket('register-update', (payload) => {
    if (payload?.action === 'close') {
      const closedId = String(payload.registerId || '').trim();
      const closedStation = String(payload.caja_station_id || '').trim();
      const role = posRoleOf(posUserRef.current);
      const myStation = String(posUserRef.current?.caja_station_id || '').trim();
      const myReg = String(registerIdRef.current || '').trim();
      const adminReg = String(adminRegisterIdRef.current || '').trim();
      const affectsMe = role === 'cajero'
        ? Boolean((closedStation && closedStation === myStation) || (closedId && closedId === myReg))
        : Boolean(closedId && adminReg && closedId === adminReg);
      invalidateGetCache(REGISTER_STATE_CACHE_PATHS);
      if (affectsMe) {
        loadDataGenRef.current += 1;
        setRegister(null);
        setRegisterStatus({ is_open: false, register: null });
        if (role === 'admin') {
          persistAdminRegisterId('');
          setAdminRegisterId('');
        }
      }
    }
    void loadData();
  });
  useSocket('order-update', () => {
    void loadData();
    void syncReservationAlertToasts();
  });
  useSocket('table-update', loadData);
  useSocket('salones-update', loadData);
  useSocket('inventory-update', loadData);
  useSocket('staff-data-update', (payload) => {
    const d = payload?.domain;
    if (['modifiers', 'reservations', 'customers', 'app_config', 'catalog', 'combos'].includes(d)) void loadData();
    if (d === 'reservations') void syncReservationAlertToasts();
  });
  useSocket('reservation-reminder', (payload) => {
    void loadData();
    const r = payload?.reservation;
    if (r?.id) {
      const toastId = reservationCajaToastId(r.id);
      const needsTable = Boolean(r.needs_table) || /sin mesa/i.test(String(r.table_label || ''));
      const tableLabel = r.table_label || 'Sin mesa asignada';
      const title = needsTable
        ? 'Reserva — asigne mesa y preparativos'
        : 'Reserva próxima — verificar preparativos';
      const msg = needsTable
        ? `${r.client_name || 'Cliente'} · ${r.date || ''} ${r.time || ''}. Pedido de reserva sin mesa: asigne mesa y verifique preparativos (cocina 30 min antes).`
        : `${r.client_name || 'Cliente'} · ${r.date || ''} ${r.time || ''} · ${Number(r.guests || 0)} persona(s). ${tableLabel}: verifique preparativos de la mesa.`;
      archiveReservationCajaAviso({ id: toastId, title, message: msg });
      if (!isReservationCajaToastDismissed(toastId)) {
        toast.custom(
          (t) => (
            <ReservaCajaToastBody
              visible={t.visible}
              title={title}
              message={msg}
              onClose={() => {
                dismissReservationCajaToast(t.id);
                toast.dismiss(t.id);
              }}
            />
          ),
          { id: toastId, duration: Infinity }
        );
        reservationAlertToastIdsRef.current.add(toastId);
      } else {
        toast.dismiss(toastId);
      }
    }
    void syncReservationAlertToasts();
  });
  useEffect(() => {
    const onSynced = () => { void loadData(); };
    window.addEventListener('rf-offline-synced', onSynced);
    return () => window.removeEventListener('rf-offline-synced', onSynced);
  }, []);

  useEffect(() => {
    void syncReservationAlertToasts();
    const interval = setInterval(() => void syncReservationAlertToasts(), 20000);
    return () => clearInterval(interval);
  }, [syncReservationAlertToasts]);

  useEffect(() => {
    if (!paymentOptions.some(opt => opt.value === paymentMethod)) {
      setPaymentMethod(paymentOptions[0]?.value || 'efectivo');
    }
  }, [paymentOptions, paymentMethod]);

  const multiPaymentOptions = useMemo(
    () => orderMultiPaymentOptions(paymentOptions),
    [paymentOptions]
  );

  useEffect(() => {
    if (!showBill) return;
    setMultiPayEnabled(false);
    setMultiPayAmounts(emptyMultiPaymentAmounts());
    setTipPayEnabled(false);
    setCheckoutTipAmount('');
    setCheckoutPaymentNote(''); setPaymentNoteOpen(false);
  }, [showBill, selectedTable?.id]);

  useEffect(() => {
    if (!showMenu) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [showMenu]);

  const releasePendingOrderMenu = useCallback(() => {
    setShowMenu(false);
    setQuickSaleMode(false);
    setEditingOrderId('');
    setEditingSessionOrderIds([]);
    setParaLlevarMesa(false);
    setMesaOrderObservation('');
    resetCart();
    clearMesaLock();
  }, [resetCart, clearMesaLock]);

  useEffect(() => {
    const requestedView = searchParams.get('view');
    const isValidView = cajaOptionsForRole.some((option) => option.id === requestedView);
    if (isValidView && requestedView !== activeCajaOption) {
      setActiveCajaOption(requestedView);
      return;
    }
    if (!isValidView && requestedView) {
      setActiveCajaOption('cobrar');
      setSearchParams({ view: 'cobrar' }, { replace: true });
      return;
    }
    if (!isValidView && !requestedView) {
      setSearchParams({ view: 'cobrar' }, { replace: true });
    }
  }, [activeCajaOption, searchParams, setSearchParams, cajaOptionsForRole]);

  useEffect(() => {
    if (activeCajaOption !== 'cobrar') setMesaDetailModalOpen(false);
  }, [activeCajaOption]);

  useEffect(() => {
    if (!posCanBarAutoDismiss) return undefined;
    let cancelled = false;
    api
      .get('/orders/bar-station-settings')
      .then((data) => {
        if (cancelled) return;
        setBarAutoDismiss(Boolean(data?.autoDismissPendingAfter30Min));
        if (data?.autoDismissMinutes != null) {
          setBarAutoDismissMinutes(Number(data.autoDismissMinutes));
        }
        setBarSettingsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setBarSettingsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [posCanBarAutoDismiss]);

  const saveBarAutoDismissSettings = async ({ enabled, minutes } = {}) => {
    setBarSettingsSaving(true);
    try {
      const payload = {};
      if (enabled !== undefined) payload.autoDismissPendingAfter30Min = Boolean(enabled);
      if (minutes !== undefined) payload.autoDismissMinutes = Number(minutes);
      const saved = await api.put('/orders/bar-station-settings', payload);
      setBarAutoDismiss(Boolean(saved?.autoDismissPendingAfter30Min));
      if (saved?.autoDismissMinutes != null) {
        setBarAutoDismissMinutes(Number(saved.autoDismissMinutes));
      }
      toast.success(
        enabled !== undefined
          ? (saved?.autoDismissPendingAfter30Min
            ? `Ajuste activo: ${saved.autoDismissMinutes} min`
            : 'Ajuste desactivado')
          : `Tiempo guardado: ${saved?.autoDismissMinutes} min`,
      );
    } catch (err) {
      toast.error(err?.message || 'No se pudo guardar el ajuste de bar');
    } finally {
      setBarSettingsSaving(false);
    }
  };

  useSocket('bar-station-settings-update', (payload) => {
    if (!payload || !posCanBarAutoDismiss) return;
    setBarAutoDismiss(Boolean(payload.autoDismissPendingAfter30Min));
    if (payload.autoDismissMinutes != null) {
      setBarAutoDismissMinutes(Number(payload.autoDismissMinutes));
    }
  });

  const loadCajaExtras = async () => {
    try {
      const history = await api.get('/pos/history');
      setRegisterHistory(history);
    } catch {
      setRegisterHistory([]);
    }
    if (!register) return;
    try {
      const [incomeData, expenseData, creditData, debitData] = await Promise.all([
        api.get(appendPosRegisterId('/pos/movements?type=income')),
        api.get(appendPosRegisterId('/pos/movements?type=expense')),
        api.get(appendPosRegisterId('/pos/notes?note_type=credit')),
        api.get(appendPosRegisterId('/pos/notes?note_type=debit')),
      ]);
      setIncomes(incomeData);
      setExpenses(expenseData);
      setCreditNotes(creditData);
      setDebitNotes(debitData);
    } catch {
      setIncomes([]);
      setExpenses([]);
      setCreditNotes([]);
      setDebitNotes([]);
    }
  };

  useEffect(() => { loadCajaExtras(); }, [register?.id, appendPosRegisterId]);

  const loadBillingStatus = async () => {
    try {
      const status = await api.get('/billing/provider-status');
      setBillingStatus(status || {});
    } catch (_) {
      setBillingStatus(prev => ({ ...prev, provider_reachable: false, checked_at: new Date().toISOString() }));
    }
  };

  useSocket('billing-document-update', (payload) => {
    loadBillingStatus();
    if (payload?.print_caja || String(payload?.provider_status || '').toLowerCase() === 'accepted') {
      openAcceptedSunatPdf(payload);
    }
  });

  useEffect(() => {
    loadBillingStatus();
    const timer = setInterval(loadBillingStatus, 15000);
    const handleOnline = () => loadBillingStatus();
    const handleOffline = () => setBillingStatus(prev => ({ ...prev, provider_reachable: false }));
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (billingForm.doc_type === 'factura' && billingForm.customer_doc_type !== '6') {
      setBillingForm(prev => ({ ...prev, customer_doc_type: '6' }));
    }
    if (billingForm.doc_type === 'nota_venta' && billingForm.customer_doc_type !== '0') {
      setBillingForm(prev => ({ ...prev, customer_doc_type: '0' }));
    }
    if (billingForm.doc_type === 'nota_venta' && billingForm.invoice_lines_mode !== 'detallado') {
      setBillingForm(prev => ({ ...prev, invoice_lines_mode: 'detallado' }));
    }
  }, [billingForm.doc_type, billingForm.customer_doc_type, billingForm.invoice_lines_mode]);

  useEffect(() => {
    if (!billingForm.enabled) {
      setMatchedCustomer(null);
      setSearchingCustomer(false);
      return;
    }
    const docNumber = normalizeDocNumber(billingForm.customer_doc_number);
    const docType = getActiveDocType();
    const requiredLength = docType === '6' ? 11 : docType === '1' ? 8 : 0;
    if (!docNumber || (requiredLength && docNumber.length !== requiredLength)) {
      setMatchedCustomer(null);
      setSearchingCustomer(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setSearchingCustomer(true);
        const found = await api.get(`/admin-modules/customers/by-document?doc_number=${encodeURIComponent(docNumber)}`);
        if (cancelled) return;
        setMatchedCustomer(found || null);
        if (found) {
          applyCustomerToBilling(found);
        }
      } catch (_) {
        if (!cancelled) setMatchedCustomer(null);
      } finally {
        if (!cancelled) setSearchingCustomer(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [billingForm.enabled, billingForm.customer_doc_number, billingForm.customer_doc_type, billingForm.doc_type]);

  const denomDefs = [
    { key: 'b200', label: 'Billete S/200', value: 200 },
    { key: 'b100', label: 'Billete S/100', value: 100 },
    { key: 'b50', label: 'Billete S/50', value: 50 },
    { key: 'b20', label: 'Billete S/20', value: 20 },
    { key: 'b10', label: 'Billete S/10', value: 10 },
    { key: 'm5', label: 'Moneda S/5', value: 5 },
    { key: 'm2', label: 'Moneda S/2', value: 2 },
    { key: 'm1', label: 'Moneda S/1', value: 1 },
    { key: 'c50', label: 'Moneda S/0.50', value: 0.5 },
    { key: 'c20', label: 'Moneda S/0.20', value: 0.2 },
    { key: 'c10', label: 'Moneda S/0.10', value: 0.1 },
  ];

  const openRegisterForCajero = async () => {
    if (workAreaLoading) return;
    if (openingAmount === '') return toast.error('Ingresa el monto inicial de caja');
    const amount = parseFloat(openingAmount);
    if (Number.isNaN(amount) || amount < 0) return toast.error('El monto inicial no es válido');
    setWorkAreaLoading(true);
    try {
      const reg = await api.post('/pos/open-register', { opening_amount: amount });
      unlockCajaClosed();
      setRegister(reg);
      setRegisterStatus({ is_open: true, register: { user_id: user?.id, cajero_name: user?.full_name, opened_at: reg.opened_at } });
      setOpeningAmount('');
      toast.success(
        reg?.already_open
          ? 'Tu caja ya estaba abierta: ingresaste al turno en curso'
          : `Caja abierta con ${formatCurrency(amount)}`,
      );
      await loadData({ preferRegister: reg });
    } catch (err) { toast.error(err.message); }
    finally { setWorkAreaLoading(false); }
  };

  const openStationRegisterForAdmin = async (stationId) => {
    if (workAreaLoading) return;
    if (openingAmount === '') return toast.error('Ingresa el monto inicial de caja');
    const amount = parseFloat(openingAmount);
    if (Number.isNaN(amount) || amount < 0) return toast.error('El monto inicial no es válido');
    const sid = String(stationId || '').trim();
    if (!sid) return toast.error('Caja no válida');
    setWorkAreaLoading(true);
    try {
      const reg = await api.post('/pos/open-register', { opening_amount: amount, caja_station_id: sid });
      unlockCajaClosed();
      persistAdminRegisterId(reg.id);
      setAdminRegisterId(reg.id);
      setRegister(reg);
      setRegisterStatus({ is_open: true, register: { user_id: user?.id, cajero_name: user?.full_name, opened_at: reg.opened_at } });
      setOpeningAmount('');
      toast.success(
        reg?.already_open
          ? 'Esa caja ya estaba abierta: ingresaste al turno en curso'
          : `Caja abierta con ${formatCurrency(amount)}`,
      );
      await loadData({ adminRegisterOverride: reg.id });
    } catch (err) { toast.error(err.message); }
    finally { setWorkAreaLoading(false); }
  };

  const attachAdminToRegister = async (registerId) => {
    if (workAreaLoading) return;
    const rid = String(registerId || '').trim();
    if (!rid) return;
    setWorkAreaLoading(true);
    try {
      persistAdminRegisterId(rid);
      setAdminRegisterId(rid);
      const station = cajaStations.find((s) => String(s.open_register?.id || '') === rid);
      const op = station?.open_register;
      if (op) {
        setRegister((prev) => ({
          ...(prev && String(prev.id) === rid ? prev : {}),
          id: rid,
          caja_station_id: station.id,
          user_id: op.user_id,
          cajero_name: op.cajero_name,
          opened_at: op.opened_at,
        }));
      }
      void prefetchTablesForCaja(station?.id, posRoleOf(user));
      await loadData({ adminRegisterOverride: rid });
    } finally {
      setWorkAreaLoading(false);
    }
  };

  const clearAdminRegisterContext = async () => {
    persistAdminRegisterId('');
    setAdminRegisterId('');
    setRegister(null);
    await loadData({ adminRegisterOverride: '' });
  };

  const prepareClose = async () => {
    if (preparingCloseModal || closingRegisterBusy) return;
    const gen = prepareCloseGenRef.current + 1;
    prepareCloseGenRef.current = gen;
    const now = new Date();
    setClosingAtPreview(now);
    const draft = readCashCloseDraft(register?.id);
    setClosingAmount(draft?.closingAmount ?? '');
    setClosingNotes(draft?.closingNotes ?? '');
    setDenominations({ ...EMPTY_DENOMINATIONS, ...(draft?.denominations || {}) });
    setNonCashCounted(draft?.nonCashCounted || {});
    setCloseDraftSavedAt(draft?.savedAt || '');
    closeAutoFocusDoneRef.current = false;
    setPreparingCloseModal(true);
    setShowCloseModal(true);
    try {
      await wakeRemoteApi();
      if (gen !== prepareCloseGenRef.current) return;
      try {
        await loadData();
      } catch (_) {
        /* usa el estado actual */
      }
      if (gen !== prepareCloseGenRef.current) return;
      const posRole = posRoleOf(posUserRef.current);
      const adminRid = String(adminRegisterIdRef.current || '').trim();
      const currentRegPath = posRole === 'admin'
        ? (adminRid ? `/pos/current-register?register_id=${encodeURIComponent(adminRid)}` : null)
        : '/pos/current-register';
      const fresh = currentRegPath ? await api.get(currentRegPath, { skipOffline: true }).catch(() => null) : null;
      if (gen !== prepareCloseGenRef.current) return;
      if (currentRegPath && !fresh) {
        toast.error('No se pudieron leer las ventas del turno. Reintente el cierre; no cierre si los totales salen en 0.');
      }
      setClosingData(fresh || register);
    } finally {
      if (gen === prepareCloseGenRef.current) setPreparingCloseModal(false);
    }
  };

  const dismissCloseModal = () => {
    if (closingRegisterBusy) return;
    prepareCloseGenRef.current += 1;
    setPreparingCloseModal(false);
    setShowCloseModal(false);
    setClosingAtPreview(null);
  };

  const calculateDenominationTotal = () => {
    const raw = denomDefs.reduce((sum, d) => sum + (parseFloat(denominations[d.key]) || 0) * d.value, 0);
    return roundMoneySoles(raw);
  };

  const updateDenomination = (key, value) => {
    const safeValue = value === '' ? '' : Math.max(0, parseFloat(value) || 0);
    const updated = { ...denominations, [key]: safeValue };
    setDenominations(updated);
    const total = roundMoneySoles(
      denomDefs.reduce((sum, d) => sum + (parseFloat(updated[d.key]) || 0) * d.value, 0)
    );
    setClosingAmount(total.toFixed(2));
  };

  const closeFieldOrder = () => [
    ...denomDefs.map((d) => d.key),
    'nc_total_pos',
    ...registerPaymentRows.filter((r) => r.value !== 'efectivo').map((r) => `nc_${r.value}`),
    'closingNotes',
  ];

  const focusCloseField = (key) => {
    const el = closeFieldRefs.current[key];
    if (!el) return false;
    el.focus();
    if (el.tagName === 'INPUT') el.select();
    return true;
  };

  const focusNextCloseField = (key) => {
    const order = closeFieldOrder();
    for (let i = order.indexOf(key) + 1; i < order.length; i += 1) {
      if (focusCloseField(order[i])) return;
    }
  };

  /** Enter: confirma la cantidad (vacío = 0) y salta a la siguiente denominación, de mayor a menor. */
  const handleCloseFieldEnter = (e, key) => {
    const isDenom = denomDefs.some((d) => d.key === key);
    if (isDenom && (e.key === '0' || e.key === 'Numpad0') && Number(denominations[key] || 0) === 0) {
      e.preventDefault();
      window.clearTimeout(denomAdvanceTimerRef.current);
      updateDenomination(key, '0');
      focusNextCloseField(key);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    window.clearTimeout(denomAdvanceTimerRef.current);
    if (denomDefs.some((d) => d.key === key) && denominations[key] === '') updateDenomination(key, '0');
    focusNextCloseField(key);
  };

  /** Al escribir una cantidad avanza solo: 0 al instante; otros números tras una pausa breve (permite 12, 150…). */
  const handleDenominationInput = (key, raw) => {
    updateDenomination(key, raw);
    window.clearTimeout(denomAdvanceTimerRef.current);
    const value = String(raw ?? '').trim();
    if (value === '') return;
    const el = closeFieldRefs.current[key];
    const advance = () => {
      if (el && document.activeElement === el) focusNextCloseField(key);
    };
    if (Number(value) === 0) {
      advance();
      return;
    }
    denomAdvanceTimerRef.current = window.setTimeout(advance, DENOM_AUTO_ADVANCE_MS);
  };

  const saveCloseDraft = () => {
    const savedAt = new Date().toISOString();
    const ok = writeCashCloseDraft(register?.id, {
      denominations,
      closingAmount,
      closingNotes,
      nonCashCounted,
      savedAt,
    });
    if (!ok) {
      toast.error('No se pudo guardar el borrador en este equipo');
      return;
    }
    setCloseDraftSavedAt(savedAt);
    toast.success('Borrador de cierre guardado. Puede seguir cobrando y retomarlo con «Cerrar caja».');
    dismissCloseModal();
  };

  const discardCloseDraft = () => {
    clearCashCloseDraft(register?.id);
    setCloseDraftSavedAt('');
    setDenominations({ ...EMPTY_DENOMINATIONS });
    setClosingAmount('');
    setClosingNotes('');
    setNonCashCounted({});
    closeAutoFocusDoneRef.current = false;
    toast.success('Borrador descartado');
  };

  const closeRegister = async () => {
    if (closingRegisterBusy) return;
    if (closingAmount === '') return toast.error('Ingresa el efectivo contado para cerrar caja');
    const amount = roundMoneySoles(parseFloat(closingAmount));
    if (Number.isNaN(amount) || amount < 0) return toast.error('El efectivo contado no es válido');
    setClosingRegisterBusy(true);
    try {
      await wakeRemoteApi();
      await api.post('/pos/close-register', {
        closing_amount: amount,
        notes: closingNotes,
        arqueo: {
          expected_cash: expectedRounded,
          counted_cash: amount,
          difference,
          denominations,
          non_cash_counted: nonCashCounted,
          non_cash_total_pos: nonCashTotalPos,
          observations: closingNotes,
        },
        ...posRegisterBody(),
      }, { skipOffline: true, _retryContext: 'Cierre de caja:' });
      lockCajaClosed(register?.id);
      loadDataGenRef.current += 1;
      invalidateGetCache(REGISTER_STATE_CACHE_PATHS);
      clearCashCloseDraft(register?.id);
      setCloseDraftSavedAt('');
      toast.success('Caja cerrada — Informe guardado');
      setShowCloseModal(false);
      setClosingAtPreview(null);
      setRegister(null);
      setRegisterStatus({ is_open: false, register: null });
      setCajaStations((prev) => filterStationsAfterClose(prev));
      if (posRoleOf(user) === 'admin') {
        persistAdminRegisterId('');
        setAdminRegisterId('');
      }
      await loadData();
      invalidateGetCache(REGISTER_STATE_CACHE_PATHS);
      await loadCajaExtras();
    } catch (err) { toast.error(err.message); }
    finally { setClosingRegisterBusy(false); }
  };
  /** Impresión clásica (diálogo del navegador / impresora USB), no tiketera térmica. */
  const printCloseRegisterManual = () => {
    const content = printRef.current;
    if (!content) {
      toast.error('No hay contenido para imprimir');
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc || !iframe.contentWindow) {
      toast.error('No se pudo preparar la impresión');
      document.body.removeChild(iframe);
      return;
    }

    const restaurantName =
      String(printRestaurantInfo.billing_nombre_comercial || printRestaurantInfo.name || '').trim() || 'Restaurante';

    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Arqueo de caja</title>
    <style>
      @page { margin: 12mm; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111827; padding: 0; margin: 0; }
      .brand { font-size: 11px; color: #4b5563; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
      h2 { font-size: 16px; margin: 0 0 4px; text-transform: uppercase; color: #111827; }
      h3 { font-size: 13px; font-weight: 500; margin: 0 0 12px; color: #374151; }
      .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 2px 0; color: #111827; }
      .row span:last-child { text-align: right; }
      .row.bold { font-weight: 700; }
      .total-row { font-weight: 700; }
      .sep { border-top: 1px dashed #9ca3af; margin: 8px 0; }
      .diff-pos { color: #047857; font-weight: 700; }
      .diff-neg { color: #b91c1c; font-weight: 700; }
      .products-table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 11px; }
      .products-table th, .products-table td { padding: 3px 4px; border-bottom: 1px solid #e5e7eb; text-align: left; color: #111827; }
      .products-table th.num, .products-table td.num { text-align: right; white-space: nowrap; }
      .products-table thead th { font-size: 10px; text-transform: uppercase; color: #6b7280; }
      .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; margin: 8px 0 4px; color: #374151; }
    </style>
  </head>
  <body>
    <p class="brand">${restaurantName}</p>
    ${content.innerHTML}
  </body>
</html>`);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => {
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
      }, 700);
    }, 200);
  };

  const resetBillingForm = () => {
    setBillingForm(DEFAULT_BILLING_FORM);
    setBillingResult(null);
    setMatchedCustomer(null);
    setSelectedBillingCustomerId('');
    setAddToAccountEnabled(false);
    setSearchingCustomer(false);
  };

  const resolveBillingCustomerId = () =>
    String(selectedBillingCustomerId || matchedCustomer?.id || '').trim();

  const handleCustomerPicked = (customer) => {
    if (!customer) return;
    applyCustomerToBilling(customer);
    setMatchedCustomer(customer);
    setSelectedBillingCustomerId(String(customer.id || ''));
    toast.success(`Cliente cargado: ${customer.name}`);
  };

  const normalizeDocNumber = (value) => String(value || '').replace(/\D/g, '');

  const getActiveDocType = () => (billingForm.doc_type === 'factura' ? '6' : billingForm.customer_doc_type);

  const handleConsultaPadron = useCallback(async () => {
    const docType = billingForm.doc_type === 'factura' ? '6' : billingForm.customer_doc_type;
    if (docType !== '1' && docType !== '6') {
      toast.error('Seleccione DNI o RUC');
      return;
    }
    const num = normalizeDocNumber(billingForm.customer_doc_number);
    const okLen = docType === '6' ? num.length === 11 : num.length === 8;
    if (!okLen) {
      toast.error(docType === '6' ? 'Ingrese RUC de 11 dígitos' : 'Ingrese DNI de 8 dígitos');
      return;
    }
    const pq = user?.padron_quota;
    const lim = pq?.limit != null && pq.limit !== '' ? Number(pq.limit) : null;
    if (lim != null && Number.isFinite(lim) && lim > 0) {
      const used = (Number(pq?.used) || 0) + padronUsedBump;
      if (used >= lim) {
        toast.error(`Límite mensual de consultas DNI/RUC alcanzado (${lim}).`);
        return;
      }
    }
    try {
      setConsultaPadronLoading(true);
      const data = await api.get(
        `/admin-modules/consulta-padron?doc_type=${encodeURIComponent(docType)}&numero=${encodeURIComponent(num)}`
      );
      const nombre = String(data?.nombre || '').trim();
      if (!nombre) {
        toast.error('No se recibió el nombre del padrón');
        return;
      }
      setBillingForm((prev) => ({
        ...prev,
        customer_name: nombre,
        customer_address:
          data?.direccion != null && String(data.direccion).trim()
            ? String(data.direccion).trim()
            : prev.customer_address,
      }));
      setMatchedCustomer(null);
      if (lim != null && Number.isFinite(lim) && lim > 0) {
        setPadronUsedBump((b) => b + 1);
      }
      toast.success(docType === '6' ? 'Razón social obtenida del padrón' : 'Nombre obtenido del padrón');
    } catch (err) {
      const msg = err?.message || 'No se pudo consultar el padrón';
      if (String(msg).toLowerCase().includes('límite mensual') || String(msg).includes('429')) {
        toast.error(msg);
      } else {
        toast.error(msg);
      }
    } finally {
      setConsultaPadronLoading(false);
    }
  }, [
    billingForm.customer_doc_number,
    billingForm.doc_type,
    billingForm.customer_doc_type,
    user?.padron_quota,
    padronUsedBump,
  ]);

  const applyCustomerToBilling = (customer) => {
    if (!customer) return;
    if (customer.id) setSelectedBillingCustomerId(String(customer.id));
    setBillingForm(prev => ({
      ...prev,
      customer_doc_type: String(customer.doc_type || prev.customer_doc_type || '1'),
      customer_doc_number: String(customer.doc_number || prev.customer_doc_number || ''),
      customer_name: String(customer.name || prev.customer_name || ''),
      customer_address: String(customer.address || prev.customer_address || ''),
      customer_phone: String(customer.phone || prev.customer_phone || ''),
    }));
  };

  /** Desde Clientes: abrir modal de cobro con pedidos del cliente (misma API que mesa). */
  useEffect(() => {
    const payload = location.state?.clientCheckout;
    if (!payload?.customerId || !Array.isArray(payload.orderIds) || !payload.orderIds.length) return;

    const byId = new Map((allOrders || []).map((o) => [o.id, o]));
    const missing = payload.orderIds.some((id) => !byId.has(id));
    if (missing) return;

    const orders = payload.orderIds
      .map((id) => byId.get(id))
      .filter((o) => String(o.payment_status || '') !== 'paid' && String(o.status || '') !== 'cancelled');

    const navKey = `${payload.customerId}:${payload.orderIds.slice().sort().join(',')}`;

    if (!orders.length) {
      clientCheckoutOpenedKeyRef.current = '';
      toast.error('Esos pedidos ya no están pendientes de cobro.');
      navigate('/admin/caja?view=cobrar', { replace: true, state: {} });
      return;
    }

    if (clientCheckoutOpenedKeyRef.current === navKey) return;

    if (!register) {
      clientCheckoutOpenedKeyRef.current = '';
      toast.error('Abra la caja antes de cobrar la cuenta del cliente.');
      navigate('/admin/caja?view=cobrar', { replace: true, state: {} });
      return;
    }

    clientCheckoutOpenedKeyRef.current = navKey;

    setActiveCajaOption('cobrar');
    setSearchParams({ view: 'cobrar' }, { replace: true });
    setTableDetail(null);
    setSelectedTable({
      id: `${CLIENT_CHECKOUT_TABLE_PREFIX}${payload.customerId}`,
      name: String(payload.customerName || 'Cliente').trim() || 'Cliente',
      number: '',
      orders,
    });
    setShowBill(true);
    setPaymentMethod('efectivo');
    setAmountReceived('');
    setSplitMode(false);
    setSelectedOrderItemIds(collectAllOrderItemIds(orders));
    setSelectedOrderItemQtys({});
    setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG });
    resetBillingForm();
    if (payload.customerForBilling) {
      applyCustomerToBilling(payload.customerForBilling);
    }
    toast.success(`Caja: cobrar cuenta de ${payload.customerName || 'cliente'}`);
    navigate('/admin/caja?view=cobrar', { replace: true, state: {} });
  }, [location.state, allOrders, navigate, setSearchParams, register]);

  const billingSuccessSummary = (doc) => {
    const num = String(doc?.full_number || '').trim();
    const st = String(doc?.provider_status || '').toLowerCase();
    const sunat = String(doc?.sunat_description || doc?.provider_message || '').trim();
    const label = billingStatusLabel(st);
    if (st === 'accepted') {
      return sunat ? `${num} — ${sunat}` : `${num} — ${label}`;
    }
    if (st === 'error') {
      return `${num || 'Comprobante'} — ${sunat || label}`;
    }
    if (st === 'pending') {
      return `${num || 'Comprobante'} — ${label}`;
    }
    if (st === 'sent') {
      return `${num || 'Comprobante'} — ${label}`;
    }
    if (st === 'local') {
      return num ? `${num} — nota de venta (registro local)` : 'Nota de venta (registro local)';
    }
    return num || 'Comprobante registrado';
  };

  const validateBillingData = () => {
    if (!billingForm.enabled) return null;
    if (billingForm.doc_type === 'nota_venta') return null;
    const docNumber = String(billingForm.customer_doc_number || '').trim();
    const customerName = String(billingForm.customer_name || '').trim();
    if (billingForm.doc_type === 'factura') {
      if (!/^\d{11}$/.test(docNumber)) return 'Para factura debes ingresar RUC válido (11 dígitos)';
      if (!customerName) return 'Para factura debes ingresar razón social';
    }
    if (billingForm.customer_doc_type === '1' && docNumber && !/^\d{8}$/.test(docNumber)) {
      return 'DNI inválido (8 dígitos)';
    }
    if (billingForm.customer_doc_type === '6' && docNumber && !/^\d{11}$/.test(docNumber)) {
      return 'RUC inválido (11 dígitos)';
    }
    return null;
  };

  const issueElectronicDocument = async (orderId) => {
    const doc = await api.post('/billing/issue', {
      order_id: orderId,
      doc_type: billingForm.doc_type,
      invoice_lines_mode: billingForm.doc_type === 'nota_venta' ? 'detallado' : billingForm.invoice_lines_mode,
      customer: {
        doc_type: billingForm.customer_doc_type,
        doc_number: billingForm.customer_doc_number,
        name: billingForm.customer_name,
        address: billingForm.customer_address,
        phone: billingForm.customer_phone,
      },
    });
    setBillingResult(doc);
    return doc;
  };

  const openCustomerModal = () => {
    const initialDocType = getActiveDocType();
    setCustomerForm({
      ...EMPTY_CUSTOMER_FORM,
      doc_type: initialDocType === '0' ? '1' : initialDocType,
      doc_number: normalizeDocNumber(billingForm.customer_doc_number),
      name: String(billingForm.customer_name || ''),
      phone: String(billingForm.customer_phone || ''),
      address: String(billingForm.customer_address || ''),
    });
    setShowCustomerModal(true);
  };

  const saveCustomerFromBilling = async () => {
    const docType = String(customerForm.doc_type || '1');
    const docNumber = normalizeDocNumber(customerForm.doc_number);
    const name = String(customerForm.name || '').trim();
    if (!name) return toast.error('Ingresa el nombre del cliente');
    if (docType === '1' && docNumber && !/^\d{8}$/.test(docNumber)) {
      return toast.error('DNI inválido (8 dígitos)');
    }
    if (docType === '6' && docNumber && !/^\d{11}$/.test(docNumber)) {
      return toast.error('RUC inválido (11 dígitos)');
    }
    try {
      setSavingCustomer(true);
      const created = await api.post('/admin-modules/customers', {
        name,
        doc_type: docType,
        doc_number: docNumber,
        phone: String(customerForm.phone || '').trim(),
        address: String(customerForm.address || '').trim(),
        email: normalizeCustomerEmail(customerForm.email),
      });
      applyCustomerToBilling(created);
      setBillingForm((prev) => ({
        ...prev,
        customer_phone: String(customerForm.phone || created?.phone || prev.customer_phone || ''),
      }));
      setMatchedCustomer(created);
      setShowCustomerModal(false);
      setCustomerForm(EMPTY_CUSTOMER_FORM);
      toast.success('Cliente guardado y cargado en el comprobante');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingCustomer(false);
    }
  };

  const cobrarMesa = async () => {
    if (!selectedTable) return;
    if (checkoutInFlightRef.current) return;
    if (!register) return toast.error('Abra la caja antes de cobrar');
    checkoutInFlightRef.current = true;
    try {
    const tableOrders = selectedTable.orders || [];
    const useLineSplit = splitMode;
    const chargeToAccount = addToAccountEnabled;
    const billingCustomerId = resolveBillingCustomerId();

    if (useLineSplit && selectedOrderItemIds.length === 0) {
      return toast.error('Selecciona al menos una línea de producto para cobrar');
    }

    if (chargeToAccount) {
      if (!billingCustomerId) {
        return toast.error('Seleccione un cliente de Mi Clientes (botón «Mis clientes»)');
      }
      if (billingForm.enabled) {
        return toast.error('Desactive «Emitir comprobante» al agregar a cuenta del cliente');
      }
    }

    const payableOrders = (tableOrders || []).filter((o) => {
      if (!o) return false;
      if (String(o.status || '') === 'cancelled') return false;
      return String(o.payment_status || 'pending').toLowerCase() !== 'paid';
    });
    if (!useLineSplit && !payableOrders.length) {
      return toast.error('No hay pedidos pendientes por cobrar en esta mesa');
    }

    const isCourtesyCheckout = discountConfig.applied && isCourtesyDiscountReason(discountConfig.reason);

    let checkoutPaymentMethod = paymentMethod;
    let checkoutPaymentBreakdown = null;
    if (!chargeToAccount && !isCourtesyCheckout) {
      if (multiPayEnabled) {
        const mp = resolveMultiPayment(multiPayAmounts, multiPaymentOptions, payableTotal);
        if (!mp.valid) return toast.error(mp.error);
        checkoutPaymentBreakdown = mp.breakdown;
        checkoutPaymentMethod = dominantPaymentFromBreakdown(mp.breakdown);
      } else if (paymentMethod === 'efectivo' && receivedAmount < payableTotal) {
        return toast.error(`Monto insuficiente. Falta ${formatCurrency(payableTotal - receivedAmount)}`);
      }
      const billingError = validateBillingData();
      if (billingError) return toast.error(billingError);
    } else if (isCourtesyCheckout) {
      if (billingForm.enabled) {
        return toast.error('Desactive «Emitir comprobante» al registrar una cortesía (total S/ 0.00)');
      }
      if (tipPayEnabled && (parseFloat(String(checkoutTipAmount).replace(',', '.')) || 0) > 0) {
        return toast.error('No se registra propina en una cortesía');
      }
      checkoutPaymentMethod = 'cortesia';
      checkoutPaymentBreakdown = null;
    }
    if (discountConfig.applied) {
      const discountReasonText = String(discountConfig.reason || '').trim();
      if (!discountReasonText) {
        return toast.error('Ingresa el motivo del descuento o cortesía');
      }
      if (discountReasonText.length < 3) {
        return toast.error('El motivo del descuento o cortesía debe tener al menos 3 caracteres');
      }
    }
      if (discountConfig.applied && splitMode && discountConfig.target === 'line' && discountConfig.targetOrderItemId) {
        if (!selectedOrderItemIds.includes(discountConfig.targetOrderItemId)) {
          return toast.error('El producto con descuento debe estar incluido en el cobro.');
        }
      }

      const discountValue = Math.max(0, parseFloat(discountConfig.value) || 0);
      const wholeBaseForDiscount = useLineSplit
        ? computeTableSplitSelectionBase(tableOrders, selectedOrderItemIds, selectedOrderItemQtys)
        : tableOrders.reduce((sum, o) => sum + getOrderChargeTotal(o), 0);

      const lineBaseForDiscount =
        splitMode &&
        discountConfig.applied &&
        discountConfig.target === 'line' &&
        String(discountConfig.targetOrderItemId || '').trim() &&
        selectedOrderItemIds.includes(String(discountConfig.targetOrderItemId).trim())
          ? getOrderItemSubtotalFromOrders(tableOrders, discountConfig.targetOrderItemId, selectedOrderItemQtys)
          : null;

      const baseForDiscount =
        discountConfig.applied && lineBaseForDiscount != null && lineBaseForDiscount > 0
          ? lineBaseForDiscount
          : wholeBaseForDiscount;

      const totalDiscountToApply = !discountConfig.applied
        ? 0
        : (discountConfig.type === 'percent'
          ? Math.min(baseForDiscount, baseForDiscount * (discountValue / 100))
          : Math.min(baseForDiscount, discountValue));

      let remainingAmountDiscount = totalDiscountToApply;
      const discountsByOrder = {};
      if (!useLineSplit && totalDiscountToApply > 0) {
        const totalOrdersAmount = wholeBaseForDiscount;
        for (let idx = 0; idx < payableOrders.length; idx += 1) {
          const order = payableOrders[idx];
          const orderTotal = getOrderChargeTotal(order);
          let extraDiscount = 0;
          if (discountConfig.type === 'percent') {
            extraDiscount = Math.min(orderTotal, orderTotal * (discountValue / 100));
          } else if (idx === payableOrders.length - 1) {
            extraDiscount = Math.min(orderTotal, remainingAmountDiscount);
          } else {
            extraDiscount = Math.min(orderTotal, (totalDiscountToApply * orderTotal) / (totalOrdersAmount || 1));
          }
          remainingAmountDiscount = Math.max(0, remainingAmountDiscount - extraDiscount);
          discountsByOrder[order.id] = extraDiscount;
        }
      }

      const issuedDocs = [];

      const checkoutBody = {
        ...posRegisterBody(),
        payment_method: checkoutPaymentMethod,
        discount_reason: discountConfig.reason,
      };
      if (chargeToAccount) {
        checkoutBody.charge_to_customer_account = true;
        checkoutBody.customer_id = billingCustomerId;
      } else if (checkoutPaymentBreakdown) {
        checkoutBody.payment_breakdown = checkoutPaymentBreakdown;
      }
      if (!chargeToAccount && tipPayEnabled) {
        const tipVal = roundMoneySoles(parseFloat(String(checkoutTipAmount).replace(',', '.')) || 0);
        if (tipVal > 0) checkoutBody.tip_amount = tipVal;
      }
      const paymentNoteText = String(checkoutPaymentNote || '').trim();
      if (paymentNoteText) checkoutBody.payment_note = paymentNoteText;

      if (useLineSplit) {
        checkoutBody.order_item_ids = selectedOrderItemIds;
        // Fallback para sync offline: si alguna línea se eliminó, el servidor cobra estos pedidos.
        checkoutBody.order_ids = payableOrders.map((o) => o.id).filter(Boolean);
        const qtysPayload = {};
        for (const id of selectedOrderItemIds) {
          const q = selectedOrderItemQtys[id];
          if (q != null && Number(q) > 0) qtysPayload[id] = Math.floor(Number(q));
        }
        if (Object.keys(qtysPayload).length) {
          checkoutBody.order_item_quantities = qtysPayload;
        }
        checkoutBody.checkout_discount_total = totalDiscountToApply;
        if (
          totalDiscountToApply > 0 &&
          discountConfig.target === 'line' &&
          String(discountConfig.targetOrderItemId || '').trim()
        ) {
          checkoutBody.checkout_discount_anchor_order_item_id = String(discountConfig.targetOrderItemId).trim();
        }
      } else {
        checkoutBody.order_ids = payableOrders.map((o) => o.id);
        checkoutBody.discounts_by_order = discountsByOrder;
      }

      setCheckoutBusy(true);
      const checkoutRes = await api.post('/pos/checkout-table', checkoutBody);
      const postPaidOrders = Array.isArray(checkoutRes?.orders) ? checkoutRes.orders : [];
      const printDiscountsByOrder = useLineSplit
        ? (checkoutRes?.discounts_applied_by_order || {})
        : discountsByOrder;

      if (!chargeToAccount && billingForm.enabled) {
        const billingOrders = postPaidOrders.length ? [postPaidOrders[0]] : [];
        for (const order of billingOrders) {
          try {
            const doc = await issueElectronicDocument(order.id);
            issuedDocs.push(doc);
            if (String(doc?.provider_status || '').toLowerCase() === 'error') {
              toast.error(doc.sunat_description || doc.provider_message || 'Error al enviar a SUNAT. Puede reintentar en Informes.');
            }
          } catch (billErr) {
            toast.error(billErr.message || 'No se pudo emitir el comprobante');
          }
        }
      }

      if (!isClientCheckoutTable(selectedTable) && !isDeliveryCheckoutTable(selectedTable)) {
        const memberIds = Array.isArray(selectedTable.union_member_ids) && selectedTable.union_member_ids.length
          ? selectedTable.union_member_ids
          : [selectedTable.id];
        for (const tid of memberIds) {
          try {
            const updatedTable = await api.get(`/tables/${tid}`);
            if (!updatedTable.orders || updatedTable.orders.length === 0) {
              await api.patch(`/tables/${tid}/status`, { status: 'available' });
              // Completar reserva del día (gris/naranja → libre en el mapa)
              const openRes = (reservations || []).filter((r) => {
                const st = String(r?.status || '').toLowerCase();
                if (['cancelled', 'completed', 'cancelada', 'completada'].includes(st)) return false;
                return String(r?.table_id || '') === String(tid);
              });
              for (const r of openRes) {
                await api.put(`/admin-modules/reservations/${r.id}`, { status: 'completed' }).catch(() => {});
              }
            }
          } catch (_) {
            /* siguiente mesa */
          }
        }
      }

      if (dissolveUnionAfterCheckout && selectedTable.union_id) {
        try {
          await api.delete(`/tables/unite/${selectedTable.union_id}`);
        } catch (unionErr) {
          toast.error(unionErr.message || 'Cobro realizado, pero no se pudieron separar las mesas');
        }
      }
      setDissolveUnionAfterCheckout(false);
      if (selectedTable?.id) {
        setPrecuentaTableIds((prev) => {
          if (!prev.has(selectedTable.id)) return prev;
          const next = new Set(prev);
          next.delete(selectedTable.id);
          return next;
        });
      }

      const ordersForPrint = postPaidOrders.length > 0 ? postPaidOrders : payableOrders;
      const chargedCount = postPaidOrders.length || payableOrders.length;

      if (issuedDocs.length > 0) {
        const detail = issuedDocs.map(billingSuccessSummary).join(' · ');
        toast.success(`${chargedCount} pedido(s) cobrados. ${detail}`);
        const pdfDoc = issuedDocs.find((d) => d?.pdf_url && String(d.provider_status || '').toLowerCase() === 'accepted')
          || issuedDocs.find((d) => d?.pdf_url && String(d.provider_status || '').toLowerCase() !== 'error');
        const pdf = pdfDoc?.pdf_url;
        if (pdf && billingForm.doc_type !== 'nota_venta') {
          if (pdfDoc?.id && String(pdfDoc.provider_status || '').toLowerCase() === 'accepted') {
            printedSunatPdfRef.current.add(pdfDoc.id);
          }
          window.open(resolveMediaUrl(pdf), '_blank', 'noopener,noreferrer');
        }
        const logoUrl = String(printRestaurantInfo.logo || '').trim() || undefined;
        const pw = cajaPaperWidthMm;
        if (billingForm.doc_type === 'nota_venta') {
          await printNotaVenta({
            tableName: selectedTable?.name || '',
            orders: ordersForPrint,
            docs: issuedDocs,
            paymentMethod: checkoutPaymentMethod,
            discountTotal: totalDiscountToApply,
            customer: {
              doc_number: billingForm.customer_doc_number,
              name: billingForm.customer_name,
              address: billingForm.customer_address,
              phone: billingForm.customer_phone,
            },
          });
        } else if (billingForm.doc_type === 'boleta' || billingForm.doc_type === 'factura') {
          for (let i = 0; i < issuedDocs.length; i += 1) {
            const doc = issuedDocs[i];
            const ord = ordersForPrint[i];
            if (!doc || !ord) continue;
            const grouped = groupItemsByProductNameForBill(ord.items || []);
            const ordDisc = Number(printDiscountsByOrder[ord.id] || 0);
            const plain = buildBoletaFacturaPlainText({
              restaurant: printRestaurantInfo,
              doc,
              groupedRows: grouped,
              formatCurrencyFn: formatCurrency,
              subtotal: Number(ord.subtotal || 0),
              tax: Number(ord.tax || 0),
              total: getOrderChargeTotal(ord),
              discount: ordDisc,
              customer: {
                name: billingForm.customer_name,
                doc_number: billingForm.customer_doc_number,
              },
              widthMm: pw,
              printedAt: new Date(),
              paymentMethod: checkoutPaymentMethod,
            });
            const r = await printCajaTicket({
              text: plain,
              preformatted: true,
              logoUrl,
              restaurantBrand: restaurantThermalBrandLine(printRestaurantInfo) || undefined,
              paperWidth: pw,
            });
            if (!r.ok) toast.error(r.error || 'No se pudo imprimir comprobante SUNAT');
          }
        }
      } else if (chargeToAccount) {
        const clientName = billingForm.customer_name || matchedCustomer?.name || 'cliente';
        toast.success(`${chargedCount} pedido(s) agregados a la cuenta de ${clientName}. Cobre después en Mi Clientes.`);
      } else {
        toast.success(`${chargedCount} pedido(s) cobrados en ${selectedTable.name}`);
      }
      setShowBill(false);
      setSplitMode(false);
      setSelectedOrderItemIds([]);
      setSelectedOrderItemQtys({});
      setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG });
      clientCheckoutOpenedKeyRef.current = '';
      setSelectedTable(null);
      setTableDetail(null);
      setMesaDetailModalOpen(false);
      setAmountReceived('');
      setMultiPayEnabled(false);
      setMultiPayAmounts(emptyMultiPaymentAmounts());
      setTipPayEnabled(false);
      setCheckoutTipAmount('');
      setCheckoutPaymentNote(''); setPaymentNoteOpen(false);
      resetBillingForm();
      loadData();
    } catch (err) { toast.error(err.message); }
    finally {
      checkoutInFlightRef.current = false;
      setCheckoutBusy(false);
    }
  };

  const toggleOrderItemSelection = (itemId) => {
    const isSelected = selectedOrderItemIds.includes(itemId);
    if (isSelected) {
      setSelectedOrderItemIds((prev) => prev.filter((id) => id !== itemId));
      setSelectedOrderItemQtys((prev) => {
        if (prev[itemId] == null) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      return;
    }
    let maxQ = 1;
    for (const o of selectedTable?.orders || []) {
      const it = (o.items || []).find((x) => x.id === itemId);
      if (it) {
        maxQ = Math.max(1, Math.floor(Number(it.quantity || 1)));
        break;
      }
    }
    setSelectedOrderItemIds((prev) => [...prev, itemId]);
    if (maxQ > 1) {
      setSelectedOrderItemQtys((prev) => ({ ...prev, [itemId]: 1 }));
    }
  };

  const setSplitChargeQty = (itemId, nextQty, maxQ) => {
    const q = Math.min(maxQ, Math.max(1, Math.floor(Number(nextQty) || 1)));
    setSelectedOrderItemQtys((prev) => ({ ...prev, [itemId]: q }));
  };

  const togglePartialSelection = () => {
    const allItemIds = collectAllOrderItemIds(selectedTable?.orders);
    if (splitMode) {
      setSplitMode(false);
      setSelectedOrderItemIds(allItemIds);
      setSelectedOrderItemQtys({});
    } else {
      setSplitMode(true);
      setSelectedOrderItemIds([]);
      setSelectedOrderItemQtys({});
    }
  };

  const handleDiscountButton = () => {
    if (discountConfig.applied) {
      setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG });
      toast.success('Descuento anulado');
      return;
    }

    if (!discountConfig.active) {
      setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG, active: true });
      return;
    }

    const value = parseFloat(discountConfig.value);
    if (Number.isNaN(value) || value <= 0) return toast.error('Ingresa un descuento válido');
    const discountReasonText = String(discountConfig.reason || '').trim();
    if (!discountReasonText) return toast.error('Ingresa el motivo del descuento');
    if (discountReasonText.length < 3) {
      return toast.error('El motivo del descuento debe tener al menos 3 caracteres');
    }

    if (splitMode && discountConfig.target === 'line' && discountConfig.targetOrderItemId) {
      if (!selectedOrderItemIds.includes(discountConfig.targetOrderItemId)) {
        return toast.error('El producto con descuento debe estar incluido en el cobro (marca su casilla).');
      }
    }

    setDiscountConfig((prev) => ({ ...prev, active: false, applied: true }));
    toast.success(
      splitMode && discountConfig.target === 'line' && discountConfig.targetOrderItemId
        ? 'Descuento aplicado al producto'
        : 'Descuento aplicado a la cuenta'
    );
  };

  const applyCourtesyDiscount = () => {
    if (!discountConfig.active || discountConfig.applied) return;
    const motive = String(discountConfig.reason || '').trim();
    if (!motive) {
      toast.error('Ingresa el motivo de la cortesía');
      return;
    }
    if (motive.length < 3) {
      toast.error('El motivo de la cortesía debe tener al menos 3 caracteres');
      return;
    }
    const orders = selectedTable?.orders || [];
    let base = selectionBaseTotal;
    if (splitMode && discountConfig.target === 'line' && discountConfig.targetOrderItemId) {
      const sid = discountConfig.targetOrderItemId;
      if (!selectedOrderItemIds.includes(sid)) {
        toast.error('Marca la línea en el cobro o elige ese producto para cortesía.');
        return;
      }
      base = getOrderItemSubtotalFromOrders(orders, sid, selectedOrderItemQtys);
    }
    if (!(base > 0)) {
      toast.error('Sin monto para cortesía');
      return;
    }
    const courtesyReason = /^cortes[ií]a\s*:/i.test(motive) ? motive : `Cortesía: ${motive}`;
    setDiscountConfig({
      ...EMPTY_DISCOUNT_CONFIG,
      applied: true,
      type: 'amount',
      value: String(roundMoneySoles(base)),
      reason: courtesyReason,
      target: discountConfig.target,
      targetOrderItemId: discountConfig.targetOrderItemId,
    });
    toast.success('Cortesía aplicada');
  };

  const selectDiscountTargetLine = (itemId) => {
    if (!discountConfig.active || discountConfig.applied) return;
    if (!splitMode) return;
    setDiscountConfig((prev) => ({ ...prev, target: 'line', targetOrderItemId: itemId }));
  };

  const selectDiscountTargetWhole = () => {
    if (!discountConfig.active || discountConfig.applied) return;
    setDiscountConfig((prev) => ({ ...prev, target: 'whole', targetOrderItemId: '' }));
  };

  const openMesaMapTransfer = (mode) => {
    setMesaUniteMode(false);
    setMesaUniteSelection([]);
    setMesaTransfer({
      mode,
      sourceId: '',
      pickSourceAndTarget: true,
    });
  };

  const toggleMesaUniteMode = () => {
    setMesaTransfer(null);
    setMesaUniteMode((prev) => {
      if (prev) setMesaUniteSelection([]);
      return !prev;
    });
  };

  const toggleMesaUniteTable = (tableId) => {
    setMesaUniteSelection((prev) =>
      prev.includes(tableId) ? prev.filter((id) => id !== tableId) : [...prev, tableId],
    );
  };

  const confirmMesaUnite = async () => {
    if (mesaUniteSelection.length < 2) {
      toast.error('Seleccione al menos 2 mesas para unir');
      return;
    }
    setMesaUniteBusy(true);
    try {
      await api.post('/tables/unite', { table_ids: mesaUniteSelection });
      toast.success('Mesas unidas correctamente');
      setMesaUniteMode(false);
      setMesaUniteSelection([]);
      await loadData();
    } catch (err) {
      toast.error(err.message || 'No se pudieron unir las mesas');
    } finally {
      setMesaUniteBusy(false);
    }
  };

  const openBillForTable = (table) => {
    if (!register) {
      toast.error('Abra la caja antes de cobrar');
      return;
    }
    if (!table?.orders?.length) return;
    if (!table.union_id) setDissolveUnionAfterCheckout(false);
    releasePendingOrderMenu();
    setMesaDetailModalOpen(false);
    setSelectedTable(table);
    setShowBill(true);
    setPaymentMethod('efectivo');
    setAmountReceived('');
    setSplitMode(false);
    setSelectedOrderItemIds(collectAllOrderItemIds(table.orders));
    setSelectedOrderItemQtys({});
    setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG });
  };

  const beginCobrarMesa = (table) => {
    if (!register) {
      toast.error('Abra la caja antes de cobrar');
      return;
    }
    if (!table?.orders?.length) return;
    if (table.union_id) {
      setMesaUnionCheckoutPrompt(table);
      return;
    }
    openBillForTable(table);
  };

  const answerMesaUnionCheckoutPrompt = (dissolve) => {
    const table = mesaUnionCheckoutPrompt;
    setMesaUnionCheckoutPrompt(null);
    if (!table) return;
    setDissolveUnionAfterCheckout(Boolean(dissolve));
    openBillForTable(table);
  };

  const desunirMesaUnida = async (table = tableDetail) => {
    const unionId = String(table?.union_id || '').trim();
    if (!unionId) return;
    setMesaDesunirBusy(true);
    try {
      await api.delete(`/tables/unite/${unionId}`);
      toast.success('Mesas separadas correctamente');
      setMesaDetailModalOpen(false);
      if (tableDetail?.id === table?.id) {
        setTableDetail(null);
        setSelectedTable(null);
      }
      await loadData();
    } catch (err) {
      toast.error(err.message || 'No se pudieron separar las mesas');
    } finally {
      setMesaDesunirBusy(false);
    }
  };

  const openMenuForTable = (table) => {
    if (isDeliveryCheckoutTable(table)) return;
    setMesaDetailModalOpen(false);
    setQuickSaleMode(false);
    setEditingOrderId('');
    setEditingSessionOrderIds([]);
    setParaLlevarMesa(false);
    setMesaOrderObservation('');
    setSelectedTable(table);
    lockMesa(table);
    setShowMenu(true);
    resetCart();
    setSearch('');
    setSelectedCat('all');
    setAmountReceived('');
    resetBillingForm();
  };

  /** @returns {boolean} si se abrió el editor */
  const openEditOrderFromToolbar = () => {
    const list = tableDetail?.orders || [];
    const editable = list.filter((o) => canEditOrderLines(o));
    if (editable.length === 0) {
      if (list.length === 0) {
        toast.error('No hay pedidos para modificar.');
      } else {
        toast.error('Ninguna comanda se puede modificar desde aquí (estado o cobro).');
      }
      return false;
    }
    const sorted = [...editable].sort((a, b) => {
      const na = Number(a.order_number);
      const nb = Number(b.order_number);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    const primary = sorted[0];
    const initialCart = mergeEditCartAcrossOrders(editable, productsById);
    editSessionInitialCartRef.current = expandEditCartToOrders(initialCart);
    setMesaDetailModalOpen(false);
    setQuickSaleMode(false);
    setEditingSessionOrderIds(editable.map((o) => o.id));
    setEditingOrderId(primary.id);
    setParaLlevarMesa(editable.some((o) => orderHasTakeoutNote(o)));
    editSessionInitialParaLlevarRef.current = editable.some((o) => orderHasTakeoutNote(o));
    setMesaOrderObservation(parseMesaOrderObservation(primary.notes));
    setSelectedTable(tableDetail);
    lockMesa(tableDetail);
    setSearch('');
    setSelectedCat('all');
    setCart(initialCart);
    setShowMenu(true);
    setAmountReceived('');
    resetBillingForm();
    return true;
  };

  const promptMesaRemovalReason = (mode) =>
    new Promise((resolve, reject) => {
      mesaRemovalConfirmRef.current = { resolve, reject, mode };
      setMesaRemovalReason('');
      setMesaRemovalModal({ mode });
    });

  const closeMesaRemovalModal = () => {
    mesaRemovalConfirmRef.current?.reject?.(new Error('cancelled'));
    mesaRemovalConfirmRef.current = null;
    setMesaRemovalModal(null);
    setMesaRemovalReason('');
    setMesaRemovalSubmitting(false);
  };

  const confirmMesaRemovalModal = async () => {
    const reason = String(mesaRemovalReason || '').trim();
    if (reason.length < 3) {
      toast.error('El motivo debe tener al menos 3 caracteres.');
      return;
    }
    setMesaRemovalSubmitting(true);
    try {
      mesaRemovalConfirmRef.current?.resolve?.(reason);
      mesaRemovalConfirmRef.current = null;
      setMesaRemovalModal(null);
      setMesaRemovalReason('');
    } finally {
      setMesaRemovalSubmitting(false);
    }
  };

  const tryMarkTableAvailableIfEmpty = async () => {
    if (
      !selectedTable ||
      isClientCheckoutTable(selectedTable) ||
      isDeliveryCheckoutTable(selectedTable) ||
      !selectedTable.id
    ) {
      return;
    }
    try {
      const updatedTable = await api.get(`/tables/${selectedTable.id}`);
      const remaining = (updatedTable.orders || []).filter((o) =>
        ['pending', 'preparing', 'ready'].includes(String(o.status || ''))
      );
      if (remaining.length === 0) {
        await api.patch(`/tables/${selectedTable.id}/status`, { status: 'available' });
      }
    } catch (_) {
      /* noop */
    }
  };

  const executeMesaOrderCancellations = async (orderIds, reason, tid) => {
    const formatted = formatMesaRemovalReason('Liberar mesa', reason);
    for (const oid of orderIds) {
      await api.put(`/orders/${oid}/status`, {
        status: 'cancelled',
        cancellation_reason: formatted,
      });
    }
    await tryMarkTableAvailableIfEmpty();
    toast.success(
      orderIds.length > 1
        ? 'Pedidos anulados. Mesa liberada si no había otros pedidos activos.'
        : 'Pedido anulado. Mesa liberada si no había otros pedidos activos.',
      { id: tid }
    );
    setShowMenu(false);
    setEditingOrderId('');
    setEditingSessionOrderIds([]);
    editSessionInitialCartRef.current = [];
    resetCart();
    loadData();
  };

  const confirmCancelOrder = async (order) => {
    if (!order?.id) return false;
    const ok = window.confirm(`¿Anular el pedido #${order.order_number}? Se devolverá stock si aplica.`);
    if (!ok) return false;
    let reason = '';
    try {
      reason = await promptMesaRemovalReason('cancel');
    } catch {
      return false;
    }
    const tid = toast.loading('Anulando pedido…');
    try {
      await api.put(`/orders/${order.id}/status`, {
        status: 'cancelled',
        cancellation_reason: formatMesaRemovalReason('Anulado desde caja', reason),
      });
      await tryMarkTableAvailableIfEmpty();
      toast.success('Pedido anulado', { id: tid });
      await loadData();
      return true;
    } catch (err) {
      toast.error(err.message || 'No se pudo anular', { id: tid });
      return false;
    }
  };

  /** Anula una venta rápida pendiente de cobro (motivo obligatorio; devuelve stock). */
  const cancelQuickSale = async (table) => {
    const order = table?.orders?.[0];
    if (!order?.id) return;
    const ok = window.confirm(
      `¿Anular la venta rápida #${order.order_number ?? '—'} por ${formatCurrency(getOrderChargeTotal(order))}? Se devolverá el stock.`
    );
    if (!ok) return;
    clientCheckoutOpenedKeyRef.current = '';
    setShowBill(false);
    setAmountReceived('');
    setSplitMode(false);
    setSelectedOrderItemIds([]);
    setSelectedOrderItemQtys({});
    setAddToAccountEnabled(false);
    resetBillingForm();
    setMesaDetailModalOpen(false);
    let reason = '';
    try {
      reason = await promptMesaRemovalReason('cancel');
    } catch {
      return;
    }
    const tid = toast.loading('Anulando venta rápida…');
    try {
      await api.put(`/orders/${order.id}/status`, {
        status: 'cancelled',
        cancellation_reason: formatMesaRemovalReason('Venta rápida anulada', reason),
      });
      toast.success('Venta rápida anulada', { id: tid });
      setSelectedTable(null);
      await loadData();
    } catch (err) {
      toast.error(err.message || 'No se pudo anular la venta rápida', { id: tid });
    }
  };

  /** Modificar pedido: carrito vacío → anular pedido y liberar mesa si no quedan pedidos activos. */
  const liberarMesaDesdeEdicionPedidoVacio = async () => {
    if (!editingOrderId || !selectedTable) return;
    if (!posCanDeleteRelease) {
      toast.error('No tiene permiso para liberar la mesa.');
      return;
    }
    const idsToCancel =
      editingSessionOrderIds.length > 0 ? editingSessionOrderIds : [editingOrderId];
    let reason = '';
    try {
      reason = await promptMesaRemovalReason('liberar');
    } catch {
      return;
    }
    const tid = toast.loading('Liberando mesa…');
    try {
      await executeMesaOrderCancellations(idsToCancel, reason, tid);
    } catch (err) {
      toast.error(err.message || 'No se pudo completar', { id: tid });
    }
  };

  /** Mesa naranja/gris por reserva, sin pedidos: completar reserva y volver a libre. */
  const liberarMesaReservadaSinPedidos = async (table = tableDetail) => {
    if (!table?.id) return;
    if (isDeliveryCheckoutTable(table) || isClientCheckoutTable(table)) return;
    if ((table.orders || []).length > 0) {
      return toast.error('Cobre o anule los pedidos antes de liberar la mesa.');
    }
    const tid = toast.loading('Liberando mesa…');
    try {
      await api.patch(`/tables/${table.id}/free`);
      const openRes = (reservations || []).filter((r) => {
        const st = String(r?.status || '').toLowerCase();
        if (['cancelled', 'completed', 'cancelada', 'completada'].includes(st)) return false;
        return String(r?.table_id || '') === String(table.id);
      });
      for (const r of openRes) {
        await api.put(`/admin-modules/reservations/${r.id}`, { status: 'completed' }).catch(() => {});
      }
      toast.success('Mesa liberada', { id: tid });
      setTableDetail(null);
      setMesaDetailModalOpen(false);
      setSelectedTable(null);
      await loadData();
    } catch (err) {
      toast.error(err.message || 'No se pudo liberar la mesa', { id: tid });
    }
  };

  const guardedUpdateQty = (lineKey, delta) => {
    if (editingOrderId) {
      const line = cart.find((c) => c.line_key === lineKey);
      if (line) {
        const nextQty = Number(line.quantity || 0) + Number(delta || 0);
        if (nextQty < 1) {
          if (!posCanDeleteRelease) {
            toast.error('No tiene permiso para eliminar productos del pedido.');
            return;
          }
        }
      }
    }
    updateQty(lineKey, delta);
  };

  const guardedRemoveFromCart = (lineKey) => {
    if (editingOrderId && !posCanDeleteRelease) {
      toast.error('No tiene permiso para quitar productos de la mesa.');
      return;
    }
    removeFromCart(lineKey);
  };

  const openQuickSaleMenu = () => {
    setQuickSaleMode(true);
    setEditingOrderId('');
    setEditingSessionOrderIds([]);
    setParaLlevarMesa(false);
    setMesaOrderObservation('');
    setSelectedTable(null);
    clearMesaLock();
    setPaymentMethod('efectivo');
    setMultiPayEnabled(false);
    setMultiPayAmounts(emptyMultiPaymentAmounts());
    setTipPayEnabled(false);
    setCheckoutTipAmount('');
    setCheckoutPaymentNote(''); setPaymentNoteOpen(false);
    setShowMenu(true);
    resetCart();
    setSearch('');
    setSelectedCat('all');
    setAmountReceived('');
    resetBillingForm();
  };

  const receivedAmount = Math.max(0, parseFloat(amountReceived) || 0);

  const showParaLlevarToggle =
    !quickSaleMode &&
    selectedTable &&
    !isClientCheckoutTable(selectedTable) &&
    !isDeliveryCheckoutTable(selectedTable);

  const mesaOrderBadge = useMemo(() => {
    if (!editingOrderId || !selectedTable) return '';
    const o = (selectedTable.orders || []).find((x) => x.id === editingOrderId);
    return o?.order_number != null ? formatOrderBadge(o.order_number) : '';
  }, [editingOrderId, selectedTable]);

  const paraLlevarToggleButton = showParaLlevarToggle ? (
    <button
      type="button"
      onClick={() => setParaLlevarMesa((v) => !v)}
      className={`min-w-0 flex-1 rounded-lg border py-2.5 px-2 text-xs font-semibold uppercase tracking-wide transition-colors flex items-center justify-center ${
        paraLlevarMesa
          ? 'bg-[var(--ui-accent)] text-white border-transparent shadow-sm'
          : 'border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] hover:bg-[var(--ui-sidebar-hover)]'
      }`}
    >
      PARA LLEVAR
    </button>
  ) : null;

  const mesaOrderSubmitFooter = (submitLabel, submitClass = 'btn-primary') =>
    cart.length > 0 ? (
      <div className="space-y-2">
        <div className="flex justify-between text-base font-bold text-[var(--ui-body-text)]">
          <span>Total</span>
          <span className="text-[var(--ui-accent-muted)]">{formatCurrency(cartTotal)}</span>
        </div>
        <div className="flex gap-2">
          {paraLlevarToggleButton}
          <button
            type="button"
            onClick={submitOrder}
            className={`${submitClass} flex min-w-0 flex-1 items-center justify-center gap-2 py-2.5 text-sm font-semibold`}
          >
            <MdReceipt className="shrink-0" /> {submitLabel}
          </button>
        </div>
      </div>
    ) : null;

  const submitOrder = async () => {
    if (cart.length === 0) {
      if (editingOrderId) {
        if (!posCanDeleteRelease) {
          return toast.error('No tiene permiso para liberar la mesa.');
        }
        return void liberarMesaDesdeEdicionPedidoVacio();
      }
      return toast.error('Agrega productos al pedido');
    }
    if (quickSaleMode && !register) {
      return toast.error('Abra la caja antes de registrar una venta rápida');
    }
    const missingRequiredNote = cart.find(i => Number(i.note_required || 0) === 1 && !String(i.notes || '').trim());
    if (missingRequiredNote) {
      setNoteEditorLineKey(missingRequiredNote.line_key);
      return toast.error(`"${missingRequiredNote.name}" requiere una nota obligatoria`);
    }
    const tid = toast.loading(
      editingOrderId ? 'Guardando cambios…' : quickSaleMode ? 'Preparando cobro…' : 'Enviando pedido…'
    );
    try {
      if (editingOrderId) {
        const mesaErr = validateMesaForSubmit(tables, selectedTable);
        if (mesaErr) {
          toast.error(mesaErr, { id: tid });
          return;
        }
        const noteOrder = buildMesaOrderNotes(paraLlevarMesa, mesaOrderObservation);
        const sessionIds =
          editingSessionOrderIds.length > 0 ? editingSessionOrderIds : [editingOrderId];
        const cartByOrder = expandEditCartToOrders(cart);
        const byOrder = new Map();
        for (const i of cartByOrder) {
          const oid = String(i.source_order_id || editingOrderId);
          if (!byOrder.has(oid)) byOrder.set(oid, []);
          byOrder.get(oid).push(i);
        }
        const willCancelOrders = sessionIds.some((oid) => (byOrder.get(oid) || []).length === 0);
        const hasRemovals = cartHasProductRemovals(editSessionInitialCartRef.current, cartByOrder);
        let removalReason = '';
        if (hasRemovals || willCancelOrders) {
          if (!posCanDeleteRelease) {
            toast.error('No tiene permiso para eliminar productos o liberar la mesa.', { id: tid });
            return;
          }
          if (hasRemovals) {
            try {
              removalReason = await promptMesaRemovalReason(willCancelOrders ? 'liberar' : 'save');
            } catch {
              toast.dismiss(tid);
              return;
            }
          } else {
            try {
              removalReason = await promptMesaRemovalReason('liberar');
            } catch {
              toast.dismiss(tid);
              return;
            }
          }
        }
        const linesPayload = (lines) =>
          lines.map((x) => {
            const qty = Number(x.quantity || 1);
            const unit = Number(x.price ?? x.unit_price ?? 0);
            const name = String(x.name || x.product_name || '').trim();
            const lineId = String(x.id || x.order_item_id || '').trim();
            return {
              ...(lineId ? { id: lineId, order_item_id: lineId } : {}),
              product_id: x.product_id,
              quantity: qty,
              modifier_id: x.modifier_id || '',
              modifier_option: x.modifier_option || '',
              notes: String(x.notes || '').trim(),
              product_name: name,
              name,
              unit_price: unit,
              price: unit,
              subtotal: qty * unit,
            };
          });
        const cancelReason = formatMesaRemovalReason(
          willCancelOrders ? 'Liberar mesa' : 'Productos retirados',
          removalReason
        );
        const updatedOrderIds = [];
        for (const oid of sessionIds) {
          const lines = byOrder.get(oid) || [];
          if (lines.length === 0) {
            await api.put(`/orders/${oid}/status`, {
              status: 'cancelled',
              cancellation_reason: cancelReason,
            });
          } else {
            const body = {
              items: linesPayload(lines),
            };
            if (paraLlevarMesa || editSessionInitialParaLlevarRef.current || mesaOrderObservation.trim()) {
              body.notes = noteOrder;
            }
            if (hasRemovals) body.removal_reason = removalReason;
            const updated = await api.put(`/orders/${oid}/lines`, body);
            updatedOrderIds.push(oid);
            void printKitchenBarOnComandaSend(updated, { merged: true });
          }
        }
        await tryMarkTableAvailableIfEmpty();
        toast.success(sessionIds.length > 1 ? 'Pedidos actualizados' : 'Pedido actualizado', { id: tid });
        setShowMenu(false);
        setEditingOrderId('');
        setEditingSessionOrderIds([]);
        editSessionInitialCartRef.current = [];
        resetCart();
        loadData();
        return;
      }
      if (!quickSaleMode) {
        const mesaErr = validateMesaForSubmit(tables, selectedTable);
        if (mesaErr) {
          toast.error(mesaErr, { id: tid });
          return;
        }
      }
      const tableForOrder = !quickSaleMode ? resolveLockedTable(tables, selectedTable) : selectedTable;
      const createdOrder = await api.post('/orders', buildDineInOrderPayload({
        table: tableForOrder,
        cartItems: buildOrderItemsPayload(cart),
        extra: {
          payment_method: paymentMethod,
          notes: !quickSaleMode ? buildMesaOrderNotes(paraLlevarMesa, mesaOrderObservation) : '',
          ...(quickSaleMode ? { type: 'pickup', table_number: '', table_id: '', target_order_id: '', customer_name: QUICK_SALE_CUSTOMER_NAME } : {}),
        },
      }));
      if (quickSaleMode) {
        toast.dismiss(tid);
        resetBillingForm();
        openBillForTable(quickSaleSlotForOrder(createdOrder));
        loadData();
        return;
      } else {
        if (createdOrder.merged_into_existing) {
          toast.success(
            `Productos agregados a comanda #${createdOrder.order_number ?? ''}`.trim(),
            { id: tid },
          );
        } else {
          toast.success(`Pedido agregado a ${tableForOrder?.name || selectedTable?.name || 'mesa'}`, { id: tid });
        }
        void printKitchenBarOnComandaSend(createdOrder, {
          merged: Boolean(createdOrder.merged_into_existing),
        });
      }
      setShowMenu(false);
      setQuickSaleMode(false);
      resetCart();
      setAmountReceived('');
      setTipPayEnabled(false);
      setCheckoutTipAmount('');
      resetBillingForm();
      clearMesaLock();
      loadData();
    } catch (err) {
      const msg = String(err?.message || '').trim();
      toast.error(
        msg && !/^internal server error$/i.test(msg)
          ? msg
          : editingOrderId
            ? 'No se pudo actualizar el pedido. Intente nuevamente.'
            : 'No se pudo enviar el pedido a cocina/bar. Intente nuevamente.',
        { id: tid },
      );
    }
  };

  const registerMovement = async (type) => {
    const amount = parseFloat(movementForm.amount);
    if (Number.isNaN(amount) || amount <= 0) return toast.error('Monto inválido');
    try {
      await api.post('/pos/movements', {
        type,
        amount,
        concept: movementForm.concept,
        register_id: posRegisterBody().register_id || register?.id || undefined,
      });
      toast.success(type === 'income' ? 'Ingreso registrado' : 'Egreso registrado');
      setMovementForm({ amount: '', concept: '' });
      await Promise.all([loadData(), loadCajaExtras()]);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const registerNote = async (noteType) => {
    const amount = parseFloat(noteForm.amount);
    if (Number.isNaN(amount) || amount <= 0) return toast.error('Monto inválido');
    try {
      await api.post('/pos/notes', {
        note_type: noteType,
        amount,
        reason: noteForm.reason,
        register_id: posRegisterBody().register_id || register?.id || undefined,
      });
      toast.success(noteType === 'credit' ? 'Nota de crédito registrada' : 'Nota de débito registrada');
      setNoteForm({ amount: '', reason: '' });
      loadCajaExtras();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const mesaPhysicalTables = useMemo(
    () => (tables || []).filter((t) => !isDeliveryCheckoutTable(t) && !isClientCheckoutTable(t)),
    [tables]
  );
  const [mesaMapClockMs, setMesaMapClockMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setMesaMapClockMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const reservationByTableId = useMemo(
    () => buildReservationByTableIdForToday(reservations, mesaMapClockMs),
    // mesaMapClockMs: recalcular gris→ocupado al cruzar la hora de reserva
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reservations, mesaMapClockMs]
  );
  useEffect(() => {
    setPrecuentaTableIds((prev) => {
      if (!prev.size) return prev;
      const next = new Set();
      for (const id of prev) {
        const t = mesaPhysicalTables.find((x) => x.id === id);
        if (t?.orders?.length) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [mesaPhysicalTables]);
  const occupiedTables = useMemo(
    () => mesaPhysicalTables.filter((t) => t.orders && t.orders.length > 0),
    [mesaPhysicalTables]
  );
  const reservationQueue = useMemo(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const pendingReservations = (reservations || []).filter((r) => {
      const st = normalize(r.status);
      return !['cancelled', 'completed', 'cancelada', 'completada'].includes(st);
    });
    const isOrderPendingPayment = (o) =>
      String(o.payment_status || '') !== 'paid' &&
      String(o.status || '') !== 'cancelled';

    return pendingReservations.map((reservation) => {
      const marker = `RESERVA_ID:${reservation.id}`;
      const reservationName = normalize(reservation.client_name);
      const reservationDate = String(reservation.date || '');
      const reservationTime = String(reservation.time || '').slice(0, 5);
      const legacyStamp = `Reserva: ${reservationDate}${reservationTime ? ` ${reservationTime}` : ''}`;
      const linkedOrders = (allOrders || []).filter((o) => {
        if (!isOrderPendingPayment(o)) return false;
        const notes = String(o.notes || '');

        // Vinculación exacta (nueva): siempre prioritaria e independiente.
        if (notes.includes(marker)) return true;

        // Compatibilidad con reservas antiguas (antes de RESERVA_ID)
        // Reglas estrictas para no mezclar reservas entre sí:
        // 1) Debe incluir sello completo "Reserva: fecha hora".
        // 2) Debe coincidir cliente (o customer_id si existiera en ambos).
        if (!notes.includes(legacyStamp)) return false;
        const byCustomerId =
          reservation.customer_id &&
          o.customer_id &&
          String(reservation.customer_id).trim() === String(o.customer_id).trim();
        if (byCustomerId) return true;
        const sameCustomer = normalize(o.customer_name) === reservationName;
        return sameCustomer;
      });
      const total = linkedOrders.reduce((sum, o) => sum + getOrderChargeTotal(o), 0);
      return { reservation, linkedOrders, total };
    }).filter((entry) => entry.linkedOrders.length > 0);
  }, [reservations, allOrders]);
  const tablesBySalon = useMemo(
    () => buildTablesBySalon(salonesConfig, mesaPhysicalTables),
    [salonesConfig, mesaPhysicalTables]
  );
  useEffect(() => {
    if (!tablesBySalon.length) {
      setSelectedPosSalon('');
      return;
    }
    setSelectedPosSalon((prev) => {
      const ids = tablesBySalon.map((s) => s.zone);
      return ids.includes(prev) ? prev : ids[0];
    });
  }, [tablesBySalon]);
  const selectedSalonTables = useMemo(() => {
    const entry = tablesBySalon.find((s) => s.zone === selectedPosSalon);
    return entry?.tables || [];
  }, [tablesBySalon, selectedPosSalon]);
  const showReservasStatCard = cajaOptionsForRole.some((o) => o.id === 'reservas');
  const cajaStatGridCols = showReservasStatCard
    ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
    : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5';
  const deliveryCajaSlots = useMemo(() => buildDeliveryCajaSlots(allOrders), [allOrders]);
  const quickSaleCajaSlots = useMemo(() => buildQuickSaleCajaSlots(allOrders), [allOrders]);
  const filteredProducts = filterOrderingProducts(products, { search, selectedCat });
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const registerLiveSales = useMemo(
    () => summarizePaidOrdersForRegister(allOrders, closingData || register, closingAtPreview || new Date()),
    [allOrders, closingData, register, closingAtPreview],
  );
  const registerSales = Number(register?.total_sales || 0) > 0
    ? Number(register.total_sales || 0)
    : registerLiveSales.total_sales;
  const openingAmt = register?.opening_amount || 0;

  const saveOpeningAmount = async () => {
    const rid = String(register?.id || '').trim();
    if (!rid || openingEdit == null) return;
    const amount = Number(String(openingEdit).replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Ingrese un monto de apertura válido');
      return;
    }
    setSavingOpening(true);
    try {
      const updated = await api.put(`/pos/register/${encodeURIComponent(rid)}/opening-amount`, { opening_amount: amount });
      setRegister((prev) => (prev && String(prev.id) === rid ? { ...prev, ...(updated || {}), opening_amount: amount } : prev));
      setOpeningEdit(null);
      toast.success('Monto de apertura actualizado');
      void loadData();
    } catch (err) {
      toast.error(err?.message || 'No se pudo actualizar el monto de apertura');
    } finally {
      setSavingOpening(false);
    }
  };

  const totalCash = Number(register?.total_cash || 0) > 0 ? Number(register.total_cash || 0) : registerLiveSales.total_cash;
  const totalYape = Number(register?.total_yape || 0) > 0 ? Number(register.total_yape || 0) : registerLiveSales.total_yape;
  const totalPlin = Number(register?.total_plin || 0) > 0 ? Number(register.total_plin || 0) : registerLiveSales.total_plin;
  const totalCard = Number(register?.total_card || 0) > 0 ? Number(register.total_card || 0) : registerLiveSales.total_card;
  const cashFlowSource = closingData && String(closingData.id || '') === String(register?.id || '') ? closingData : register;
  const totalIncome = Number(cashFlowSource?.total_income || 0);
  const totalExpense = Number(cashFlowSource?.total_expense || 0);
  const tipsSource = Number(register?.total_tips || 0) > 0 ? register : registerLiveSales;
  const totalTips = Number(tipsSource?.total_tips || 0);
  const nonCashTipsTotal = ['tips_yape', 'tips_plin', 'tips_card', 'tips_online']
    .reduce((s, k) => s + Number(tipsSource?.[k] || 0), 0);
  const tipsByMethod = {
    efectivo: tipsSource?.tips_cash != null
      ? Number(tipsSource.tips_cash || 0)
      : Math.max(0, roundMoneySoles(totalTips - nonCashTipsTotal)),
    yape: Number(tipsSource?.tips_yape || 0),
    plin: Number(tipsSource?.tips_plin || 0),
    tarjeta: Number(tipsSource?.tips_card || 0),
    online: Number(tipsSource?.tips_online || 0),
  };
  const cashTips = roundMoneySoles(tipsByMethod.efectivo);
  const notesCredit = Number(cashFlowSource?.notes_credit || 0);
  const notesDebit = Number(cashFlowSource?.notes_debit || 0);
  const useLiveRegisterSales = !(Number(register?.total_sales || 0) > 0) && registerLiveSales.total_sales > 0;
  const expectedCash = useLiveRegisterSales
    ? roundMoneySoles(
      openingAmt + totalCash + cashTips + totalIncome - totalExpense + notesCredit - notesDebit,
    )
    : (register?.expected_cash ??
      roundMoneySoles(
        openingAmt + totalCash + cashTips + totalIncome - totalExpense + notesCredit - notesDebit,
      ));
  const expectedRounded = roundMoneySoles(expectedCash);

  const closingAmt =
    closingAmount === '' ? 0 : roundMoneySoles(parseFloat(closingAmount) || 0);
  const difference =
    closingAmount === '' ? 0 : roundMoneySoles(closingAmt - expectedRounded);
  const denomTotalRounded = calculateDenominationTotal();
  const denominationMismatch =
    closingAmount !== '' &&
    denomTotalRounded > 0 &&
    Math.abs(denomTotalRounded - closingAmt) >= 0.02;

  /**
   * Totales por método (API) alineados con gestión: mismos ids que pedidos pagados del turno.
   * Incluye filas configuradas en Ajustes y, si hubo ventas «online» sin estar en la lista, una fila extra.
   */
  const registerPaymentRows = useMemo(() => {
    const by = {
      efectivo: Number(register?.total_cash || 0) > 0 ? Number(register.total_cash || 0) : registerLiveSales.total_cash,
      yape: Number(register?.total_yape || 0) > 0 ? Number(register.total_yape || 0) : registerLiveSales.total_yape,
      plin: Number(register?.total_plin || 0) > 0 ? Number(register.total_plin || 0) : registerLiveSales.total_plin,
      tarjeta: Number(register?.total_card || 0) > 0 ? Number(register.total_card || 0) : registerLiveSales.total_card,
      online: Number(register?.total_online || 0) > 0 ? Number(register.total_online || 0) : registerLiveSales.total_online,
    };
    const opts = paymentOptions || [];
    const rows = opts.map((opt) => ({
      value: opt.value,
      label: opt.label,
      amount: by[opt.value] ?? 0,
      tip: roundMoneySoles(tipsByMethod[opt.value] || 0),
    }));
    const hasOnlineRow = rows.some((r) => r.value === 'online');
    if (!hasOnlineRow && (by.online > 0 || tipsByMethod.online > 0)) {
      rows.push({
        value: 'online',
        label: PAYMENT_METHODS.online || 'Online',
        amount: by.online,
        tip: roundMoneySoles(tipsByMethod.online || 0),
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, paymentOptions, registerLiveSales, tipsByMethod.efectivo, tipsByMethod.yape, tipsByMethod.plin, tipsByMethod.tarjeta, tipsByMethod.online]);

  /** Verificación de cobros no efectivo (POS de tarjeta / QR): vacío = aún sin verificar (se asume el del sistema). */
  const nonCashCheckRows = registerPaymentRows
    .filter((row) => row.value !== 'efectivo')
    .map((row) => {
      const raw = nonCashCounted[row.value];
      const expected = roundMoneySoles(row.amount + (row.tip || 0));
      const verified = raw !== undefined && raw !== '';
      const counted = verified ? roundMoneySoles(Math.max(0, parseFloat(raw) || 0)) : expected;
      return {
        ...row,
        checkLabel: nonCashCheckLabel(row.value, row.label),
        expected,
        counted,
        verified,
        difference: verified ? roundMoneySoles(counted - expected) : 0,
      };
    });
  const nonCashExpectedTotal = roundMoneySoles(nonCashCheckRows.reduce((s, r) => s + r.expected, 0));
  const totalPosRaw = nonCashCounted.total_pos;
  /** Total del cierre del POS (Culqi, Izipay…): si se ingresa, reemplaza la suma por medio. */
  const nonCashTotalPos = posTerminalEnabled && totalPosRaw !== undefined && totalPosRaw !== ''
    ? roundMoneySoles(Math.max(0, parseFloat(totalPosRaw) || 0))
    : null;
  const nonCashCountedTotal = nonCashTotalPos != null
    ? nonCashTotalPos
    : roundMoneySoles(nonCashCheckRows.reduce((s, r) => s + r.counted, 0));
  const nonCashPending = nonCashTotalPos != null
    ? []
    : nonCashCheckRows.filter((r) => !r.verified && r.expected > 0);
  const grandExpected = roundMoneySoles(expectedRounded + nonCashExpectedTotal);
  const grandCounted = roundMoneySoles(closingAmt + nonCashCountedTotal);
  const markNonCashCorrect = (method) => {
    setNonCashCounted((prev) => {
      const next = { ...prev };
      nonCashCheckRows.forEach((r) => {
        if (!method || r.value === method) next[r.value] = r.expected.toFixed(2);
      });
      if (!method && posTerminalEnabled) next.total_pos = nonCashExpectedTotal.toFixed(2);
      return next;
    });
  };
  const grandDifference = closingAmount === '' ? 0 : roundMoneySoles(grandCounted - grandExpected);

  useEffect(() => {
    if (!showCloseModal || preparingCloseModal || !closingData || closeAutoFocusDoneRef.current) return undefined;
    const t = setTimeout(() => {
      const first = denomDefs.find((d) => denominations[d.key] === '')?.key || denomDefs[0].key;
      if (focusCloseField(first)) closeAutoFocusDoneRef.current = true;
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCloseModal, preparingCloseModal, closingData]);

  const paymentRowAmountClass = (value) => {
    switch (value) {
      case 'efectivo':
        return 'text-emerald-600';
      case 'yape':
        return 'text-fuchsia-600';
      case 'plin':
        return 'text-sky-600';
      case 'tarjeta':
        return 'text-amber-600';
      case 'online':
        return 'text-violet-600';
      default:
        return 'text-[var(--ui-body-text)]';
    }
  };

  const arqueoOpeningParts = useMemo(
    () => (closingData?.opened_at ? formatPeDateTimeParts(closingData.opened_at) : { date: '—', time: '—' }),
    [closingData?.opened_at]
  );
  const { arqueoClosingParts, arqueoHeaderDayLabel } = useMemo(() => {
    const inst = closingAtPreview || new Date();
    return {
      arqueoClosingParts: formatPeDateTimeParts(inst),
      arqueoHeaderDayLabel: inst.toLocaleDateString('es-PE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    };
  }, [closingAtPreview]);

  const registerSoldProducts = useMemo(() => {
    const sessionRegister = closingData || register;
    if (!sessionRegister?.opened_at) return [];
    const map = new Map();
    for (const order of registerLiveSales.orders || []) {
      for (const item of order.items || []) {
        const key = `${item.product_id}|${item.product_name}`;
        const prev = map.get(key) || {
          product_id: item.product_id,
          product_name: item.product_name || 'Producto',
          total_qty: 0,
          total_amount: 0,
        };
        prev.total_qty += Number(item.quantity) || 0;
        prev.total_amount += Number(item.subtotal) || 0;
        map.set(key, prev);
      }
    }
    return [...map.values()]
      .map((row) => ({
        ...row,
        unit_price: row.total_qty > 0 ? row.total_amount / row.total_qty : 0,
      }))
      .sort((a, b) => String(a.product_name).localeCompare(String(b.product_name), 'es'));
  }, [registerLiveSales, closingData, register]);

  const hydratedSelectedOrders = useMemo(
    () => (selectedTable?.orders || []).map((o) => ({
      ...o,
      items: (o.items || []).map((it) => hydratePosOrderItem(it, productsById)),
    })),
    [selectedTable, productsById]
  );

  const selectionBaseTotal = useMemo(() => {
    if (!selectedTable) return 0;
    if (!splitMode) {
      return hydratedSelectedOrders.reduce((sum, o) => sum + getOrderChargeTotal(o), 0);
    }
    return computeTableSplitSelectionBase(hydratedSelectedOrders, selectedOrderItemIds, selectedOrderItemQtys);
  }, [selectedTable, splitMode, selectedOrderItemIds, selectedOrderItemQtys, hydratedSelectedOrders]);

  const splitBillLines = useMemo(() => {
    if (!selectedTable || !splitMode) return [];
    const rows = [];
    for (const o of hydratedSelectedOrders) {
      for (const it of o.items || []) {
        const qty = Number(it.quantity || 0);
        const unit = Number(it.unit_price ?? 0);
        const sub = Number(it.subtotal != null ? it.subtotal : unit * qty);
        rows.push({
          id: it.id,
          orderNumber: o.order_number,
          name: billLineDisplayName(it),
          qty,
          unit,
          sub,
        });
      }
    }
    return rows;
  }, [selectedTable, splitMode, hydratedSelectedOrders]);

  const discountTargetLabel = useMemo(() => {
    if (!discountConfig.active && !discountConfig.applied) return '';
    if (
      discountConfig.target !== 'line' ||
      !String(discountConfig.targetOrderItemId || '').trim() ||
      !splitMode
    ) {
      return 'Cuenta completa';
    }
    const line = splitBillLines.find((l) => l.id === discountConfig.targetOrderItemId);
    return line ? line.name : 'Producto seleccionado';
  }, [
    discountConfig.active,
    discountConfig.applied,
    discountConfig.target,
    discountConfig.targetOrderItemId,
    splitMode,
    splitBillLines,
  ]);

  const discountAmountBase = useMemo(
    () =>
      resolveAppliedDiscountBase(
        selectedTable?.orders || [],
        selectedOrderItemIds,
        splitMode,
        discountConfig,
        selectionBaseTotal,
        selectedOrderItemQtys
      ),
    [
      selectedTable,
      selectedOrderItemIds,
      selectedOrderItemQtys,
      splitMode,
      discountConfig.applied,
      discountConfig.target,
      discountConfig.targetOrderItemId,
      selectionBaseTotal,
    ]
  );

  const discountValue = Math.max(0, parseFloat(discountConfig.value) || 0);
  const discountPreview = !discountConfig.applied
    ? 0
    : (discountConfig.type === 'percent'
      ? Math.min(discountAmountBase, discountAmountBase * (discountValue / 100))
      : Math.min(discountAmountBase, discountValue));
  const payableTotal = Math.max(0, selectionBaseTotal - discountPreview);
  const multiPayState = useMemo(
    () => resolveMultiPayment(multiPayAmounts, multiPaymentOptions, payableTotal),
    [multiPaymentOptions, multiPayAmounts, payableTotal]
  );
  const billLineItemsGrouped = useMemo(() => {
    if (!selectedTable) return [];
    const orders = hydratedSelectedOrders;
    if (splitMode) {
      const set = new Set(selectedOrderItemIds);
      const picked = [];
      for (const o of orders) {
        for (const it of o.items || []) {
          if (!set.has(it.id)) continue;
          const chargeQ = resolveSplitChargeQty(it, selectedOrderItemQtys);
          picked.push(itemWithSplitChargeQty(it, chargeQ));
        }
      }
      return groupItemsByProductNameForBill(picked);
    }
    return groupItemsByProductNameForBill(orders.flatMap((o) => o.items || []));
  }, [selectedTable, splitMode, selectedOrderItemIds, selectedOrderItemQtys, hydratedSelectedOrders]);
  const occupiedHours = (() => {
    const timestamps = (selectedTable?.orders || [])
      .map(o => o.created_at)
      .filter(Boolean)
      .map(v => new Date(`${v}Z`).getTime())
      .filter(Boolean);
    if (timestamps.length === 0) return 0;
    const first = Math.min(...timestamps);
    return Math.max(0, Math.round((Date.now() - first) / (1000 * 60 * 60)));
  })();
  const printPrecuenta = async (tableOverride = null) => {
    const table = tableOverride || selectedTable;
    if (!table) return;
    const useSplit = !tableOverride && splitMode;
    let payableOrders;
    let groupedPrecuenta;
    if (useSplit) {
      const set = new Set(selectedOrderItemIds);
      const itemsFlat = [];
      payableOrders = [];
      for (const o of table.orders || []) {
        const picks = (o.items || [])
          .filter((it) => set.has(it.id))
          .map((it) => itemWithSplitChargeQty(it, resolveSplitChargeQty(it, selectedOrderItemQtys)));
        if (picks.length) {
          itemsFlat.push(...picks);
          payableOrders.push(o);
        }
      }
      if (!itemsFlat.length) return toast.error('Selecciona al menos una línea para la precuenta');
      groupedPrecuenta = groupItemsByProductNameForBill(itemsFlat);
    } else {
      payableOrders = table.orders || [];
      if (payableOrders.length === 0) return toast.error('No hay pedidos para precuenta');
      groupedPrecuenta = groupItemsByProductNameForBill(payableOrders.flatMap((o) => o.items || []));
    }
    const mozoName =
      [...new Set(payableOrders.map((o) => String(o.created_by_user_name || '').trim()).filter(Boolean))].join(', ')
      || String(user?.full_name || '').trim()
      || '—';
    const customerLines = [
      billingForm.customer_name && `Cliente: ${billingForm.customer_name}`,
      billingForm.customer_doc_number && `Doc: ${billingForm.customer_doc_number}`,
      billingForm.customer_phone && `Tel: ${billingForm.customer_phone}`,
      billingForm.customer_address && `Dir: ${billingForm.customer_address}`,
    ].filter(Boolean);
    const ordersSubtotal = useSplit
      ? computeTableSplitSelectionBase(table.orders, selectedOrderItemIds, selectedOrderItemQtys)
      : payableOrders.reduce((sum, o) => sum + getOrderChargeTotal(o), 0);
    const discBase = resolveAppliedDiscountBase(
      table.orders || [],
      useSplit ? selectedOrderItemIds : [],
      useSplit,
      discountConfig,
      ordersSubtotal,
      selectedOrderItemQtys
    );
    const discountForPrecuenta = !discountConfig.applied
      ? 0
      : (discountConfig.type === 'percent'
        ? Math.min(discBase, discBase * (discountValue / 100))
        : Math.min(discBase, discountValue));
    const payableForPrecuenta = Math.max(0, ordersSubtotal - discountForPrecuenta);
    const widthMm = cajaPaperWidthMm;
    const plain = buildPrecuentaPlainText({
      restaurant: printRestaurantInfo,
      tableName: table.name,
      mozoName,
      customerLines,
      groupedRows: groupedPrecuenta,
      formatCurrencyFn: formatCurrency,
      subtotal: ordersSubtotal,
      discount: discountForPrecuenta,
      payableTotal: payableForPrecuenta,
      widthMm,
      printedAt: new Date(),
    });
    const surveyQr = await getPrecuentaSurveyQrAttachment(widthMm).catch(() => null);
    const r = await printCajaTicket({
      text: surveyQr ? `${plain.replace(/\s+$/, '')}\n${surveyQr.textSuffix}` : plain,
      preformatted: true,
      logoUrl: String(printRestaurantInfo.logo || '').trim() || undefined,
      restaurantBrand: restaurantThermalBrandLine(printRestaurantInfo) || undefined,
      paperWidth: widthMm,
      ...(surveyQr ? surveyQr.payload : {}),
    });
    if (r.ok) {
      toast.success(`Precuenta impresa · ${getThermalPrintRevision()}`);
      const tid = String(table.id || '').trim();
      if (tid) {
        setPrecuentaTableIds((prev) => {
          const next = new Set(prev);
          next.add(tid);
          return next;
        });
      }
    } else toast.error(r.error || 'No se pudo imprimir precuenta');
  };

  const printNotaVenta = async ({
    tableName,
    orders,
    docs,
    customer,
    paymentMethod: paymentMethodArg,
    discountTotal = 0,
  }) => {
    const docText = (docs || []).map((d) => String(d?.full_number || '').trim()).filter(Boolean).join(' · ');
    const groupedNota = groupItemsByProductNameForBill((orders || []).flatMap((o) => o.items || []));
    const total = (orders || []).reduce((sum, o) => sum + getOrderChargeTotal(o), 0);
    const subtotalLines = groupedNota.reduce((s, g) => s + Number(g.subtotal != null ? g.subtotal : 0), 0);
    const customerLines = [
      customer?.name && `Nombre: ${customer.name}`,
      customer?.doc_number && `DNI / RUC: ${customer.doc_number}`,
      customer?.phone && `Tel: ${customer.phone}`,
      customer?.address && `Dir: ${customer.address}`,
    ].filter(Boolean);
    const widthMm = cajaPaperWidthMm;
    const plain = buildNotaVentaPlainText({
      restaurant: printRestaurantInfo,
      docLine: docText,
      tableName: tableName || '',
      customerLines,
      groupedRows: groupedNota,
      formatCurrencyFn: formatCurrency,
      subtotal: subtotalLines,
      total,
      discount: discountTotal,
      widthMm,
      printedAt: new Date(),
      paymentMethod: paymentMethodArg || paymentMethod || 'efectivo',
    });
    const r = await printCajaTicket({
      text: plain,
      preformatted: true,
      logoUrl: String(printRestaurantInfo.logo || '').trim() || undefined,
      restaurantBrand: restaurantThermalBrandLine(printRestaurantInfo) || undefined,
      paperWidth: widthMm,
    });
    if (r.ok) {
      toast.success('Nota de venta impresa');
    } else {
      toast.error(r.error || 'No se pudo imprimir nota de venta');
    }
  };

  if (loading && tables.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-4 border-gold-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const printTableOrder = async (table) => {
    if (!table) return;
    const groupedTable = mergedProductsOnTable(table, productsById);
    if (!groupedTable.length) return toast.error('La mesa no tiene pedidos para precuenta');
    const tableTotal = (table.orders || []).reduce((sum, o) => sum + getOrderChargeTotal(o), 0);
    const mozoNameTbl =
      [...new Set((table.orders || []).map((o) => String(o.created_by_user_name || '').trim()).filter(Boolean))].join(', ')
      || String(user?.full_name || '').trim()
      || '—';
    const customerLines = [
      billingForm.customer_name && `Cliente: ${billingForm.customer_name}`,
      billingForm.customer_doc_number && `Doc: ${billingForm.customer_doc_number}`,
      billingForm.customer_phone && `Tel: ${billingForm.customer_phone}`,
      billingForm.customer_address && `Dir: ${billingForm.customer_address}`,
    ].filter(Boolean);
    const widthMm = cajaPaperWidthMm;
    const plain = buildPrecuentaPlainText({
      restaurant: printRestaurantInfo,
      tableName: table.name,
      mozoName: mozoNameTbl,
      customerLines,
      groupedRows: groupedTable,
      formatCurrencyFn: formatCurrency,
      subtotal: tableTotal,
      discount: 0,
      payableTotal: tableTotal,
      widthMm,
      printedAt: new Date(),
    });
    const r = await printCajaTicket({
      text: plain,
      preformatted: true,
      logoUrl: String(printRestaurantInfo.logo || '').trim() || undefined,
      restaurantBrand: restaurantThermalBrandLine(printRestaurantInfo) || undefined,
      paperWidth: widthMm,
    });
    if (r.ok) toast.success('Acción completada');
    else toast.error(r.error || 'No se pudo imprimir');
  };
  const chargeReservation = async (entry) => {
    const orders = entry?.linkedOrders || [];
    if (!orders.length) return toast.error('Esta reserva no tiene pedidos pendientes para cobrar');
    try {
      await api.post('/pos/checkout-table', {
        ...posRegisterBody(),
        order_ids: orders.map(o => o.id),
        payment_method: paymentMethod || 'efectivo',
      });
      await api.put(`/admin-modules/reservations/${entry.reservation.id}`, { status: 'completed' }).catch(() => {});
      toast.success(`Reserva de ${entry.reservation.client_name} cobrada correctamente`);
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const mesaMapToolbarMoveTableClass = 'btn-mesa-map-toolbar btn-mesa-move-table';
  const mesaMapToolbarMoveOrdersClass = 'btn-mesa-map-toolbar btn-mesa-move-orders';
  const mesaMapToolbarUniteClass = 'btn-mesa-map-toolbar btn-mesa-unite';

  const mesaMapToolbarButtons = (
    <>
      <button
        type="button"
        onClick={() => openMesaMapTransfer('move_table')}
        className={mesaMapToolbarMoveTableClass}
        title="Mover toda la cuenta a otra mesa"
      >
        <MdOpenWith className="shrink-0 text-sm" />
        <span>Mover mesa</span>
      </button>
      <button
        type="button"
        onClick={() => openMesaMapTransfer('move_orders')}
        className={mesaMapToolbarMoveOrdersClass}
        title="Mover pedidos seleccionados a otra mesa"
      >
        <MdSwapHoriz className="shrink-0 text-sm" />
        <span>Mover ped.</span>
      </button>
      <button
        type="button"
        onClick={() => {
          if (mesaUniteMode && mesaUniteSelection.length >= 2) {
            void confirmMesaUnite();
          } else {
            toggleMesaUniteMode();
          }
        }}
        disabled={mesaUniteBusy}
        className={`${mesaMapToolbarUniteClass}${mesaUniteMode ? ' ring-2 ring-blue-300 ring-offset-1' : ''}`}
        title="Unir varias mesas en una sola cuenta"
      >
        <MdCallMerge className="shrink-0 text-sm" />
        <span>
          {mesaUniteMode && mesaUniteSelection.length >= 2
            ? `Unir (${mesaUniteSelection.length})`
            : 'Unir mesas'}
        </span>
      </button>
    </>
  );

  const cajaRequiresRegisterNotice = (
    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
      Abra un turno de caja para registrar operaciones en este submodulo.
    </p>
  );

  const renderOpenRegisterScreen = () => {
    const isAdmin = posRoleOf(user) === 'admin';
    if (isAdmin) {
      return (
        <div className="flex items-center justify-center py-12 px-4">
          <div className="card max-w-3xl w-full">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
              <div>
                <MdPointOfSale className="text-5xl text-gold-500 mb-2" />
                <h2 className="text-xl font-bold text-[var(--ui-body-text)]">Cajas del local</h2>
                <p className="text-sm ui-text-muted">
                  AGREGUE EL MONTO DE APERTURA PARA ABRIR UN TURNO DE CAJA O SELECCIONE UN TURNO YA ABIERTO PARA INSPECCIONAR.
                </p>
              </div>
              {String(adminRegisterId || '').trim() ? (
                <button
                  type="button"
                  onClick={() => void clearAdminRegisterContext()}
                  className="btn-secondary text-sm shrink-0"
                >
                  Quitar selección
                </button>
              ) : null}
            </div>

            <div className="mb-6 text-left">
              <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Monto de apertura (nuevos turnos)</label>
              <div className="relative max-w-xs">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ui-muted)] font-medium">S/</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  placeholder="0.00"
                  className="input-field pl-10 text-lg font-bold text-center"
                />
              </div>
              <p className="text-xs text-[var(--ui-muted)] mt-1">Se usa al pulsar «Abrir turno» en una caja sin sesión activa.</p>
            </div>

            {!cajaStations.length ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                No hay cajas activas en configuración. Defínalas en <strong>Configuración → Cajas</strong>.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {cajaStations.map((st) => {
                  const op = st.open_register;
                  return (
                    <div
                      key={st.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 text-left flex flex-col gap-3"
                    >
                      <div>
                        <p className="font-semibold rf-section-title">{st.name}</p>
                        {op ? (
                          <p className="text-xs ui-text-muted mt-1">
                            Turno abierto · {op.cajero_name || 'Usuario'}{' '}
                            {op.opened_at ? `· ${formatPeDateTimeLine(op.opened_at)}` : ''}
                          </p>
                        ) : (
                          <p className="text-xs ui-text-muted mt-1">Sin turno abierto</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-auto">
                        {op ? (
                          <button
                            type="button"
                            onClick={() => void attachAdminToRegister(op.id)}
                            disabled={workAreaLoading}
                            className="btn-primary text-sm flex items-center gap-1 disabled:opacity-60"
                          >
                            {workAreaLoading ? (
                              <>
                                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                                Cargando área…
                              </>
                            ) : (
                              <>
                                <MdPointOfSale /> Operar esta caja
                              </>
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void openStationRegisterForAdmin(st.id)}
                            disabled={openingAmount === '' || workAreaLoading}
                            className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50"
                          >
                            {workAreaLoading ? (
                              <>
                                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                                Cargando área…
                              </>
                            ) : (
                              <>
                                <MdPointOfSale /> Abrir turno
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center py-20">
        <div className="card text-center max-w-md">
          <MdPointOfSale className="text-6xl text-gold-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Abrir Caja</h2>
          {cajaStations[0]?.name ? (
            <p className="text-sm text-[var(--ui-muted)] mb-2">
              Caja asignada: <span className="font-semibold rf-section-title">{cajaStations[0].name}</span>
            </p>
          ) : null}
          <p className="ui-text-muted mb-6">Ingresa el monto inicial y abre la caja para comenzar a operar</p>

          <div className="mb-4 text-left">
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Monto de apertura</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ui-muted)] font-medium">S/</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={openingAmount}
                onChange={(e) => setOpeningAmount(e.target.value)}
                placeholder="0.00"
                className="input-field pl-10 text-lg font-bold text-center"
                autoFocus
              />
            </div>
            <p className="text-xs text-[var(--ui-muted)] mt-1">Dinero en efectivo al iniciar el turno</p>
          </div>

          <button
            type="button"
            onClick={() => void openRegisterForCajero()}
            disabled={openingAmount === '' || workAreaLoading}
            className="btn-primary w-full py-3 text-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {workAreaLoading ? (
              <>
                <span className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                Cargando área de trabajo…
              </>
            ) : (
              <>
                <MdPointOfSale /> Abrir Caja
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  const cobrarMapReady = activeCajaOption === 'cobrar' && posRegisterReady;

  return (
    <div
      className={
        cobrarMapReady
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : undefined
      }
    >
      <div className={cobrarMapReady ? 'flex min-h-0 flex-1 flex-col' : 'mb-3'}>
      {activeCajaOption === 'cobrar' && (
        posRegisterReady ? (
        workAreaLoading ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <PosInlineLoading
              title="Cargando área de trabajo…"
              subtitle="Mesas y zonas de su caja"
            />
          </div>
        ) : (
        <>
      <div className="rf-mesa-map-toolbar mb-2 shrink-0">
        {tablesBySalon.length > 0 ? (
          <div className="rf-mesa-map-toolbar__zones scrollbar-hide">
            {tablesBySalon.map(({ zone, label, tables: salonTables }) => {
              const active = selectedPosSalon === zone;
              return (
                <button
                  key={zone}
                  type="button"
                  onClick={() => setSelectedPosSalon(zone)}
                  className={`rf-mesa-map-toolbar__zone-btn ${
                    active
                      ? 'border-[color:var(--ui-border)] bg-[var(--ui-accent)] text-white shadow-sm'
                      : 'border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] hover:bg-[var(--ui-sidebar-hover)]'
                  }`}
                >
                  {label}
                  <span className={`ml-1 tabular-nums ${active ? 'text-white/90' : 'text-[var(--ui-muted)]'}`}>
                    ({salonTables.length})
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="rf-mesa-map-toolbar__actions">
          {tablesBySalon.length > 0 ? (
            <div className="rf-mesa-map-toolbar__divider hidden sm:block" aria-hidden="true" />
          ) : null}
          {mesaMapToolbarButtons}
          {canSwitchCaja ? (
            <button
              type="button"
              onClick={() => void clearAdminRegisterContext()}
              className="btn-mesa-map-toolbar-secondary"
              title="Volver a elegir caja / turno"
            >
              Cambiar caja
            </button>
          ) : null}
          {showDeliveryUi ? (
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('pos-delivery-caja');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                if (!deliveryCajaSlots.length) {
                  toast.error('No hay pedidos delivery pendientes de cobro');
                }
              }}
              className="btn-mesa-map-toolbar-secondary"
            >
              <MdDeliveryDining className="text-sm shrink-0" />
              Delivery
            </button>
          ) : null}
          <button
            type="button"
            onClick={openQuickSaleMenu}
            className="btn-mesa-map-toolbar-primary"
          >
            <MdPointOfSale className="text-sm shrink-0" /> Venta rápida
          </button>
        </div>
      </div>

      {mesaUniteMode ? (
        <p className="mb-2 shrink-0 text-xs sm:text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          Seleccione 2 o más mesas en el mapa y pulse <strong>Unir ({mesaUniteSelection.length})</strong>.
          <button
            type="button"
            onClick={toggleMesaUniteMode}
            className="ml-2 underline font-medium hover:text-blue-900"
          >
            Cancelar
          </button>
        </p>
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide space-y-6 pb-2">
        {selectedSalonTables.length > 0 ? (
          <>
            <div className="rf-mesa-map-legend shrink-0">
              <span className="rf-mesa-map-legend__item">
                <span className="rf-mesa-map-legend__dot" style={{ background: '#22c55e' }} />
                Libre
              </span>
              <span className="rf-mesa-map-legend__item">
                <span className="rf-mesa-map-legend__dot" style={{ background: '#f97316' }} />
                Ocupada
              </span>
              <span className="rf-mesa-map-legend__item">
                <span className="rf-mesa-map-legend__dot" style={{ background: '#9333ea' }} />
                Pre-cuenta
              </span>
              <span className="rf-mesa-map-legend__item">
                <span className="rf-mesa-map-legend__dot" style={{ background: '#2563eb' }} />
                Mesa unida
              </span>
              <span className="rf-mesa-map-legend__item">
                <span className="rf-mesa-map-legend__dot" style={{ background: '#9ca3af' }} />
                Reservada
              </span>
            </div>
            <div className="rf-mesa-map-grid">
            {selectedSalonTables.map((table) => {
              const mesaLock = getMesaLock();
              const isSelected =
                tableDetail?.id === table.id
                || (showMenu && !quickSaleMode && mesaLock?.id === table.id);
              const isUnitePicked = mesaUniteSelection.includes(table.id);
              const visualState = getMesaMapVisualState(
                table,
                reservationByTableId,
                precuentaTableIds,
                reservations,
                mesaMapClockMs
              );
              const chairCount = getMesaMapChairCount(table, reservationByTableId, mesaPhysicalTables);
              return (
                <MesaMapTableTile
                  key={table.id}
                  table={table}
                  visualState={visualState}
                  chairCount={chairCount}
                  selected={isSelected}
                  unitePicked={isUnitePicked}
                  onClick={() => {
                    if (mesaUniteMode) {
                      toggleMesaUniteTable(table.id);
                      return;
                    }
                    const lock = getMesaLock();
                    if (showMenu && !quickSaleMode && lock && String(lock.id) !== String(table.id)) {
                      releasePendingOrderMenu();
                    }
                    setTableDetail(table);
                    setMesaDetailModalOpen(true);
                  }}
                />
              );
            })}
            </div>
          </>
        ) : tablesBySalon.length === 0 ? (
          <p className="text-sm text-center text-[var(--ui-muted)] py-8">No hay mesas configuradas</p>
        ) : (
          <p className="text-sm text-center text-[var(--ui-muted)] py-8">No hay mesas en esta zona</p>
        )}

        {showDeliveryUi && deliveryCajaSlots.length > 0 && (
          <>
            <h2
              id="pos-delivery-caja"
              className="font-semibold text-slate-700 mb-2 flex items-center gap-2 scroll-mt-4"
            >
              <MdDeliveryDining /> Delivery en caja
            </h2>
            <p className="text-sm ui-text-muted mb-3">
              Un recuadro por pedido delivery pendiente de cobro. Al cobrar, desaparece de esta lista.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
              {deliveryCajaSlots.map((slot) => {
                const isSelected = tableDetail?.id === slot.id;
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => {
                      setTableDetail(slot);
                      setMesaDetailModalOpen(true);
                    }}
                    className={`card text-left transition-all border-l-4 border-l-sky-500 hover:shadow-lg bg-slate-50/80 ${
                      isSelected ? 'ring-2 ring-gold-400' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-100">
                        <MdDeliveryDining className="text-sky-700 text-xl" />
                      </div>
                      <div>
                        <p className="font-bold rf-section-title">{slot.name}</p>
                        <p className="text-xs ui-text-muted">Pedido #{slot.orders?.[0]?.order_number ?? '—'}</p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-sky-800">
                      Por cobrar · {formatCurrency((slot.orders || []).reduce((s, o) => s + getOrderChargeTotal(o), 0))}
                    </p>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {quickSaleCajaSlots.length > 0 && (
          <>
            <h2 className="font-semibold text-slate-700 mt-4 mb-2 flex items-center gap-2">
              <MdPointOfSale /> Ventas rápidas por cobrar
            </h2>
            <p className="text-sm ui-text-muted mb-3">
              Ventas rápidas que se cerraron sin cobrar. Al cobrarlas o anularlas, desaparecen de esta lista.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
              {quickSaleCajaSlots.map((slot) => (
                <div
                  key={slot.id}
                  className="card text-left transition-all border-l-4 border-l-emerald-500 hover:shadow-lg bg-slate-50/80 flex flex-col gap-2"
                >
                  <button
                    type="button"
                    onClick={() => openBillForTable(slot)}
                    className="text-left"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-100">
                        <MdPointOfSale className="text-emerald-700 text-xl" />
                      </div>
                      <div>
                        <p className="font-bold rf-section-title">{slot.name}</p>
                        <p className="text-xs ui-text-muted">Pedido #{slot.orders?.[0]?.order_number ?? '—'}</p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-emerald-800">
                      Por cobrar · {formatCurrency(slot.order_total)}
                    </p>
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openBillForTable(slot)}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-1"
                    >
                      <MdAttachMoney className="text-sm" /> Cobrar
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelQuickSale(slot)}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-1"
                      title="Anular esta venta rápida sin cobrarla"
                    >
                      <MdClose className="text-sm" /> Anular
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {mesaDetailModalOpen && tableDetail && (
        <div className="fixed top-14 left-0 right-0 bottom-0 z-[200] flex min-h-0">
          <button
            type="button"
            className="min-h-0 min-w-0 flex-1 cursor-default border-0 bg-black/40 p-0"
            aria-label="Cerrar panel"
            onClick={() => setMesaDetailModalOpen(false)}
          />
          <div
            className="flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col border-l border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-body-text)] shadow-2xl md:w-1/2 md:max-w-[920px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pos-mesa-detail-title"
          >
          <div className="flex items-center justify-between gap-3 shrink-0 border-b border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2.5 sm:px-4">
            <h2 id="pos-mesa-detail-title" className="font-semibold flex items-center gap-2 text-base sm:text-lg min-w-0 truncate text-[var(--ui-body-text)]">
              <MdTableRestaurant className="shrink-0 text-[var(--ui-accent-muted)]" />
              <span className="truncate">{tableDetail.name}</span>
            </h2>
            <button
              type="button"
              onClick={() => setMesaDetailModalOpen(false)}
              className="shrink-0 rounded-lg p-2 text-[var(--ui-muted)] hover:bg-[var(--ui-sidebar-hover)] hover:text-[var(--ui-body-text)] transition-colors"
              aria-label="Cerrar"
            >
              <MdClose className="text-2xl" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4 lg:p-5">
            <div className="flex min-h-0 w-full max-w-full flex-1 flex-col gap-3">
              <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--ui-border)] pb-3">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--ui-muted)]">
                    {isDeliveryCheckoutTable(tableDetail)
                      ? (() => {
                          const o = tableDetail.orders?.[0];
                          if (!o) return 'Sin pedido';
                          if (isQuickSaleCheckoutTable(tableDetail)) return `Venta rápida pendiente de cobro · Pedido #${o.order_number ?? '—'}`;
                          return [o.customer_name, o.delivery_address].filter(Boolean).join(' · ') || 'Delivery';
                        })()
                      : tableDetail.orders?.length
                        ? `${tableDetail.orders.length} pedido(s) activo(s)`
                        : 'Sin pedidos activos'}
                  </p>
                </div>
                <p className="text-xl font-bold text-[var(--ui-accent-muted)] shrink-0 tabular-nums">
                  {formatCurrency((tableDetail.orders || []).reduce((sum, o) => sum + getOrderChargeTotal(o), 0))}
                </p>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] p-3 text-[var(--ui-body-text)]">
                <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-[var(--ui-muted)] mb-2">Productos en la mesa</p>
                {(() => {
                  const lines = mergedProductsOnTable(tableDetail, productsById);
                  const totalMesa = (tableDetail.orders || []).reduce((s, o) => s + getOrderChargeTotal(o), 0);
                  if (!lines.length) {
                    return <p className="text-center text-[var(--ui-muted)] py-6 text-sm">No hay productos para mostrar.</p>;
                  }
                  return (
                    <>
                      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1 text-sm">
                        {lines.map((row) => (
                          <li
                            key={row.key}
                            className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-2 items-baseline border-b border-[color:var(--ui-border)] pb-1.5 last:border-0 last:pb-0"
                          >
                            <span className="tabular-nums font-semibold text-[var(--ui-body-text)] text-right">
                              {row.qty}
                            </span>
                            <span className="min-w-0 font-medium text-[var(--ui-body-text)] break-words">
                              {row.name}
                            </span>
                            <span className="shrink-0 tabular-nums font-medium text-[var(--ui-accent-muted)]">
                              {formatCurrency(row.subtotal)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex shrink-0 justify-between border-t border-[color:var(--ui-border)] pt-3 mt-3 text-base font-bold text-[var(--ui-body-text)]">
                        <span>Total</span>
                        <span className="text-[var(--ui-accent-muted)]">{formatCurrency(totalMesa)}</span>
                      </div>
                    </>
                  );
                })()}
              </div>

              <div className="btn-mesa-grid-row shrink-0 pt-1 pb-1">
                {!isDeliveryCheckoutTable(tableDetail) && (
                  <button
                    type="button"
                    onClick={() => openMenuForTable(tableDetail)}
                    className="btn-mesa-grid btn-mesa-pedir"
                    title="Tomar pedido"
                  >
                    <MdRestaurantMenu className="shrink-0 text-lg" />
                    <span>Pedir</span>
                  </button>
                )}
                {!isDeliveryCheckoutTable(tableDetail) && tableDetail.union_id ? (
                  <button
                    type="button"
                    onClick={() => void desunirMesaUnida(tableDetail)}
                    disabled={mesaDesunirBusy}
                    className="btn-mesa-grid btn-mesa-desunir"
                    title="Separar las mesas unidas"
                  >
                    <MdCallMerge className="shrink-0 text-lg" />
                    <span>Desunir mesa</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  title="Modificar pedido"
                  onClick={openEditOrderFromToolbar}
                  disabled={
                    !tableDetail.orders?.length ||
                    isClientCheckoutTable(tableDetail) ||
                    !(tableDetail.orders || []).some((o) => canEditOrderLines(o))
                  }
                  className="btn-mesa-grid btn-mesa-modificar"
                >
                  <MdEdit className="shrink-0 text-lg" />
                  <span>Modificar</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    releasePendingOrderMenu();
                    setSelectedTable(tableDetail);
                    void printPrecuenta(tableDetail);
                  }}
                  disabled={!tableDetail.orders?.length}
                  className="btn-mesa-grid btn-mesa-precuenta"
                  title="Imprimir precuenta"
                >
                  <MdPrint className="shrink-0 text-lg" />
                  <span>Precuenta</span>
                </button>
                {isQuickSaleCheckoutTable(tableDetail) && tableDetail.orders?.length ? (
                  <button
                    type="button"
                    onClick={() => void cancelQuickSale(tableDetail)}
                    className="btn-mesa-grid !bg-red-600 hover:!bg-red-700 !text-white !border-red-700"
                    title="Anular esta venta rápida sin cobrarla"
                  >
                    <MdClose className="shrink-0 text-lg" />
                    <span>Anular</span>
                  </button>
                ) : null}
                {(() => {
                  const heldByReserva =
                    !tableDetail.orders?.length
                    && !isDeliveryCheckoutTable(tableDetail)
                    && !isClientCheckoutTable(tableDetail)
                    && ['occupied', 'reserved'].includes(
                      getMesaMapVisualState(
                        tableDetail,
                        reservationByTableId,
                        precuentaTableIds,
                        reservations,
                        mesaMapClockMs
                      )
                    );
                  if (heldByReserva) {
                    return (
                      <button
                        type="button"
                        onClick={() => void liberarMesaReservadaSinPedidos(tableDetail)}
                        className="btn-cobrar btn-mesa-grid"
                        title="Liberar mesa (reserva sin pedidos)"
                      >
                        <MdTableRestaurant className="shrink-0 text-lg" />
                        <span>Liberar</span>
                      </button>
                    );
                  }
                  return (
                    <button
                      type="button"
                      onClick={() => beginCobrarMesa(tableDetail)}
                      disabled={!tableDetail.orders?.length}
                      className="btn-cobrar btn-mesa-grid"
                      title={isQuickSaleCheckoutTable(tableDetail) ? 'Cobrar venta rápida' : isDeliveryCheckoutTable(tableDetail) ? 'Cobrar delivery' : 'Cobrar mesa'}
                    >
                      <MdAttachMoney className="shrink-0 text-lg" />
                      <span>Cobrar</span>
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>
          </div>
        </div>
      )}

      <div className={`grid ${cajaStatGridCols} gap-2 w-full shrink-0 pt-1`}>
        {showReservasStatCard && (
        <button
          type="button"
          onClick={() => openCajaView('reservas')}
          className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem] hover:border-indigo-300"
        >
          <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center shrink-0">
            <MdReceipt className="text-indigo-600 text-xl" />
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs leading-tight ui-text-muted">Reservas</p>
            <p className="text-base font-bold text-indigo-700 leading-tight tabular-nums">{reservationQueue.length}</p>
          </div>
        </button>
        )}
        <div className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem]">
          <div className="w-10 h-10 bg-sky-100 rounded-lg flex items-center justify-center shrink-0">
            <MdTableRestaurant className="text-sky-600 text-xl" />
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs leading-tight ui-text-muted">Total Mesas</p>
            <p className="text-base font-bold leading-tight tabular-nums">{mesaPhysicalTables.length}</p>
          </div>
        </div>
        <div className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem]">
          <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center shrink-0">
            <MdPeople className="text-red-600 text-xl" />
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs leading-tight ui-text-muted">Ocupadas</p>
            <p className="text-base font-bold text-red-600 leading-tight tabular-nums">{occupiedTables.length}</p>
          </div>
        </div>
        <div className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem]">
          <div className="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center shrink-0">
            <MdCheckCircle className="text-emerald-600 text-xl" />
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs leading-tight ui-text-muted">Disponibles</p>
            <p className="text-base font-bold text-emerald-600 leading-tight tabular-nums">{mesaPhysicalTables.length - occupiedTables.length}</p>
          </div>
        </div>
        <div className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem]">
          <div className="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center shrink-0">
            <MdAttachMoney className="text-emerald-600 text-xl" />
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs leading-tight text-emerald-600">Ventas del turno</p>
            <p className="text-base font-bold text-emerald-700 leading-tight tabular-nums">{formatCurrency(registerSales)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void prepareClose()}
          disabled={!register || preparingCloseModal}
          className="card flex flex-row items-center gap-2.5 px-3 py-2.5 min-h-[3.75rem] hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center shrink-0">
            {preparingCloseModal ? (
              <span className="animate-spin w-5 h-5 border-2 border-red-600 border-t-transparent rounded-full" />
            ) : (
              <MdClose className="text-red-600 text-xl" />
            )}
          </div>
          <p className="text-base font-bold text-red-700 leading-tight">
            {preparingCloseModal ? 'Preparando cierre…' : 'Cerrar Caja'}
          </p>
        </button>
      </div>
        </>
        )
        ) : (
          renderOpenRegisterScreen()
        )
      )}

      {activeCajaOption === 'reservas' && (
        <div className="card">
          {!register ? cajaRequiresRegisterNotice : null}
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold rf-section-title">Reservas para cobro</h3>
            <span className="text-xs ui-text-muted">Total: {reservationQueue.length}</span>
          </div>
          {reservationQueue.length === 0 ? (
            <p className="ui-text-muted">No hay reservas pendientes.</p>
          ) : (
            <div className="space-y-3">
              {reservationQueue.map((entry) => (
                <div key={entry.reservation.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold rf-section-title">{entry.reservation.client_name}</p>
                      <p className="text-xs ui-text-muted">{formatDate(entry.reservation.date)} · {entry.reservation.time} · {entry.reservation.guests} comensales</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs ui-text-muted">Total pedido</p>
                      <p className="font-bold text-emerald-700">{formatCurrency(entry.total)}</p>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-[var(--ui-muted)]">
                    {entry.reservation.notes || 'Sin nota adicional'}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={() => chargeReservation(entry)}
                      disabled={!register || !entry.linkedOrders.length}
                      className="btn-cobrar disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {entry.linkedOrders.length ? 'Cobrar reserva' : 'Sin pedido para cobrar'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeCajaOption === 'apertura_cierre' && (
        register ? (
          <div className="card">
            <h3 className="font-bold rf-section-title mb-4">Apertura y cierre</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div className="rf-surface-light rounded-lg p-3">
                <p className="text-xs ui-text-muted">Apertura</p>
                {isMasterAdmin && openingEdit != null ? (
                  <div className="mt-1 space-y-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      className="input-field"
                      value={openingEdit}
                      onChange={(e) => setOpeningEdit(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveOpeningAmount();
                        if (e.key === 'Escape') setOpeningEdit(null);
                      }}
                      disabled={savingOpening}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button type="button" className="btn-primary text-sm" onClick={() => void saveOpeningAmount()} disabled={savingOpening}>
                        {savingOpening ? 'Guardando…' : 'Guardar'}
                      </button>
                      <button type="button" className="btn-secondary text-sm" onClick={() => setOpeningEdit(null)} disabled={savingOpening}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-bold">{formatCurrency(openingAmt)}</p>
                    {isMasterAdmin ? (
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1"
                        onClick={() => setOpeningEdit(String(Number(openingAmt || 0)))}
                      >
                        Editar
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="rf-surface-light rounded-lg p-3"><p className="text-xs ui-text-muted">Efectivo esperado</p><p className="font-bold">{formatCurrency(expectedRounded)}</p></div>
              <div className="rf-surface-light rounded-lg p-3"><p className="text-xs ui-text-muted">Ventas del turno</p><p className="font-bold">{formatCurrency(registerSales)}</p></div>
            </div>
            <button
              type="button"
              onClick={() => void prepareClose()}
              disabled={preparingCloseModal}
              className="btn-primary flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {preparingCloseModal ? (
                <>
                  <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                  Preparando cierre…
                </>
              ) : (
                'Ir al cierre de caja'
              )}
            </button>
          </div>
        ) : (
          renderOpenRegisterScreen()
        )
      )}

      {activeCajaOption === 'cierres_caja' && (
        <div className="card">
          <h3 className="font-bold rf-section-title mb-4">Historial de cierres de caja</h3>
          {!registerHistory.length ? (
            <p className="ui-text-muted">No hay cierres registrados.</p>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b"><th className="text-left py-2">Cajero</th><th className="text-left py-2">Apertura</th><th className="text-left py-2">Cierre</th><th className="text-right py-2">Ventas</th></tr></thead>
              <tbody>
                {registerHistory.map(r => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-2">{r.user_name}</td>
                    <td className="py-2">{r.opened_at ? formatPeDateTimeLine(r.opened_at) : '-'}</td>
                    <td className="py-2">{r.closed_at ? formatPeDateTimeLine(r.closed_at) : 'Abierta'}</td>
                    <td className="py-2 text-right font-semibold">{formatCurrency(r.total_sales || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {activeCajaOption === 'ingresos' && (
        <div className="card">
          <h3 className="font-bold rf-section-title mb-4">Ingresos</h3>
          {!register ? cajaRequiresRegisterNotice : null}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <input className="input-field" type="number" min="0" step="0.01" placeholder="Monto" value={movementForm.amount} onChange={e => setMovementForm({ ...movementForm, amount: e.target.value })} disabled={!register} />
            <input className="input-field md:col-span-2" placeholder="Concepto" value={movementForm.concept} onChange={e => setMovementForm({ ...movementForm, concept: e.target.value })} disabled={!register} />
          </div>
          <button onClick={() => registerMovement('income')} disabled={!register} className="btn-primary mb-4 disabled:opacity-50 disabled:cursor-not-allowed">Registrar ingreso</button>
          <div className="space-y-2">
            {incomes.map(m => <div key={m.id} className="text-sm flex justify-between border-b border-slate-100 pb-1"><span>{m.concept || 'Sin concepto'}</span><strong>{formatCurrency(m.amount)}</strong></div>)}
          </div>
        </div>
      )}

      {activeCajaOption === 'egresos' && (
        <div className="card">
          <h3 className="font-bold rf-section-title mb-4">Egresos</h3>
          {!register ? cajaRequiresRegisterNotice : null}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <input className="input-field" type="number" min="0" step="0.01" placeholder="Monto" value={movementForm.amount} onChange={e => setMovementForm({ ...movementForm, amount: e.target.value })} disabled={!register} />
            <input className="input-field md:col-span-2" placeholder="Concepto" value={movementForm.concept} onChange={e => setMovementForm({ ...movementForm, concept: e.target.value })} disabled={!register} />
          </div>
          <button onClick={() => registerMovement('expense')} disabled={!register} className="btn-primary mb-4 disabled:opacity-50 disabled:cursor-not-allowed">Registrar egreso</button>
          <div className="space-y-2">
            {expenses.map(m => <div key={m.id} className="text-sm flex justify-between border-b border-slate-100 pb-1"><span>{m.concept || 'Sin concepto'}</span><strong>{formatCurrency(m.amount)}</strong></div>)}
          </div>
        </div>
      )}

      {activeCajaOption === 'impresora' && (
        <div className="card max-w-3xl">
          <h3 className="font-bold rf-section-title mb-4 flex items-center gap-2"><MdPrint /> Configuración de Impresora (Caja)</h3>
          <PrinterModulePanel
            moduleKey="caja"
            showLinkSection
            onConfigLoaded={(cfg) => setPrintingConfig(cfg)}
          />
        </div>
      )}
      {activeCajaOption === 'bar_ajuste' && (
        <div className="card max-w-xl space-y-4">
          <h3 className="font-bold rf-section-title">Bar: quitar comandas sin atender</h3>
          <p className="text-sm ui-text-muted">
            Si está activo, las comandas de bar que no se marquen en preparación se retiran solas después del tiempo indicado.
          </p>
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded"
              checked={barAutoDismiss}
              disabled={barSettingsSaving || !barSettingsLoaded}
              onChange={(e) => void saveBarAutoDismissSettings({ enabled: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">Activar retiro automático</span>
              <span className="block text-xs ui-text-muted mt-1">Afecta solo la pantalla de bar, no elimina el pedido de la mesa.</span>
            </span>
          </label>
          {barAutoDismiss ? (
            <label className="block">
              <span className="block text-sm font-medium mb-1">Minutos sin atender</span>
              <select
                className="input-field"
                value={barAutoDismissMinutes}
                disabled={barSettingsSaving || !barSettingsLoaded}
                onChange={(e) => void saveBarAutoDismissSettings({ minutes: Number(e.target.value) })}
              >
                {BAR_AUTO_DISMISS_MINUTE_OPTIONS.map((mins) => (
                  <option key={mins} value={mins}>{mins} minutos</option>
                ))}
              </select>
            </label>
          ) : null}
          {barSettingsSaving ? <p className="text-xs ui-text-muted">Guardando…</p> : null}
        </div>
      )}
      </div>

      {/* Modal tomar pedido / venta rápida */}
      <Modal
        {...staffOrderModalProps({
          isOpen: showMenu,
          onClose: () => {
            setShowMenu(false);
            setQuickSaleMode(false);
            setEditingOrderId('');
            setEditingSessionOrderIds([]);
            setParaLlevarMesa(false);
            setMesaOrderObservation('');
            setAmountReceived('');
            setMultiPayEnabled(false);
            setMultiPayAmounts(emptyMultiPaymentAmounts());
            setTipPayEnabled(false);
            setCheckoutTipAmount('');
            setCheckoutPaymentNote(''); setPaymentNoteOpen(false);
            resetBillingForm();
            resetCart();
            clearMesaLock();
          },
          title: (() => {
            if (quickSaleMode) return 'Venta rápida';
            if (editingOrderId && selectedTable) {
              if (editingSessionOrderIds.length > 1) {
                const nums = (selectedTable.orders || [])
                  .filter((x) => editingSessionOrderIds.includes(x.id))
                  .map((x) => x.order_number)
                  .filter((n) => n != null);
                const suffix = nums.length ? ` · #${nums.join(', #')}` : '';
                return `Modificar pedidos — ${selectedTable.name || ''}${suffix}`;
              }
              const o = (selectedTable.orders || []).find((x) => x.id === editingOrderId);
              return o
                ? `Modificar pedido #${o.order_number} — ${selectedTable.name || ''}`
                : `Modificar pedido — ${selectedTable.name || ''}`;
            }
            return `Agregar Pedido — ${getMesaLock()?.name || selectedTable?.name || ''}`;
          })(),
        })}
      >
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {quickSaleMode ? (
        <StaffDineInOrderUI
          fillParentHeight
          search={search}
          onSearchChange={setSearch}
          selectedCat={selectedCat}
          onSelectedCatChange={setSelectedCat}
          categories={categories}
          filteredProducts={filteredProducts}
          onProductPick={addToCart}
          cart={cart}
          noteEditorLineKey={noteEditorLineKey}
          setNoteEditorLineKey={setNoteEditorLineKey}
          updateQty={updateQty}
          removeFromCart={removeFromCart}
          updateItemNote={updateItemNote}
          cartTotal={cartTotal}
          formatCurrency={formatCurrency}
          className="min-h-0 flex-1"
          showOrderObservation={false}
          footer={
            cart.length > 0 ? (
              <>
                <div className="flex justify-between font-bold text-lg text-[var(--ui-body-text)]">
                  <span>Total</span>
                  <span className="text-[var(--ui-accent-muted)]">{formatCurrency(cartTotal)}</span>
                </div>
                {quickSaleMode && (
                  <p className="text-[11px] text-[var(--ui-muted)]">
                    Al continuar se abre el cobro de caja: descuento, cortesía, dividir cuenta, pagos y comprobante.
                  </p>
                )}
                <button
                  type="button"
                  onClick={submitOrder}
                  className={`w-full py-3 flex items-center justify-center gap-2 text-base ${
                    quickSaleMode ? 'btn-cobrar' : 'btn-primary'
                  }`}
                >
                  <MdReceipt /> {quickSaleMode ? 'Cobrar venta rápida' : editingOrderId ? 'Guardar cambios' : 'Enviar Pedido'}
                </button>
              </>
            ) : null
          }
        />
        ) : selectedTable ? (
          <div className="flex h-full min-h-0 flex-1 gap-2 overflow-hidden lg:flex-row lg:items-stretch">
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:max-w-[min(100%,28rem)]">
              <StaffDineInOrderUI
                externalCartAside
                fillParentHeight
                search={search}
                onSearchChange={setSearch}
                selectedCat={selectedCat}
                onSelectedCatChange={setSelectedCat}
                categories={categories}
                filteredProducts={filteredProducts}
                onProductPick={addToCart}
                cart={cart}
                noteEditorLineKey={noteEditorLineKey}
                setNoteEditorLineKey={setNoteEditorLineKey}
                updateQty={editingOrderId ? guardedUpdateQty : updateQty}
                removeFromCart={editingOrderId ? guardedRemoveFromCart : removeFromCart}
                updateItemNote={updateItemNote}
                cartTotal={cartTotal}
                formatCurrency={formatCurrency}
                className="h-full min-h-0 flex-1"
                orderBadge={mesaOrderBadge}
                orderObservation={mesaOrderObservation}
                onOrderObservationChange={setMesaOrderObservation}
                showLineDeleteLabel={Boolean(editingOrderId && posCanDeleteRelease)}
                canDeleteLine={!editingOrderId || posCanDeleteRelease}
                footer={
                  editingOrderId ? (
                    cart.length > 0 ? (
                      mesaOrderSubmitFooter('Guardar cambios')
                    ) : (
                      <button
                        type="button"
                        onClick={() => void liberarMesaDesdeEdicionPedidoVacio()}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-400/60 bg-amber-950/50 py-3 text-base font-semibold text-amber-100 hover:bg-amber-900/60"
                      >
                        <MdTableRestaurant /> Liberar mesa
                      </button>
                    )
                  ) : cart.length > 0 ? (
                    mesaOrderSubmitFooter('Enviar Pedido')
                  ) : null
                }
              />
            </div>
            <StaffDineInOrderCartPanel
              elevatedAside
              fillParentHeight
              className={`hidden h-full min-h-0 shrink-0 overflow-hidden lg:flex lg:flex-col ${VIEWPORT_CART_MAX_CLASS}`}
              cart={cart}
              cartLayout="lines"
              formatCurrency={formatCurrency}
              noteEditorLineKey={noteEditorLineKey}
              setNoteEditorLineKey={setNoteEditorLineKey}
              updateQty={editingOrderId ? guardedUpdateQty : updateQty}
              removeFromCart={editingOrderId ? guardedRemoveFromCart : removeFromCart}
              updateItemNote={updateItemNote}
              orderBadge={mesaOrderBadge}
              orderObservation={mesaOrderObservation}
              onOrderObservationChange={setMesaOrderObservation}
              showLineDeleteLabel={Boolean(editingOrderId && posCanDeleteRelease)}
              canDeleteLine={!editingOrderId || posCanDeleteRelease}
              footer={
                editingOrderId ? (
                  cart.length > 0 ? (
                    mesaOrderSubmitFooter('Guardar cambios')
                  ) : (
                    <button
                      type="button"
                      onClick={() => void liberarMesaDesdeEdicionPedidoVacio()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-400/60 bg-amber-950/50 py-3 text-base font-semibold text-amber-100 hover:bg-amber-900/60"
                    >
                      <MdTableRestaurant /> Liberar mesa
                    </button>
                  )
                ) : cart.length > 0 ? (
                  mesaOrderSubmitFooter('Enviar Pedido')
                ) : null
              }
            />
          </div>
        ) : (
          <StaffDineInOrderUI
            fillParentHeight
            search={search}
            onSearchChange={setSearch}
            selectedCat={selectedCat}
            onSelectedCatChange={setSelectedCat}
            categories={categories}
            filteredProducts={filteredProducts}
            onProductPick={addToCart}
            cart={cart}
            noteEditorLineKey={noteEditorLineKey}
            setNoteEditorLineKey={setNoteEditorLineKey}
            updateQty={updateQty}
            removeFromCart={removeFromCart}
            updateItemNote={updateItemNote}
            cartTotal={cartTotal}
            formatCurrency={formatCurrency}
            className="min-h-0 flex-1"
            orderObservation={mesaOrderObservation}
            onOrderObservationChange={setMesaOrderObservation}
            footer={mesaOrderSubmitFooter('Enviar Pedido')}
          />
        )}
        </div>
      </Modal>

      <MesaTransferModal
        open={Boolean(mesaTransfer?.mode)}
        onClose={() => setMesaTransfer(null)}
        mode={mesaTransfer?.mode}
        tables={mesaPhysicalTables}
        initialSourceId={mesaTransfer?.sourceId || ''}
        pickSourceAndTarget={Boolean(mesaTransfer?.pickSourceAndTarget)}
        onComplete={() => void loadData()}
      />

      <Modal
        isOpen={Boolean(mesaUnionCheckoutPrompt)}
        onClose={() => {
          setDissolveUnionAfterCheckout(false);
          setMesaUnionCheckoutPrompt(null);
        }}
        title="Mesa unida"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--ui-body-text)]">
            ¿Desunir mesa después del cobro?
          </p>
          {mesaUnionCheckoutPrompt?.union_member_labels?.length > 1 ? (
            <p className="text-xs text-[var(--ui-muted)]">
              Mesas: {mesaUnionCheckoutPrompt.union_member_labels.join(' + ')}
            </p>
          ) : null}
          <p className="text-xs text-[var(--ui-muted)]">
            Si elige <strong>No</strong>, la cuenta seguirá unida para seguir pidiendo. Puede separarlas después con «Desunir mesa».
          </p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => answerMesaUnionCheckoutPrompt(false)}
              className="btn-secondary flex-1"
            >
              No
            </button>
            <button
              type="button"
              onClick={() => answerMesaUnionCheckoutPrompt(true)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg font-semibold text-white bg-violet-600 hover:bg-violet-700"
            >
              Sí, desunir
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(viewOrdersModal?.table)}
        onClose={() => setViewOrdersModal(null)}
        title={(() => {
          const t = viewOrdersModal?.table;
          if (!t) return 'Pedidos';
          const name = String(t.name || '').trim();
          return name || 'Pedidos';
        })()}
        size="md"
      >
        {viewOrdersModal?.table ? (() => {
          const tbl = viewOrdersModal.table;
          const lines = mergedProductsOnTable(tbl, productsById);
          const totalMesa = (tbl.orders || []).reduce((s, o) => s + getOrderChargeTotal(o), 0);
          return (
            <div className="max-h-[min(70vh,480px)] overflow-y-auto space-y-3 pr-1 text-[var(--ui-body-text)]">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ui-muted)]">Productos en la mesa</p>
              {lines.length === 0 ? (
                <p className="text-center text-[var(--ui-muted)] py-6">No hay productos para mostrar.</p>
              ) : (
                <ul className="space-y-1.5 text-sm text-[var(--ui-muted)]">
                  {lines.map((row) => (
                    <li
                      key={row.key}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-2 items-baseline border-b border-[color:var(--ui-border)] pb-1.5 last:border-0 last:pb-0"
                    >
                      <span className="tabular-nums font-semibold text-[var(--ui-body-text)] text-right">
                        {row.qty}
                      </span>
                      <span className="min-w-0 font-medium text-[var(--ui-body-text)] break-words">
                        {row.name}
                      </span>
                      <span className="shrink-0 tabular-nums font-medium text-[var(--ui-accent-muted)]">
                        {formatCurrency(row.subtotal)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {lines.length > 0 && (
                <div className="flex justify-between border-t border-[color:var(--ui-border)] pt-3 text-base font-bold text-[var(--ui-body-text)]">
                  <span>Total</span>
                  <span className="text-[var(--ui-accent-muted)]">{formatCurrency(totalMesa)}</span>
                </div>
              )}
            </div>
          );
        })() : null}
      </Modal>

      <StaffModifierPromptModal
        open={modifierPrompt.open}
        onClose={() => setModifierPrompt({ open: false, product: null, modifier: null, selectedOption: '' })}
        modifierPrompt={modifierPrompt}
        setModifierPrompt={setModifierPrompt}
        onConfirm={confirmModifierForCart}
        onSkipOptional={addProductWithoutOptionalModifier}
      />

      {/* Modal cobro mesa: pedidos o boleta/factura (izq) | cuenta | cobro (mesa arriba del total) */}
      <Modal
        isOpen={showBill}
        onClose={() => {
          if (checkoutBusy) return;
          clientCheckoutOpenedKeyRef.current = '';
          setDissolveUnionAfterCheckout(false);
          setShowBill(false);
          setAmountReceived('');
          setSplitMode(false);
          setSelectedOrderItemIds([]);
          setSelectedOrderItemQtys({});
          setAddToAccountEnabled(false);
          setShowCustomerPickerModal(false);
          resetBillingForm();
        }}
        title={
          selectedTable && isClientCheckoutTable(selectedTable)
            ? 'COBRAR CUENTA CLIENTE'
            : selectedTable && isQuickSaleCheckoutTable(selectedTable)
              ? 'COBRAR VENTA RÁPIDA'
              : selectedTable && isDeliveryCheckoutTable(selectedTable)
                ? 'COBRAR DELIVERY'
                : 'COBRAR MESA'
        }
        size="xl"
        dialogClassName="!max-w-5xl"
        maxHeightClass="max-h-[min(90vh,860px)]"
        bodyClassName="!overflow-hidden !flex !flex-col !min-h-0 !pb-4"
        headerClassName="bg-[var(--ui-surface-2)] border-b border-[color:var(--ui-border)]"
        titleClassName="text-[var(--ui-body-text)] font-extrabold tracking-wide uppercase"
        closeButtonClassName="hover:bg-[var(--ui-sidebar-hover)]"
        closeIconClassName="text-[var(--ui-muted)]"
      >
        {selectedTable && (
          <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden">
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4 overflow-hidden">
                {/* Pedidos o formulario de facturación (reemplazo al activar emitir comprobante) */}
                <div className="flex flex-col min-h-0 min-w-0 overflow-y-auto overscroll-contain scrollbar-thin pr-1">
                  <div className="rounded-xl border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)]/70 backdrop-blur-md shadow-lg shadow-black/20 p-3 sm:p-4 flex flex-col gap-2">
                      {!billingForm.enabled ? (
                        <>
                          <h3 className="text-base font-bold text-[var(--ui-body-text)] shrink-0">Productos</h3>
                          {splitMode ? (
                            <>
                              <div className="rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)]/50 px-2 py-1.5 shrink-0">
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ui-muted)]">
                                  Incluir en cobro (cada línea de producto)
                                </p>
                              </div>
                              <div className="grid grid-cols-[1.75rem_2rem_minmax(0,1fr)_5.75rem_3.75rem_3.75rem] gap-1.5 text-[10px] sm:text-xs font-semibold text-[var(--ui-muted)] border-b border-[color:var(--ui-border)] pb-2 shrink-0 items-center">
                                <span className="sr-only">Incluir</span>
                                <span className="text-center">Ped.</span>
                                <span className="col-start-3 col-end-7 sm:col-auto">Producto</span>
                                <span className="col-start-4 sm:col-auto text-center tabular-nums">Cant.</span>
                                <span className="text-right tabular-nums">P. unit.</span>
                                <span className="text-right tabular-nums">Total</span>
                              </div>
                              <div className="space-y-0.5">
                                {splitBillLines.length === 0 ? (
                                  <p className="text-sm text-[var(--ui-muted)] text-center py-6">Sin ítems</p>
                                ) : (
                                  splitBillLines.map((line) => {
                                    const sel = selectedOrderItemIds.includes(line.id);
                                    const maxQ = Math.max(1, Math.floor(Number(line.qty) || 1));
                                    const showQtyStepper = sel && maxQ > 1;
                                    const chargeQty = showQtyStepper
                                      ? resolveSplitChargeQty(
                                          { id: line.id, quantity: maxQ },
                                          selectedOrderItemQtys
                                        )
                                      : maxQ;
                                    const lineTotal = showQtyStepper
                                      ? splitLineChargeSubtotal(
                                          { quantity: maxQ, unit_price: line.unit, subtotal: line.sub },
                                          chargeQty
                                        )
                                      : line.sub;
                                    const discountRowFocus =
                                      discountConfig.active &&
                                      !discountConfig.applied &&
                                      discountConfig.target === 'line' &&
                                      discountConfig.targetOrderItemId === line.id;
                                    return (
                                      <div
                                        key={line.id}
                                        role="presentation"
                                        onClick={() => {
                                          if (discountConfig.active && !discountConfig.applied) {
                                            selectDiscountTargetLine(line.id);
                                          }
                                        }}
                                        className={`grid grid-cols-[1.75rem_2rem_minmax(0,1fr)_5.75rem_3.75rem_3.75rem] gap-1.5 items-center rounded-md border px-1 py-1.5 text-sm transition-colors ${
                                          discountRowFocus
                                            ? 'border-[color:var(--ui-warning)] bg-[color-mix(in_srgb,var(--ui-warning)_18%,var(--ui-surface))] ring-1 ring-[color:var(--ui-warning)]'
                                            : sel
                                              ? 'border-[color:var(--ui-accent)]/80 bg-[var(--ui-sidebar-active-bg)]/25 text-[var(--ui-body-text)]'
                                              : 'border-transparent text-[var(--ui-muted)]'
                                        } ${discountConfig.active && !discountConfig.applied ? 'cursor-pointer' : ''}`}
                                      >
                                        <div onClick={(e) => e.stopPropagation()} className="flex justify-center">
                                          <input
                                            type="checkbox"
                                            checked={sel}
                                            onChange={() => toggleOrderItemSelection(line.id)}
                                            className="rounded border-[color:var(--ui-accent)]"
                                          />
                                        </div>
                                        <span className="text-center text-[10px] font-bold text-[var(--ui-accent-muted)] tabular-nums">
                                          #{line.orderNumber}
                                        </span>
                                        <span className="col-start-3 col-end-7 sm:col-auto min-w-0 break-words leading-snug">{line.name}</span>
                                        {showQtyStepper ? (
                                          <div
                                            onClick={(e) => e.stopPropagation()}
                                            className="col-start-4 sm:col-auto inline-flex items-center justify-center gap-0.5 h-6 mx-auto"
                                          >
                                            <button
                                              type="button"
                                              aria-label="Disminuir cantidad"
                                              disabled={chargeQty <= 1}
                                              onClick={() => setSplitChargeQty(line.id, chargeQty - 1, maxQ)}
                                              className="h-5 w-5 shrink-0 rounded border border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[11px] leading-none font-bold text-[var(--ui-body-text)] disabled:opacity-40 hover:bg-[var(--ui-sidebar-hover)]"
                                            >
                                              −
                                            </button>
                                            <span className="min-w-[1.25rem] text-center tabular-nums text-xs font-semibold text-[var(--ui-body-text)]">
                                              {chargeQty}
                                            </span>
                                            <button
                                              type="button"
                                              aria-label="Aumentar cantidad"
                                              disabled={chargeQty >= maxQ}
                                              onClick={() => setSplitChargeQty(line.id, chargeQty + 1, maxQ)}
                                              className="h-5 w-5 shrink-0 rounded border border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[11px] leading-none font-bold text-[var(--ui-body-text)] disabled:opacity-40 hover:bg-[var(--ui-sidebar-hover)]"
                                            >
                                              +
                                            </button>
                                          </div>
                                        ) : (
                                          <span className="col-start-4 sm:col-auto text-center tabular-nums text-[var(--ui-body-text)]">{line.qty}</span>
                                        )}
                                        <span className="text-right tabular-nums text-[#D1D5DB]">{formatCurrency(line.unit)}</span>
                                        <span className="text-right tabular-nums font-medium text-[var(--ui-body-text)]">{formatCurrency(lineTotal)}</span>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                              <p className="text-[11px] text-[var(--ui-muted)] shrink-0">
                                Desmarca las líneas que no vas a cobrar en esta operación.
                              </p>
                              {discountConfig.applied && (
                                <p className="text-[11px] font-semibold text-[var(--ui-body-text)] shrink-0">
                                  <span className="font-extrabold text-[color:var(--ui-warning-hover)]">Descuento aplicado a:</span> {discountTargetLabel}
                                </p>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_4.25rem_4.25rem] gap-2 text-[10px] sm:text-xs font-semibold text-[var(--ui-muted)] border-b border-[color:var(--ui-border)] pb-2 shrink-0">
                                <span>Producto</span>
                                <span className="text-center tabular-nums">Cant.</span>
                                <span className="text-right tabular-nums">P. unit.</span>
                                <span className="text-right tabular-nums">Total</span>
                              </div>
                              <div className="space-y-2">
                                {billLineItemsGrouped.length === 0 ? (
                                  <p className="text-sm text-[var(--ui-muted)] text-center py-6">Sin ítems</p>
                                ) : (
                                  billLineItemsGrouped.map((row) => (
                                    <div
                                      key={row.key}
                                      className="grid grid-cols-[minmax(0,1fr)_2.75rem_4.25rem_4.25rem] gap-2 text-sm text-[#D1D5DB] py-1.5 border-b border-[#3B82F6]/10 last:border-0"
                                    >
                                      <span className="min-w-0 break-words leading-snug">{row.name}</span>
                                      <span className="text-center tabular-nums text-[var(--ui-body-text)]">{row.qty}</span>
                                      <span className="text-right tabular-nums text-[#D1D5DB]">{formatCurrency(row.unitPrice)}</span>
                                      <span className="text-right tabular-nums font-medium text-[var(--ui-body-text)]">{formatCurrency(row.subtotal)}</span>
                                    </div>
                                  ))
                                )}
                              </div>
                              {discountConfig.applied && (
                                <p className="text-[11px] font-semibold text-[var(--ui-body-text)] shrink-0 pt-1">
                                  <span className="font-extrabold text-[color:var(--ui-warning-hover)]">Descuento aplicado a:</span> {discountTargetLabel}
                                </p>
                              )}
                            </>
                          )}
                        </>
                      ) : (
                        <div className="flex flex-col gap-3">
                          <h3 className="text-base font-bold text-[var(--ui-body-text)] shrink-0">Datos del comprobante</h3>
                          <div className="flex items-center justify-end gap-2 shrink-0 flex-wrap">
                            <button
                              type="button"
                              onClick={() => setShowCustomerPickerModal(true)}
                              className="px-2 py-1 rounded-lg border border-[color:var(--ui-accent)] text-[var(--ui-accent-muted)] text-xs font-medium hover:bg-[#2563EB]/20 flex items-center gap-1 shrink-0"
                            >
                              <MdPeople className="text-sm" />
                              Mis clientes
                            </button>
                            <button
                              type="button"
                              onClick={openCustomerModal}
                              className="px-2 py-1 rounded-lg border border-[color:var(--ui-accent)] text-[var(--ui-accent-muted)] text-xs font-medium hover:bg-[#2563EB]/20 flex items-center gap-1 shrink-0"
                            >
                              <MdPersonAdd className="text-sm" />
                              Agregar cliente
                            </button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <select
                              className="input-field text-sm"
                              value={billingForm.doc_type}
                              onChange={(e) => setBillingForm((prev) => ({ ...prev, doc_type: e.target.value }))}
                            >
                              <option value="boleta">Boleta</option>
                              <option value="factura">Factura</option>
                              <option value="nota_venta">Nota de venta</option>
                            </select>
                            <select
                              className="input-field text-sm"
                              value={billingForm.customer_doc_type}
                              onChange={(e) => setBillingForm((prev) => ({ ...prev, customer_doc_type: e.target.value }))}
                              disabled={billingForm.doc_type === 'factura' || billingForm.doc_type === 'nota_venta'}
                            >
                              <option value="1">DNI</option>
                              <option value="6">RUC</option>
                              <option value="0">Sin documento</option>
                            </select>
                            <div className="sm:col-span-2 rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)]/60 p-2 space-y-1.5">
                              <p className="text-xs font-medium text-[var(--ui-body-text)]">Detalle en el comprobante</p>
                              <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-4 text-xs text-[#D1D5DB]">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name="invoice_lines_mesa"
                                    checked={billingForm.invoice_lines_mode === 'detallado'}
                                    onChange={() => setBillingForm((prev) => ({ ...prev, invoice_lines_mode: 'detallado' }))}
                                    className="border-[color:var(--ui-accent)]"
                                    disabled={billingForm.doc_type === 'nota_venta'}
                                  />
                                  Detallado (cada producto)
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name="invoice_lines_mesa"
                                    checked={billingForm.invoice_lines_mode === 'consumo'}
                                    onChange={() => setBillingForm((prev) => ({ ...prev, invoice_lines_mode: 'consumo' }))}
                                    className="border-[color:var(--ui-accent)]"
                                    disabled={billingForm.doc_type === 'nota_venta'}
                                  />
                                  Por consumo (una línea)
                                </label>
                              </div>
                            </div>
                            <div className="sm:col-span-2 flex gap-2 items-stretch">
                              <input
                                className="input-field text-sm flex-1 min-w-0"
                                placeholder="N° documento"
                                value={billingForm.customer_doc_number}
                                onChange={(e) =>
                                  setBillingForm((prev) => ({ ...prev, customer_doc_number: normalizeDocNumber(e.target.value) }))
                                }
                              />
                              {(billingForm.doc_type !== 'nota_venta' && (billingForm.customer_doc_type === '1' || billingForm.customer_doc_type === '6')) && (
                                <button
                                  type="button"
                                  title={`Consultar nombre o razón social en padrón (requiere PERU_CONSULTAS_TOKEN en el servidor). ${padronQuotaUi.label || ''}`.trim()}
                                  onClick={() => void handleConsultaPadron()}
                                  disabled={consultaPadronLoading || padronQuotaUi.exhausted}
                                  className="shrink-0 px-2.5 py-2 rounded-lg border border-[color:var(--ui-accent)] text-[var(--ui-accent-muted)] text-xs font-medium hover:bg-[#2563EB]/20 flex items-center justify-center gap-1 disabled:opacity-50"
                                >
                                  <MdSearch className="text-lg shrink-0" />
                                  <span className="hidden sm:inline">Padrón</span>
                                </button>
                              )}
                            </div>
                            <div className="sm:col-span-2 space-y-1">
                              <input
                                className="input-field text-sm w-full"
                                placeholder={billingForm.doc_type === 'factura' ? 'Razón social' : 'Nombre cliente'}
                                value={billingForm.customer_name}
                                onChange={(e) => {
                                  setBillingForm((prev) => ({ ...prev, customer_name: e.target.value }));
                                  setSelectedBillingCustomerId('');
                                  setMatchedCustomer(null);
                                }}
                              />
                              {selectedBillingCustomerId ? (
                                <p className="text-[11px] text-emerald-400">
                                  Cliente vinculado a Mi Clientes
                                  {billingForm.customer_name ? `: ${billingForm.customer_name}` : ''}
                                </p>
                              ) : null}
                            </div>
                            <input
                              className="input-field text-sm sm:col-span-2"
                              placeholder="Dirección (opcional)"
                              value={billingForm.customer_address}
                              onChange={(e) => setBillingForm((prev) => ({ ...prev, customer_address: e.target.value }))}
                            />
                            <div className="sm:col-span-2">
                              <label className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">Celular del cliente</label>
                              <input
                                className="input-field text-sm w-full"
                                placeholder=""
                                value={billingForm.customer_phone}
                                onChange={(e) => setBillingForm((prev) => ({ ...prev, customer_phone: e.target.value }))}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              {searchingCustomer && <p className="text-xs text-[var(--ui-muted)]">Buscando cliente en el registro local...</p>}
                              {matchedCustomer && (
                                <p className="text-xs text-emerald-400">Cliente encontrado: {matchedCustomer.name}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {discountConfig.active && !discountConfig.applied && (
                        <div className="p-2.5 rounded-lg border-2 border-[color:var(--ui-warning)] bg-[var(--ui-surface)] space-y-2 shrink-0 shadow-sm">
                          <p className="text-xs font-extrabold text-[var(--ui-body-text)]">Definir descuento</p>
                          <select
                            className="input-field text-sm"
                            value={discountConfig.type}
                            onChange={(e) => setDiscountConfig((prev) => ({ ...prev, type: e.target.value }))}
                          >
                            <option value="amount">Monto fijo (S/)</option>
                            <option value="percent">Porcentaje (%)</option>
                          </select>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="input-field text-sm"
                            placeholder={discountConfig.type === 'percent' ? 'Ej. 10' : 'Ej. 5.00'}
                            value={discountConfig.value}
                            onChange={(e) => setDiscountConfig((prev) => ({ ...prev, value: e.target.value }))}
                          />
                          <input
                            className="input-field text-sm"
                            placeholder="Motivo (obligatorio)"
                            value={discountConfig.reason}
                            onChange={(e) => setDiscountConfig((prev) => ({ ...prev, reason: e.target.value }))}
                          />
                          <div className="rounded-md border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] px-2 py-1.5 space-y-1">
                            <p className="text-[11px] font-medium text-[var(--ui-body-text)]">
                              <span className="font-extrabold text-[color:var(--ui-warning-hover)]">Aplicando a: </span>
                              {discountTargetLabel}
                            </p>
                            {splitMode ? (
                              <p className="text-[10px] font-medium text-[var(--ui-muted)] leading-snug">
                                Pulsa una línea de la lista de productos para descontar solo ese ítem. Por defecto: cuenta
                                completa.
                              </p>
                            ) : (
                              <p className="text-[10px] font-medium text-[var(--ui-muted)] leading-snug">
                                El descuento afecta a toda la cuenta. Activa «Dividir cuentas» para elegir un solo
                                producto.
                              </p>
                            )}
                            {splitMode && (
                              <button
                                type="button"
                                onClick={selectDiscountTargetWhole}
                                className="text-[11px] font-bold text-[color:var(--ui-accent)] hover:underline underline-offset-2"
                              >
                                Volver a cuenta completa
                              </button>
                            )}
                          </div>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <button
                              type="button"
                              onClick={handleDiscountButton}
                              className="flex-1 py-2 rounded-lg bg-[color:var(--ui-warning)] text-white text-xs font-extrabold hover:bg-[color:var(--ui-warning-hover)] shadow-sm"
                            >
                              Aplicar descuento
                            </button>
                            <button
                              type="button"
                              onClick={applyCourtesyDiscount}
                              className="flex-1 py-2 rounded-lg border-2 border-[color:var(--ui-warning-hover)] bg-[var(--ui-surface)] text-[color:var(--ui-warning-hover)] text-xs font-extrabold hover:bg-[color-mix(in_srgb,var(--ui-warning)_14%,var(--ui-surface))]"
                            >
                              Cortesía (requiere motivo)
                            </button>
                            <button
                              type="button"
                              onClick={() => setDiscountConfig({ ...EMPTY_DISCOUNT_CONFIG })}
                              className="px-3 py-2 rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-body-text)] text-xs font-bold shrink-0 hover:bg-[var(--ui-surface-2)]"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                  </div>
                </div>

                {/* Cobro */}
                <div className="flex flex-col min-h-0 min-w-0 overflow-y-auto overscroll-contain scrollbar-thin pr-1 lg:border-l lg:border-[color:var(--ui-border)] lg:pl-4">
                  <div className="rounded-xl border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)]/70 backdrop-blur-md p-3 sm:p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-base font-bold text-[var(--ui-body-text)] shrink-0">Cobro</h3>
                      <p className="text-base sm:text-lg font-extrabold text-[var(--ui-body-text)] tracking-wide text-right leading-tight">
                        {selectedTable ? getTableDisplayLabel(selectedTable) : '—'}
                      </p>
                    </div>
                    <div className="text-right border-b border-[color:var(--ui-border)] pb-3">
                      <p className="text-2xl sm:text-3xl font-bold text-[var(--ui-accent-muted)] tabular-nums">{formatCurrency(payableTotal)}</p>
                      <p className="text-xs text-[var(--ui-muted)] mt-0.5">Total a pagar</p>
                    </div>
                    <div className={addToAccountEnabled ? 'opacity-50 pointer-events-none' : ''}>
                      <label htmlFor="checkout-payment-method" className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">
                        Método de pago
                      </label>
                      <select
                        id="checkout-payment-method"
                        className="input-field w-full"
                        value={multiPayEnabled ? MULTI_PAY_OPTION : paymentMethod}
                        disabled={addToAccountEnabled}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === MULTI_PAY_OPTION) {
                            setMultiPayEnabled(true);
                            return;
                          }
                          setMultiPayEnabled(false);
                          setPaymentMethod(v);
                        }}
                      >
                        {paymentOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                        {multiPaymentOptions.length >= 2 ? <option value={MULTI_PAY_OPTION}>Multimétodo</option> : null}
                      </select>
                      {multiPayEnabled ? (
                        <div className="mt-2 space-y-2 rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface)]/40 p-2">
                          {multiPaymentOptions.map((opt) => (
                            <div key={opt.value} className="flex items-center gap-2">
                              <span className="text-xs text-[var(--ui-body-text)] w-[88px] shrink-0">{opt.label}</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                className="input-field flex-1 text-sm"
                                placeholder="0.00"
                                value={multiPayAmounts[opt.value] ?? ''}
                                onChange={(e) =>
                                  setMultiPayAmounts((prev) => ({ ...prev, [opt.value]: e.target.value }))
                                }
                              />
                            </div>
                          ))}
                          <p className={`text-xs font-extrabold ${multiPayStatusClass(multiPayState)}`}>
                            Suma: {formatCurrency(multiPayState.sum)} · Total {formatCurrency(payableTotal)}
                          </p>
                          {multiPayState.valid && multiPayState.change > 0 ? (
                            <p className="text-xs font-semibold text-[var(--ui-body-text)]">
                              Efectivo recibido {formatCurrency(multiPayState.cashGiven)} · aplicado a la venta {formatCurrency(multiPayState.cashApplied)} · vuelto {formatCurrency(multiPayState.change)}
                            </p>
                          ) : null}
                          {!multiPayState.valid && multiPayState.sum > 0 ? (
                            <p className="text-xs font-semibold text-[color:var(--ui-danger)]">{multiPayState.error}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          key: 'tip',
                          label: 'Propina',
                          active: tipPayEnabled,
                          disabled: addToAccountEnabled,
                          onClick: () => {
                            const on = !tipPayEnabled;
                            setTipPayEnabled(on);
                            if (!on) setCheckoutTipAmount('');
                          },
                        },
                        {
                          key: 'account',
                          label: 'Agregar a cuenta',
                          active: addToAccountEnabled,
                          disabled: false,
                          onClick: () => {
                            const on = !addToAccountEnabled;
                            setAddToAccountEnabled(on);
                            if (on) {
                              setTipPayEnabled(false);
                              setCheckoutTipAmount('');
                              setBillingForm((prev) => ({ ...prev, enabled: false }));
                            } else {
                              setSelectedBillingCustomerId('');
                              setMatchedCustomer(null);
                              setBillingForm((prev) => ({ ...prev, customer_name: '' }));
                            }
                          },
                        },
                        {
                          key: 'note',
                          label: 'Nota',
                          active: paymentNoteOpen,
                          disabled: false,
                          onClick: () => {
                            const on = !paymentNoteOpen;
                            setPaymentNoteOpen(on);
                            if (!on) setCheckoutPaymentNote('');
                          },
                        },
                      ].map((b) => (
                        <button
                          key={b.key}
                          type="button"
                          onClick={b.onClick}
                          disabled={b.disabled}
                          aria-pressed={b.active}
                          className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            b.active
                              ? 'border-[color:var(--ui-accent)] bg-[color-mix(in_srgb,var(--ui-accent)_14%,var(--ui-surface))] text-[var(--ui-body-text)]'
                              : 'border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-body-text)] hover:bg-[var(--ui-surface-2)]'
                          }`}
                        >
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              b.active ? 'border-[color:var(--ui-accent)] bg-[var(--ui-accent)] text-white' : 'border-[color:var(--ui-border)]'
                            }`}
                          >
                            {b.active ? <span className="text-[10px] leading-none">✓</span> : null}
                          </span>
                          <span className="truncate">{b.label}</span>
                        </button>
                      ))}
                    </div>
                    {tipPayEnabled && !addToAccountEnabled && (
                      <div className="rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface)]/40 p-2">
                        <label htmlFor="checkout-tip-amount" className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">Monto propina</label>
                        <input
                          id="checkout-tip-amount"
                          type="number"
                          min="0"
                          step="0.01"
                          className="input-field w-full text-sm"
                          placeholder="0.00"
                          value={checkoutTipAmount}
                          onChange={(e) => setCheckoutTipAmount(e.target.value)}
                        />
                      </div>
                    )}
                    {paymentNoteOpen && (
                      <div className="rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface)]/40 p-2">
                        <label htmlFor="checkout-payment-note" className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">
                          Nota del pago
                        </label>
                        <textarea
                          id="checkout-payment-note"
                          rows={2}
                          maxLength={300}
                          className="input-field w-full text-sm resize-y"
                          placeholder="Ej.: Yape a nombre de Juan, operación 123456"
                          value={checkoutPaymentNote}
                          onChange={(e) => setCheckoutPaymentNote(e.target.value)}
                        />
                      </div>
                    )}
                    {addToAccountEnabled && (
                      <div className="rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface)]/40 p-2 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-[var(--ui-body-text)]">Cliente</p>
                          <button
                            type="button"
                            onClick={() => setShowCustomerPickerModal(true)}
                            className="px-2 py-1 rounded-lg border border-[color:var(--ui-accent)] text-[var(--ui-accent-muted)] text-xs font-medium hover:bg-[#2563EB]/20 flex items-center gap-1 shrink-0"
                          >
                            <MdPeople className="text-sm" />
                            Mis clientes
                          </button>
                        </div>
                        <input
                          className="input-field text-sm w-full"
                          placeholder="Nombre del cliente"
                          value={billingForm.customer_name}
                          onChange={(e) => {
                            setBillingForm((prev) => ({ ...prev, customer_name: e.target.value }));
                            setSelectedBillingCustomerId('');
                            setMatchedCustomer(null);
                          }}
                        />
                        {selectedBillingCustomerId ? (
                          <p className="text-[11px] text-emerald-400">Vinculado a Mi Clientes</p>
                        ) : null}
                        <p className="text-[11px] text-sky-300/90 leading-snug rounded-lg border border-sky-500/30 bg-sky-950/25 px-2 py-1.5">
                          {resolveBillingCustomerId()
                            ? `Se cargará a la cuenta de ${billingForm.customer_name || 'el cliente'}. Cobre después en Mi Clientes.`
                            : 'Seleccione un cliente con «Mis clientes» para agregar el consumo a su cuenta.'}
                        </p>
                      </div>
                    )}
                    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${addToAccountEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                      <div>
                        <label className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">Paga con</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="input-field w-full"
                          value={amountReceived}
                          onChange={(e) => setAmountReceived(e.target.value)}
                          placeholder="0.00"
                          disabled={multiPayEnabled || paymentMethod !== 'efectivo'}
                        />
                      </div>
                      <div className="flex flex-col justify-center py-0.5 bg-transparent">
                        <p className="text-xs text-[var(--ui-muted)]">Vuelto</p>
                        <p className="text-lg font-extrabold text-[color:var(--ui-success)] tabular-nums">
                          {multiPayEnabled
                            ? formatCurrency(multiPayState.valid ? multiPayState.change : 0)
                            : paymentMethod === 'efectivo'
                              ? formatCurrency(Math.max(0, receivedAmount - payableTotal))
                              : formatCurrency(0)}
                        </p>
                        {!multiPayEnabled && paymentMethod === 'efectivo' && receivedAmount < payableTotal && (
                          <p className="text-sm font-extrabold text-[color:var(--ui-danger)]">Falta: {formatCurrency(payableTotal - receivedAmount)}</p>
                        )}
                      </div>
                    </div>

                    {billingResult && (
                      <div className="text-xs rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-2 py-2 text-emerald-200 flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {billingResult.full_number} · {billingStatusLabel(billingResult.provider_status)}
                        </span>
                        {billingResult.pdf_url && (
                          <button
                            type="button"
                            className="px-2 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
                            onClick={() => window.open(resolveMediaUrl(billingResult.pdf_url), '_blank', 'noopener,noreferrer')}
                          >
                            Ver PDF
                          </button>
                        )}
                      </div>
                    )}

                    <label className={`flex items-start gap-2 text-sm font-medium text-[var(--ui-body-text)] pt-1 border-t border-[color:var(--ui-border)] ${addToAccountEnabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <input
                        type="checkbox"
                        checked={billingForm.enabled}
                        onChange={(e) => setBillingForm((prev) => (e.target.checked
                          ? {
                            ...prev,
                            enabled: true,
                            doc_type: 'nota_venta',
                            customer_doc_type: '0',
                            invoice_lines_mode: 'detallado',
                          }
                          : { ...prev, enabled: false }))}
                        disabled={addToAccountEnabled}
                        className="rounded border-[color:var(--ui-accent)] mt-0.5"
                      />
                      <span>Emitir Comprobante</span>
                    </label>
                  </div>
                </div>
            </div>

            {/* Fijos fuera del scroll: dividir/descuento (izq) + cobrar (der) */}
            <div className="shrink-0 grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4 pt-2 mt-1 border-t border-[color:var(--ui-border)]">
              <div className="flex flex-wrap items-center gap-2 px-0.5">
                <button
                  type="button"
                  onClick={togglePartialSelection}
                  className="px-4 py-2.5 rounded-lg bg-[#1E3A8A] hover:bg-[#1D4ED8] text-white text-sm font-semibold border border-[color:var(--ui-border)] shadow-md shadow-black/20"
                >
                  {splitMode ? 'Cerrar dividir cuentas' : 'Dividir cuentas'}
                </button>
                <button
                  type="button"
                  onClick={handleDiscountButton}
                  className="px-4 py-2.5 rounded-lg bg-[#1E3A8A] hover:bg-[#1D4ED8] text-white text-sm font-semibold border border-[color:var(--ui-border)] shadow-md shadow-black/20"
                >
                  {discountConfig.applied
                    ? 'Anular descuento'
                    : discountConfig.active
                      ? 'Aplicar descuento'
                      : 'Agregar descuento'}
                </button>
                {isQuickSaleCheckoutTable(selectedTable) && (
                  <button
                    type="button"
                    onClick={() => void cancelQuickSale(selectedTable)}
                    disabled={checkoutBusy}
                    className="px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold border border-red-700 shadow-md shadow-black/20 inline-flex items-center gap-1.5 disabled:opacity-60"
                    title="Anular esta venta rápida sin cobrarla"
                  >
                    <MdClose className="text-base" /> Anular venta
                  </button>
                )}
              </div>
              <div className="lg:pl-4 px-0.5">
                <button
                  type="button"
                  onClick={cobrarMesa}
                  disabled={checkoutBusy}
                  className={`btn-cobrar w-full py-3 text-lg sm:text-xl disabled:opacity-80 disabled:cursor-wait ${
                    addToAccountEnabled
                      ? '!bg-gradient-to-r !from-sky-600 !to-sky-700 hover:!from-sky-500 hover:!to-sky-600 !border-sky-700 !shadow-sky-700/25'
                      : ''
                  }`}
                >
                  {checkoutBusy
                    ? (addToAccountEnabled ? 'AGREGANDO...' : 'COBRANDO...')
                    : (addToAccountEnabled
                      ? 'AGREGAR A CUENTA'
                      : isQuickSaleCheckoutTable(selectedTable) ? 'COBRAR VENTA' : 'COBRAR MESA')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <PosCustomerPickerModal
        isOpen={showCustomerPickerModal}
        onClose={() => setShowCustomerPickerModal(false)}
        onSelect={handleCustomerPicked}
      />

      <Modal
        isOpen={showCustomerModal}
        onClose={() => {
          if (savingCustomer) return;
          setShowCustomerModal(false);
        }}
        title="Agregar cliente"
        size="md"
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">Tipo documento</label>
              <select
                className="input-field"
                value={customerForm.doc_type}
                onChange={(e) => setCustomerForm(prev => ({ ...prev, doc_type: e.target.value }))}
              >
                <option value="1">DNI</option>
                <option value="6">RUC</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">N° documento</label>
              <input
                className="input-field"
                value={customerForm.doc_number}
                onChange={(e) => setCustomerForm(prev => ({ ...prev, doc_number: normalizeDocNumber(e.target.value) }))}
                placeholder={customerForm.doc_type === '6' ? '11 dígitos' : '8 dígitos'}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">Nombre / Razón social</label>
            <input
              className="input-field"
              value={customerForm.name}
              onChange={(e) => setCustomerForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder={customerForm.doc_type === '6' ? 'Razón social' : 'Nombre completo'}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">Teléfono (opcional)</label>
              <input
                className="input-field"
                value={customerForm.phone}
                onChange={(e) => setCustomerForm(prev => ({ ...prev, phone: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">Email (opcional)</label>
              <input
                className="input-field"
                type="text"
                name="pos-customer-email"
                autoComplete="off"
                value={customerForm.email}
                onChange={(e) => setCustomerForm(prev => ({ ...prev, email: e.target.value }))}
                onBlur={(e) => setCustomerForm(prev => ({ ...prev, email: normalizeCustomerEmail(e.target.value) }))}
                placeholder="@gmail.com"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ui-muted)] mb-1">Dirección (opcional)</label>
            <input
              className="input-field"
              value={customerForm.address}
              onChange={(e) => setCustomerForm(prev => ({ ...prev, address: e.target.value }))}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowCustomerModal(false)}
              className="btn-secondary flex-1"
              disabled={savingCustomer}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={saveCustomerFromBilling}
              className="btn-primary flex-1"
              disabled={savingCustomer}
            >
              {savingCustomer ? 'Guardando...' : 'Guardar cliente'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal Cerrar Caja / Arqueo */}
      <Modal
        isOpen={showCloseModal}
        onClose={dismissCloseModal}
        title="Arqueo y Cierre de Caja"
        size="xl"
      >
        {preparingCloseModal ? (
          <PosInlineLoading
            title="Preparando datos de cierre…"
            subtitle="Calculando ventas y arqueo del turno"
          />
        ) : closingData ? (
          <div className="text-[var(--ui-body-text)]">
            <div ref={printRef} className="cash-close-print space-y-0.5">
              <h2>ARQUEO DE CAJA</h2>
              <h3>{user?.full_name} — {arqueoHeaderDayLabel}</h3>
              <div className="sep"></div>
              <div className="row">
                <span>Apertura: </span>
                <span className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5 text-right">
                  <span>{arqueoOpeningParts.date}</span>
                  <span className="tabular-nums">{arqueoOpeningParts.time}</span>
                </span>
              </div>
              <div className="row">
                <span>Cierre: </span>
                <span className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5 text-right">
                  <span>{arqueoClosingParts.date}</span>
                  <span className="tabular-nums">{arqueoClosingParts.time}</span>
                </span>
              </div>
              <div className="sep"></div>
              <div className="row bold"><span>MONTO APERTURA</span><span>{formatCurrency(openingAmt)}</span></div>
              <div className="sep"></div>
              {registerPaymentRows.map((row) => (
                <div key={row.value}>
                  <div className="row">
                    <span>Ventas ({row.label})</span>
                    <span>{formatCurrency(row.amount)}</span>
                  </div>
                  {row.tip > 0 && (
                    <div className="row">
                      <span>  + Propina ({row.label})</span>
                      <span>{formatCurrency(row.tip)}</span>
                    </div>
                  )}
                </div>
              ))}
              <div className="sep"></div>
              <div className="row total-row"><span>TOTAL VENTAS</span><span>{formatCurrency(registerSales)}</span></div>
              <div className="row bold"><span>N° de cuentas cobradas</span><span>{closingData.order_count || registerLiveSales.order_count || 0}</span></div>
              {registerSoldProducts.length > 0 && (
                <>
                  <div className="sep"></div>
                  <p className="section-title">Productos vendidos</p>
                  <table className="products-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th className="num">Cant.</th>
                        <th className="num">P. unit.</th>
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registerSoldProducts.map((item) => (
                        <tr key={`${item.product_id}-${item.product_name}`}>
                          <td>{item.product_name}</td>
                          <td className="num">{item.total_qty}</td>
                          <td className="num">{formatCurrency(item.unit_price)}</td>
                          <td className="num">{formatCurrency(item.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <div className="sep"></div>
              {cashTips > 0 && <div className="row"><span>Propinas en efectivo</span><span>{formatCurrency(cashTips)}</span></div>}
              <div className="row"><span>Ingresos de caja</span><span>+{formatCurrency(totalIncome)}</span></div>
              <div className="row"><span>Egresos de caja</span><span>−{formatCurrency(totalExpense)}</span></div>
              {notesCredit > 0 && <div className="row"><span>Notas de crédito</span><span>+{formatCurrency(notesCredit)}</span></div>}
              {notesDebit > 0 && <div className="row"><span>Notas de débito</span><span>−{formatCurrency(notesDebit)}</span></div>}
              <div className="row bold"><span>EFECTIVO ESPERADO</span><span>{formatCurrency(expectedRounded)}</span></div>
              <div className="row"><span className="arqueo-hint">(Apertura + efectivo + propinas en efectivo + ingresos − egresos ± notas de caja)</span></div>
              <div className="sep"></div>
              <div className="row bold"><span>DETALLE ARQUEO</span><span></span></div>
              {denomDefs
                .filter(d => (parseFloat(denominations[d.key]) || 0) > 0)
                .map(d => (
                  <div key={d.key} className="row">
                    <span>{d.label} x {parseFloat(denominations[d.key]) || 0}</span>
                    <span>{formatCurrency((parseFloat(denominations[d.key]) || 0) * d.value)}</span>
                  </div>
                ))}
              <div className="row bold"><span>EFECTIVO CONTADO</span><span>{formatCurrency(closingAmt)}</span></div>
              <div className={`row bold ${difference >= 0 ? 'diff-pos' : 'diff-neg'}`}><span>DIFERENCIA</span><span>{difference > 0 ? '+' : ''}{formatCurrency(difference)}</span></div>
              {nonCashCheckRows.length > 0 && (
                <>
                  <div className="sep"></div>
                  <div className="row bold"><span>{posTerminalEnabled ? 'VERIFICACIÓN POS / QR' : 'VERIFICACIÓN QR'}</span><span></span></div>
                  {nonCashCheckRows.map((r) => (
                    <div key={r.value} className="row">
                      <span>{r.checkLabel}: sist. {formatCurrency(r.expected)}</span>
                      <span>
                        {r.verified
                          ? `${formatCurrency(r.counted)} (${r.difference > 0 ? '+' : ''}${formatCurrency(r.difference)})`
                          : 'sin verificar'}
                      </span>
                    </div>
                  ))}
                  {nonCashTotalPos != null && (
                    <div className="row">
                      <span>Total POS: sist. {formatCurrency(nonCashExpectedTotal)}</span>
                      <span>{formatCurrency(nonCashTotalPos)} ({nonCashTotalPos - nonCashExpectedTotal > 0 ? '+' : ''}{formatCurrency(roundMoneySoles(nonCashTotalPos - nonCashExpectedTotal))})</span>
                    </div>
                  )}
                  <div className="sep"></div>
                  <div className="row bold"><span>TOTAL ESPERADO</span><span>{formatCurrency(grandExpected)}</span></div>
                  <div className="row bold"><span>TOTAL CONTADO</span><span>{formatCurrency(grandCounted)}</span></div>
                  <div className={`row bold ${grandDifference >= 0 ? 'diff-pos' : 'diff-neg'}`}><span>DIFERENCIA TOTAL</span><span>{grandDifference > 0 ? '+' : ''}{formatCurrency(grandDifference)}</span></div>
                </>
              )}
              {closingNotes && <div className="row"><span>OBS:</span><span>{closingNotes}</span></div>}
            </div>

            <div className="mt-4 space-y-4">
              {closeDraftSavedAt ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
                  <span className="text-[var(--ui-body-text)]">
                    Borrador recuperado ({new Date(closeDraftSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
                    Los totales del sistema ya incluyen las ventas hechas después; solo ajuste el billete o moneda que cambió.
                  </span>
                  <button type="button" onClick={discardCloseDraft} className="text-xs font-semibold text-red-600 hover:underline">
                    Descartar borrador
                  </button>
                </div>
              ) : null}
              <div className="flex flex-wrap lg:flex-nowrap gap-3">
                <CloseSummaryCard tone="total" label="Ventas del turno" amount={registerSales} sub="Desde la apertura" />
                {registerPaymentRows.map((row) => (
                  <CloseSummaryCard
                    key={row.value}
                    tone={row.value}
                    label={row.label}
                    amount={row.amount}
                  />
                ))}
              </div>
              <CashCountSection
                denomDefs={denomDefs}
                denominations={denominations}
                onInput={handleDenominationInput}
                onStep={(key, delta) => updateDenomination(key, String(Math.max(0, (parseFloat(denominations[key]) || 0) + delta)))}
                registerFieldRef={(key, el) => { closeFieldRefs.current[key] = el; }}
                onFieldEnter={handleCloseFieldEnter}
                closingAmount={closingAmount}
                onClosingAmountChange={setClosingAmount}
                cashExpected={expectedRounded}
                expectedHint={[
                  `Apertura ${formatCurrency(openingAmt)} + efectivo ${formatCurrency(totalCash)}`,
                  cashTips > 0 ? ` + propinas ${formatCurrency(cashTips)}` : '',
                  totalIncome > 0 ? ` + ingresos ${formatCurrency(totalIncome)}` : '',
                  totalExpense > 0 ? ` − egresos ${formatCurrency(totalExpense)}` : '',
                  notesCredit > 0 ? ` + notas crédito ${formatCurrency(notesCredit)}` : '',
                  notesDebit > 0 ? ` − notas débito ${formatCurrency(notesDebit)}` : '',
                ].join('')}
                difference={difference}
                denominationMismatch={denominationMismatch}
                denomTotal={denomTotalRounded}
              />

              {nonCashCheckRows.length > 0 && (
                <NonCashArqueoSection
                  rows={nonCashCheckRows}
                  counted={nonCashCounted}
                  onCountedChange={(method, value) => setNonCashCounted((prev) => ({ ...prev, [method]: value }))}
                  registerFieldRef={(key, el) => { closeFieldRefs.current[key] = el; }}
                  onFieldEnter={handleCloseFieldEnter}
                  tipRows={registerPaymentRows.filter((row) => row.tip > 0)}
                  cashExpected={expectedRounded}
                  cashCounted={closingAmt}
                  cashCountMissing={closingAmount === ''}
                  grandExpected={grandExpected}
                  grandCounted={grandCounted}
                  grandDifference={grandDifference}
                  pendingRows={nonCashPending}
                  expectedTotal={nonCashExpectedTotal}
                  totalPos={nonCashTotalPos}
                  showPosTotal={posTerminalEnabled}
                  onMarkCorrect={markNonCashCorrect}
                />
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--ui-muted)] mb-1">Observaciones</label>
                <textarea
                  ref={(el) => { closeFieldRefs.current.closingNotes = el; }}
                  value={closingNotes}
                  onChange={e => setClosingNotes(e.target.value)}
                  className="input-field"
                  rows="2"
                  placeholder="Notas sobre el turno, incidencias, etc."
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pt-4 mt-4 border-t border-[color:var(--ui-border)]">
              <button
                type="button"
                onClick={dismissCloseModal}
                disabled={closingRegisterBusy}
                className="btn-secondary flex-1 min-w-[120px] disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={saveCloseDraft}
                disabled={closingRegisterBusy}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm btn-secondary min-w-[160px] disabled:opacity-50"
                title="Guarda el conteo para cobrar a un cliente y retomar el cierre después"
              >
                <MdSave /> Guardar borrador
              </button>
              <button
                type="button"
                onClick={printCloseRegisterManual}
                disabled={closingRegisterBusy}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm btn-secondary min-w-[180px] disabled:opacity-50"
              >
                <MdPrint /> Imprimir cierre de caja
              </button>
              <button
                type="button"
                onClick={closeRegister}
                disabled={closingRegisterBusy}
                className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-70"
              >
                {closingRegisterBusy ? (
                  <>
                    <span className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                    Preparando cierre de caja…
                  </>
                ) : (
                  <>
                    <MdCheckCircle /> Cerrar Caja
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <PosInlineLoading
            title="Preparando datos de cierre…"
            subtitle="Calculando ventas y arqueo del turno"
          />
        )}
      </Modal>

      <Modal
        isOpen={Boolean(mesaRemovalModal)}
        onClose={() => {
          if (!mesaRemovalSubmitting) closeMesaRemovalModal();
        }}
        title={
          mesaRemovalModal?.mode === 'liberar'
            ? 'Liberar mesa — motivo obligatorio'
            : mesaRemovalModal?.mode === 'cancel'
              ? 'Anular pedido — motivo obligatorio'
              : 'Quitar productos — motivo obligatorio'
        }
        size="md"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--ui-muted)]">
            {mesaRemovalModal?.mode === 'liberar'
              ? 'Indique el motivo para anular el pedido y liberar la mesa (obligatorio).'
              : mesaRemovalModal?.mode === 'cancel'
                ? 'Indique el motivo de la anulación (obligatorio). Quedará registrado en ventas y auditoría.'
                : 'Solo se pide motivo al eliminar un producto por completo (botón Eliminar o cantidad a cero). Reducir con +/− no requiere motivo.'}
          </p>
          <div>
            <label htmlFor="mesa-removal-reason" className="block text-xs font-medium text-[var(--ui-body-text)] mb-1">
              Motivo
            </label>
            <textarea
              id="mesa-removal-reason"
              value={mesaRemovalReason}
              onChange={(e) => setMesaRemovalReason(e.target.value)}
              rows={4}
              className="input-field w-full text-sm resize-y min-h-[100px]"
              placeholder="Ej.: Cliente se retiró, error en el pedido, cambio de mesa…"
              disabled={mesaRemovalSubmitting}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={mesaRemovalSubmitting}
              onClick={closeMesaRemovalModal}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
              disabled={mesaRemovalSubmitting}
              onClick={() => void confirmMesaRemovalModal()}
            >
              {mesaRemovalSubmitting ? 'Guardando…' : 'Confirmar'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
