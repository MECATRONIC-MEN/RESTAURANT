import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, formatCurrency, parseApiDate, PAYMENT_METHODS, formatInstantTime, toLocalDateKey } from '../../utils/api';
import { useSocket } from '../../hooks/useSocket';
import { useActiveInterval } from '../../hooks/useActiveInterval';
import { useDeliverySettings } from '../../hooks/useDeliveryEnabled';
import { useNavigate, Link } from 'react-router-dom';
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, ComposedChart } from 'recharts';
import {
  MdDateRange, MdKeyboardArrowDown, MdChevronLeft, MdChevronRight, MdKitchen, MdLocalBar, MdDeliveryDining,
  MdPointOfSale, MdTableBar, MdBolt, MdWarning, MdNotificationsActive, MdPayments, MdCreditCard, MdPhoneIphone,
  MdBarChart, MdLocalOffer, MdCreditScore, MdAccountBalance, MdPeople, MdShowChart, MdInventory2, MdCardGiftcard,
  MdMoreVert, MdNorthEast,
} from 'react-icons/md';

import { useChartTheme } from '../../theme/useChartTheme';
import {
  isActiveProductionQueueOrder,
  orderPendingForProductionStation,
} from '../../utils/productionArea';
import { isCourtesyOrder, isDiscountOrder, summarizePaidSalesAccounts } from '../../utils/mesaOrderLines';

const PAYMENT_METHOD_COLORS = {
  efectivo: '#10b981',
  yape: '#7c3aed',
  plin: '#06b6d4',
  tarjeta: '#2563eb',
  online: '#f59e0b',
  transferencia: '#0ea5e9',
};

function colorForPaymentMethod(method, fallback = '#64748b') {
  const key = String(method || '').trim().toLowerCase();
  return PAYMENT_METHOD_COLORS[key] || fallback;
}

function dominantPaymentMethod(account) {
  const buckets = {};
  (account?.orders || []).forEach((order) => {
    const key = String(order?.payment_method || 'efectivo').trim().toLowerCase() || 'efectivo';
    buckets[key] = (buckets[key] || 0) + Number(order?.total || 0);
  });
  const entries = Object.entries(buckets);
  if (!entries.length) {
    return String(account?.primary?.payment_method || 'efectivo').trim().toLowerCase() || 'efectivo';
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/** Eje X temporal: ventana de 20 min (o más si hace falta) y ticks cada 5 min. */
function buildPaymentTimeAxis(paymentRows) {
  const STEP = 5;
  const WINDOW = 20;
  const DAY = 24 * 60;
  const floorStep = (m) => Math.floor(Number(m) / STEP) * STEP;
  const ceilStep = (m) => Math.ceil(Number(m) / STEP) * STEP;

  if (!paymentRows?.length) {
    const ticks = [];
    for (let t = 0; t <= WINDOW; t += STEP) ticks.push(t);
    return { domain: [0, WINDOW], ticks };
  }

  const mins = paymentRows.map((r) => Number(r.minuteOfDay) || 0);
  const dataLo = Math.min(...mins);
  const dataHi = Math.max(...mins);
  const dataSpan = Math.max(0, dataHi - dataLo);

  let lo;
  let hi;
  if (dataSpan <= WINDOW) {
    // Centrar los cobros en una ventana de exactamente 20 minutos.
    const mid = (dataLo + dataHi) / 2;
    lo = floorStep(mid - WINDOW / 2);
    hi = lo + WINDOW;
    if (lo < 0) {
      lo = 0;
      hi = WINDOW;
    }
    if (hi > DAY) {
      hi = DAY;
      lo = Math.max(0, DAY - WINDOW);
    }
  } else {
    // Día con cobros más largos: cubrir el rango y redondear a múltiplos de 5.
    lo = Math.max(0, floorStep(dataLo) - STEP);
    hi = Math.min(DAY, ceilStep(dataHi) + STEP);
    if (hi - lo < WINDOW) hi = Math.min(DAY, lo + WINDOW);
  }

  // Asegurar extremos en la grilla de 5 minutos.
  lo = floorStep(lo);
  hi = ceilStep(hi);
  if (hi <= lo) hi = lo + WINDOW;

  // Ventana corta: ticks cada 5 min. Rangos largos: espaciar para no saturar.
  const span = hi - lo;
  const tickStep = span <= 20 ? 5 : span <= 60 ? 10 : span <= 180 ? 15 : 30;
  const ticks = [];
  for (let t = lo; t <= hi + 0.001; t += tickStep) {
    ticks.push(Math.round(t));
  }
  if (ticks[ticks.length - 1] !== Math.round(hi)) ticks.push(Math.round(hi));

  return { domain: [lo, hi], ticks };
}

function formatMinuteOfDayLabel(value) {
  const DAY = 24 * 60;
  const total = Math.round(Number(value) || 0);
  const normalized = ((total % DAY) + DAY) % DAY;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Una barra por cada cuenta cobrada; eje X = minutos del día (espacio proporcional a la hora). */
function buildPaymentTimelineRows(accounts, scheduleCheck) {
  return (accounts || [])
    .slice()
    .sort((a, b) => {
      const ta = parseApiDate(a.paidAt)?.getTime() || 0;
      const tb = parseApiDate(b.paidAt)?.getTime() || 0;
      return ta - tb;
    })
    .map((account, index) => {
      const parsed = parseApiDate(account.paidAt);
      if (!parsed) return null;
      if (scheduleCheck && !scheduleCheck({
        paid_at: account.paidAt,
        updated_at: account.paidAt,
        created_at: account.paidAt,
      })) return null;
      const hh = String(parsed.getHours()).padStart(2, '0');
      const mm = String(parsed.getMinutes()).padStart(2, '0');
      const amount = Number(Number(account.total || 0).toFixed(2));
      const table = String(account.table || '').trim();
      const paymentMethod = dominantPaymentMethod(account);
      const minuteOfDay = parsed.getHours() * 60 + parsed.getMinutes() + parsed.getSeconds() / 60;
      return {
        id: `pay-${index}-${account.paidAt || ''}-${amount}`,
        label: `${hh}:${mm}`,
        minuteOfDay,
        amount,
        table,
        mesaLabel: table ? `Mesa ${table}` : 'Cuenta cobrada',
        paymentMethod,
        paymentLabel: PAYMENT_METHODS[paymentMethod] || paymentMethod,
        fill: colorForPaymentMethod(paymentMethod),
      };
    })
    .filter(Boolean);
}

const toInputDate = (date) => {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const getCurrentMonthRange = () => {
  const now = new Date();
  return {
    start: toInputDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: toInputDate(now),
  };
};
const getCurrentWeekRange = () => {
  const now = new Date();
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  return {
    start: toInputDate(monday),
    end: toInputDate(now),
  };
};
const getTotalRange = () => ({
  start: '2020-01-01',
  end: toInputDate(new Date()),
});
const formatDateForLabel = (value) => {
  if (!value) return '-';
  const [y, m, d] = String(value).split('-');
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
};
const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());

function enumerateDateRangeDays(fromYmd, toYmd) {
  const from = String(fromYmd || '').trim();
  const to = String(toYmd || '').trim();
  if (!from || !to) return [];
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(toInputDate(cursor));
  }
  return days;
}

function buildHourlySalesRows(accounts, scheduleCheck) {
  const byHour = {};
  for (let h = 0; h < 24; h += 1) byHour[String(h).padStart(2, '0')] = 0;
  (accounts || []).forEach((account) => {
    const parsed = parseApiDate(account.paidAt);
    if (!parsed) return;
    if (scheduleCheck && !scheduleCheck({
      paid_at: account.paidAt,
      updated_at: account.paidAt,
      created_at: account.paidAt,
    })) return;
    const hour = parsed.getHours();
    byHour[String(hour).padStart(2, '0')] += Number(account.total || 0);
  });
  return Object.entries(byHour).map(([hour, total]) => ({
    hour: `${hour}:00`,
    sales: Number(Number(total).toFixed(2)),
  }));
}

function pickPeakAndLowHour(hourlyRows) {
  const rows = hourlyRows || [];
  if (!rows.some((item) => item.sales > 0)) {
    return {
      peak: { hour: '--:--', sales: 0 },
      low: { hour: '--:--', sales: 0 },
    };
  }
  const peak = rows.reduce(
    (best, item) => (item.sales > best.sales ? item : best),
    { hour: '--:--', sales: -1 },
  );
  const low = rows.reduce(
    (best, item) => (item.sales < best.sales ? item : best),
    { hour: '--:--', sales: Number.MAX_VALUE },
  );
  return { peak, low };
}

function isPaidSaleOrder(order) {
  if (!order || order.status === 'cancelled') return false;
  if (order.payment_status !== 'paid') return false;
  const method = String(order.payment_method || '').toLowerCase();
  return method !== 'cortesia' && method !== 'cuenta_cliente';
}

function getOrderPaidAtIso(order) {
  return order?.paid_at || order?.updated_at || order?.created_at || '';
}

function orderMatchesRegisterWindow(order, registerId, openedAt, closedAt) {
  if (!isPaidSaleOrder(order)) return false;
  const paidAt = getOrderPaidAtIso(order);
  if (!paidAt || !openedAt) return false;
  const end = closedAt || new Date().toISOString();
  const regId = String(registerId || '').trim();
  const orderRegId = String(order.cash_register_id || '').trim();
  if (regId) {
    if (orderRegId === regId) return true;
    if (!orderRegId) return paidAt >= openedAt && paidAt <= end;
    return false;
  }
  return paidAt >= openedAt && paidAt <= end;
}

const WEEKDAY_CHART_META = [
  { dow: 1, name: 'Lun', label: 'Lunes' },
  { dow: 2, name: 'Mar', label: 'Martes' },
  { dow: 3, name: 'Mié', label: 'Miércoles' },
  { dow: 4, name: 'Jue', label: 'Jueves' },
  { dow: 5, name: 'Vie', label: 'Viernes' },
  { dow: 6, name: 'Sáb', label: 'Sábado' },
  { dow: 0, name: 'Dom', label: 'Domingo' },
];

function getChartYAxisMax(values) {
  const max = Math.max(0, ...values.map((v) => Number(v) || 0));
  if (max <= 0) return 0;
  const padded = max * 1.05;
  if (padded <= 1000) return Math.ceil(padded);
  if (padded <= 10000) return Math.ceil(padded / 100) * 100;
  return Math.ceil(padded / 1000) * 1000;
}

function getChartYAxisTicks(max) {
  const ceiling = Number(max) || 0;
  if (ceiling <= 0) return [];
  const segments = 4;
  const step = Math.max(1, Math.ceil(ceiling / segments));
  return Array.from({ length: segments + 1 }, (_, index) => {
    if (index === segments) return ceiling;
    return Math.min(ceiling, index * step);
  });
}

function formatChartYAxisTick(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return `S/ ${Math.round(n / 100) / 10}k`;
  return formatCurrency(n).replace(/\.00$/, '');
}

function orderBelongsToRegisterSession(order, registerId, openedAt, closedAt) {
  if (!order || order.status === 'cancelled') return false;
  const eventAt = order.payment_status === 'paid'
    ? getOrderPaidAtIso(order)
    : (order.updated_at || order.created_at || '');
  if (!eventAt || !openedAt) return false;
  const end = closedAt || new Date().toISOString();
  const regId = String(registerId || '').trim();
  const orderRegId = String(order.cash_register_id || '').trim();
  if (regId && orderRegId === regId) return true;
  if (regId && orderRegId && orderRegId !== regId) return false;
  return eventAt >= openedAt && eventAt <= end;
}

const KPI_WAVE_LINE = 'M0 46 C 30 40, 52 50, 80 42 S 128 30, 150 34 S 186 14, 200 6';

function DashboardKpiCard({ item }) {
  const Icon = item.icon;
  const gradId = `kpi-wave-${item.key}`;
  const value = Number(item.amount || 0);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[color:var(--ui-card-border)] bg-[var(--ui-surface)] shadow-sm hover:shadow-md transition-shadow min-h-[10rem] p-4">
      <MdMoreVert className="absolute right-3 top-3 z-10 text-lg text-[var(--ui-muted)]" aria-hidden="true" />
      <div className="relative z-10 flex items-center gap-3 pr-5">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: `${item.color}1f`, color: item.color }}
        >
          <Icon className="text-[1.45rem]" />
        </span>
        <p className="text-sm font-semibold text-[var(--ui-body-text)] leading-tight">{item.label}</p>
      </div>
      <p className="relative z-10 mt-3 text-2xl sm:text-[1.8rem] font-bold tabular-nums text-[var(--ui-body-text)] whitespace-nowrap leading-none">
        {item.currency ? (
          <>
            <span className="font-medium text-[var(--ui-muted)] mr-1.5">S/</span>
            {value.toFixed(2)}
          </>
        ) : value}
      </p>
      <div className="relative z-10 mt-3 flex items-center gap-2 text-[11px] text-[var(--ui-muted)]">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-md"
          style={{ backgroundColor: `${item.color}1f`, color: item.color }}
        >
          <MdNorthEast className="text-xs" />
        </span>
        vs. periodo anterior
      </div>
      <svg
        className="pointer-events-none absolute inset-x-0 bottom-0 h-14 w-full"
        viewBox="0 0 200 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={item.color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={item.color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${KPI_WAVE_LINE} L200 56 L0 56 Z`} fill={`url(#${gradId})`} />
        <path d={KPI_WAVE_LINE} fill="none" stroke={item.color} strokeWidth="2" strokeLinecap="round" opacity="0.75" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function Escritorio() {
  const CHART_COLORS = useChartTheme();
  const { enabled: deliveryEnabled, loaded: deliverySettingsLoaded } = useDeliverySettings();
  const [orders, setOrders] = useState([]);
  const [liveDash, setLiveDash] = useState(null);
  const [liveDashLoading, setLiveDashLoading] = useState(true);
  const [liveDashError, setLiveDashError] = useState('');
  const [loading, setLoading] = useState(true);
  const [restaurantInfo, setRestaurantInfo] = useState({ name: 'Resto-FADEY', address: '', phone: '' });
  const [datePreset, setDatePreset] = useState('month');
  const [startDate, setStartDate] = useState(getCurrentMonthRange().start);
  const [endDate, setEndDate] = useState(getCurrentMonthRange().end);
  const [datePickStep, setDatePickStep] = useState('idle');
  const [pendingStart, setPendingStart] = useState('');
  const [pendingEnd, setPendingEnd] = useState('');
  const [rankingMode, setRankingMode] = useState('dias');
  const [cajaStations, setCajaStations] = useState([]);
  const [selectedCajaStationId, setSelectedCajaStationId] = useState('');
  const [activeProductionAreas, setActiveProductionAreas] = useState(() => [
    { id: 'cocina', name: 'Cocina' },
    { id: 'bar', name: 'Bar' },
  ]);
  const [registerPeriodReport, setRegisterPeriodReport] = useState(null);
  const [registerReportLoading, setRegisterReportLoading] = useState(true);
  const [hourlyHistoryIndex, setHourlyHistoryIndex] = useState(0);
  const hourlySwipeRef = useRef({ x: 0, active: false });
  const startDateInputRef = useRef(null);
  const endDateInputRef = useRef(null);
  const navigate = useNavigate();

  const deliveryModuleActive = useMemo(() => {
    if (deliverySettingsLoaded) return deliveryEnabled;
    if (liveDash?.deliveryEnabled != null) return Boolean(liveDash.deliveryEnabled);
    return true;
  }, [deliverySettingsLoaded, deliveryEnabled, liveDash?.deliveryEnabled]);

  useEffect(() => {
    const loadAreas = () => {
      api
        .get('/production-areas/active')
        .then((list) => {
          const areas = (Array.isArray(list) ? list : [])
            .map((a) => ({
              id: String(a?.id || '').trim(),
              name: String(a?.name || a?.id || '').trim() || 'Área',
            }))
            .filter((a) => a.id);
          setActiveProductionAreas(areas);
        })
        .catch(() => {});
    };
    loadAreas();
    const onAreas = () => loadAreas();
    window.addEventListener('production-areas-updated', onAreas);
    return () => window.removeEventListener('production-areas-updated', onAreas);
  }, []);

  const loadLiveDash = useCallback(async () => {
    setLiveDashLoading(true);
    try {
      const d = await api.get('/reports/dashboard');
      setLiveDash(d);
      setLiveDashError('');
    } catch (err) {
      const msg = String(err?.message || '').trim() || 'No se pudo cargar el monitoreo en vivo';
      try {
        const op = await api.get('/reports/operational-alerts');
        setLiveDash({
          operationalSummary: op.summary,
          operationalAlerts: op.alerts,
          insightToday: op.insightToday,
          generated_at: op.generated_at,
          activeOrders: op.summary?.activeOrders ?? 0,
          tablesWithActiveOrders: op.summary?.tablesWithActiveOrders ?? 0,
          deliveryActiveCount: op.summary?.deliveryActiveCount ?? 0,
          inKitchenCount: op.summary?.inKitchenCount ?? 0,
          registerOpen: op.summary?.registerOpen ?? false,
          deliveryEnabled: op.deliveryEnabled,
          openRegisters: [],
          registerOpenSummary: null,
          lowStock: [],
          liveSales: null,
          liveSalesByRegister: [],
          today: null,
        });
        setLiveDashError('');
      } catch {
        setLiveDash(null);
        setLiveDashError(msg);
      }
    } finally {
      setLiveDashLoading(false);
    }
  }, []);

  const loadRegisterPeriodReport = useCallback(async () => {
    const from = String(startDate || '').trim();
    const to = String(endDate || '').trim();
    if (!from || !to) {
      setRegisterPeriodReport(null);
      setRegisterReportLoading(false);
      return;
    }
    setRegisterReportLoading(true);
    try {
      const report = await api.get(`/reports/product-sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setRegisterPeriodReport(report);
    } catch (err) {
      console.error(err);
      setRegisterPeriodReport(null);
    } finally {
      setRegisterReportLoading(false);
    }
  }, [startDate, endDate]);

  const loadData = async () => {
    try {
      const allOrders = await api.get('/orders');
      setOrders(allOrders);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);
  useActiveInterval(loadData, 10000);

  useEffect(() => {
    void loadRegisterPeriodReport();
  }, [loadRegisterPeriodReport]);

  useEffect(() => {
    const loadCajaStations = () => {
      api
        .get('/pos/caja-stations')
        .then((res) => setCajaStations(Array.isArray(res?.stations) ? res.stations : []))
        .catch(() => setCajaStations([]));
    };
    loadCajaStations();
    const onFocus = () => loadCajaStations();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(loadCajaStations, 15000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    loadLiveDash();
  }, [loadLiveDash]);
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.hash !== '#monitoreo-vivo') return;
    const el = document.getElementById('monitoreo-vivo');
    if (!el) return;
    const t = window.setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => window.clearTimeout(t);
  }, [loading, liveDashLoading]);
  useActiveInterval(loadLiveDash, 15000);
  useSocket('order-update', () => {
    loadData();
    void loadLiveDash();
    void loadRegisterPeriodReport();
  });
  useSocket('table-update', loadLiveDash);
  useSocket('delivery-update', loadLiveDash);
  useSocket('register-update', () => {
    loadData();
    void loadLiveDash();
    void loadRegisterPeriodReport();
  });
  useSocket('inventory-update', loadLiveDash);
  useSocket('billing-document-update', () => {
    void loadLiveDash();
  });
  useEffect(() => {
    if (datePreset === 'month') {
      const monthRange = getCurrentMonthRange();
      setStartDate(monthRange.start);
      setEndDate(monthRange.end);
      return;
    }
    if (datePreset === 'week') {
      const weekRange = getCurrentWeekRange();
      setStartDate(weekRange.start);
      setEndDate(weekRange.end);
      return;
    }
    if (datePreset === 'total') {
      const totalRange = getTotalRange();
      setStartDate(totalRange.start);
      setEndDate(totalRange.end);
    }
  }, [datePreset]);
  useEffect(() => {
    setHourlyHistoryIndex(0);
  }, [startDate, endDate, selectedCajaStationId]);
  useEffect(() => {
    api
      .get('/restaurant')
      .then((cfg) => {
        setRestaurantInfo(cfg || { name: 'Resto-FADEY', address: '', phone: '' });
      })
      .catch(() => {});
  }, []);

  const activeRegisterBlocks = useMemo(() => {
    const blocks = Array.isArray(registerPeriodReport?.by_register) ? registerPeriodReport.by_register : [];
    if (!selectedCajaStationId) return blocks;
    return blocks.filter((block) => String(block.caja_station_id || '') === selectedCajaStationId);
  }, [registerPeriodReport, selectedCajaStationId]);

  const selectedCajaLabel = useMemo(() => {
    if (!selectedCajaStationId) return 'Todas';
    const match = cajaStations.find((s) => s.id === selectedCajaStationId);
    return match?.name || registerPeriodReport?.by_register?.find((b) => b.caja_station_id === selectedCajaStationId)?.station_name || 'Caja';
  }, [selectedCajaStationId, cajaStations, registerPeriodReport]);

  const scopedOrdersAll = useMemo(() => {
    if (registerReportLoading || !registerPeriodReport) return [];
    if (!activeRegisterBlocks.length) return [];
    return orders.filter((order) =>
      activeRegisterBlocks.some((block) =>
        orderMatchesRegisterWindow(order, block.register_id, block.opened_at, block.closed_at)
      )
    );
  }, [orders, activeRegisterBlocks, registerPeriodReport, registerReportLoading]);
  const scopedOrders = useMemo(
    () => scopedOrdersAll.filter(o => o.status !== 'cancelled'),
    [scopedOrdersAll]
  );
  const paidOrders = useMemo(
    () => scopedOrders.filter((o) => o.payment_status === 'paid' && String(o.payment_method || '').toLowerCase() !== 'cortesia'),
    [scopedOrders]
  );

  const parseHourToMinutes = (raw) => {
    const [h = '0', m = '0'] = String(raw || '').split(':');
    return (Number(h) * 60) + Number(m);
  };
  const isSaleInConfiguredSchedule = (order) => {
    const schedule = restaurantInfo?.schedule;
    if (!schedule || typeof schedule !== 'object') return true;
    const date = parseApiDate(order?.paid_at || order?.updated_at || order?.created_at);
    if (!date) return true;
    const dayMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayKey = dayMap[date.getDay()];
    const aliases = {
      sunday: ['sunday', 'domingo', 'dom'],
      monday: ['monday', 'lunes', 'lun'],
      tuesday: ['tuesday', 'martes', 'mar'],
      wednesday: ['wednesday', 'miercoles', 'miércoles', 'mie', 'mié'],
      thursday: ['thursday', 'jueves', 'jue'],
      friday: ['friday', 'viernes', 'vie'],
      saturday: ['saturday', 'sabado', 'sábado', 'sab', 'sáb'],
    };
    const cfg = (aliases[dayKey] || [])
      .map(k => schedule[k])
      .find(Boolean);
    if (!cfg) return true;
    if (cfg.enabled === false || Number(cfg.enabled) === 0) return false;
    const openMinutes = parseHourToMinutes(cfg.open || '00:00');
    const closeMinutes = parseHourToMinutes(cfg.close || '23:59');
    const currentMinutes = (date.getHours() * 60) + date.getMinutes();
    if (closeMinutes >= openMinutes) {
      return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
    }
    return currentMinutes >= openMinutes || currentMinutes <= closeMinutes;
  };

  const paidSalesAccounts = useMemo(() => summarizePaidSalesAccounts(paidOrders), [paidOrders]);
  const paidSalesAccountsInSchedule = useMemo(
    () => paidSalesAccounts.filter((account) => isSaleInConfiguredSchedule({
      paid_at: account.paidAt,
      updated_at: account.paidAt,
      created_at: account.paidAt,
    })),
    [paidSalesAccounts, restaurantInfo]
  );

  const scheduleSaleCheck = useCallback((order) => isSaleInConfiguredSchedule(order), [restaurantInfo]);

  const hourlySalesHistory = useMemo(() => {
    const accountsByDay = new Map();
    paidSalesAccountsInSchedule.forEach((account) => {
      const dayKey = toLocalDateKey(account.paidAt);
      if (!dayKey) return;
      if (!accountsByDay.has(dayKey)) accountsByDay.set(dayKey, []);
      accountsByDay.get(dayKey).push(account);
    });
    return enumerateDateRangeDays(startDate, endDate)
      .reverse()
      .map((dateKey) => {
        const dayAccounts = accountsByDay.get(dateKey) || [];
        return {
          dateKey,
          dateLabel: formatDateForLabel(dateKey),
          hourly: buildHourlySalesRows(dayAccounts, scheduleSaleCheck),
          payments: buildPaymentTimelineRows(dayAccounts, scheduleSaleCheck),
          total: dayAccounts.reduce((sum, account) => sum + Number(account.total || 0), 0),
          accountCount: dayAccounts.length,
        };
      });
  }, [paidSalesAccountsInSchedule, startDate, endDate, scheduleSaleCheck]);

  useEffect(() => {
    setHourlyHistoryIndex((prev) => {
      if (!hourlySalesHistory.length) return 0;
      return Math.min(prev, hourlySalesHistory.length - 1);
    });
  }, [hourlySalesHistory.length]);

  const hourlyHistoryEntry = hourlySalesHistory[hourlyHistoryIndex] || null;
  const hourlySales = hourlyHistoryEntry?.hourly || buildHourlySalesRows([], scheduleSaleCheck);
  const paymentSales = hourlyHistoryEntry?.payments || [];
  const paymentTimeAxis = useMemo(
    () => buildPaymentTimeAxis(paymentSales),
    [paymentSales],
  );
  const themeAccent = (() => {
    if (typeof document !== 'undefined') {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim();
      if (accent) return accent;
    }
    return CHART_COLORS?.[0] || '#2563eb';
  })();
  const { peak: peakHour, low: lowHour } = useMemo(
    () => pickPeakAndLowHour(hourlySales),
    [hourlySales],
  );

  const goToOlderHourlyDay = useCallback(() => {
    setHourlyHistoryIndex((prev) => Math.min(prev + 1, Math.max(0, hourlySalesHistory.length - 1)));
  }, [hourlySalesHistory.length]);

  const goToNewerHourlyDay = useCallback(() => {
    setHourlyHistoryIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const onHourlyChartTouchStart = (event) => {
    hourlySwipeRef.current = {
      x: event.touches?.[0]?.clientX ?? 0,
      active: true,
    };
  };

  const onHourlyChartTouchEnd = (event) => {
    if (!hourlySwipeRef.current.active) return;
    hourlySwipeRef.current.active = false;
    const endX = event.changedTouches?.[0]?.clientX ?? hourlySwipeRef.current.x;
    const delta = endX - hourlySwipeRef.current.x;
    if (Math.abs(delta) < 48) return;
    if (delta > 0) goToNewerHourlyDay();
    else goToOlderHourlyDay();
  };

  const salesByPayment = useMemo(() => {
    const map = { efectivo: 0, tarjeta: 0, yape: 0, plin: 0, online: 0 };
    paidOrders.forEach((o) => {
      const m = o.payment_method || 'efectivo';
      map[m] = (map[m] || 0) + Number(o.total || 0);
    });
    return map;
  }, [paidOrders]);

  const paymentPieData = useMemo(() => {
    const rows = [
      { name: PAYMENT_METHODS.efectivo, value: salesByPayment.efectivo || 0, key: 'efectivo' },
      { name: PAYMENT_METHODS.tarjeta, value: salesByPayment.tarjeta || 0, key: 'tarjeta' },
      { name: PAYMENT_METHODS.yape, value: salesByPayment.yape || 0, key: 'yape' },
      { name: PAYMENT_METHODS.plin, value: salesByPayment.plin || 0, key: 'plin' },
      { name: PAYMENT_METHODS.online, value: salesByPayment.online || 0, key: 'online' },
    ].filter((r) => r.value > 0);
    return rows;
  }, [salesByPayment]);

  const totalSales = paidOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

  const paidAccountsCount = paidSalesAccounts.length;
  const averageSaleAmount = paidAccountsCount > 0 ? totalSales / paidAccountsCount : 0;
  const productsSoldCount = useMemo(() => {
    let total = 0;
    paidOrders.forEach((order) => {
      (order.items || []).forEach((item) => {
        total += Number(item.quantity || 0);
      });
    });
    return total;
  }, [paidOrders]);
  const courtesyCount = useMemo(() => {
    if (registerReportLoading || !activeRegisterBlocks.length) return 0;
    return orders.reduce((count, order) => {
      if (order.status === 'cancelled' || order.payment_status !== 'paid' || !isCourtesyOrder(order)) return count;
      const inSession = activeRegisterBlocks.some((block) =>
        orderBelongsToRegisterSession(order, block.register_id, block.opened_at, block.closed_at)
      );
      return inSession ? count + 1 : count;
    }, 0);
  }, [orders, activeRegisterBlocks, registerReportLoading]);

  const totalDiscounts = useMemo(() => {
    if (registerReportLoading || !activeRegisterBlocks.length) return 0;
    return orders.reduce((sum, order) => {
      if (order.status === 'cancelled' || !isDiscountOrder(order)) return sum;
      const inSession = activeRegisterBlocks.some((block) =>
        orderBelongsToRegisterSession(order, block.register_id, block.opened_at, block.closed_at)
      );
      if (!inSession) return sum;
      return sum + Number(order.discount || 0);
    }, 0);
  }, [orders, activeRegisterBlocks, registerReportLoading]);
  const totalCashExpenses = useMemo(
    () => activeRegisterBlocks.reduce((sum, block) => sum + Number(block.cash_expenses || 0), 0),
    [activeRegisterBlocks]
  );
  const totalDebitIncome = useMemo(
    () => activeRegisterBlocks.reduce((sum, block) => sum + Number(block.notes_debit || 0), 0),
    [activeRegisterBlocks]
  );
  const totalCredit = paidOrders
    .filter(o => o.payment_method === 'online')
    .reduce((sum, o) => sum + Number(o.total || 0), 0);

  const topDiasData = useMemo(() => {
    const dailyTotals = new Map();
    const from = String(startDate || '').trim();
    const to = String(endDate || '').trim();

    paidSalesAccountsInSchedule.forEach((account) => {
      const parsed = parseApiDate(account.paidAt);
      if (!parsed) return;
      const dateKey = toInputDate(parsed);
      if (from && dateKey < from) return;
      if (to && dateKey > to) return;
      dailyTotals.set(dateKey, (dailyTotals.get(dateKey) || 0) + Number(account.total || 0));
    });

    const weekdayTotals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    dailyTotals.forEach((total, dateKey) => {
      const parsed = new Date(`${dateKey}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) return;
      weekdayTotals[parsed.getDay()] += total;
    });

    return WEEKDAY_CHART_META.map(({ dow, name, label }) => ({
      dow,
      name,
      label,
      value: weekdayTotals[dow] || 0,
    }));
  }, [paidSalesAccountsInSchedule, startDate, endDate, selectedCajaStationId, datePreset]);

  const topMesasData = useMemo(() => {
    const grouped = {};
    const from = String(startDate || '').trim();
    const to = String(endDate || '').trim();

    paidSalesAccountsInSchedule.forEach((account) => {
      const table = String(account.table || '').trim();
      if (!table) return;
      const parsed = parseApiDate(account.paidAt);
      if (!parsed) return;
      const dateKey = toInputDate(parsed);
      if (from && dateKey < from) return;
      if (to && dateKey > to) return;
      if (!grouped[table]) {
        grouped[table] = {
          table,
          name: `M${table}`,
          label: `Mesa ${table}`,
          value: 0,
        };
      }
      grouped[table].value += Number(account.total || 0);
    });

    return Object.values(grouped)
      .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
      .slice(0, 7);
  }, [paidSalesAccountsInSchedule, startDate, endDate, selectedCajaStationId, datePreset]);

  const topDiasHasSales = topDiasData.some((d) => Number(d.value || 0) > 0);
  const topMesasHasSales = topMesasData.some((m) => Number(m.value || 0) > 0);
  const topDiasYMax = useMemo(
    () => (topDiasHasSales ? getChartYAxisMax(topDiasData.map((d) => d.value)) : 0),
    [topDiasData, topDiasHasSales]
  );
  const topMesasYMax = useMemo(
    () => (topMesasHasSales ? getChartYAxisMax(topMesasData.map((m) => m.value)) : 0),
    [topMesasData, topMesasHasSales]
  );
  const topDiasYTicks = useMemo(() => getChartYAxisTicks(topDiasYMax), [topDiasYMax]);
  const topMesasYTicks = useMemo(() => getChartYAxisTicks(topMesasYMax), [topMesasYMax]);

  const productionQueuesByArea = useMemo(() => {
    const map = {};
    for (const area of activeProductionAreas) {
      const id = String(area.id || '').trim();
      if (!id) continue;
      map[id] = orders.filter(
        (o) => isActiveProductionQueueOrder(o) && orderPendingForProductionStation(o, id)
      ).length;
    }
    return map;
  }, [orders, activeProductionAreas]);
  const productionQueueTotal = useMemo(
    () => Object.values(productionQueuesByArea).reduce((s, n) => s + Number(n || 0), 0),
    [productionQueuesByArea]
  );
  const activeCajaStations = useMemo(
    () => (Array.isArray(cajaStations) ? cajaStations : []).filter((s) => s && (s.active !== false && s.active !== 0)),
    [cajaStations]
  );
  const liveSalesByStationId = useMemo(() => {
    const map = {};
    for (const row of liveDash?.liveSalesByRegister || []) {
      const sid = String(row?.caja_station_id || '').trim();
      if (sid) map[sid] = row;
    }
    return map;
  }, [liveDash?.liveSalesByRegister]);
  const visibleOperationalAlerts = useMemo(() => {
    const list = Array.isArray(liveDash?.operationalAlerts) ? liveDash.operationalAlerts : [];
    if (productionQueueTotal > 0) return list;
    return list.filter((a) => !['kitchen_prep_demora', 'ready_demora', 'kitchen_load'].includes(String(a?.id || '')));
  }, [liveDash?.operationalAlerts, productionQueueTotal]);
  const showStockAlertPanel = liveDash?.businessIntel?.show_stock_alert_panel !== false;
  const deliveryReady = useMemo(
    () => orders.filter(o => o.type === 'delivery' && o.status === 'ready').length,
    [orders]
  );
  const salonActive = useMemo(
    () => orders.filter(o => o.type === 'dine_in' && ['pending', 'preparing', 'ready'].includes(o.status)).length,
    [orders]
  );
  const getQueueLevel = (value) => {
    if (value >= 10) return { label: 'Crítico', pill: 'bg-red-100 text-red-700', card: 'border-red-300 bg-red-50 ring-1 ring-red-300' };
    if (value >= 5) return { label: 'Alto', pill: 'bg-amber-100 text-amber-700', card: 'border-amber-300 bg-amber-50' };
    return { label: 'Normal', pill: 'bg-emerald-100 text-emerald-700', card: 'border-emerald-200 bg-emerald-50' };
  };
  const productionAreaTone = (areaId) => {
    const id = String(areaId || '').trim();
    if (id === 'bar') {
      return {
        icon: MdLocalBar,
        title: 'text-indigo-700',
        value: 'text-indigo-800',
        sub: 'text-indigo-700',
        link: 'text-indigo-700',
      };
    }
    if (id === 'cocina') {
      return {
        icon: MdKitchen,
        title: 'text-amber-700',
        value: 'text-amber-800',
        sub: 'text-amber-700',
        link: 'ui-live-link-amber',
      };
    }
    return {
      icon: MdKitchen,
      title: 'text-teal-700',
      value: 'text-teal-800',
      sub: 'text-teal-700',
      link: 'text-teal-700',
    };
  };

  const dateRangeLabel = datePreset === 'total'
    ? 'Total · todos los cierres de caja'
    : `Inicio ${formatDateForLabel(startDate)} · Fin ${formatDateForLabel(endDate)}`;
  const dateRangeDisplay = datePreset === 'total'
    ? 'Inicio: desde el comienzo · Fin: hoy'
    : `Inicio ${formatDateForLabel(startDate)} · Fin ${formatDateForLabel(endDate)}`;
  const datePickerCaption = datePickStep === 'start'
    ? 'Inicio'
    : datePickStep === 'end'
      ? 'Fin'
      : (datePreset === 'custom' ? 'Inicio · Fin' : datePreset === 'week' ? 'Semana' : datePreset === 'total' ? 'Todos' : 'Mes');
  const datePickerValue = datePickStep === 'start'
    ? 'Elige fecha de inicio'
    : datePickStep === 'end'
      ? `Inicio ${formatDateForLabel(pendingStart)} · elige fin`
      : dateRangeDisplay;
  const resetPendingRange = () => {
    setDatePickStep('idle');
    setPendingStart('');
    setPendingEnd('');
  };
  const applyMonthRange = () => {
    const monthRange = getCurrentMonthRange();
    setDatePreset('month');
    setStartDate(monthRange.start);
    setEndDate(monthRange.end);
    resetPendingRange();
  };
  const applyWeekRange = () => {
    const weekRange = getCurrentWeekRange();
    setDatePreset('week');
    setStartDate(weekRange.start);
    setEndDate(weekRange.end);
    resetPendingRange();
  };
  const applyTotalRange = () => {
    const totalRange = getTotalRange();
    setDatePreset('total');
    setStartDate(totalRange.start);
    setEndDate(totalRange.end);
    resetPendingRange();
  };
  const openNativeDatePicker = (inputRef) => {
    const input = inputRef?.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {
      /* showPicker puede fallar si el input no está visible; se usa click. */
    }
    input.click();
  };
  const startRangeSelection = () => {
    setDatePickStep('start');
    setPendingStart('');
    setPendingEnd('');
    window.requestAnimationFrame(() => {
      openNativeDatePicker(startDateInputRef);
    });
  };
  const onDateRangeButtonClick = () => {
    if (datePickStep === 'end' && isIsoDate(pendingStart)) {
      openNativeDatePicker(endDateInputRef);
      return;
    }
    startRangeSelection();
  };
  const applyCustomRange = (fromValue, toValue) => {
    if (!isIsoDate(fromValue) || !isIsoDate(toValue)) return;
    const from = fromValue < toValue ? fromValue : toValue;
    const to = fromValue < toValue ? toValue : fromValue;
    setStartDate(from);
    setEndDate(to);
    setDatePreset('custom');
    resetPendingRange();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-gold-500 border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="space-y-4">
      <div id="monitoreo-vivo" className="card p-4 scroll-mt-4">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <MdBolt className="text-xl text-[var(--ui-accent-muted)] shrink-0" />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-[var(--ui-body-text)]">Monitoreo en vivo</h3>
              {liveDash?.generated_at ? (
                <p className="text-xs text-[var(--ui-muted)]">
                  Actualizado {formatInstantTime(liveDash.generated_at, { withSeconds: true })}
                </p>
              ) : null}
            </div>
          </div>
          {liveDash ? (
            <span
              className={`text-xs font-medium px-2 py-1 rounded-lg border ${
                liveDash.registerOpen ? 'ui-live-badge-open' : 'ui-live-badge-closed'
              }`}
            >
              {liveDash.registerOpen
                ? (liveDash.openRegisters?.length || 0) > 1
                  ? `${liveDash.openRegisters.length} cajas abiertas`
                  : liveDash.registerOpenSummary?.station_name
                    ? `Caja abierta · ${liveDash.registerOpenSummary.station_name}`
                    : 'Caja abierta'
                : 'Sin caja abierta'}
            </span>
          ) : null}
        </div>

        {liveDashLoading && !liveDash ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--ui-muted)]">
            <div className="animate-spin w-5 h-5 border-2 border-[var(--ui-accent)] border-t-transparent rounded-full" />
            Cargando monitoreo en vivo…
          </div>
        ) : null}

        {liveDashError && !liveDash ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <p className="font-medium">No se pudo conectar con el panel en vivo</p>
            <p className="text-xs mt-1 text-amber-900/90">{liveDashError}</p>
            <button type="button" onClick={() => void loadLiveDash()} className="btn-secondary text-xs mt-3">
              Reintentar
            </button>
          </div>
        ) : null}

        {liveDash ? (
          <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 mb-3">
            {(activeCajaStations.length
              ? activeCajaStations
              : [{ id: '_default', name: liveDash.liveSales?.label || 'Caja', active: 1 }]
            ).map((station) => {
              const sid = String(station.id || '').trim();
              const perReg = sid && sid !== '_default' ? liveSalesByStationId[sid] : null;
              const openReg =
                sid && sid !== '_default'
                  ? (liveDash.openRegisters || []).find(
                      (r) => String(r?.caja_station_id || '').trim() === sid
                    )
                  : liveDash.registerOpen
                    ? liveDash.registerOpenSummary
                    : null;
              const isOpen = Boolean(
                openReg || perReg?.register_open || (sid === '_default' && liveDash.registerOpen),
              );
              const total = !isOpen
                ? 0
                : perReg
                  ? Number(perReg.total || 0)
                  : sid === '_default'
                    ? Number(liveDash.liveSales?.total ?? 0)
                    : 0;
              const count = !isOpen
                ? 0
                : perReg
                  ? Number(perReg.count || 0)
                  : sid === '_default'
                    ? Number(liveDash.liveSales?.count ?? 0)
                    : 0;
              const stationName = station.name || perReg?.station_name || openReg?.station_name || 'Caja';
              const cashier = perReg?.user_name || openReg?.user_name || '';
              return (
                <button
                  key={sid || stationName}
                  type="button"
                  onClick={() => navigate('/admin/caja')}
                  className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-left hover:bg-sky-100 transition-colors"
                >
                  <div className="flex items-center gap-1.5 text-sky-700 font-semibold text-xs">
                    <MdPointOfSale className="shrink-0" />
                    <span className="truncate">{stationName}</span>
                  </div>
                  <p className="text-lg font-bold text-sky-800 tabular-nums mt-1">
                    {formatCurrency(total)}
                  </p>
                  <p className="text-[11px] text-sky-700">
                    {isOpen ? `${count} cobradas` : 'Sin turno activo'}
                    {isOpen && cashier ? ` · ${cashier}` : ''}
                  </p>
                  <p className="text-[11px] font-medium text-sky-700 mt-0.5">Ir a Caja</p>
                </button>
              );
            })}
            {activeProductionAreas.map((area) => {
              const areaId = String(area.id || '').trim();
              if (!areaId) return null;
              const queue = Number(productionQueuesByArea[areaId] || 0);
              const level = getQueueLevel(queue);
              const tone = productionAreaTone(areaId);
              const Icon = tone.icon;
              return (
                <button
                  key={areaId}
                  type="button"
                  onClick={() => navigate(`/admin/produccion/${areaId}`)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors hover:opacity-95 ${level.card}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className={`flex items-center gap-1.5 font-semibold text-xs ${tone.title}`}>
                      <Icon className="shrink-0" />
                      <span className="truncate">{area.name || areaId}</span>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${level.pill}`}>
                      {level.label}
                    </span>
                  </div>
                  <p className={`text-lg font-bold tabular-nums mt-1 ${tone.value}`}>{queue}</p>
                  <p className={`text-[11px] ${tone.sub}`}>Pedidos en cola</p>
                  <p className={`text-[11px] font-medium mt-0.5 ${tone.link}`}>
                    Ir a {area.name || areaId}
                  </p>
                </button>
              );
            })}
            {deliveryModuleActive ? (
            <button
              type="button"
              onClick={() => navigate('/admin/delivery')}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left hover:bg-emerald-100 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-emerald-700 font-semibold text-xs">
                <MdDeliveryDining className="shrink-0" />
                Delivery
              </div>
              <p className="text-lg font-bold text-emerald-800 tabular-nums mt-1">
                {Number(liveDash.deliveryActiveCount || 0)}
              </p>
              <p className="text-[11px] text-emerald-700">
                En curso · {deliveryReady} listos para repartir
              </p>
              <p className="text-[11px] font-medium ui-live-link-emerald mt-0.5">Ir a Delivery</p>
            </button>
            ) : null}
            <button
              type="button"
              onClick={() => navigate('/admin/mesas')}
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-left hover:bg-rose-100 transition-colors"
            >
              <div className="flex items-center gap-1.5 text-rose-700 font-semibold text-xs">
                <MdTableBar className="shrink-0" />
                Mesas
              </div>
              <p className="text-lg font-bold text-rose-800 tabular-nums mt-1">
                {Number(liveDash.tablesWithActiveOrders || 0)}
              </p>
              <p className="text-[11px] text-rose-700">
                Con cuenta · {salonActive} pedidos en salón
              </p>
              <p className="text-[11px] font-medium ui-live-link-rose mt-0.5">Ir a Mesas</p>
            </button>
            {showStockAlertPanel ? (
            <button
              type="button"
              onClick={() => navigate('/admin/almacen')}
              className="rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2 text-left hover:bg-[var(--ui-sidebar-hover)] transition-colors"
            >
              <p className="text-[10px] uppercase tracking-wide text-[var(--ui-muted)]">Stock ≤ 10</p>
              <p className="text-lg font-bold text-[var(--ui-body-text)] tabular-nums mt-1">{liveDash.lowStock?.length ?? 0}</p>
              <p className="text-[11px] text-[var(--ui-muted)]">Inventario</p>
              <p className="text-[11px] font-medium text-[var(--ui-accent-muted)] mt-0.5">Ir a Control De Recursos</p>
            </button>
            ) : null}
          </div>
          {liveDash.operationalSummary &&
          (liveDash.operationalSummary.pendingCount != null ||
            liveDash.operationalSummary.readyCount != null ||
            liveDash.operationalSummary.staleReadyCount != null ||
            liveDash.activeOrders != null) ? (
            <div className="flex flex-wrap gap-2 mb-3 text-[11px] text-[var(--ui-body-text)]">
              <span className="rounded-md border border-[color:var(--ui-border)] bg-[var(--ui-body-bg)] px-2 py-1 tabular-nums">
                Activos: <strong>{Number(liveDash.activeOrders ?? 0)}</strong>
              </span>
              <span className="rounded-md border border-[color:var(--ui-border)] bg-[var(--ui-body-bg)] px-2 py-1 tabular-nums">
                Pendientes: <strong>{Number(liveDash.operationalSummary.pendingCount ?? 0)}</strong>
              </span>
              <span className="rounded-md border border-[color:var(--ui-border)] bg-[var(--ui-body-bg)] px-2 py-1 tabular-nums">
                Listos: <strong>{Number(liveDash.operationalSummary.readyCount ?? 0)}</strong>
              </span>
              {productionQueueTotal > 0 && Number(liveDash.operationalSummary.staleReadyCount ?? 0) > 0 ? (
              <span
                className="rounded-md border px-2 py-1 tabular-nums ui-live-pill-stale"
              >
                Listos {'>'}25 min: <strong>{Number(liveDash.operationalSummary.staleReadyCount ?? 0)}</strong>
              </span>
              ) : null}
            </div>
          ) : null}
          {liveDash.insightToday ? (
            <p className="text-xs text-[var(--ui-accent-muted)] mb-2">{liveDash.insightToday}</p>
          ) : null}
          <div className="border-t border-[color:var(--ui-border)] pt-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {visibleOperationalAlerts.length > 0 ? (
                <ul className="space-y-1.5">
                  {visibleOperationalAlerts.map((a) => {
                    const alertBody = (
                      <>
                        <MdWarning className="shrink-0 text-lg ui-live-alert-icon mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="font-semibold">{a.title}: </span>
                          {a.message}
                          {a.linkTo && a.linkLabel ? (
                            <span className="block mt-1 text-xs font-semibold ui-live-alert-link underline-offset-2 group-hover:underline">
                              {a.linkLabel}
                            </span>
                          ) : null}
                        </span>
                      </>
                    );
                    const alertClass = `flex items-start gap-2 text-sm rounded-lg px-2 py-1.5 ${
                      a.severity === 'warning' ? 'ui-live-alert-warning' : 'ui-live-alert-info'
                    }${a.linkTo ? ' group cursor-pointer hover:brightness-[0.98] transition' : ''}`;

                    return (
                      <li key={a.id}>
                        {a.linkTo ? (
                          <Link to={a.linkTo} className={alertClass} title={a.linkLabel || a.title}>
                            {alertBody}
                          </Link>
                        ) : (
                          <div className={alertClass}>{alertBody}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-[var(--ui-muted)]">Sin alertas operativas en este momento.</p>
              )}
            </div>
            <Link
              to="/admin/indicadores?tab=alertas"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[color:var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-body-text)] hover:bg-[var(--ui-sidebar-hover)] transition-colors"
              title="Ver alertas en Indicadores"
            >
              <MdNotificationsActive className="text-base text-[var(--ui-accent)]" />
              Alertas
              {visibleOperationalAlerts.length > 0 ? (
                <span className="min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center tabular-nums">
                  {visibleOperationalAlerts.length > 99 ? '99+' : visibleOperationalAlerts.length}
                </span>
              ) : null}
            </Link>
          </div>
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="rounded-lg border border-[color:var(--ui-card-border)] bg-[var(--ui-surface)] px-3 py-2">
          <label htmlFor="escritorio-caja-filter" className="flex items-center gap-2 text-xs text-[var(--ui-muted)] mb-1">
            <MdPointOfSale className="shrink-0 text-[var(--ui-accent-muted)]" />
            Caja
          </label>
          <div className="relative">
            <select
              id="escritorio-caja-filter"
              value={selectedCajaStationId}
              onChange={(e) => setSelectedCajaStationId(e.target.value)}
              className="w-full appearance-none rounded-md border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2 pr-8 text-sm font-medium text-[var(--ui-body-text)] focus:outline-none focus:border-[var(--ui-accent-muted)]"
            >
              <option value="">Todas</option>
              {cajaStations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
            <MdKeyboardArrowDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ui-accent-muted)]" />
          </div>
          <p className="text-[11px] text-[var(--ui-muted)] mt-1.5">
            Ventas según cierres de caja · {selectedCajaLabel}
            {activeRegisterBlocks.length > 0 ? (
              <span> · {activeRegisterBlocks.length} turno{activeRegisterBlocks.length === 1 ? '' : 's'}</span>
            ) : null}
          </p>
        </div>

        <div className="rounded-lg border border-[color:var(--ui-card-border)] bg-[var(--ui-surface)] px-3 py-2 text-left text-sm flex flex-col gap-2">
          <div className="grid grid-cols-12 gap-2 relative">
            <button
              type="button"
              onClick={onDateRangeButtonClick}
              className={`col-span-6 rounded-md border px-2 py-1.5 text-left transition-colors min-w-0 ${
                datePreset === 'custom' || datePickStep !== 'idle'
                  ? 'bg-[var(--ui-accent)] border-[var(--ui-accent)] text-white'
                  : 'bg-[var(--ui-surface-2)] border-[color:var(--ui-border)] hover:border-[var(--ui-accent-muted)]'
              }`}
            >
              <div className={`flex items-center gap-2 text-xs ${
                datePreset === 'custom' || datePickStep !== 'idle' ? 'text-white/80' : 'text-[var(--ui-muted)]'
              }`}>
                <MdDateRange className={`shrink-0 ${
                  datePreset === 'custom' || datePickStep !== 'idle' ? 'text-white' : 'text-[var(--ui-accent-muted)]'
                }`} />
                <span className="truncate font-semibold tracking-wide">{datePickerCaption}</span>
                <MdKeyboardArrowDown className={`ml-auto shrink-0 ${
                  datePreset === 'custom' || datePickStep !== 'idle' ? 'text-white' : 'text-[var(--ui-accent-muted)]'
                }`} />
              </div>
              <p className={`mt-0.5 text-[13px] font-medium whitespace-nowrap truncate tabular-nums ${
                datePreset === 'custom' || datePickStep !== 'idle' ? 'text-white' : 'text-[var(--ui-body-text)]'
              }`}>
                {datePickerValue}
              </p>
            </button>
            <button
              type="button"
              onClick={applyWeekRange}
              className={`col-span-2 rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors ${
                datePreset === 'week'
                  ? 'bg-[var(--ui-accent)] border-[var(--ui-accent)] text-white'
                  : 'bg-[var(--ui-surface-2)] border-[color:var(--ui-border)] text-[var(--ui-body-text)] hover:border-[var(--ui-accent-muted)]'
              }`}
            >
              Semana
            </button>
            <button
              type="button"
              onClick={applyMonthRange}
              className={`col-span-2 rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors ${
                datePreset === 'month'
                  ? 'bg-[var(--ui-accent)] border-[var(--ui-accent)] text-white'
                  : 'bg-[var(--ui-surface-2)] border-[color:var(--ui-border)] text-[var(--ui-body-text)] hover:border-[var(--ui-accent-muted)]'
              }`}
            >
              Mes
            </button>
            <button
              type="button"
              onClick={applyTotalRange}
              className={`col-span-2 rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors ${
                datePreset === 'total'
                  ? 'bg-[var(--ui-accent)] border-[var(--ui-accent)] text-white'
                  : 'bg-[var(--ui-surface-2)] border-[color:var(--ui-border)] text-[var(--ui-body-text)] hover:border-[var(--ui-accent-muted)]'
              }`}
            >
              Todos
            </button>
            {/* Inputs casi visibles: showPicker en Android falla con sr-only/clip. */}
            <input
              ref={startDateInputRef}
              type="date"
              value={datePickStep === 'start' ? (pendingStart || '') : (pendingStart || startDate || '')}
              onChange={(e) => {
                const next = e.target.value;
                if (!isIsoDate(next)) return;
                setPendingStart(next);
                setPendingEnd('');
                setDatePickStep('end');
                window.setTimeout(() => {
                  openNativeDatePicker(endDateInputRef);
                }, 320);
              }}
              className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-[0.01]"
              tabIndex={-1}
              aria-label="Fecha de inicio"
            />
            <input
              ref={endDateInputRef}
              type="date"
              value={datePickStep === 'end' ? (pendingEnd || '') : (endDate || '')}
              min={pendingStart || startDate || undefined}
              onChange={(e) => {
                const next = e.target.value;
                if (!isIsoDate(next) || !isIsoDate(pendingStart)) return;
                setPendingEnd(next);
                applyCustomRange(pendingStart, next);
              }}
              className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-[0.01]"
              tabIndex={-1}
              aria-label="Fecha de fin"
            />
          </div>
          <p className="text-[11px] text-[var(--ui-muted)]">
            {datePickStep === 'start'
              ? 'Paso 1 · elige la fecha de inicio'
              : datePickStep === 'end'
                ? 'Paso 2 · elige la fecha de fin (actualiza al confirmar)'
                : dateRangeLabel}
            {registerReportLoading && datePickStep === 'idle' ? ' · actualizando…' : null}
          </p>
        </div>
      </div>

      {registerReportLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--ui-muted)]">
          <div className="animate-spin w-5 h-5 border-2 border-[var(--ui-accent)] border-t-transparent rounded-full" />
          Cargando ventas por cierres de caja…
        </div>
      ) : null}

      <div className={registerReportLoading ? 'space-y-4 opacity-60 pointer-events-none' : 'space-y-4'}>
      <div className="card p-4">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-2 min-w-0 self-start overflow-visible">
            <div className="grid grid-cols-2 xl:grid-cols-1 gap-3">
              <div className="min-w-0">
                <p className="text-xs text-[var(--ui-muted)]">Hora punta</p>
                <p className="text-3xl font-light text-[var(--ui-body-text)] leading-normal tabular-nums py-1 min-h-[2.5rem] flex items-center">
                  {peakHour.hour}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-[var(--ui-muted)]">Hora más libre</p>
                <p className="text-3xl font-light text-[var(--ui-body-text)] leading-normal tabular-nums py-1 min-h-[2.5rem] flex items-center">
                  {lowHour.hour}
                </p>
              </div>
            </div>
          </div>

          <div className="xl:col-span-10">
            <div className="flex flex-nowrap items-center gap-1.5 sm:gap-2 mb-2">
              <button
                type="button"
                onClick={goToOlderHourlyDay}
                disabled={!hourlySalesHistory.length || hourlyHistoryIndex >= hourlySalesHistory.length - 1}
                className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] disabled:opacity-40 disabled:cursor-not-allowed hover:border-[var(--ui-accent-muted)]"
                title="Día anterior"
                aria-label="Ver día anterior"
              >
                <MdChevronLeft className="text-xl" />
              </button>
              <div className="flex-1 min-w-0 text-center px-0.5">
                <h3 className="text-sm sm:text-base text-[var(--ui-body-text)] font-medium leading-snug">
                  <span className="sm:hidden">Cobros del día</span>
                  <span className="hidden sm:inline">Cobros del día · barras y tendencia</span>
                </h3>
                <p className="text-[11px] sm:text-xs text-[var(--ui-muted)] tabular-nums leading-snug break-words">
                  {hourlyHistoryEntry
                    ? `${hourlyHistoryEntry.dateLabel} · ${formatCurrency(hourlyHistoryEntry.total)} · ${hourlyHistoryEntry.accountCount} cuenta(s)`
                    : 'Sin datos en el rango'}
                  {hourlySalesHistory.length > 1 ? (
                    <span> · {hourlyHistoryIndex + 1}/{hourlySalesHistory.length}</span>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                onClick={goToNewerHourlyDay}
                disabled={!hourlySalesHistory.length || hourlyHistoryIndex <= 0}
                className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] disabled:opacity-40 disabled:cursor-not-allowed hover:border-[var(--ui-accent-muted)]"
                title="Día siguiente"
                aria-label="Ver día siguiente"
              >
                <MdChevronRight className="text-xl" />
              </button>
            </div>
            {hourlySalesHistory.length > 1 ? (
              <p className="text-[11px] text-center text-[var(--ui-muted)] mb-2">
                Desliza el gráfico o usa las flechas para recorrer el historial diario
              </p>
            ) : null}
            <div
              className="touch-pan-y"
              onTouchStart={onHourlyChartTouchStart}
              onTouchEnd={onHourlyChartTouchEnd}
            >
              {paymentSales.length > 0 ? (
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart
                    data={paymentSales}
                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--ui-border)" strokeOpacity={0.55} />
                    <XAxis
                      type="number"
                      dataKey="minuteOfDay"
                      domain={paymentTimeAxis.domain}
                      ticks={paymentTimeAxis.ticks}
                      tickCount={paymentTimeAxis.ticks.length}
                      interval={0}
                      tick={{ fontSize: 10, fill: 'var(--ui-muted)' }}
                      tickFormatter={formatMinuteOfDayLabel}
                      allowDecimals={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--ui-muted)' }}
                      width={48}
                      tickFormatter={(v) => formatChartYAxisTick(v)}
                    />
                    <Tooltip
                      cursor={{ stroke: 'var(--ui-border)', strokeWidth: 1 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload.find((p) => p?.dataKey === 'amount')?.payload
                          || payload[0]?.payload;
                        if (!row) return null;
                        const barColor = row.fill || colorForPaymentMethod(row.paymentMethod, themeAccent);
                        return (
                          <div
                            className="rounded-lg border px-3 py-2 text-xs shadow-sm"
                            style={{
                              background: 'var(--ui-surface-2)',
                              borderColor: 'var(--ui-border)',
                              color: 'var(--ui-body-text)',
                            }}
                          >
                            <p className="font-semibold tabular-nums">
                              {hourlyHistoryEntry?.dateLabel || ''} · {row.label}
                            </p>
                            <p className="text-[var(--ui-muted)] mt-0.5">{row.mesaLabel}</p>
                            <p className="text-[var(--ui-muted)]">{row.paymentLabel}</p>
                            <p className="mt-1 font-bold tabular-nums" style={{ color: barColor }}>
                              {formatCurrency(row.amount)}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="amount"
                      barSize={8}
                      maxBarSize={10}
                      radius={[3, 3, 0, 0]}
                      name="Cobro"
                      isAnimationActive={false}
                    >
                      {paymentSales.map((row) => (
                        <Cell key={row.id} fill={row.fill || colorForPaymentMethod(row.paymentMethod, themeAccent)} />
                      ))}
                    </Bar>
                    <Line
                      type="monotone"
                      dataKey="amount"
                      stroke={themeAccent}
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: themeAccent, strokeWidth: 0 }}
                      activeDot={{ r: 4 }}
                      name="Tendencia"
                      legendType="none"
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[190px] flex items-center justify-center text-sm text-[var(--ui-muted)]">
                  Sin cobros en este día
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-8 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { key: 'cash', label: 'Ventas en efectivo', amount: salesByPayment.efectivo, currency: true, icon: MdPayments, color: '#10b981' },
            { key: 'card', label: 'Ventas con tarjeta', amount: salesByPayment.tarjeta, currency: true, icon: MdCreditCard, color: '#3b82f6' },
            { key: 'qr', label: 'Yape/Plin', amount: (salesByPayment.yape || 0) + (salesByPayment.plin || 0), currency: true, icon: MdPhoneIphone, color: '#8b5cf6' },
            { key: 'total', label: 'Total de ventas', amount: totalSales, currency: true, icon: MdBarChart, color: '#2563eb' },
            { key: 'expense', label: 'Egresos de caja', amount: totalCashExpenses, currency: true, icon: MdPointOfSale, color: '#ef4444' },
            { key: 'discount', label: 'Total de descuentos', amount: totalDiscounts, currency: true, icon: MdLocalOffer, color: '#f59e0b' },
            { key: 'credit', label: 'Ventas al crédito', amount: totalCredit, currency: true, icon: MdCreditScore, color: '#14b8a6' },
            { key: 'debit', label: 'Cobro de débito', amount: totalDebitIncome, currency: true, icon: MdAccountBalance, color: '#7c3aed' },
            { key: 'clients', label: 'Clientes', amount: paidAccountsCount, currency: false, icon: MdPeople, color: '#0ea5e9' },
            { key: 'avg', label: 'Promedio de venta', amount: averageSaleAmount, currency: true, icon: MdShowChart, color: '#f97316' },
            { key: 'products', label: 'Productos vendidos', amount: productsSoldCount, currency: false, icon: MdInventory2, color: '#22c55e' },
            { key: 'courtesy', label: 'Cortesías', amount: courtesyCount, currency: false, icon: MdCardGiftcard, color: '#f43f5e' },
          ].map((item) => (
            <DashboardKpiCard key={item.key} item={item} />
          ))}
        </div>

        <div className="xl:col-span-4 space-y-4">
        <div className="card p-4">
          <div className="inline-flex w-full rounded-lg border border-[color:var(--ui-border)] overflow-hidden mb-3">
            <button
              type="button"
              onClick={() => setRankingMode('dias')}
              className={`flex-1 px-3 py-2 text-sm font-semibold transition-colors ${
                rankingMode === 'dias' ? 'bg-[var(--ui-accent)] text-white' : 'bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] hover:bg-[var(--ui-sidebar-hover)]'
              }`}
            >
              Top días
            </button>
            <button
              type="button"
              onClick={() => setRankingMode('mesas')}
              className={`flex-1 px-3 py-2 text-sm font-semibold transition-colors border-l border-[color:var(--ui-border)] ${
                rankingMode === 'mesas' ? 'bg-[var(--ui-accent)] text-white' : 'bg-[var(--ui-surface-2)] text-[var(--ui-body-text)] hover:bg-[var(--ui-sidebar-hover)]'
              }`}
            >
              Top mesas
            </button>
          </div>
          {rankingMode === 'dias' ? (
            <div className="relative h-[220px]">
              {topDiasHasSales ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={topDiasData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap="18%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--ui-border)" strokeOpacity={0.55} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--ui-muted)' }} interval={0} />
                    <YAxis
                      domain={[0, topDiasYMax]}
                      ticks={topDiasYTicks}
                      allowDecimals={false}
                      tick={{ fontSize: 10, fill: 'var(--ui-muted)' }}
                      width={52}
                      tickFormatter={formatChartYAxisTick}
                    />
                    <Tooltip
                      cursor={{ fill: 'color-mix(in srgb, var(--ui-accent-muted) 12%, transparent)' }}
                      formatter={(v) => [formatCurrency(v), 'Total vendido']}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.label || _label}
                      contentStyle={{
                        background: 'var(--ui-surface-2)',
                        border: '1px solid var(--ui-border)',
                        borderRadius: '8px',
                        color: 'var(--ui-body-text)',
                      }}
                    />
                    <Bar dataKey="value" fill="#f59e0b" radius={[6, 6, 0, 0]} maxBarSize={48} name="Ventas" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="absolute inset-0 flex items-center justify-center text-xs text-[var(--ui-muted)] px-4 text-center">
                  Sin ventas en el periodo por día de la semana.
                </p>
              )}
            </div>
          ) : (
            <div className="relative h-[220px]">
              {topMesasHasSales ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={topMesasData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap="18%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--ui-border)" strokeOpacity={0.55} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--ui-muted)' }} interval={0} />
                    <YAxis
                      domain={[0, topMesasYMax]}
                      ticks={topMesasYTicks}
                      allowDecimals={false}
                      tick={{ fontSize: 10, fill: 'var(--ui-muted)' }}
                      width={52}
                      tickFormatter={formatChartYAxisTick}
                    />
                    <Tooltip
                      cursor={{ fill: 'color-mix(in srgb, var(--ui-accent-muted) 12%, transparent)' }}
                      formatter={(v) => [formatCurrency(v), 'Total vendido']}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.label || _label}
                      contentStyle={{
                        background: 'var(--ui-surface-2)',
                        border: '1px solid var(--ui-border)',
                        borderRadius: '8px',
                        color: 'var(--ui-body-text)',
                      }}
                    />
                    <Bar dataKey="value" fill="var(--ui-accent-muted)" radius={[6, 6, 0, 0]} maxBarSize={48} name="Ventas" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="absolute inset-0 flex items-center justify-center text-xs text-[var(--ui-muted)] px-4 text-center">
                  Sin ventas por mesa en el periodo seleccionado.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="card p-4">
          <p className="text-sm font-semibold text-[var(--ui-body-text)] mb-3">Métodos de pago</p>
          <div className="relative h-[220px]">
            {paymentPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <Pie
                    data={paymentPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="52%"
                    outerRadius="78%"
                    paddingAngle={2}
                    label={false}
                  >
                    {paymentPieData.map((row) => (
                      <Cell key={row.key} fill={colorForPaymentMethod(row.key)} stroke="var(--ui-border)" />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v, name) => [formatCurrency(v), name]}
                    contentStyle={{
                      background: 'var(--ui-surface-2)',
                      border: '1px solid var(--ui-border)',
                      borderRadius: '8px',
                      color: 'var(--ui-body-text)',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : null}
          </div>
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}
