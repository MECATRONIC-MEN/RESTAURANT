const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryAll, queryOne, runSql } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { FINANCIAL_FILTER_SQL, getSalesEventSql, getLocalTodayDateKey, COURTESY_ORDER_WHERE_SQL } = require('../businessRules');
const { getEffectiveFlat } = require('../services/businessConfigService');
const { getControlConfig } = require('../masterAdminService');
const { computeOpenStatus } = require('../services/systemConfigHubService');
const { getOpenRegistersOnActiveStations, listCajasWithIds } = require('../cajaSettings');
const {
  queryRegisterSessionSales,
  queryRegisterSessionSalesBetween,
} = require('../services/registerSessionSales');
const { emitStaffDataUpdate } = require('../socketBroadcast');
const { getSlowMovingProductIds } = require('../services/slowMovingProductsService');
const { getReservationCajaOperationalAlerts } = require('../services/reservationSchedulerService');
const { sqlBusinessNowExpr } = require('../utils/appDateTime');
const {
  getPaidSalesEventSql,
  metricsFromPaidOrdersWhere,
  queryPaidSalesOrders,
  sumSalesAccountsByHour,
  summarizePaymentMethodsByAccount,
  summarizeSalesAccountsByDay,
  summarizeSalesAccountsByMonth,
  countSalesAccounts,
  buildOrderAccountKeyMap,
  queryProductSalesRanking,
} = require('../utils/salesAccountGrouping');
const { INVENTORY_EXPENSE_PURCHASE_DATE_SQL } = require('../utils/inventoryPurchaseDate');
const { sumSalesCogsForRange, sumSalesCogsForMonth, sumSalesCogsSinceDaysAgo } = require('../utils/salesCogs');
const { composeFinanceTotals, sumPeriodPurchasesSplit } = require('../utils/financeInvestmentOperating');
const { getOrderItemsWithProductionArea } = require('../services/orderItemsProductionService');
const { filterKitchenOrdersForStation } = require('../utils/kitchenStationReady');
const { isNonTransformedLowStockSql } = require('../utils/productStockThreshold');
const { KITCHEN_ARRIVAL_ALERT_MIN, KITCHEN_PREP_ALERT_MIN } = require('../constants/kitchenTiming');
const { logRouteError, publicErrorMessage } = require('../utils/routeErrors');

const router = express.Router();
const FINANCIAL_FILTER = FINANCIAL_FILTER_SQL;

/** Solo ítems de inventario (excluye platos de carta con process_type transformado). */
const INVENTORY_PRODUCT_WHERE = "IFNULL(process_type, 'transformed') = 'non_transformed'";

/**
 * Pedido en «listo» que aún debe cerrarse en salón/caja/delivery.
 * Salón/mostrador ya cobrado no cuenta: cocina/bar no lo muestran y no es demora operativa.
 */
const READY_NEEDS_CLOSURE_WHERE = `status = 'ready'
  AND NOT (payment_status = 'paid' AND type IN ('dine_in', 'pickup'))`;

function readBusinessIntelFlat() {
  try {
    return getEffectiveFlat();
  } catch (_) {
    return {};
  }
}

function readDeliveryEnabled() {
  try {
    const row = queryOne('SELECT delivery_enabled FROM restaurants LIMIT 1');
    return Number(row?.delivery_enabled) === 1;
  } catch (_) {
    return true;
  }
}

/** Pedidos que aún aparecen en panel cocina o bar (misma regla que los módulos de producción). */
function countVisibleProductionQueueOrders() {
  const orders = queryAll(
    `SELECT * FROM orders
     WHERE status IN ('pending', 'preparing')
       AND status != 'cancelled'
       AND IFNULL(payment_status, 'pending') != 'paid'`
  );
  if (!orders.length) return 0;
  const visibleIds = new Set();
  const getAreaItems = (orderId) => getOrderItemsWithProductionArea(orderId);
  for (const station of ['cocina', 'bar']) {
    filterKitchenOrdersForStation(orders, station, getAreaItems).forEach(({ order }) => {
      if (order?.id) visibleIds.add(order.id);
    });
  }
  return visibleIds.size;
}

/** Ventas «en vivo»: turno de caja abierto; si no, último turno o día según horario del local. */
function buildLiveSalesPanel(registerOpen) {
  const ps = getPaidSalesEventSql();
  const dayMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_DATE} = ${ps.TODAY}`);
  const dayTotal = dayMetrics.sales;
  const dayCount = dayMetrics.orders;

  let scheduleJson = {};
  try {
    const r = queryOne('SELECT schedule FROM restaurants LIMIT 1');
    scheduleJson = r?.schedule;
  } catch (_) {
    scheduleJson = {};
  }
  const venue = computeOpenStatus(scheduleJson);

  if (registerOpen?.id && registerOpen?.opened_at) {
    const session = queryRegisterSessionSales(registerOpen);
    return {
      mode: 'register_open',
      register_open: true,
      venue_open: venue.is_open,
      venue_reason: venue.reason,
      total: session.total_sales,
      count: session.order_count,
      day_total: dayTotal,
      day_count: dayCount,
      session_opened_at: registerOpen.opened_at,
      label: 'Ventas del turno (caja abierta)',
      subtitle: 'Cobradas desde la apertura del turno activo',
    };
  }

  const lastClosed = queryOne(
    `SELECT id, opened_at, closed_at FROM cash_registers
     WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1`
  );
  let lastSession = { total_sales: 0, order_count: 0 };
  if (lastClosed?.opened_at) {
    lastSession = queryRegisterSessionSalesBetween(
      lastClosed.opened_at,
      lastClosed.closed_at,
      lastClosed.id,
    );
  }

  if (!venue.is_open) {
    return {
      mode: 'venue_closed',
      register_open: false,
      venue_open: false,
      venue_reason: venue.reason,
      venue_hours: venue.hours || null,
      total: dayTotal,
      count: dayCount,
      day_total: dayTotal,
      day_count: dayCount,
      last_session_total: lastSession.total_sales,
      last_session_count: lastSession.order_count,
      last_closed_at: lastClosed?.closed_at || null,
      label: 'Ventas del día',
      subtitle: 'Local fuera de horario · total cobrado hoy (día local)',
    };
  }

  return {
    mode: 'register_closed',
    register_open: false,
    venue_open: true,
    venue_reason: venue.reason,
    total: lastSession.total_sales,
    count: lastSession.order_count,
    day_total: dayTotal,
    day_count: dayCount,
    last_session_total: lastSession.total_sales,
    last_session_count: lastSession.order_count,
    last_closed_at: lastClosed?.closed_at || null,
    label: 'Último turno de caja',
    subtitle: 'Sin caja abierta · cobrado en el último cierre',
  };
}

/**
 * Métricas operativas y alertas en tiempo casi real (mismas tablas que Caja, Mesas, Delivery, inventario, finanzas).
 * Usado por GET /reports/dashboard y GET /reports/operational-alerts (solo admin / maestro).
 * @param {{ role?: string }} [opts]
 */
function buildOperationalIntelligence(opts = {}) {
  const s = getSalesEventSql();
  const role = String(opts.role || '');
  const deliveryEnabled = readDeliveryEnabled();
  const biz = readBusinessIntelFlat();
  const autoAlertsOn = biz.auto_alerts_enabled !== false;
  const masterStockOn = Number(getControlConfig()?.stock_alerts_enabled) !== 0;
  const stockBizAlertsOn = autoAlertsOn && masterStockOn && biz.alert_critical_stock_enabled !== false;
  const marginBizAlertsOn = autoAlertsOn && biz.alert_low_margin_enabled !== false;
  const lossRatioThresholdPct = Math.min(80, Math.max(5, Number(biz.var_tolerance_pct ?? 14)));
  const targetNetMarginPct = Math.min(90, Math.max(1, Number(biz.prof_target_net_margin_pct ?? 12)));
  const slowMovingDays = Math.min(365, Math.max(1, Math.round(Number(biz.auto_slow_moving_days ?? 14))));
  const predHorizonDays = Math.min(180, Math.max(1, Math.round(Number(biz.pred_horizon_days ?? 14))));

  const today = getLocalTodayDateKey();
  const tablesWithActiveOrders = queryOne(
    `SELECT COUNT(DISTINCT TRIM(o.table_number)) as count
     FROM orders o
     WHERE o.status IN ('pending','preparing','ready')
       AND TRIM(IFNULL(o.table_number,'')) != ''
       AND IFNULL(o.type,'dine_in') IN ('dine_in','pickup')`
  );
  const deliveryActive = queryOne(
    `SELECT COUNT(*) as count FROM orders
     WHERE type = 'delivery'
       AND payment_status != 'paid'
       AND status IN ('pending','preparing','ready')`
  );
  const inKitchen = queryOne(`SELECT COUNT(*) as count FROM orders WHERE status = 'preparing'`);
  const openRegisters = getOpenRegistersOnActiveStations();
  const registerOpen = openRegisters[0] || null;
  const allOpenRows = queryAll(
    `SELECT cr.caja_station_id FROM cash_registers cr WHERE cr.closed_at IS NULL`
  );
  const activeStationIds = new Set(listCajasWithIds().filter((c) => c.active).map((c) => c.id));
  const orphanOpens = (allOpenRows || []).filter(
    (r) => !activeStationIds.has(String(r.caja_station_id || '').trim())
  ).length;
  const activeOrders = queryOne(
    `SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
     OR (${READY_NEEDS_CLOSURE_WHERE})`
  );
  const pendingCount = queryOne(`SELECT COUNT(*) as count FROM orders WHERE status = 'pending'`);
  const readyCount = queryOne(`SELECT COUNT(*) as count FROM orders WHERE ${READY_NEEDS_CLOSURE_WHERE}`);
  const kitchenPrepDelayed = queryOne(
    `SELECT COUNT(*) as count FROM orders
     WHERE status IN ('pending', 'preparing')
       AND (kitchen_release_at IS NULL OR trim(kitchen_release_at) = '' OR datetime(kitchen_release_at) <= ${sqlBusinessNowExpr(queryOne)})
       AND (
         (status = 'pending' AND (julianday('now') - julianday(created_at)) * 24 * 60 > ?)
         OR (status = 'preparing' AND (julianday('now') - julianday(COALESCE(preparing_at, updated_at, created_at))) * 24 * 60 > ?)
       )`,
    [KITCHEN_ARRIVAL_ALERT_MIN, KITCHEN_PREP_ALERT_MIN]
  );
  const staleReady = queryOne(
    `SELECT COUNT(*) as count FROM orders WHERE ${READY_NEEDS_CLOSURE_WHERE}
     AND (julianday('now') - julianday(COALESCE(updated_at, created_at))) * 24 * 60 > 25`
  );
  const lowStock = queryAll(
    `SELECT * FROM products WHERE ${isNonTransformedLowStockSql()} AND is_active = 1 AND ${INVENTORY_PRODUCT_WHERE}
     ORDER BY stock ASC LIMIT 10`
  );
  const lowStockTotal = queryOne(
    `SELECT COUNT(*) as count FROM products
     WHERE ${isNonTransformedLowStockSql()} AND is_active = 1 AND ${INVENTORY_PRODUCT_WHERE}`
  );
  const peakHourToday = queryOne(
    `SELECT ${s.EVENT_HOUR} as hour, COALESCE(SUM(total), 0) as total
     FROM orders
     WHERE ${s.EVENT_DATE} = ${s.TODAY} AND ${FINANCIAL_FILTER}
     GROUP BY ${s.EVENT_HOUR}
     ORDER BY total DESC
     LIMIT 1`
  );
  const barPreparingDistinct = queryOne(
    `SELECT COUNT(DISTINCT o.id) as count
     FROM orders o
     WHERE o.status = 'preparing'
       AND EXISTS (
         SELECT 1 FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = o.id AND IFNULL(p.production_area, 'cocina') = 'bar'
       )`
  );
  const deliveryStaleReady = queryOne(
    `SELECT COUNT(*) as count FROM orders
     WHERE type = 'delivery' AND ${READY_NEEDS_CLOSURE_WHERE}
       AND (julianday('now') - julianday(COALESCE(updated_at, created_at))) * 24 * 60 > 22`
  );
  const outOfStockCount = queryOne(
    `SELECT COUNT(*) as count FROM products
     WHERE is_active = 1 AND IFNULL(stock, 0) <= 0
       AND IFNULL(process_type, 'transformed') = 'non_transformed'`
  );

  let slowMovingData = { product_ids: [], products: [], days: slowMovingDays };
  if (autoAlertsOn) {
    try {
      slowMovingData = getSlowMovingProductIds();
    } catch (err) {
      console.warn('[reports] slow moving products:', err.message || err);
    }
  }
  const slowMovingCount = { count: slowMovingData.product_ids.length };

  let visibleProductionQueue = 0;
  try {
    visibleProductionQueue = countVisibleProductionQueueOrders();
  } catch (err) {
    console.warn('[reports] visible production queue:', err.message || err);
  }

  const operationalAlerts = [];
  const lowN = Number(lowStockTotal?.count || lowStock?.length || 0);
  if (stockBizAlertsOn && lowN > 0) {
    operationalAlerts.push({
      id: 'stock',
      severity: lowN >= 5 ? 'warning' : 'info',
      title: 'Stock bajo',
      message: `${lowN} producto(s) con stock ≤ 10`,
      linkTo: '/admin/productos?stock=bajo',
      linkLabel: 'Ir a productos',
    });
  }
  const oosN = Number(outOfStockCount?.count || 0);
  if (stockBizAlertsOn && oosN > 0) {
    operationalAlerts.push({
      id: 'stock_agotado',
      severity: oosN >= 3 ? 'warning' : 'info',
      title: 'Productos agotados',
      message: `${oosN} producto(s) de venta con stock 0 (no transformados).`,
      linkTo: '/admin/productos?stock=agotado',
      linkLabel: 'Ir a productos',
    });
  }
  const slowN = Number(slowMovingCount?.count || 0);
  if (autoAlertsOn && slowN >= 3) {
    operationalAlerts.push({
      id: 'rotacion_lenta',
      severity: slowN >= 12 ? 'warning' : 'info',
      title: 'Productos con ventas detenidas',
      message: `${slowN} producto(s) con stock y sin ventas cobradas en los últimos ${slowMovingDays} días.`,
      linkTo: '/admin/productos?sin_ventas=1',
      linkLabel: 'Revisar carta / productos',
    });
  }

  const delN = deliveryEnabled ? Number(deliveryActive?.count || 0) : 0;
  if (deliveryEnabled && delN > 0) {
    operationalAlerts.push({
      id: 'delivery',
      severity: 'info',
      title: 'Delivery activo',
      message: `${delN} pedido(s) pendiente(s) de cobro o en curso`,
      linkTo: role === 'delivery' ? '/delivery' : '/admin/delivery',
      linkLabel: role === 'delivery' ? 'Ir a reparto' : 'Ir a delivery',
    });
  }
  const dStale = deliveryEnabled ? Number(deliveryStaleReady?.count || 0) : 0;
  if (deliveryEnabled && dStale > 0) {
    operationalAlerts.push({
      id: 'delivery_listo_demora',
      severity: 'warning',
      title: 'Delivery listo con demora',
      message: `${dStale} pedido(s) en «listo» llevan más de 22 minutos sin marcar entrega.`,
      linkTo: role === 'delivery' ? '/delivery' : '/admin/delivery',
      linkLabel: role === 'delivery' ? 'Ir a reparto' : 'Ir a delivery',
    });
  }
  const prepN = Number(inKitchen?.count || 0);
  if (prepN >= 6) {
    operationalAlerts.push({
      id: 'kitchen_load',
      severity: 'warning',
      title: 'Cocina cargada',
      message: `${prepN} pedidos en preparación (cocina y bar combinados).`,
      linkTo: '/admin/cocina',
      linkLabel: 'Ir a Cocina',
    });
  }
  const barN = Number(barPreparingDistinct?.count || 0);
  if (barN >= 4) {
    operationalAlerts.push({
      id: 'bar_load',
      severity: 'info',
      title: 'Bar con cola',
      message: `${barN} pedido(s) con platos/bebidas de bar aún en preparación.`,
      linkTo: '/admin/bar',
      linkLabel: 'Ir a Bar',
    });
  }
  if (!registerOpen?.id) {
    operationalAlerts.push({
      id: 'caja_cerrada',
      severity: 'warning',
      title: 'Caja cerrada',
      message: 'No hay turno de caja abierto en ninguna caja activa; abra un turno en el módulo Caja para registrar ventas.',
      linkTo: '/admin/caja',
      linkLabel: 'Ir a Caja',
    });
  }
  if (orphanOpens > 0) {
    operationalAlerts.push({
      id: 'caja_huerfana',
      severity: 'warning',
      title: 'Turno de caja sin estación',
      message: `${orphanOpens} turno(s) abierto(s) no están vinculados a una caja activa. Ciérrelos o reábralos desde Caja.`,
      linkTo: '/admin/caja',
      linkLabel: 'Ir a Caja',
    });
  }
  const readyN = Number(readyCount?.count || 0);
  if (readyN >= 5) {
    operationalAlerts.push({
      id: 'ready_backlog',
      severity: 'warning',
      title: 'Pedidos listos sin retirar',
      message: `${readyN} pedido(s) en estado «listo»; revisar salón, bar o entrega.`,
      linkTo: '/admin/mesas',
      linkLabel: 'Ir a Mesas',
    });
  }
  const prepDelayN = Number(kitchenPrepDelayed?.count || 0);
  if (prepDelayN > 0 && visibleProductionQueue > 0) {
    operationalAlerts.push({
      id: 'kitchen_prep_demora',
      severity: 'warning',
      title: 'Demora en cocina / bar',
      message: `${prepDelayN} pedido(s) superan el tiempo en pendiente (>${KITCHEN_ARRIVAL_ALERT_MIN} min) o en preparación (>${KITCHEN_PREP_ALERT_MIN} min).`,
      linkTo: '/admin/cocina',
      linkLabel: 'Ir a Cocina',
    });
  }
  const staleN = Number(staleReady?.count || 0);
  const pendN = Number(pendingCount?.count || 0);
  if (pendN >= 12) {
    operationalAlerts.push({
      id: 'pending_spike',
      severity: 'warning',
      title: 'Cola de pedidos nuevos',
      message: `${pendN} pedido(s) en «pendiente»; revisar cocina o toma de pedidos.`,
      linkTo: '/admin/cocina',
      linkLabel: 'Ir a Cocina',
    });
  }
  const actN = Number(activeOrders?.count || 0);
  if (actN >= 25) {
    operationalAlerts.push({
      id: 'active_high',
      severity: 'info',
      title: 'Alto volumen operativo',
      message: `${actN} pedido(s) activos en el sistema.`,
      linkTo: '/admin/mesas',
      linkLabel: 'Ir a Mesas',
    });
  }

  if (['admin', 'cajero'].includes(role)) {
    const tolerance = getCajaDifferenceToleranceSoles();
    const lastClose = queryOne(
      `SELECT closed_at, arqueo_data FROM cash_registers
       WHERE closed_at IS NOT NULL
         AND datetime(closed_at) >= datetime('now', '-14 days')
       ORDER BY closed_at DESC LIMIT 1`
    );
    if (lastClose?.arqueo_data) {
      const ar = parseArqueoData(lastClose.arqueo_data);
      const diff = Number(ar.difference);
      if (Number.isFinite(diff) && Math.abs(diff) > tolerance) {
        operationalAlerts.push({
          id: 'caja_diferencia',
          severity: Math.abs(diff) > tolerance * 3 ? 'warning' : 'info',
          title: 'Diferencia de caja en el último cierre',
          message: `Último cierre: desvío de S/ ${diff.toFixed(2)} vs esperado (tolerancia S/ ${Number(tolerance).toFixed(2)}).`,
          linkTo: '/admin/caja?view=cierres_caja',
          linkLabel: 'Cierres de caja',
        });
      }
    }

    const billingErr = queryOne(
      `SELECT COUNT(*) as count FROM electronic_documents
       WHERE LOWER(TRIM(IFNULL(provider_status,''))) = 'error'`
    );
    const billN = Number(billingErr?.count || 0);
    if (billN > 0) {
      operationalAlerts.push({
        id: 'billing_errors',
        severity: 'warning',
        title: 'Comprobantes con error',
        message: `${billN} comprobante(s) electrónico(s) en estado error; reintentar o revisar en Informes · Facturación.`,
        linkTo: '/admin/informes?seccion=facturacion',
        linkLabel: 'Abrir facturación',
      });
    }
  }

  if (role === 'admin' || role === 'master_admin') {
    try {
      const fw = financeRolling7dSnapshot();
      if (marginBizAlertsOn) {
        const ratioThreshold = lossRatioThresholdPct / 100;
        if (fw.totalSales >= 400 && fw.lossesCombined > 0) {
          const ratio = fw.lossesCombined / fw.totalSales;
          if (ratio >= ratioThreshold) {
            operationalAlerts.push({
              id: 'gastos_ratio',
              severity: ratio >= ratioThreshold * 1.75 ? 'warning' : 'info',
              title: 'Gastos y pérdidas altos (7 días)',
              message: `Ventas cobradas ~S/ ${fw.totalSales.toFixed(0)} vs salidas ~S/ ${fw.lossesCombined.toFixed(0)} (${(ratio * 100).toFixed(0)}% sobre ventas; umbral ${lossRatioThresholdPct}% en módulo empresarial).`,
              linkTo: '/admin/informes?seccion=finanzas',
              linkLabel: 'Informes · Finanzas',
            });
          }
        }
        if (fw.totalSales >= 500 && fw.approxProfit < 0) {
          operationalAlerts.push({
            id: 'rentabilidad_negativa',
            severity: 'warning',
            title: 'Resultado aproximado negativo (7 días)',
            message: 'Ventas menos compras y pérdidas/gastos de caja dan saldo negativo en la ventana reciente.',
            linkTo: '/admin/informes?seccion=finanzas',
            linkLabel: 'Informes · Finanzas',
          });
        } else if (fw.totalSales >= 400 && fw.approxProfit > 0) {
          const netRat = fw.approxProfit / fw.totalSales;
          const targetNet = targetNetMarginPct / 100;
          if (netRat < targetNet) {
            operationalAlerts.push({
              id: 'margen_bajo',
              severity: 'info',
              title: 'Utilidad neta por debajo del objetivo (7 días)',
              message: `Utilidad aproximada ${(100 * netRat).toFixed(1)}% sobre ventas cobradas (objetivo ${targetNetMarginPct}% en módulo empresarial).`,
              linkTo: '/admin/informes?seccion=finanzas',
              linkLabel: 'Informes · Finanzas',
            });
          }
        }
      }
    } catch (err) {
      console.warn('[reports] finance rolling 7d alerts:', err.message || err);
    }
  }

  if (['admin', 'cajero'].includes(role)) {
    try {
      const reservationAlerts = getReservationCajaOperationalAlerts();
      reservationAlerts.forEach((alert) => operationalAlerts.push(alert));
    } catch (err) {
      console.warn('[reports] reservation caja alerts:', err.message || err);
    }
  }

  let insightToday = '';
  const ph = peakHourToday?.hour != null ? String(peakHourToday.hour).padStart(2, '0') : '';
  if (ph && Number(peakHourToday?.total || 0) > 0) {
    insightToday = `Mayor facturación hoy entre las ${ph}:00 y ${ph}:59 (ventas cobradas).`;
  }

  const summary = {
    date: today,
    tablesWithActiveOrders: Number(tablesWithActiveOrders?.count || 0),
    deliveryActiveCount: deliveryEnabled ? Number(deliveryActive?.count || 0) : null,
    inKitchenCount: Number(inKitchen?.count || 0),
    activeOrders: actN,
    pendingCount: pendN,
    readyCount: readyN,
    staleReadyCount: staleN,
    lowStockCount: lowN,
    outOfStockCount: oosN,
    barPreparingCount: barN,
    deliveryStaleReadyCount: dStale,
    registerOpen: !!registerOpen?.id,
    slowMovingCount: slowN,
    deliveryEnabled,
  };

  const dashPreset = String(biz.dash_kpi_preset || 'basic').trim();
  const allowedPresets = new Set(['basic', 'operations', 'finance']);
  const dashKpiPreset = allowedPresets.has(dashPreset) ? dashPreset : 'basic';

  return {
    operationalAlerts,
    summary,
    insightToday,
    lowStock,
    registerOpen: registerOpen
      ? {
          id: registerOpen.id,
          opened_at: registerOpen.opened_at,
          user_id: registerOpen.user_id,
          user_name: registerOpen.user_name,
          caja_station_id: registerOpen.caja_station_id,
          station_name: registerOpen.station_name,
        }
      : null,
    openRegisters,
    tablesWithActiveOrders: summary.tablesWithActiveOrders,
    deliveryActiveCount: summary.deliveryActiveCount,
    inKitchenCount: summary.inKitchenCount,
    deliveryEnabled,
    generated_at: new Date().toISOString(),
    businessIntel: {
      dash_kpi_preset: dashKpiPreset,
      pred_horizon_days: predHorizonDays,
      auto_alerts_enabled: autoAlertsOn,
      alert_critical_stock_enabled: stockBizAlertsOn,
      alert_low_margin_enabled: marginBizAlertsOn,
      auto_slow_moving_days: slowMovingDays,
      loss_ratio_threshold_pct: lossRatioThresholdPct,
      target_net_margin_pct: targetNetMarginPct,
      show_stock_alert_panel: autoAlertsOn && masterStockOn && biz.alert_critical_stock_enabled !== false,
    },
  };
}

function parseArqueoData(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function parsePagosSistemaSettings() {
  const row = queryOne('SELECT value FROM app_settings WHERE key = ?', ['pagos_sistema']);
  try {
    return row?.value ? JSON.parse(row.value) : {};
  } catch (_) {
    return {};
  }
}

function getCajaDifferenceToleranceSoles() {
  const p = parsePagosSistemaSettings();
  const t = Number(p.tolerancia_diferencia_caja);
  if (Number.isFinite(t) && t >= 0) return t;
  return 2;
}

/** Ventas y costos aproximados últimos 7 días (alineado con la lógica de finance-overview). */
function financeRolling7dSnapshot() {
  const s = getSalesEventSql();
  const dateSales = s.EVENT_DATE;
  const salesRow = queryOne(
    `SELECT COALESCE(SUM(total), 0) as total_sales FROM orders WHERE ${FINANCIAL_FILTER} AND ${dateSales} >= date(${s.TODAY}, '-6 days')`
  );
  const cashExpensesRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements
     WHERE type = 'expense' AND date(datetime(created_at, '-05:00')) >= date(${s.TODAY}, '-6 days')`
  );
  const lossEventsRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM finance_loss_events
     WHERE date(datetime(occurred_at, '-05:00')) >= date(${s.TODAY}, '-6 days')`
  );
  const purchasesRow = queryOne(
    `SELECT COALESCE(SUM(total_cost), 0) as total FROM inventory_expenses
     WHERE ${INVENTORY_EXPENSE_PURCHASE_DATE_SQL} >= date(${s.TODAY}, '-6 days')`
  );
  const cogs = sumSalesCogsSinceDaysAgo(6);
  const payrollRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM investment_movements
     WHERE date(datetime(created_at, '-05:00')) >= date(${s.TODAY}, '-6 days')`
  );
  const totalSales = Number(salesRow?.total_sales || 0);
  const cashExpenses = Number(cashExpensesRow?.total || 0);
  const lossEventsTotal = Number(lossEventsRow?.total || 0);
  const totalPurchases = Number(purchasesRow?.total || 0);
  const payrollTotal = Number(payrollRow?.total || 0);
  const lossesCombined = lossEventsTotal + cashExpenses;
  const composed = composeFinanceTotals({
    purchases: totalPurchases,
    productCogs: cogs.purchase_cogs,
    kardexCogs: cogs.kardex_cogs,
    lossEvents: lossEventsTotal,
    cashExpenses,
    payroll: payrollTotal,
  });
  const operatingExpenses = composed.operating_expenses;
  const approxProfit = totalSales - operatingExpenses;
  return {
    totalSales,
    lossesCombined,
    approxProfit,
    totalPurchases,
    payrollTotal,
    operatingExpenses,
    investmentTotal: composed.investment_total,
    kardexCogs: cogs.kardex_cogs,
    productCogs: cogs.purchase_cogs,
  };
}

/** Mes calendario en curso: ventas cobradas, compras, salidas y utilidad aprox. (base Informes · Finanzas). */
function financeMonthToDateSnapshot() {
  const ps = getPaidSalesEventSql();
  const monthMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_MONTH} = ${ps.MONTH}`);
  const s = getSalesEventSql();
  const purchasesRow = queryOne(
    `SELECT COALESCE(SUM(total_cost), 0) as total FROM inventory_expenses
     WHERE strftime('%Y-%m', ${INVENTORY_EXPENSE_PURCHASE_DATE_SQL}) = ${s.MONTH}`
  );
  const cogs = sumSalesCogsForMonth();
  const cashExpensesRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements
     WHERE type = 'expense' AND strftime('%Y-%m', datetime(created_at, '-05:00')) = ${s.MONTH}`
  );
  const lossEventsRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM finance_loss_events
     WHERE strftime('%Y-%m', datetime(occurred_at, '-05:00')) = ${s.MONTH}`
  );
  const payrollRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM investment_movements
     WHERE strftime('%Y-%m', datetime(created_at, '-05:00')) = ${s.MONTH}`
  );
  const ymRow = { ym: s.MONTH.replace(/'/g, '') };
  const totalSales = Number(monthMetrics.sales || 0);
  const totalPurchases = Number(purchasesRow?.total || 0);
  const totalProductCogs = Number(cogs.purchase_cogs || 0);
  const totalKardexCogs = Number(cogs.kardex_cogs || 0);
  const cashExpenses = Number(cashExpensesRow?.total || 0);
  const lossEventsTotal = Number(lossEventsRow?.total || 0);
  const payrollTotal = Number(payrollRow?.total || 0);
  const lossesCombined = lossEventsTotal + cashExpenses;
  const composed = composeFinanceTotals({
    purchases: totalPurchases,
    productCogs: totalProductCogs,
    kardexCogs: totalKardexCogs,
    lossEvents: lossEventsTotal,
    cashExpenses,
    payroll: payrollTotal,
  });
  const investmentTotal = composed.investment_total;
  const operatingExpenses = composed.operating_expenses;
  const approxGrossMargin = totalSales - composed.cogs_total;
  const approxProfit = totalSales - operatingExpenses;
  return {
    month_key: String(ymRow?.ym || ''),
    sales_total: totalSales,
    orders_count: Number(monthMetrics.orders || 0),
    purchases_total: totalPurchases,
    product_cogs_total: totalProductCogs,
    kardex_cogs_total: totalKardexCogs,
    payroll_total: payrollTotal,
    investment_total: investmentTotal,
    operating_expenses: operatingExpenses,
    loss_events_total: lossEventsTotal,
    cash_expenses_total: cashExpenses,
    losses_combined_total: lossesCombined,
    approx_gross_margin: approxGrossMargin,
    approx_profit: approxProfit,
  };
}

router.get('/dashboard', authenticateToken, requireRole('admin', 'cajero', 'master_admin'), (req, res) => {
  try {
    const ps = getPaidSalesEventSql();
    const todayMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_DATE} = ${ps.TODAY}`);
    const monthMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_MONTH} = ${ps.MONTH}`);
    const todaySales = { count: todayMetrics.orders, total: todayMetrics.sales };
    const monthSales = { count: monthMetrics.orders, total: monthMetrics.sales };
    const topProducts = queryAll(`SELECT oi.product_name, SUM(oi.quantity) as total_sold, SUM(oi.subtotal) as total_revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' AND o.payment_status = 'paid' AND IFNULL(o.payment_method, '') != 'cortesia' AND ${ps.ORDER_MONTH} = ${ps.MONTH} GROUP BY oi.product_name ORDER BY total_sold DESC LIMIT 10`);
    const recentOrders = queryAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10');
    recentOrders.forEach(o => { o.items = queryAll('SELECT * FROM order_items WHERE order_id = ?', [o.id]); });
    const paymentMethods = summarizePaymentMethodsByAccount(
      queryPaidSalesOrders(`${ps.EVENT_DATE} = ${ps.TODAY}`)
    ).map((row) => ({
      payment_method: row.payment_method,
      count: row.count,
      total: row.total,
    }));

    const op = buildOperationalIntelligence({ role: req.user?.role });
    let financeMonth = null;
    try {
      financeMonth = financeMonthToDateSnapshot();
    } catch (err) {
      console.warn('[reports] financeMonthToDateSnapshot:', err.message || err);
    }
    let liveSales = null;
    try {
      liveSales = buildLiveSalesPanel(op.registerOpen);
    } catch (err) {
      console.warn('[reports] buildLiveSalesPanel:', err.message || err);
    }
    const liveSalesByRegister = (op.openRegisters || []).map((reg) => {
      let total = 0;
      let count = 0;
      try {
        const session = queryRegisterSessionSales(reg);
        total = Number(session.total_sales || 0);
        count = Number(session.order_count || 0);
      } catch (err) {
        console.warn('[reports] ventas del turno en vivo:', err.message || err);
      }
      return {
        register_id: reg.id,
        caja_station_id: String(reg.caja_station_id || '').trim(),
        station_name: reg.station_name || 'Caja',
        user_name: reg.user_name || '',
        opened_at: reg.opened_at,
        register_open: true,
        total,
        count,
      };
    });

    res.json({
      today: todaySales,
      liveSales,
      liveSalesByRegister,
      month: monthSales,
      activeOrders: op.summary.activeOrders,
      topProducts,
      recentOrders,
      lowStock: op.lowStock,
      lowStockCount: Number(op.summary?.lowStockCount || 0),
      paymentMethods,
      tablesWithActiveOrders: op.tablesWithActiveOrders,
      deliveryActiveCount: op.deliveryActiveCount,
      inKitchenCount: op.inKitchenCount,
      registerOpen: op.summary.registerOpen,
      openRegisters: op.openRegisters || [],
      registerOpenSummary: op.registerOpen,
      operationalAlerts: op.operationalAlerts,
      operationalSummary: op.summary,
      insightToday: op.insightToday,
      generated_at: op.generated_at,
      financeMonth,
      businessIntel: op.businessIntel,
      deliveryEnabled: op.deliveryEnabled,
    });
  } catch (err) {
    console.error('[reports] GET /dashboard:', err.message || err);
    res.status(500).json({ error: 'No se pudo cargar el monitoreo en vivo' });
  }
});

router.get('/operational-alerts', authenticateToken, requireRole('admin', 'cajero', 'master_admin'), (req, res) => {
  try {
    const op = buildOperationalIntelligence({ role: req.user?.role });
    res.json({
      alerts: op.operationalAlerts,
      summary: op.summary,
      insightToday: op.insightToday,
      generated_at: op.generated_at,
      businessIntel: op.businessIntel,
      deliveryEnabled: op.deliveryEnabled,
      openRegisters: op.openRegisters || [],
      registerOpen: op.registerOpen || null,
      tablesWithActiveOrders: op.tablesWithActiveOrders,
      deliveryActiveCount: op.deliveryActiveCount,
      inKitchenCount: op.inKitchenCount,
      lowStockCount: Number(op.summary?.lowStockCount || 0),
    });
  } catch (err) {
    console.error('[reports] GET /operational-alerts:', err.message || err);
    res.status(500).json({ error: 'No se pudo cargar alertas operativas' });
  }
});

/** Avisos de reserva en caja (toasts POS); no expone el panel Operación completo. */
router.get('/reservation-caja-alerts', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.json({
    alerts: getReservationCajaOperationalAlerts(),
    generated_at: new Date().toISOString(),
  });
});

router.get('/slow-moving-products', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.json(getSlowMovingProductIds());
});

router.get('/daily', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
  const ps = getPaidSalesEventSql();
  const today = getLocalTodayDateKey();
  const dateKey = parseYmd(req.query.date) || today;
  const isToday = dateKey === today;

  const openRegisters = isToday ? getOpenRegistersOnActiveStations() : [];
  const register = openRegisters.length ? openRegisters[openRegisters.length - 1] : null;

  const dayMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_DATE} = date(?)`, [dateKey]);
  const sales = {
    order_count: dayMetrics.orders,
    total_sales: dayMetrics.sales,
    subtotal: dayMetrics.subtotal,
    total_tax: dayMetrics.tax,
    total_discount: dayMetrics.discount,
    total_tips: dayMetrics.tips,
    comanda_count: dayMetrics.comandas,
  };

  const dayPaidOrders = queryPaidSalesOrders(`${ps.EVENT_DATE} = date(?)`, [dateKey]);
  const hourlyMap = sumSalesAccountsByHour(dayPaidOrders);
  const hourly = Object.entries(hourlyMap).map(([hour, data]) => ({
    hour,
    orders: data.accounts,
    total: data.total,
  }));

  const paymentMethods = summarizePaymentMethodsByAccount(dayPaidOrders).map((row) => ({
    payment_method: row.payment_method,
    count: row.count,
    total: row.total,
  }));

  const orders = queryAll(
    `SELECT * FROM orders WHERE ${ps.EVENT_DATE} = date(?) AND NOT ${COURTESY_ORDER_WHERE_SQL} ORDER BY ${ps.EVENT_AT} DESC`,
    [dateKey],
  );
  orders.forEach(o => { o.items = queryAll('SELECT * FROM order_items WHERE order_id = ?', [o.id]); });

  let adjustments = {
    count: 0,
    courtesy_count: 0,
    discount_count: 0,
    courtesy_reference_total: 0,
    discount_amount_total: 0,
    reference_total: 0,
  };
  try {
    const { listSalesAdjustments, summarizeSalesAdjustments } = require('../services/salesAdjustmentsService');
    const adjustmentOrders = listSalesAdjustments({ from: dateKey, to: dateKey, limit: 2000 });
    adjustments = summarizeSalesAdjustments(adjustmentOrders);
  } catch (err) {
    console.warn('[reports/daily] adjustments:', err?.message || err);
  }

  res.json({
    register_open: isToday && openRegisters.length > 0,
    register: isToday ? register : null,
    sales,
    hourly,
    paymentMethods,
    orders,
    adjustments,
    date: dateKey,
    is_today: isToday,
    lifetime_sales: (() => {
      try {
        return require('../services/saleNumberService').currentSaleCount();
      } catch {
        return 0;
      }
    })(),
  });
  } catch (err) {
    logRouteError(req, err, { phase: 'reports_daily' });
    res.status(500).json({ error: publicErrorMessage(err, 'No se pudo cargar el informe de ventas del día') });
  }
});

function parseReportMonth(input) {
  const v = String(input || '').trim();
  return /^\d{4}-\d{2}$/.test(v) ? v : null;
}

function monthRangeEndingAt(monthKey, count = 12) {
  const [y, m] = monthKey.split('-').map(Number);
  const end = new Date(y, (m || 1) - 1, 1);
  const start = new Date(end);
  start.setMonth(start.getMonth() - (count - 1));
  const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { startKey, endKey: monthKey };
}

router.get('/monthly', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
  const ps = getPaidSalesEventSql();
  const { getBusinessMonthKey } = require('../utils/appDateTime');
  const { sqlCoalesceRegisterBusinessDate } = require('../utils/registerBusinessDate');
  const monthKey = parseReportMonth(req.query.month) || getBusinessMonthKey(queryOne);
  const registerBizDate = sqlCoalesceRegisterBusinessDate('cr.business_date', 'cr.opened_at', 'cr.closed_at', queryOne);
  const { querySoldProductsBetween } = require('../services/productSalesReportService');
  const { startKey, endKey } = monthRangeEndingAt(monthKey, 12);

  const closedRegisters = queryAll(
    `SELECT cr.*, u.full_name as user_name
     FROM cash_registers cr
     LEFT JOIN users u ON u.id = cr.user_id
     WHERE cr.closed_at IS NOT NULL
       AND strftime('%Y-%m', ${registerBizDate}) = ?
     ORDER BY cr.closed_at DESC`,
    [monthKey],
  );
  const closedRegistersWithDetails = closedRegisters.map((r) => {
    const sold = querySoldProductsBetween(r.opened_at, r.closed_at, r.id);
    const sold_units_total = sold.reduce((sum, row) => sum + (Number(row.total_qty) || 0), 0);
    return {
      ...r,
      arqueo: parseArqueoData(r.arqueo_data),
      sold_products_count: sold.length,
      sold_units_total,
    };
  });

  const monthOrders = queryPaidSalesOrders(`strftime('%Y-%m', ${ps.EVENT_LOCAL}) = ?`, [monthKey]);
  const dailySales = summarizeSalesAccountsByDay(monthOrders);

  const monthDetalleOrders = queryAll(
    `SELECT * FROM orders
     WHERE strftime('%Y-%m', ${ps.EVENT_LOCAL}) = ?
       AND payment_status = 'paid'
       AND status != 'cancelled'
     ORDER BY ${ps.EVENT_AT} ASC`,
    [monthKey],
  );

  const trendOrders = queryPaidSalesOrders(
    `strftime('%Y-%m', ${ps.EVENT_LOCAL}) >= ? AND strftime('%Y-%m', ${ps.EVENT_LOCAL}) <= ?`,
    [startKey, endKey],
  );
  const monthlySales = summarizeSalesAccountsByMonth(trendOrders);

  const totalMonthMetrics = metricsFromPaidOrdersWhere(`strftime('%Y-%m', ${ps.EVENT_LOCAL}) = ?`, [monthKey]);
  const totalMonth = {
    orders: totalMonthMetrics.orders,
    total: totalMonthMetrics.sales,
    tax: totalMonthMetrics.tax,
    comanda_count: totalMonthMetrics.comandas,
  };
  const closedRegistersMonth = queryOne(
    `SELECT COUNT(*) as count FROM cash_registers cr
     WHERE cr.closed_at IS NOT NULL
       AND strftime('%Y-%m', ${registerBizDate}) = ?`,
    [monthKey],
  );

  res.json({
    month: monthKey,
    closedRegisters: closedRegistersWithDetails,
    closedRegistersMonth: Number(closedRegistersMonth?.count || 0),
    dailySales,
    monthlySales,
    totalMonth,
    orders: monthDetalleOrders,
    lifetime_sales: (() => {
      try {
        return require('../services/saleNumberService').currentSaleCount();
      } catch {
        return 0;
      }
    })(),
  });
  } catch (err) {
    logRouteError(req, err, { phase: 'reports_monthly' });
    res.status(500).json({ error: publicErrorMessage(err, 'No se pudo cargar el informe de ventas del mes') });
  }
});

router.get('/closed-registers', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
    const { querySoldProductsBetween } = require('../services/productSalesReportService');
    const { sqlCoalesceRegisterBusinessDate } = require('../utils/registerBusinessDate');
    const registerBizDate = sqlCoalesceRegisterBusinessDate('cr.business_date', 'cr.opened_at', 'cr.closed_at', queryOne);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const month = parseReportMonth(req.query.month);
    let sql = `
      SELECT cr.*, u.full_name as user_name
      FROM cash_registers cr
      LEFT JOIN users u ON u.id = cr.user_id
      WHERE cr.closed_at IS NOT NULL
    `;
    const params = [];
    if (month) {
      sql += ` AND strftime('%Y-%m', ${registerBizDate}) = ?`;
      params.push(month);
    }
    sql += ` ORDER BY cr.closed_at DESC LIMIT ${limit}`;
    const rows = queryAll(sql, params);
    const enriched = rows.map((r) => {
      const sold = querySoldProductsBetween(r.opened_at, r.closed_at, r.id);
      const sold_units_total = sold.reduce((sum, row) => sum + (Number(row.total_qty) || 0), 0);
      return {
        ...r,
        arqueo: parseArqueoData(r.arqueo_data),
        sold_products_count: sold.length,
        sold_units_total,
      };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo listar cierres de caja' });
  }
});

router.get('/closed-registers/:id', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const register = queryOne(
    "SELECT cr.*, u.full_name as user_name FROM cash_registers cr LEFT JOIN users u ON u.id = cr.user_id WHERE cr.id = ? AND cr.closed_at IS NOT NULL",
    [req.params.id]
  );
  if (!register) return res.status(404).json({ error: 'Cierre de caja no encontrado' });
  register.arqueo = parseArqueoData(register.arqueo_data);
  register.movements = queryAll(
    "SELECT cm.*, u.full_name as user_name FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.register_id = ? ORDER BY cm.created_at ASC",
    [register.id]
  );
  register.notes_list = queryAll(
    "SELECT cn.*, u.full_name as user_name FROM cash_notes cn LEFT JOIN users u ON u.id = cn.user_id WHERE cn.register_id = ? ORDER BY cn.created_at ASC",
    [register.id]
  );
  const sumBy = (rows, key, value) => rows
    .filter((r) => r[key] === value)
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  register.cash_flow = {
    income: Math.round(sumBy(register.movements, 'type', 'income') * 100) / 100,
    expense: Math.round(sumBy(register.movements, 'type', 'expense') * 100) / 100,
    notes_credit: Math.round(sumBy(register.notes_list, 'note_type', 'credit') * 100) / 100,
    notes_debit: Math.round(sumBy(register.notes_list, 'note_type', 'debit') * 100) / 100,
  };
  const { querySoldProductsBetween } = require('../services/productSalesReportService');
  const { queryRegisterSessionOrderRows } = require('../services/registerSessionSales');
  const sold_products = querySoldProductsBetween(
    register.opened_at,
    register.closed_at,
    register.id,
  );
  register.sold_products = sold_products;
  register.product_sales_total = sold_products.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
  register.sales_orders = queryRegisterSessionOrderRows({
    id: register.id,
    opened_at: register.opened_at,
    closed_at: register.closed_at,
  });
  if (register.sales_orders.length > 0) {
    const orderIds = register.sales_orders.map((o) => o.id);
    const placeholders = orderIds.map(() => '?').join(',');
    const orderItems = queryAll(
      `SELECT order_id, product_name, quantity, unit_price, subtotal
       FROM order_items
       WHERE order_id IN (${placeholders})`,
      orderIds
    );
    const itemsByOrder = orderItems.reduce((acc, item) => {
      if (!acc[item.order_id]) acc[item.order_id] = [];
      acc[item.order_id].push(item);
      return acc;
    }, {});
    register.sales_orders = register.sales_orders.map((order) => ({
      ...order,
      sold_at: order.updated_at || order.created_at,
      items: itemsByOrder[order.id] || [],
    }));
  }
  res.json(register);
});

router.get('/product-sales', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
    const { buildProductSalesReport } = require('../services/productSalesReportService');
    const report = buildProductSalesReport(req.query || {});
    if (report.error && report.mode === 'none') {
      return res.status(400).json({ error: report.error });
    }
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo generar informe de productos' });
  }
});

router.get('/ranking', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const ps = getPaidSalesEventSql();
  const { period } = req.query;
  let dateWhere = '1=1';
  const params = [];
  if (period === 'today') dateWhere = `${ps.ORDER_DATE} = ${ps.TODAY}`;
  else if (period === 'week') dateWhere = `${ps.ORDER_DATE} >= date(${ps.TODAY}, '-6 days')`;
  else if (period === 'month') dateWhere = `${ps.ORDER_MONTH} = ${ps.MONTH}`;

  res.json(queryProductSalesRanking(dateWhere, params));
});

router.get('/sales', authenticateToken, requireRole('admin'), (req, res) => {
  const ps = getPaidSalesEventSql();
  const { period, start_date, end_date } = req.query;
  if (period === 'daily') {
    const params = [start_date || null, end_date || null];
    const where = `${ps.EVENT_DATE} BETWEEN COALESCE(?, date(${ps.TODAY}, '-30 days')) AND COALESCE(?, ${ps.TODAY})`;
    const orders = queryPaidSalesOrders(where, params);
    res.json(summarizeSalesAccountsByDay(orders));
  } else {
    const orders = queryPaidSalesOrders('1=1');
    res.json(summarizeSalesAccountsByMonth(orders).slice(0, 12));
  }
});

router.get('/products', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  res.json(queryProductSalesRanking('1=1', []));
});

router.get('/payment-methods', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  const ps = getPaidSalesEventSql();
  const { start_date, end_date } = req.query;
  const params = [start_date || null, end_date || null];
  const where = `${ps.EVENT_DATE} BETWEEN COALESCE(?, date(${ps.TODAY}, '-30 days')) AND COALESCE(?, ${ps.TODAY})`;
  const orders = queryPaidSalesOrders(where, params);
  res.json(summarizePaymentMethodsByAccount(orders));
});

const LOSS_CATEGORIES = new Set(['salida_efectivo', 'gasto_extra', 'merma', 'danio_propiedad', 'reembolso', 'otro']);

function parseYmd(input) {
  const v = String(input || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function defaultFinanceRange() {
  const { getBusinessTodayDateKey } = require('../utils/appDateTime');
  const to = getBusinessTodayDateKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to.slice(0, 8)}01` : to;
  return { from, to };
}

router.get('/finance-overview', authenticateToken, requireRole('admin'), (req, res) => {
  const ps = getPaidSalesEventSql();
  const def = defaultFinanceRange();
  const from = parseYmd(req.query.from) || def.from;
  const to = parseYmd(req.query.to) || def.to;
  const salesMetrics = metricsFromPaidOrdersWhere(`${ps.EVENT_DATE} BETWEEN date(?) AND date(?)`, [from, to]);
  const totalSales = Number(salesMetrics.sales || 0);
  const investmentRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM investment_movements
     WHERE date(datetime(created_at, 'localtime')) BETWEEN date(?) AND date(?)`,
    [from, to]
  );
  const purchaseSplit = sumPeriodPurchasesSplit(from, to);
  const cogs = sumSalesCogsForRange(from, to);
  const cashExpensesRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements
     WHERE type = 'expense'
       AND date(datetime(created_at, 'localtime')) BETWEEN date(?) AND date(?)`,
    [from, to]
  );
  const lossEventsRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as n FROM finance_loss_events
     WHERE date(datetime(occurred_at, 'localtime')) BETWEEN date(?) AND date(?)`,
    [from, to]
  );
  const lossByCat = queryAll(
    `SELECT category, COALESCE(SUM(amount), 0) as total, COUNT(*) as event_count FROM finance_loss_events
     WHERE date(datetime(occurred_at, 'localtime')) BETWEEN date(?) AND date(?)
     GROUP BY category ORDER BY total DESC`,
    [from, to]
  );
  const totalInvestmentMovements = Number(investmentRow?.total || 0);
  const totalPurchases = purchaseSplit.total;
  const productCogs = Number(cogs.purchase_cogs || 0);
  const kardexCogs = Number(cogs.kardex_cogs || 0);
  const cashExpenses = Number(cashExpensesRow?.total || 0);
  const lossEventsTotal = Number(lossEventsRow?.total || 0);
  const lossesCombined = lossEventsTotal + cashExpenses;
  const composed = composeFinanceTotals({
    purchases: totalPurchases,
    productCogs,
    kardexCogs,
    lossEvents: lossEventsTotal,
    cashExpenses,
    payroll: totalInvestmentMovements,
  });
  const inventoryProductsTotal = composed.warehouse_products;
  const insumosInvestment = composed.inventory_insumos;
  const inventoryInvestmentTotal = composed.inventory_total;
  const cogsTotal = composed.cogs_total;
  const operatingExpenses = composed.operating_expenses;
  const approxGross = totalSales - cogsTotal;
  const approxProfit = totalSales - operatingExpenses;

  let business_intel = null;
  try {
    business_intel = getEffectiveFlat();
  } catch (_) {
    business_intel = null;
  }

  res.json({
    filters: { from, to },
    sales: { total: totalSales, orders: Number(salesMetrics.orders || 0) },
    investment: {
      /** Compras de productos de almacén e insumos en el rango de fechas. */
      total: composed.investment_total,
      movements_total: composed.investment_total,
      payroll_total: totalInvestmentMovements,
      cogs_total: cogsTotal,
      product_cogs_total: productCogs,
      kardex_cogs_total: kardexCogs,
      purchases_in_period: totalPurchases,
      purchases_products: purchaseSplit.products,
      purchases_insumos: purchaseSplit.insumos,
      /** Stock actual (foto; no usa el rango de fechas). */
      inventory_snapshot: inventoryProductsTotal,
      inventory_products: purchaseSplit.products,
      inventory_insumos: purchaseSplit.insumos,
      inventory_total: inventoryInvestmentTotal,
    },
    purchases: { total: totalPurchases, products: purchaseSplit.products, insumos: purchaseSplit.insumos },
    cash_expenses: { total: cashExpenses },
    payroll: { total: totalInvestmentMovements },
    operating_expenses: operatingExpenses,
    loss_events: { total: lossEventsTotal, count: Number(lossEventsRow?.n || 0) },
    loss_by_category: lossByCat.map((r) => ({
      category: r.category,
      total: Number(r.total || 0),
      event_count: Number(r.event_count || 0),
    })),
    losses_combined_total: lossesCombined,
    /** Ventas − costo de productos vendidos (precio de compra e insumos). */
    approx_gross_margin: approxGross,
    approx_profit: approxProfit,
    business_intel,
  });
});

router.get('/finance-loss-events', authenticateToken, requireRole('admin'), (req, res) => {
  const def = defaultFinanceRange();
  const from = parseYmd(req.query.from) || def.from;
  const to = parseYmd(req.query.to) || def.to;
  const category = String(req.query.category || '').trim();
  const clauses = ["date(datetime(occurred_at, 'localtime')) BETWEEN date(?) AND date(?)"];
  const params = [from, to];
  if (category && LOSS_CATEGORIES.has(category)) {
    clauses.push('category = ?');
    params.push(category);
  }
  const whereSql = clauses.join(' AND ');
  const rows = queryAll(
    `SELECT * FROM finance_loss_events WHERE ${whereSql} ORDER BY datetime(occurred_at) DESC LIMIT 500`,
    params
  );
  const parsed = rows.map((row) => {
    let items = null;
    if (row.items_json) {
      try {
        items = JSON.parse(row.items_json);
      } catch (_) {
        items = row.items_json;
      }
    }
    return { ...row, items_json_parsed: items };
  });
  const totalRow = queryOne(
    `SELECT COALESCE(SUM(amount), 0) as total FROM finance_loss_events WHERE ${whereSql}`,
    params
  );
  res.json({
    filters: { from, to, category: category || 'all' },
    events: parsed,
    loss_events_total: Number(totalRow?.total || 0),
  });
});

router.post('/finance-loss-events', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const category = String(req.body?.category || '').trim();
    if (!LOSS_CATEGORIES.has(category)) return res.status(400).json({ error: 'Categoría de pérdida inválida' });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
    const concept = String(req.body?.concept || '').trim();
    const orderId = String(req.body?.order_id || '').trim();
    let itemsJson = '';
    if (req.body?.items != null) {
      itemsJson = typeof req.body.items === 'string' ? req.body.items : JSON.stringify(req.body.items);
    }
    let occurredAt = String(req.body?.occurred_at || '').trim();
    if (occurredAt && !/^\d{4}-\d{2}-\d{2}/.test(occurredAt)) {
      return res.status(400).json({ error: 'Fecha occurred_at inválida' });
    }
    if (!occurredAt) occurredAt = new Date().toISOString();
    const id = uuidv4();
    runSql(
      `INSERT INTO finance_loss_events (id, category, amount, concept, order_id, items_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [id, category, amount, concept, orderId || null, itemsJson || '', occurredAt]
    );
    const created = queryOne('SELECT * FROM finance_loss_events WHERE id = ?', [id]);
    emitStaffDataUpdate({ domain: 'finance_ops' });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message || 'No se pudo registrar la pérdida' });
  }
});

router.buildOperationalIntelligence = buildOperationalIntelligence;
router.financeMonthToDateSnapshot = financeMonthToDateSnapshot;
router.financeRolling7dSnapshot = financeRolling7dSnapshot;

router.get('/indicators-hub', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { buildIndicatorsHub } = require('../services/indicatorsHubService');
    res.json(buildIndicatorsHub(req.query || {}, { role: req.user?.role || 'admin' }));
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo cargar indicadores' });
  }
});

router.get('/indicators-export', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { exportIndicators } = require('../services/indicatorsExportService');
    exportIndicators(req.query || {}, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message || 'No se pudo exportar' });
  }
});

router.get('/sales-adjustments', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
    const { listSalesAdjustments, summarizeSalesAdjustments } = require('../services/salesAdjustmentsService');
    const orders = listSalesAdjustments({
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json({
      summary: summarizeSalesAdjustments(orders),
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo cargar informe de descuentos y cortesías' });
  }
});

router.delete('/sales-adjustments/:orderId', authenticateToken, requireRole('admin'), (req, res) => {
  const { verifyAdminPassword } = require('../lib/adminPassword');
  const { classifySalesAdjustment, SALES_ADJUSTMENT_WHERE_SQL } = require('../businessRules');
  const { deleteProductRemoval } = require('../services/productRemovalLogService');
  const kardexInventory = require('../services/kardexInventoryService');
  const { withTransaction, runSql, queryOne, logAudit } = require('../database');
  const { restoreNonTransformedStockForOrder } = require('../warehouseStock');
  const { emitInventoryUpdate } = require('../socketBroadcast');

  if (!verifyAdminPassword(req.body?.admin_password)) {
    return res.status(403).json({ error: 'Contraseña de administrador incorrecta' });
  }
  const recordId = String(req.params.orderId || '').trim();

  const removalRow = queryOne('SELECT * FROM order_product_removals WHERE id = ?', [recordId]);
  if (removalRow?.id) {
    try {
      deleteProductRemoval(removalRow.id);
      logAudit({
        actorUserId: req.user?.id || '',
        actorName: req.user?.full_name || req.user?.username || '',
        action: 'product_removal.delete',
        resourceType: 'order_product_removal',
        resourceId: removalRow.id,
        details: {
          product_name: removalRow.product_name,
          order_number: removalRow.order_number,
        },
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'No se pudo eliminar el registro' });
    }
  }

  const order = queryOne(`SELECT * FROM orders WHERE id = ? AND ${SALES_ADJUSTMENT_WHERE_SQL}`, [recordId]);
  if (!order) {
    return res.status(404).json({ error: 'Registro no encontrado o no es descuento/cortesía' });
  }
  try {
    if (String(order.status || '') !== 'cancelled') {
      withTransaction((tx) => {
        kardexInventory.revertirSalidasVentaPedido(tx, order.id, req.user.id);
      });
      restoreNonTransformedStockForOrder(order.id);
      runSql(
        "UPDATE orders SET status = 'cancelled', cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?",
        ['Eliminado por administrador (descuento/cortesía)', order.id],
      );
      emitInventoryUpdate({});
    }
    withTransaction((tx) => {
      tx.run('DELETE FROM order_items WHERE order_id = ?', [order.id]);
      tx.run('DELETE FROM electronic_documents WHERE order_id = ?', [order.id]);
      tx.run('DELETE FROM delivery_assignments WHERE order_id = ?', [order.id]);
      try {
        tx.run('DELETE FROM finance_loss_events WHERE order_id = ?', [order.id]);
      } catch (_) {
        /* opcional */
      }
      tx.run('DELETE FROM orders WHERE id = ?', [order.id]);
    });
    logAudit({
      actorUserId: req.user?.id || '',
      actorName: req.user?.full_name || req.user?.username || '',
      action: 'sales_adjustment.delete',
      resourceType: 'order',
      resourceId: order.id,
      details: {
        order_number: order.order_number,
        adjustment_kind: classifySalesAdjustment(order),
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo eliminar el registro' });
  }
});

/** Alias histórico — mismo informe unificado descuentos + cortesías. */
router.get('/courtesies', authenticateToken, requireRole('admin', 'cajero'), (req, res) => {
  try {
    const { listSalesAdjustments, summarizeSalesAdjustments } = require('../services/salesAdjustmentsService');
    const orders = listSalesAdjustments({
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json({
      summary: summarizeSalesAdjustments(orders),
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo cargar informe de descuentos y cortesías' });
  }
});

router.post('/backfill-kardex-ventas', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { backfillKardexVentasPagadas } = require('../services/kardexBackfillService');
    const limit = req.body?.limit ?? req.query?.limit;
    const result = backfillKardexVentasPagadas({ limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo aplicar inventario histórico' });
  }
});

module.exports = router;
