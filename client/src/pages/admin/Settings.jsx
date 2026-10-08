import { useState, useEffect, useRef, useMemo } from 'react';
import {
  api,
  buildConfiguredPrintingLinkStatus,
  checkPrintingHealth,
  electronPrinting,
  formatDateTime,
  getApiOrigin,
  getPersistedPrintingBridgeOrigin,
  getPrintingApiBase,
  hasElectronPrinting,
  isPrintingLinkConfigured,
  fetchUsbPrintersFromBridge,
  markPrintingLinkConfigured,
  normalizeUsbPrinterList,
  persistPrintingBridgeOrigin,
  printingUnreachableMessage,
  resolvePrintingAssistantOrigin,
  usesInstalledLocalPrinting,
} from '../../utils/api';
import PrintingAssistantDownloadButton from '../../components/printing/PrintingAssistantDownloadButton';
import { useAuth } from '../../context/AuthContext';
import Modal from '../../components/Modal';
import toast from 'react-hot-toast';
import {
  MdPeople, MdAdd, MdEdit, MdDelete, MdPerson,
  MdAdminPanelSettings, MdPointOfSale, MdRoomService,
  MdKitchen, MdLocalBar,
  MdVisibility, MdVisibilityOff, MdSettings, MdStore,
  MdSave, MdSchedule, MdAttachMoney, MdLanguage,
  MdStorefront, MdWarehouse, MdTableRestaurant,
  MdReceipt, MdPercent, MdCreditCard,
  MdAccessTime, MdMonetizationOn, MdAccountBalanceWallet,
  MdBrandingWatermark, MdImage, MdBlockFlipped, MdPayment,
  MdChevronRight, MdExpandMore, MdArrowBack, MdInventory, MdSwapHoriz,
  MdLabel, MdDoNotDisturb, MdCategory, MdHistory,
  MdSecurity, MdDashboard, MdEventSeat, MdDeliveryDining, MdPhotoCamera,
  MdAssessment, MdInsights, MdLocalOffer,
  MdTableBar, MdPeopleAlt, MdRestaurantMenu, MdTouchApp, MdPalette,
  MdAutoGraph, MdStars,
} from 'react-icons/md';
import { applyUiThemeFromAppSettings } from '../../theme/uiTheme';
import { UI_BADGE } from '../../utils/uiBadges';
import { formatCatalogNameInput } from '../../utils/catalogNameFormat';
import {
  cachePrintingConfig,
  normalizePrintingConfig,
  savePrintingModuleAutoPrint,
  listPrintingUiModules,
  ensurePrintingConfigForAreas,
  printingModuleLabel,
} from '../../utils/printingConfig';
import { syncLocaleFromRegional, setAppLocale } from '../../i18n';
import { normalizeConfigFromApi, mergeSavedAppSettings } from '../../utils/appSettingsNormalize';
import { salonSlugFromName, reorderSalonList, tablesForSalon } from '../../utils/salonesUtils';
import { getTableDisplayLabel, normalizeTableDisplayLabel } from '../../utils/mesaMapTableVisual';
import SettingsAppearancePanel from '../../components/settings/SettingsAppearancePanel';
import ProductionAreasSection from '../../components/settings/ProductionAreasSection';
import { useSocket } from '../../hooks/useSocket';
import { useConfigHub } from '../../hooks/useConfigHub';
import SettingsConfigHubBanner from '../../components/settings/SettingsConfigHubBanner';
import SettingsRegionalPanel from '../../components/settings/SettingsRegionalPanel';
import SettingsSectionInsights from '../../components/settings/SettingsSectionInsights';

const ALL_MODULES = [
  { id: 'escritorio', label: 'Escritorio', icon: MdDashboard, defaultRoles: ['admin'] },
  { id: 'ventas', label: 'Ventas', icon: MdAttachMoney, defaultRoles: ['admin'] },
  { id: 'caja', label: 'Caja', icon: MdPointOfSale, defaultRoles: ['admin', 'cajero'] },
  { id: 'mesas', label: 'Mesas', icon: MdTableBar, defaultRoles: ['admin', 'mozo'] },
  { id: 'cocina', label: 'Cocina', icon: MdKitchen, defaultRoles: ['admin'] },
  { id: 'bar', label: 'Bar', icon: MdLocalBar, defaultRoles: ['admin'] },
  { id: 'reservas', label: 'Reservas', icon: MdEventSeat, defaultRoles: ['admin'] },
  { id: 'auto_pedido', label: 'Auto pedido', icon: MdTouchApp, defaultRoles: ['admin'] },
  { id: 'creditos', label: 'Créditos', icon: MdCreditCard, defaultRoles: ['admin'] },
  { id: 'clientes', label: 'Clientes', icon: MdPeopleAlt, defaultRoles: ['admin'] },
  { id: 'productos', label: 'Productos', icon: MdRestaurantMenu, defaultRoles: ['admin'] },
  { id: 'ofertas', label: 'Promociones', icon: MdLocalOffer, defaultRoles: ['admin'] },
  { id: 'almacen', label: 'Control De Recursos', icon: MdWarehouse, defaultRoles: ['admin'] },
  { id: 'delivery', label: 'Delivery', icon: MdDeliveryDining, defaultRoles: ['admin', 'delivery'] },
  { id: 'informes', label: 'Informes', icon: MdAssessment, defaultRoles: ['admin'] },
  { id: 'indicadores', label: 'Indicadores', icon: MdInsights, defaultRoles: ['admin'] },
  { id: 'fidelizacion', label: 'Fidelización', icon: MdStars, defaultRoles: ['admin'] },
  { id: 'mi_restaurant', label: 'Mi empresa', icon: MdStorefront, defaultRoles: ['admin'] },
  { id: 'tiempo_trabajado', label: 'Recursos humanos', icon: MdAccessTime, defaultRoles: ['admin'] },
  { id: 'configuracion', label: 'Configuración', icon: MdSettings, defaultRoles: ['admin'] },
];

const CAJA_EXTRA_PERMISSIONS = [
  { key: 'caja:eliminar_liberar_mesa', label: 'Eliminar y liberar mesa', hint: 'Solo cajeros: quitar productos y liberar mesas desde caja' },
];

const ROLES = {
  admin: { label: 'Administrador', icon: MdAdminPanelSettings, color: UI_BADGE.purple, desc: 'Acceso completo al sistema' },
  cajero: { label: 'Cajero', icon: MdPointOfSale, color: UI_BADGE.blue, desc: 'Solo su caja' },
  mozo: { label: 'Mozo', icon: MdRoomService, color: UI_BADGE.emerald, desc: 'Mesas y pedidos de su caja' },
  produccion: { label: 'Producción', icon: MdKitchen, color: UI_BADGE.amber, desc: 'Se vincula al área desde Áreas de producción' },
  delivery: { label: 'Delivery', icon: MdDeliveryDining, color: UI_BADGE.sky, desc: 'Reparto y entregas' },
};

function uiStaffRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'cocina' || r === 'bar') return 'produccion';
  return r;
}

function isProductionStaffRole(role) {
  return ['produccion', 'cocina', 'bar'].includes(String(role || '').toLowerCase());
}

/** Permisos de estación según el área vinculada (nunca forzar Cocina si el área es otra). */
function defaultProductionAreaPermissions(user) {
  const role = String(user?.role || '').toLowerCase();
  const area = String(user?.production_area_id || '').trim().toLowerCase();
  const out = { cocina: false, bar: false, produccion: false };
  if (role === 'bar' || area === 'bar') {
    out.bar = true;
  } else if (role === 'cocina' || area === 'cocina') {
    out.cocina = true;
  } else if (area) {
    // Área personalizada (ej. Parrilla): acceso por área, no por Cocina/Bar.
    out.produccion = true;
  } else if (role === 'produccion') {
    // Sin área aún: no asignar Cocina por defecto.
  } else {
    out.cocina = true;
  }
  return out;
}

function isModuleDefaultForUser(mod, user) {
  if (!mod || !user) return false;
  if (isProductionStaffRole(user.role)) {
    if (mod.isProductionAreaLink) return true;
    if (mod.id === 'cocina' || mod.id === 'bar') {
      return Boolean(defaultProductionAreaPermissions(user)[mod.id]);
    }
    return false;
  }
  const role = String(user.role || '').toLowerCase();
  return (mod.defaultRoles || []).includes(role) || (mod.defaultRoles || []).includes(uiStaffRole(role));
}

function buildPermModulesForUser(user, areaNameById) {
  if (!isProductionStaffRole(user?.role)) return ALL_MODULES;
  const areaId = String(user?.production_area_id || '').trim();
  const areaLc = areaId.toLowerCase();
  const areaName = (areaNameById && areaNameById.get(areaId)) || areaId || 'Área de producción';
  const withoutStations = ALL_MODULES.filter((m) => m.id !== 'cocina' && m.id !== 'bar');
  const insertAt = Math.max(0, withoutStations.findIndex((m) => m.id === 'mesas') + 1);
  const areaRow = {
    id: '_production_area',
    label: areaName,
    icon: MdKitchen,
    defaultRoles: ['produccion'],
    isProductionAreaLink: true,
    productionAreaId: areaId,
    hint: areaId
      ? 'Área vinculada en Áreas de producción'
      : 'Vincula un área en Configuración → Áreas de producción',
  };
  // Si el área es cocina/bar legado, mostrar con ese nombre; si es custom, solo el área.
  if (areaLc === 'cocina' || areaLc === 'bar') {
    areaRow.label = areaLc === 'bar' ? 'Bar' : 'Cocina';
  }
  const next = [...withoutStations];
  next.splice(insertAt, 0, areaRow);
  return next;
}

const DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const DAY_NAMES = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };
const DEFAULT_PRINTING_CONFIG = {
  caja: { tipo: 'usb', nombre: '', ip: '', puerto: 9100, autoPrint: true, paperWidth: 80, anchoPapel: 80 },
  cocina: { tipo: 'usb', nombre: '', ip: '', puerto: 9100, autoPrint: true, paperWidth: 80, anchoPapel: 80 },
  bar: { tipo: 'usb', nombre: '', ip: '', puerto: 9100, autoPrint: true, paperWidth: 80, anchoPapel: 80 },
};
const PRINTING_CONFIG_CACHE_KEY = 'resto_printing_config_cache_v1';

const MENU_ITEMS = [
  { id: 'regional', label: 'Configuración regional', icon: MdLanguage },
  { id: 'locales', label: 'Locales', icon: MdStorefront },
  { id: 'users', label: 'Usuarios', icon: MdPeople },
  { id: 'almacenes', label: 'Almacenes y Producción', icon: MdWarehouse },
  { id: 'salones', label: 'Salones y Mesas', icon: MdTableRestaurant },
  { id: 'production_areas', label: 'Áreas de producción', icon: MdKitchen },
  { id: 'cajas', label: 'Cajas', icon: MdPointOfSale },
  { id: 'comprobantes', label: 'Comprobantes', icon: MdReceipt },
  { id: 'impresoras', label: 'Configuración de Impresoras', icon: MdReceipt },
  { id: 'impuestos', label: 'Impuestos', icon: MdPercent },
  { id: 'tarjetas', label: 'Tarjetas', icon: MdCreditCard },
  { id: 'turnos', label: 'Turnos', icon: MdAccessTime },
  { id: 'jornada_laboral', label: 'Jornada y asistencia', icon: MdPhotoCamera },
  { id: 'monedas', label: 'Monedas', icon: MdMonetizationOn },
  { id: 'moneda_facturacion', label: 'Moneda de facturación', icon: MdAttachMoney },
  { id: 'cuentas_transferencia', label: 'Cuentas de transferencia', icon: MdSwapHoriz },
  { id: 'marcas', label: 'Gestión de marcas', icon: MdLabel },
  { id: 'categoria_anular', label: 'Categoría Anular Venta', icon: MdDoNotDisturb },
  { id: 'formas_pago', label: 'Formas de pago', icon: MdPayment },
  { id: 'apariencia', label: 'Apariencia', icon: MdPalette },
  { id: 'modulo_empresarial', label: 'Módulo empresarial', icon: MdAutoGraph },
  { id: 'config_historial', label: 'Historial de configuración', icon: MdHistory },
];
/** Regional se guarda solo con «Guardar regional» (endpoint dedicado), sin autoguardado. */
const PARTIAL_SECTIONS = new Set([
  'locales', 'almacenes', 'cajas', 'comprobantes',
  'tarjetas', 'monedas', 'cuentas_transferencia', 'marcas',
  'categoria_anular', 'formas_pago', 'apariencia',
]);
/** Claves para filtrar el historial (incluye legado imagenes_self). */
const HISTORY_FILTER_SECTIONS = [...PARTIAL_SECTIONS, 'imagenes_self', 'regional'];
const REQUIRED_ACTIVE_SECTIONS = new Set(['comprobantes', 'formas_pago']);

const DEFAULT_APP_SETTINGS = {
  regional: {
    country: 'Peru',
    timezone: 'America/Lima',
    language: 'es',
    date_format: 'DD/MM/YYYY',
    time_format: '24h',
    currency_code: 'PEN',
    currency_symbol: 'S/',
    decimal_separator: '.',
    thousands_separator: ',',
    ticket_language: 'es',
    number_decimals: 2,
    rounding_mode: 'standard',
  },
  locales: [{ name: 'Principal', address: '', phone: '', active: 1 }],
  almacenes: [{ name: 'Almacén Principal', description: 'Almacén general de insumos', active: 1 }],
  production_areas: [
    { id: 'cocina', name: 'Cocina', active: 1, encargado_user_ids: [], mozo_user_ids: [] },
    { id: 'bar', name: 'Bar', active: 1, encargado_user_ids: [], mozo_user_ids: [] },
  ],
  cajas: [{
    id: 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001',
    name: 'Caja Principal',
    description: 'Caja #1 - Recepción',
    active: 1,
  }],
  salones: [{
    id: 'principal',
    name: 'Salón Principal',
    description: 'Área principal del restaurante',
    sort_order: 0,
    caja_station_id: 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001',
  }],
  comprobantes: [
    { name: 'Boleta de Venta', series: 'B001', active: 1 },
    { name: 'Factura', series: 'F001', active: 1 },
    { name: 'Nota de Venta', series: 'N001', active: 1 },
  ],
  impresoras: [
    { name: 'Impresora Cocina', area: 'Comandas', station: 'cocina', connection: 'browser', printer_type: 'lan', ip_address: '', port: 9100, width_mm: 80, copies: 1, active: 1, auto_print: 1, local_printer_name: '' },
    { name: 'Impresora Bar', area: 'Comandas Bar', station: 'bar', connection: 'browser', printer_type: 'lan', ip_address: '', port: 9100, width_mm: 80, copies: 1, active: 1, auto_print: 1, local_printer_name: '' },
    { name: 'Impresora Caja', area: 'Comprobantes', station: 'caja', connection: 'browser', printer_type: 'lan', ip_address: '', port: 9100, width_mm: 80, copies: 1, active: 1, auto_print: 1, local_printer_name: '' },
  ],
  tarjetas: [
    { name: 'Visa', fee_percent: 2.5, active: 1 },
    { name: 'Mastercard', fee_percent: 3, active: 1 },
  ],
  monedas: [
    { code: 'PEN', name: 'Sol Peruano', symbol: 'S/', active: 1 },
    { code: 'USD', name: 'Dólar Americano', symbol: '$', active: 0 },
  ],
  cuentas_transferencia: [],
  marcas: [],
  imagenes_self: [],
  categoria_anular: ['Error en el pedido', 'Cliente se retiró'],
  formas_pago: [
    { name: 'Efectivo', desc: 'Pago en efectivo', active: 1 },
    { name: 'Yape', desc: 'Pago móvil BCP', active: 0 },
    { name: 'Plin', desc: 'Pago móvil Interbank', active: 0 },
    { name: 'Tarjeta', desc: 'Visa, Mastercard, etc.', active: 1 },
  ],
  impuestos: {
    name: 'IGV',
    rate: 18,
    included_in_price: 1,
  },
  jornada_laboral: {
    requiere_foto_inicio_sesion: 0,
    requiere_foto_fin_jornada: 0,
    requiere_foto_asistencia: 0,
  },
  /** Tema visual del panel — ver theme/themePresets.js */
  ui_theme: 'corporate_blue',
  ui_theme_mode: 'light',
  ui_theme_custom: {},
};

/** Alineado con server/services/jornadaLaboralService.normalizeJornadaLaboral */
function getJornadaLaboralToggles(jl) {
  const o = jl && typeof jl === 'object' ? jl : {};
  const inicio = Object.prototype.hasOwnProperty.call(o, 'requiere_foto_inicio_sesion')
    ? Number(o.requiere_foto_inicio_sesion) === 1
    : false;
  const fin = Object.prototype.hasOwnProperty.call(o, 'requiere_foto_fin_jornada')
    ? Number(o.requiere_foto_fin_jornada) === 1
    : false;
  return { inicio, fin };
}

const SETTINGS_SECTION_FORMS = {
  locales: {
    title: 'Local',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'address', label: 'Dirección' },
      { key: 'phone', label: 'Teléfono' },
      { key: 'reference', label: 'Referencia / indicaciones' },
      { key: 'whatsapp', label: 'WhatsApp (con código país)' },
      { key: 'lat', label: 'Latitud (mapa)' },
      { key: 'lng', label: 'Longitud (mapa)' },
      { key: 'maps_url', label: 'Enlace Google Maps' },
    ],
  },
  almacenes: {
    title: 'Almacén',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'description', label: 'Descripción' },
    ],
  },
  cajas: {
    title: 'Caja',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'description', label: 'Descripción' },
    ],
  },
  comprobantes: {
    title: 'Comprobante',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'series', label: 'Serie', required: true },
    ],
  },
  tarjetas: {
    title: 'Tarjeta',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'fee_percent', label: 'Comisión (%)', type: 'number' },
    ],
  },
  monedas: {
    title: 'Moneda',
    fields: [
      { key: 'code', label: 'Código', required: true },
      { key: 'name', label: 'Nombre', required: true },
      { key: 'symbol', label: 'Símbolo', required: true },
    ],
  },
  cuentas_transferencia: {
    title: 'Cuenta de transferencia',
    fields: [
      { key: 'bank', label: 'Banco', required: true },
      { key: 'account', label: 'Nro. cuenta', required: true },
      { key: 'cci', label: 'CCI / interbancario' },
      { key: 'type', label: 'Tipo de cuenta' },
      { key: 'holder', label: 'Titular' },
    ],
  },
  marcas: {
    title: 'Marca',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
    ],
  },
  formas_pago: {
    title: 'Forma de pago',
    fields: [
      { key: 'name', label: 'Nombre', required: true },
      { key: 'desc', label: 'Descripción' },
    ],
  },
  categoria_anular: {
    title: 'Motivo de anulación',
    fields: [
      { key: 'value', label: 'Motivo', required: true },
    ],
  },
};
function newLocalCajaId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `caja_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureCajaIdsDeep(cajas) {
  if (!Array.isArray(cajas)) return [];
  return cajas.map((c) => {
    const id = String(c?.id || '').trim();
    if (id) return { ...c };
    return { ...c, id: newLocalCajaId() };
  });
}

const EMPTY_USER_FORM = {
  username: '', email: '', password: '', full_name: '', role: 'mozo', phone: '', is_active: 1,
  caja_station_id: '', production_area_id: '', production_area_ids: [],
};

/** WhatsApp proveedor: nuevas sucursales/locales son contratación aparte. */
const WHATSAPP_PROVEEDOR_LOCALES =
  'https://wa.me/51935968198?text=' + encodeURIComponent(
    'Hola, solicito información para agregar una sucursal o local adicional a mi sistema.'
  );

export default function Settings() {
  const [activeSection, setActiveSection] = useState(null);
  /** En teléfono: lista de opciones abierta/cerrada. En escritorio se ignora (siempre visible). */
  const [settingsNavOpen, setSettingsNavOpen] = useState(true);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [showPw, setShowPw] = useState(false);
  const [form, setForm] = useState(EMPTY_USER_FORM);
  const [restaurant, setRestaurant] = useState(null);
  const [appSettings, setAppSettings] = useState(DEFAULT_APP_SETTINGS);
  const [appSettingsSnapshot, setAppSettingsSnapshot] = useState(JSON.stringify(DEFAULT_APP_SETTINGS));
  /** Borrador regional: no dispara autoguardado del resto de configuración. */
  const [regionalDraft, setRegionalDraft] = useState(DEFAULT_APP_SETTINGS.regional);
  const [regionalSavedJson, setRegionalSavedJson] = useState(() =>
    JSON.stringify(DEFAULT_APP_SETTINGS.regional),
  );
  const [isSavingAppSettings, setIsSavingAppSettings] = useState(false);
  const [settingsHistory, setSettingsHistory] = useState([]);
  const [settingsHistoryLoading, setSettingsHistoryLoading] = useState(false);
  const [isRollingBackSettings, setIsRollingBackSettings] = useState(false);
  const [historyFilterSection, setHistoryFilterSection] = useState('all');
  const [historyFilterActor, setHistoryFilterActor] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historySearchDebounced, setHistorySearchDebounced] = useState('');
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(8);
  const [historyPreview, setHistoryPreview] = useState(null);
  const [settingsCrudModal, setSettingsCrudModal] = useState({ isOpen: false, section: '', index: null });
  const [settingsCrudForm, setSettingsCrudForm] = useState({});
  const [printingConfig, setPrintingConfig] = useState(DEFAULT_PRINTING_CONFIG);
  const printingModuleEntries = useMemo(
    () => listPrintingUiModules(appSettings?.production_areas),
    [appSettings?.production_areas],
  );
  const printingModuleKeys = useMemo(
    () => printingModuleEntries.map((m) => m.key),
    [printingModuleEntries],
  );
  const [detectedPrintersByModule, setDetectedPrintersByModule] = useState({
    caja: [],
    cocina: [],
    bar: [],
  });
  const [detectedNetworkPrintersByModule, setDetectedNetworkPrintersByModule] = useState({
    caja: [],
    cocina: [],
    bar: [],
  });
  const [printingBusy, setPrintingBusy] = useState(false);
  const [bizEffective, setBizEffective] = useState(null);
  const [bizDraft, setBizDraft] = useState({});
  const [bizLoading, setBizLoading] = useState(false);
  const [bizSaving, setBizSaving] = useState(false);
  const [bizHistRows, setBizHistRows] = useState(null);
  const [printerStatus, setPrinterStatus] = useState({
    caja: { status: 'No disponible', connected: false },
    cocina: { status: 'No disponible', connected: false },
    bar: { status: 'No disponible', connected: false },
  });
  const [printingLinkStatus, setPrintingLinkStatus] = useState({
    checking: false,
    connected: false,
    source: 'Sin verificar',
    detail: '',
  });
  const [manualPrintingApi, setManualPrintingApi] = useState(() => {
    try {
      return getPersistedPrintingBridgeOrigin() || 'http://127.0.0.1:3002';
    } catch (_) {
      return 'http://127.0.0.1:3002';
    }
  });
  const { user: currentUser } = useAuth();
  const { hub: configHub, loading: configHubLoading, reload: reloadConfigHub } = useConfigHub({
    enabled: Boolean(activeSection),
  });
  const autoSaveTimerRef = useRef(null);
  const appearanceSaveTimerRef = useRef(null);
  const pendingAppSettingsSaveRef = useRef(null);
  /** Catálogos editados a mano por el usuario: el servidor no debe "recuperarlos" como si fueran un reset. */
  const catalogEditsRef = useRef(new Set());
  const markCatalogEdit = (section) => {
    if (section === 'cajas' || section === 'salones') catalogEditsRef.current.add(section);
  };
  const appSettingsReadyRef = useRef(false);
  const historySearchTimerRef = useRef(null);
  const appSettingsRef = useRef(appSettings);
  const skipConfigReloadUntilRef = useRef(0);
  appSettingsRef.current = appSettings;
  const serializeAppSettings = (value) => JSON.stringify(value || {});
  const stripRegionalFromSettings = (value) => {
    if (!value || typeof value !== 'object') return value;
    const { regional: _r, ...rest } = value;
    return rest;
  };
  const normalizeConfigPayload = (payload) => {
    const fromApi = normalizeConfigFromApi(payload);
    const merged = {
      ...DEFAULT_APP_SETTINGS,
      ...fromApi,
      regional: { ...DEFAULT_APP_SETTINGS.regional, ...fromApi.regional },
    };
    merged.cajas = ensureCajaIdsDeep(Array.isArray(merged.cajas) ? merged.cajas : []);
    return merged;
  };
  const hasUnsavedAppSettings =
    serializeAppSettings(stripRegionalFromSettings(appSettings)) !==
    serializeAppSettings(stripRegionalFromSettings(JSON.parse(appSettingsSnapshot || '{}')));
  const hasUnsavedRegional = JSON.stringify(regionalDraft || {}) !== regionalSavedJson;

  const loadUsers = () => {
    api.get('/users')
      .then((data) => {
        const list = Array.isArray(data)
          ? data
          : (Array.isArray(data?.users) ? data.users : []);
        setUsers(list);
      })
      .catch((err) => {
        console.error(err);
        toast.error(err?.message || 'No se pudieron cargar los usuarios');
        setUsers([]);
      })
      .finally(() => setLoading(false));
  };

  const loadRestaurant = () => {
    api.get('/restaurant').then(data => {
      if (!data.schedule || typeof data.schedule !== 'object') data.schedule = {};
      DAYS.forEach(d => {
        if (!data.schedule[d]) data.schedule[d] = { open: '11:00', close: '23:00', enabled: true };
      });
      setRestaurant(data);
    }).catch(console.error);
  };

  const loadAppSettings = () => {
    api.get('/admin-modules/config/app')
      .then(cfg => {
        const normalized = normalizeConfigPayload(cfg);
        appSettingsReadyRef.current = true;
        setAppSettings(normalized);
        setAppSettingsSnapshot(serializeAppSettings(normalized));
        setRegionalDraft(normalized.regional || DEFAULT_APP_SETTINGS.regional);
        setRegionalSavedJson(JSON.stringify(normalized.regional || DEFAULT_APP_SETTINGS.regional));
        applyUiThemeFromAppSettings(normalized, currentUser?.id);
        void syncLocaleFromRegional(normalized?.regional?.language);
      })
      .catch(() => {
        appSettingsReadyRef.current = false;
        setAppSettings(DEFAULT_APP_SETTINGS);
        setAppSettingsSnapshot(serializeAppSettings(DEFAULT_APP_SETTINGS));
        applyUiThemeFromAppSettings(DEFAULT_APP_SETTINGS, currentUser?.id);
      });
  };
  const loadPrintingConfig = () => {
    const loader = hasElectronPrinting()
      ? electronPrinting.getConfig()
      : api.printing.get('/printing/config');
    loader
      .then((cfg) => {
        if (cfg && typeof cfg === 'object') {
          const normalized = ensurePrintingConfigForAreas(cfg, appSettings?.production_areas);
          setPrintingConfig(normalized);
          cachePrintingConfig(normalized);
          return;
        }
        setPrintingConfig(ensurePrintingConfigForAreas(DEFAULT_PRINTING_CONFIG, appSettings?.production_areas));
      })
      .catch((err) => {
        console.warn('[printing] fallback frontend config por error de carga:', err?.message || err);
        try {
          const raw = window.localStorage?.getItem(PRINTING_CONFIG_CACHE_KEY);
          if (raw) {
            const cached = JSON.parse(raw);
            setPrintingConfig(ensurePrintingConfigForAreas(cached, appSettings?.production_areas));
            return;
          }
        } catch (_) {
          // noop
        }
        setPrintingConfig(ensurePrintingConfigForAreas(DEFAULT_PRINTING_CONFIG, appSettings?.production_areas));
      });
  };
  const isValidIp = (value) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(value || '').trim());
  const refreshPrinterStatus = () => {
    printingModuleKeys.forEach((moduleKey) => {
      const req = hasElectronPrinting()
        ? electronPrinting.getStatus(moduleKey)
        : api.printing.get(`/printing/status/${moduleKey}`);
      req
        .then((data) => {
          setPrinterStatus((prev) => ({
            ...prev,
            [moduleKey]: {
              status: data?.status || 'No disponible',
              connected: Boolean(data?.connected),
            },
          }));
        })
        .catch(() => {
          setPrinterStatus((prev) => ({
            ...prev,
            [moduleKey]: { status: 'No disponible', connected: false },
          }));
        });
    });
  };
  const detectUsbPrintersForModule = (moduleKey) => {
    setPrintingBusy(true);
    fetchUsbPrintersFromBridge(moduleKey)
      .then((list) => {
        setDetectedPrintersByModule((prev) => ({ ...prev, [moduleKey]: list }));
        if (!list.length) toast('No se detectaron impresoras en Windows. Verifique que SAT 22TUE esté instalada.');
        refreshPrinterStatus();
      })
      .catch((err) => toast.error(err.message || printingUnreachableMessage()))
      .finally(() => setPrintingBusy(false));
  };
  const detectNetworkPrintersForModule = (moduleKey) => {
    setPrintingBusy(true);
    api.printing.get('/printing/network-printers')
      .then((data) => {
        const list = Array.isArray(data)
          ? data
            .map((it) => ({
              name: String(it?.name || '').trim(),
              ip: String(it?.ip || '').trim(),
              port: Number(it?.port || 9100),
            }))
            .filter((it) => it.ip)
          : [];
        setDetectedNetworkPrintersByModule((prev) => ({ ...prev, [moduleKey]: list }));
        if (!list.length) toast('No se detectaron impresoras de red en Windows');
      })
      .catch((err) => toast.error(err.message || 'No se pudo detectar impresoras de red'))
      .finally(() => setPrintingBusy(false));
  };
  const detectUsbPrintersElectronAuto = () => {
    if (!hasElectronPrinting()) return;
    printingModuleKeys.forEach((moduleKey) => {
      electronPrinting.getPrinters(moduleKey)
        .then((data) => {
          const list = normalizeUsbPrinterList(data);
          setDetectedPrintersByModule((prev) => ({ ...prev, [moduleKey]: list }));
        })
        .catch((err) => {
          console.warn('[printing] no se pudo detectar impresoras en Electron:', err?.message || err);
          setDetectedPrintersByModule((prev) => ({ ...prev, [moduleKey]: [] }));
        });
    });
  };
  const printTestByModule = (moduleKey) => {
    setPrintingBusy(true);
    const req = hasElectronPrinting()
      ? electronPrinting.printTest(moduleKey)
      : api.printing.post(`/printing/test/${moduleKey}`, {});
    req
      .then(() => {
        toast.success(`Prueba enviada a ${moduleKey}`);
        refreshPrinterStatus();
      })
      .catch((err) => toast.error(err.message || 'No se pudo imprimir prueba'))
      .finally(() => setPrintingBusy(false));
  };
  const toggleModuleAutoPrint = (moduleKey) => {
    const cfg = printingConfig?.[moduleKey] || {};
    const nextAuto = !Boolean(cfg.autoPrint);
    const moduleLabel = printingModuleLabel(moduleKey, appSettings?.production_areas);
    setPrintingBusy(true);
    savePrintingModuleAutoPrint(printingConfig, moduleKey, nextAuto)
      .then((saved) => {
        setPrintingConfig(normalizePrintingConfig(saved));
        toast.success(nextAuto ? `Impresora ${moduleLabel} activada` : `Impresora ${moduleLabel} desactivada`);
        refreshPrinterStatus();
      })
      .catch((err) => toast.error(err.message || 'No se pudo guardar'))
      .finally(() => setPrintingBusy(false));
  };
  const savePrintingConfig = () => {
    const invalidRed = printingModuleKeys.find((moduleKey) => {
      const cfg = printingConfig?.[moduleKey] || {};
      if (String(cfg.tipo || 'usb').toLowerCase() !== 'red') return false;
      if (!isValidIp(cfg.ip)) return true;
      const p = Number(cfg.puerto);
      return !Number.isFinite(p) || p < 1 || p > 65535;
    });
    if (invalidRed) {
      toast.error(`Revise IP y puerto en ${invalidRed} (modo Red). No se guardó.`);
      return;
    }
    const invalidUsb = printingModuleKeys.find((moduleKey) => {
      const cfg = printingConfig?.[moduleKey] || {};
      if (String(cfg.tipo || 'usb').toLowerCase() === 'red') return false;
      /** Solo exigir USB en módulos con autoimpresión activa; permite guardar ancho/config general. */
      if (moduleKey !== 'caja' && !Boolean(cfg.autoPrint)) return false;
      return !String(cfg.nombre || '').trim();
    });
    if (invalidUsb) {
      toast.error(`Seleccione una impresora USB en ${invalidUsb} o use modo Red. No se guardó.`);
      return;
    }
    setPrintingBusy(true);
    const req = hasElectronPrinting()
      ? electronPrinting.saveConfig(printingConfig)
      : api.printing.put('/printing/config', printingConfig);
    req
      .then(async (saved) => {
        if (saved && typeof saved === 'object') {
          setPrintingConfig(normalizePrintingConfig(saved));
          cachePrintingConfig(saved);
        }
        let origin = getPersistedPrintingBridgeOrigin();
        if (!origin) origin = await resolvePrintingAssistantOrigin();
        if (!origin && usesInstalledLocalPrinting()) origin = getApiOrigin();
        markPrintingLinkConfigured(origin);
        if (origin) setManualPrintingApi(origin);
        toast.success('Configuración de impresoras guardada');
        refreshPrinterStatus();
      })
      .catch((err) => toast.error(err.message || 'No se pudo guardar'))
      .finally(() => setPrintingBusy(false));
  };
  const verifyPrintingLink = async () => {
    setPrintingLinkStatus((prev) => ({ ...prev, checking: true }));
    try {
      if (hasElectronPrinting()) {
        await electronPrinting.health();
        let detail = 'Impresión con aplicación Resto FADEY instalada';
        try {
          const br = await electronPrinting.getBridgeOrigin();
          if (br?.origin) {
            detail = `Servicio local · ${br.origin}`;
            setManualPrintingApi(br.origin);
          }
        } catch (_) {
          /* noop */
        }
        setPrintingLinkStatus({
          checking: false,
          connected: true,
          source: 'Aplicación Resto FADEY',
          detail,
        });
        return true;
      }
      await checkPrintingHealth();
      const persisted = getPersistedPrintingBridgeOrigin();
      if (persisted) setManualPrintingApi(persisted);
      setPrintingLinkStatus({
        checking: false,
        connected: true,
        source: 'Asistente local vinculado',
        detail: getPrintingApiBase(),
      });
      return true;
    } catch (err) {
      if (isPrintingLinkConfigured()) {
        setPrintingLinkStatus({
          checking: false,
          ...buildConfiguredPrintingLinkStatus(err?.message || 'Reconectando servicio local…'),
        });
        return true;
      }
      setPrintingLinkStatus({
        checking: false,
        connected: false,
        source: 'Sin vínculo',
        detail: err?.message || printingUnreachableMessage(),
      });
      return false;
    }
  };
  const linkPrintingAssistantManually = async () => {
    const raw = String(manualPrintingApi || '').trim();
    if (!raw) {
      toast.error('Ingrese una URL local (ej. http://127.0.0.1:3002)');
      return;
    }
    try {
      window.localStorage?.setItem('resto_local_printing_api', raw);
      persistPrintingBridgeOrigin(raw);
      const ok = await verifyPrintingLink();
      if (ok) {
        markPrintingLinkConfigured(raw);
        toast.success('Asistente de impresión vinculado');
      } else toast.error('No se pudo vincular el asistente');
    } catch (_) {
      toast.error('No se pudo guardar la URL local');
    }
  };
  const loadAppSettingsHistory = () => {
    setSettingsHistoryLoading(true);
    const params = [
      `limit=${historyLimit}`,
      `offset=${historyOffset}`,
      `section=${encodeURIComponent(historyFilterSection)}`,
      `actor=${encodeURIComponent(historyFilterActor)}`,
      `q=${encodeURIComponent(historySearchDebounced)}`,
    ].join('&');
    api.get(`/admin-modules/config/app/history?${params}`)
      .then(data => {
        const items = Array.isArray(data?.items) ? data.items : [];
        setSettingsHistory(items);
        setHistoryTotal(Number(data?.total || 0));
      })
      .catch(() => {
        setSettingsHistory([]);
        setHistoryTotal(0);
      })
      .finally(() => setSettingsHistoryLoading(false));
  };

  useEffect(() => { loadUsers(); loadRestaurant(); loadAppSettings(); loadPrintingConfig(); refreshPrinterStatus(); }, []);

  useEffect(() => {
    if (activeSection === 'users') loadUsers();
  }, [activeSection]);

  useSocket('staff-data-update', (p) => {
    if (p?.domain !== 'app_config') return;
    if (Date.now() < skipConfigReloadUntilRef.current) {
      void reloadConfigHub?.();
      if (activeSection === 'config_historial') loadAppSettingsHistory();
      return;
    }
    loadAppSettings();
    void reloadConfigHub?.();
    if (activeSection === 'config_historial') loadAppSettingsHistory();
  });
  useSocket('order-update', () => { void reloadConfigHub?.(); });
  useSocket('register-update', () => { void reloadConfigHub?.(); });
  useSocket('inventory-update', () => { void reloadConfigHub?.(); });

  useEffect(() => {
    if (activeSection !== 'impresoras') return;
    if (hasElectronPrinting()) {
      detectUsbPrintersElectronAuto();
      return;
    }
    if (usesInstalledLocalPrinting()) {
      printingModuleKeys.forEach((moduleKey) => {
        fetchUsbPrintersFromBridge(moduleKey)
          .then((list) => {
            setDetectedPrintersByModule((prev) => ({ ...prev, [moduleKey]: list }));
          })
          .catch((err) => {
            console.warn('[printing] auto-detect en app instalada:', err?.message || err);
          });
      });
    }
  }, [activeSection]);
  useEffect(() => {
    if (activeSection !== 'impresoras') return;
    const persisted = getPersistedPrintingBridgeOrigin();
    if (persisted) setManualPrintingApi(persisted);
    verifyPrintingLink();
  }, [activeSection]);

  useEffect(() => {
    const onAreas = () => {
      api.get('/production-areas')
        .then((areas) => {
          if (!Array.isArray(areas)) return;
          setAppSettings((prev) => ({ ...prev, production_areas: areas }));
          setPrintingConfig((prev) => ensurePrintingConfigForAreas(prev, areas));
        })
        .catch(() => {});
    };
    window.addEventListener('production-areas-updated', onAreas);
    return () => window.removeEventListener('production-areas-updated', onAreas);
  }, []);

  const loadBusinessConfigEffective = () => {
    setBizLoading(true);
    return api
      .get('/business-config/effective')
      .then((data) => {
        setBizEffective(data);
        const draft = {};
        (data.domains || []).forEach((d) => {
          (d.entries || []).forEach((e) => {
            draft[e.key] = e.value;
          });
        });
        setBizDraft(draft);
      })
      .catch((err) => {
        toast.error(err.message || 'No se pudo cargar el módulo empresarial');
      })
      .finally(() => setBizLoading(false));
  };

  const saveBusinessModule = async () => {
    if (!bizEffective?.domains) return;
    const updates = {};
    for (const d of bizEffective.domains) {
      for (const e of d.entries || []) {
        const next = bizDraft[e.key];
        const same = JSON.stringify(next) === JSON.stringify(e.value);
        if (!same) updates[e.key] = next;
      }
    }
    if (!Object.keys(updates).length) {
      toast('Sin cambios');
      return;
    }
    setBizSaving(true);
    try {
      const data = await api.put('/business-config/values', { updates });
      setBizEffective(data);
      const draft = {};
      (data.domains || []).forEach((dom) => {
        (dom.entries || []).forEach((e) => {
          draft[e.key] = e.value;
        });
      });
      setBizDraft(draft);
      toast.success('Parámetros empresariales guardados');
    } catch (err) {
      toast.error(err.message || 'No se pudo guardar');
    } finally {
      setBizSaving(false);
    }
  };

  const loadBusinessConfigHistory = () => {
    api
      .get('/business-config/history?limit=50')
      .then((r) => setBizHistRows(Array.isArray(r.rows) ? r.rows : []))
      .catch((err) => toast.error(err.message || 'No se pudo cargar el historial'));
  };

  useEffect(() => {
    if (activeSection !== 'modulo_empresarial') return undefined;
    loadBusinessConfigEffective();
    return undefined;
  }, [activeSection]);

  useEffect(() => {
    if (activeSection !== 'config_historial') return;
    loadAppSettingsHistory();
  }, [activeSection, historyOffset, historyFilterSection, historyFilterActor, historySearchDebounced, historyLimit]);
  useEffect(() => {
    if (historySearchTimerRef.current) clearTimeout(historySearchTimerRef.current);
    historySearchTimerRef.current = setTimeout(() => {
      setHistoryOffset(0);
      setHistorySearchDebounced(historySearch);
    }, 300);
    return () => {
      if (historySearchTimerRef.current) clearTimeout(historySearchTimerRef.current);
    };
  }, [historySearch]);
  const prevSettingsSectionRef = useRef(null);
  useEffect(() => {
    if (activeSection === 'regional') {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      if (prevSettingsSectionRef.current !== 'regional') {
        setRegionalDraft(appSettings.regional || DEFAULT_APP_SETTINGS.regional);
        setRegionalSavedJson(JSON.stringify(appSettings.regional || DEFAULT_APP_SETTINGS.regional));
      }
      prevSettingsSectionRef.current = activeSection;
      return undefined;
    }
    prevSettingsSectionRef.current = activeSection;
    if (!activeSection || !PARTIAL_SECTIONS.has(activeSection)) return undefined;
    /** Apariencia guarda al instante vía PUT /config/appearance (no autoguardado del blob completo). */
    if (activeSection === 'apariencia') return undefined;
    if (!hasUnsavedAppSettings || settingsCrudModal.isOpen) return undefined;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      const snap = JSON.parse(appSettingsSnapshot || '{}');
      saveAppSettings({
        silent: true,
        nextSettings: { ...appSettingsRef.current, regional: snap.regional || appSettingsRef.current?.regional },
      });
    }, 900);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [activeSection, appSettings, appSettingsSnapshot, hasUnsavedAppSettings, settingsCrudModal.isOpen]);

  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (appearanceSaveTimerRef.current) clearTimeout(appearanceSaveTimerRef.current);
    if (historySearchTimerRef.current) clearTimeout(historySearchTimerRef.current);
  }, []);

  const openNewUser = () => {
    setEditUser(null);
    setForm(EMPTY_USER_FORM);
    setShowPw(false);
    setShowModal(true);
  };

  const openEditUser = (u) => {
    setEditUser(u);
    const role = String(u.role || 'mozo').toLowerCase() === 'cocina' || String(u.role || '').toLowerCase() === 'bar'
      ? 'produccion'
      : (u.role || 'mozo');
    setForm({
      username: formatCatalogNameInput(u.username || ''),
      email: u.email || '',
      password: '',
      full_name: formatCatalogNameInput(u.full_name || ''),
      role,
      phone: u.phone || '',
      is_active: Number(u.is_active || 0) === 1 ? 1 : 0,
      caja_station_id: String(u.caja_station_id || '').trim(),
      production_area_id: String(u.production_area_id || '').trim(),
      production_area_ids: [],
    });
    setShowPw(false);
    setShowModal(true);
  };

  const closeUserModal = () => {
    setShowModal(false);
    setEditUser(null);
    setShowPw(false);
    setForm(EMPTY_USER_FORM);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const roleLc = String(form.role || '').trim().toLowerCase();
      const payload = {
        ...form,
        username: formatCatalogNameInput(String(form.username || '').trim()),
        email: String(form.email || '').trim(),
        full_name: formatCatalogNameInput(String(form.full_name || '').trim()),
        role: roleLc,
        phone: String(form.phone || '').trim(),
        is_active: Number(form.is_active || 0) === 1 ? 1 : 0,
        caja_station_id:
          roleLc === 'cajero' || roleLc === 'mozo' ? String(form.caja_station_id || '').trim() : '',
        production_area_ids: [],
      };
      // El área del encargado se gestiona en Áreas de producción; no sobrescribir al editar usuario.
      if (roleLc === 'produccion') {
        delete payload.production_area_id;
      } else {
        payload.production_area_id = '';
      }
      if (!payload.password) delete payload.password;
      if (editUser) {
        await api.put(`/users/${editUser.id}`, payload);
        toast.success('Usuario actualizado');
      } else {
        await api.post('/users', payload);
        toast.success('Usuario creado');
      }
      closeUserModal();
      loadUsers();
    } catch (err) { toast.error(err.message); }
  };

  const handleDelete = async (u) => {
    if (u.id === currentUser?.id) return toast.error('No puedes eliminarte a ti mismo');
    if (!confirm(`¿Eliminar usuario "${u.full_name}"?`)) return;
    try {
      await api.delete(`/users/${u.id}`);
      toast.success('Usuario eliminado');
      loadUsers();
    } catch (err) { toast.error(err.message); }
  };

  const toggleActive = async (u) => {
    try {
      await api.put(`/users/${u.id}`, { is_active: u.is_active ? 0 : 1 });
      toast.success(u.is_active ? 'Usuario desactivado' : 'Usuario activado');
      loadUsers();
    } catch (err) { toast.error(err.message); }
  };

  const saveRestaurant = async () => {
    try {
      await api.put('/restaurant', restaurant);
      toast.success('Configuración guardada');
    } catch (err) { toast.error(err.message); }
  };
  const saveTaxSettings = async () => {
    try {
      const rate = Number(appSettings.impuestos?.rate ?? restaurant?.tax_rate ?? 18);
      await api.put('/restaurant', { ...restaurant, tax_rate: Number.isNaN(rate) ? 18 : rate });
      await saveAppSettings({ silent: true });
      toast.success('Configuración de impuestos guardada');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const saveRegionalSettings = async (regionalPayload) => {
    if (isSavingAppSettings) {
      toast.error('Espere, se está guardando…');
      return;
    }
    const regional = regionalPayload || appSettingsRef.current?.regional;
    if (!regional || typeof regional !== 'object') {
      toast.error('No hay datos regionales para guardar');
      return;
    }
    try {
      setIsSavingAppSettings(true);
      skipConfigReloadUntilRef.current = Date.now() + 4000;
      const saved = await api.put('/admin-modules/config/regional', { regional });
      const merged = {
        ...DEFAULT_APP_SETTINGS.regional,
        ...(saved?.regional || regional),
      };
      const savedJson = JSON.stringify(merged);
      setRegionalSavedJson(savedJson);
      setRegionalDraft(merged);
      setAppSettings((prev) => {
        const next = { ...prev, regional: merged };
        setAppSettingsSnapshot(serializeAppSettings(next));
        return next;
      });
      const uiLang = String(merged.language || '').toLowerCase();
      if (uiLang === 'es' || uiLang === 'en') {
        await setAppLocale(uiLang);
      }
      void reloadConfigHub?.();
      toast.success(
        uiLang === 'en'
          ? 'Regional settings saved (English).'
          : 'Configuración regional guardada correctamente.',
      );
      return merged;
    } catch (err) {
      toast.error(err.message || 'No se pudo guardar la configuración regional');
      throw err;
    } finally {
      setIsSavingAppSettings(false);
    }
  };

  const saveAppSettings = async ({ silent = false, nextSettings = null } = {}) => {
    if (!appSettingsReadyRef.current) return;
    if (isSavingAppSettings) {
      pendingAppSettingsSaveRef.current = { kind: 'settings', silent, nextSettings };
      return;
    }
    const snap = JSON.parse(appSettingsSnapshot || '{}');
    const base = nextSettings || appSettings;
    const source = { ...base, regional: snap.regional || base.regional };
    const intendedLang = String(source?.regional?.language || '').toLowerCase();
    const payloadSettings = normalizeConfigPayload({ settings: source });
    try {
      setIsSavingAppSettings(true);
      skipConfigReloadUntilRef.current = Date.now() + 4000;
      const catalogEdits = [...catalogEditsRef.current];
      const saved = await api.put('/admin-modules/config/app', {
        settings: payloadSettings,
        regional: payloadSettings.regional || {},
        ...(catalogEdits.length ? { catalog_edits: catalogEdits } : {}),
      });
      catalogEdits.forEach((k) => catalogEditsRef.current.delete(k));
      const normalized = mergeSavedAppSettings(normalizeConfigPayload(saved), source);
      setAppSettings(normalized);
      setAppSettingsSnapshot(serializeAppSettings(normalized));
      applyUiThemeFromAppSettings(normalized, currentUser?.id);
      const uiLang =
        intendedLang === 'es' || intendedLang === 'en'
          ? intendedLang
          : String(normalized?.regional?.language || '').toLowerCase();
      if (uiLang === 'es' || uiLang === 'en') {
        await setAppLocale(uiLang);
      }
      if (activeSection === 'config_historial') loadAppSettingsHistory();
      if (!silent) {
        toast.success(uiLang === 'en' ? 'Settings saved.' : 'Configuración guardada.');
      }
    } catch (err) {
      if (!silent) toast.error(err.message);
    } finally {
      setIsSavingAppSettings(false);
      const pending = pendingAppSettingsSaveRef.current;
      pendingAppSettingsSaveRef.current = null;
      if (pending?.kind === 'appearance') {
        void saveRestaurantAppearance(pending.nextSettings || appSettingsRef.current);
      } else if (pending) {
        void saveAppSettings({
          silent: pending.silent,
          nextSettings: pending.nextSettings || appSettingsRef.current,
        });
      }
    }
  };

  const saveRestaurantAppearance = async (nextSettings, { debounceMs = 0 } = {}) => {
    const run = async () => {
      if (isSavingAppSettings) {
        pendingAppSettingsSaveRef.current = { kind: 'appearance', silent: true, nextSettings };
        return;
      }
      const snap = JSON.parse(appSettingsSnapshot || '{}');
      const source = { ...nextSettings, regional: snap.regional || nextSettings.regional };
      const patch = {
        ui_theme: source.ui_theme,
        ui_theme_mode: source.ui_theme_mode,
        ui_theme_custom: source.ui_theme_custom || {},
      };
      try {
        setIsSavingAppSettings(true);
        skipConfigReloadUntilRef.current = Date.now() + 4000;
        const saved = await api.put('/admin-modules/config/appearance', patch);
        const normalized = mergeSavedAppSettings(normalizeConfigPayload(saved), source, {
          skipArrayKeys: ['cajas', 'salones', 'locales', 'almacenes', 'comprobantes', 'impresoras'],
        });
        setAppSettings(normalized);
        setAppSettingsSnapshot(serializeAppSettings(normalized));
        applyUiThemeFromAppSettings(normalized, currentUser?.id);
      } catch (err) {
        toast.error(err.message || 'No se pudo guardar el tema del restaurante');
      } finally {
        setIsSavingAppSettings(false);
        const pending = pendingAppSettingsSaveRef.current;
        pendingAppSettingsSaveRef.current = null;
        if (pending?.kind === 'appearance') {
          void saveRestaurantAppearance(pending.nextSettings || appSettingsRef.current);
        } else if (pending) {
          void saveAppSettings({
            silent: pending.silent,
            nextSettings: pending.nextSettings || appSettingsRef.current,
          });
        }
      }
    };
    if (appearanceSaveTimerRef.current) clearTimeout(appearanceSaveTimerRef.current);
    if (debounceMs > 0) {
      appearanceSaveTimerRef.current = setTimeout(() => {
        appearanceSaveTimerRef.current = null;
        void run();
      }, debounceMs);
      return;
    }
    await run();
  };

  const updateR = (field, value) => setRestaurant(prev => ({ ...prev, [field]: value }));
  const updateSchedule = (day, field, value) => setRestaurant(prev => ({
    ...prev, schedule: { ...prev.schedule, [day]: { ...prev.schedule[day], [field]: value } }
  }));
  const updateAppSection = (section, index, patch) => {
    setAppSettings(prev => {
      const list = Array.isArray(prev[section]) ? [...prev[section]] : [];
      list[index] = { ...(list[index] || {}), ...patch };
      return { ...prev, [section]: list };
    });
  };
  const toggleAppSection = (section, index, field = 'active') => {
    setAppSettings(prev => {
      const list = Array.isArray(prev[section]) ? [...prev[section]] : [];
      const row = { ...(list[index] || {}) };
      if (field === 'active' && REQUIRED_ACTIVE_SECTIONS.has(section) && row[field]) {
        const activeCount = list.filter(item => Number(item?.active || 0) === 1).length;
        if (activeCount <= 1) {
          toast.error('Debe existir al menos un elemento activo en esta sección');
          return prev;
        }
      }
      row[field] = row[field] ? 0 : 1;
      list[index] = row;
      markCatalogEdit(section);
      return { ...prev, [section]: list };
    });
  };
  const deleteAppSectionItem = (section, index, label = 'registro') => {
    const currentList = section === 'categoria_anular'
      ? (appSettings.categoria_anular || []).map(value => ({ value }))
      : (Array.isArray(appSettings[section]) ? appSettings[section] : []);
    if (REQUIRED_ACTIVE_SECTIONS.has(section) && currentList.length <= 1) {
      toast.error('No puedes eliminar el último elemento de esta sección');
      return;
    }
    const target = currentList[index];
    if (REQUIRED_ACTIVE_SECTIONS.has(section) && Number(target?.active || 0) === 1) {
      const activeCount = currentList.filter(item => Number(item?.active || 0) === 1).length;
      if (activeCount <= 1) {
        toast.error('Debe existir al menos un elemento activo en esta sección');
        return;
      }
    }
    if (!window.confirm(`¿Eliminar ${label}? Esta acción no se puede deshacer.`)) return;
    markCatalogEdit(section);
    setAppSettings(prev => {
      if (section === 'categoria_anular') {
        return { ...prev, categoria_anular: (prev.categoria_anular || []).filter((_, idx) => idx !== index) };
      }
      return { ...prev, [section]: (Array.isArray(prev[section]) ? prev[section] : []).filter((_, idx) => idx !== index) };
    });
    toast.success('Elemento eliminado');
  };
  const openSettingsCrudModal = (section, index = null) => {
    const cfg = SETTINGS_SECTION_FORMS[section];
    if (!cfg) return;
    const source = index === null
      ? {}
      : section === 'categoria_anular'
        ? { value: (appSettings.categoria_anular || [])[index] || '' }
        : (appSettings[section] || [])[index] || {};
    const nextForm = {};
    cfg.fields.forEach(f => {
      if (f.type === 'select') {
        const defOpt = f.options?.[0]?.value ?? '';
        nextForm[f.key] = source[f.key] ?? defOpt;
      } else if (f.type === 'number') nextForm[f.key] = source[f.key] ?? 0;
      else nextForm[f.key] = source[f.key] ?? '';
    });
    setSettingsCrudForm(nextForm);
    setSettingsCrudModal({ isOpen: true, section, index });
  };
  const closeSettingsCrudModal = () => {
    setSettingsCrudModal({ isOpen: false, section: '', index: null });
    setSettingsCrudForm({});
  };
  const submitSettingsCrudModal = (e) => {
    e.preventDefault();
    const { section, index } = settingsCrudModal;
    const cfg = SETTINGS_SECTION_FORMS[section];
    if (!cfg) return;
    for (const field of cfg.fields) {
      if (field.required && !String(settingsCrudForm[field.key] ?? '').trim()) {
        return toast.error(`Completa: ${field.label}`);
      }
    }
    if (section === 'categoria_anular') {
      const value = String(settingsCrudForm.value || '').trim();
      setAppSettings(prev => {
        const list = [...(prev.categoria_anular || [])];
        if (index === null) list.push(value);
        else list[index] = value;
        return { ...prev, categoria_anular: list };
      });
      closeSettingsCrudModal();
      return;
    }
    if (section === 'comprobantes') {
      const series = String(settingsCrudForm.series || '').trim().toUpperCase();
      const duplicated = (appSettings.comprobantes || []).some((c, idx) => idx !== index && String(c.series || '').toUpperCase() === series);
      if (duplicated) return toast.error('La serie ya existe en otro comprobante');
    }
    if (section === 'monedas') {
      const nextCode = String(settingsCrudForm.code || '').trim().toUpperCase();
      const duplicated = (appSettings.monedas || []).some((m, idx) => idx !== index && String(m.code || '').toUpperCase() === nextCode);
      if (duplicated) return toast.error('El código de moneda ya existe');
    }
    const payload = {};
    cfg.fields.forEach(f => {
      if (f.type === 'number') {
        payload[f.key] = Number(settingsCrudForm[f.key] || 0);
      } else {
        payload[f.key] = String(settingsCrudForm[f.key] ?? '').trim();
      }
    });
    if (section === 'monedas') {
      payload.code = String(payload.code || '').toUpperCase();
    }
    if (index === null) payload.active = 1;
    if (section === 'cajas') {
      if (index === null) {
        payload.id = newLocalCajaId();
      } else {
        const existing = (appSettings.cajas || [])[index] || {};
        const existingId = String(existing.id || '').trim();
        payload.id = existingId || newLocalCajaId();
      }
    }
    markCatalogEdit(section);
    setAppSettings(prev => {
      const list = Array.isArray(prev[section]) ? [...prev[section]] : [];
      if (index === null) list.push(payload);
      else list[index] = { ...(list[index] || {}), ...payload };
      return { ...prev, [section]: list };
    });
    closeSettingsCrudModal();
  };
  const rollbackAppSettings = async (historyId) => {
    if (!historyId) return;
    if (!window.confirm('¿Restaurar esta versión de configuración? Se aplicará inmediatamente.')) return;
    try {
      setIsRollingBackSettings(true);
      const restored = await api.post(`/admin-modules/config/app/rollback/${historyId}`, {});
      const normalized = normalizeConfigPayload(restored);
      setAppSettings(normalized);
      setAppSettingsSnapshot(serializeAppSettings(normalized));
      applyUiThemeFromAppSettings(normalized, currentUser?.id);
      if (activeSection === 'config_historial') loadAppSettingsHistory();
      toast.success('Configuración restaurada');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setIsRollingBackSettings(false);
    }
  };
  const settingsHistoryFiltered = settingsHistory;
  const historyActors = Array.from(new Set(settingsHistory.map(item => (item.actor_name || '').trim()).filter(Boolean)));
  const historyPageStart = historyTotal === 0 ? 0 : historyOffset + 1;
  const historyPageEnd = Math.min(historyOffset + settingsHistory.length, historyTotal);
  const historyHasPrev = historyOffset > 0;
  const historyHasNext = historyOffset + historyLimit < historyTotal;
  const clearHistoryFilters = () => {
    setHistoryFilterSection('all');
    setHistoryFilterActor('all');
    setHistorySearch('');
    setHistorySearchDebounced('');
    setHistoryOffset(0);
  };
  const exportHistoryCsv = async () => {
    try {
      const fetchLimit = 100;
      const allRows = [];
      let offset = 0;
      let total = 0;
      do {
        const params = [
          `limit=${fetchLimit}`,
          `offset=${offset}`,
          `section=${encodeURIComponent(historyFilterSection)}`,
          `actor=${encodeURIComponent(historyFilterActor)}`,
          `q=${encodeURIComponent(historySearchDebounced)}`,
        ].join('&');
        const data = await api.get(`/admin-modules/config/app/history?${params}`);
        const chunk = Array.isArray(data?.items) ? data.items : [];
        total = Number(data?.total || 0);
        allRows.push(...chunk);
        offset += fetchLimit;
        if (!chunk.length) break;
      } while (offset < total);
      if (!allRows.length) return toast.error('No hay registros para exportar');
      const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const header = ['Fecha', 'Usuario', 'Secciones', 'Origen'];
      const rows = allRows.map(item => ([
        formatDateTime(item.created_at),
        item.actor_name || 'Sistema',
        Array.isArray(item.changed_keys) ? item.changed_keys.join(', ') : '',
        item?.details?.source || '',
      ]));
      const csv = [header, ...rows].map(row => row.map(escapeCsv).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `historial_configuracion_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Historial exportado (${allRows.length} registros)`);
    } catch (err) {
      toast.error(err.message || 'No se pudo exportar el historial');
    }
  };
  const getHistoryDiff = (item) => {
    const changedKeys = Array.isArray(item?.changed_keys) ? item.changed_keys : [];
    const before = item?.before_state || {};
    const after = item?.after_state || {};
    return changedKeys.map((key) => {
      const beforeValue = before[key];
      const afterValue = after[key];
      return {
        key,
        beforeText: JSON.stringify(beforeValue === undefined ? null : beforeValue, null, 2),
        afterText: JSON.stringify(afterValue === undefined ? null : afterValue, null, 2),
      };
    });
  };

  const activeMenuLabel = useMemo(
    () => MENU_ITEMS.find((item) => item.id === activeSection)?.label || '',
    [activeSection]
  );

  const selectSettingsSection = (sectionId) => {
    setActiveSection(sectionId);
    setSettingsNavOpen(false);
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden flex-col md:flex-row">
      {/* Sidebar Menu — en móvil se retrae al elegir opción */}
      <aside
        className={[
          'flex shrink-0 flex-col min-h-0 self-stretch border-[color:var(--ui-border)]',
          'w-full border-b md:w-72 md:border-b-0 md:border-r',
          settingsNavOpen ? 'max-h-[min(60vh,28rem)] md:max-h-none' : '',
        ].join(' ')}
      >
        <div className="rf-settings-hub rf-settings-hub--split flex min-h-0 max-h-full flex-col overflow-hidden">
          <div className="rf-settings-hub__header shrink-0">
            <button
              type="button"
              className="rf-settings-hub__header-toggle w-full flex items-center justify-between gap-2 text-left md:cursor-default"
              onClick={() => {
                if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) return;
                setSettingsNavOpen((open) => !open);
              }}
              aria-expanded={settingsNavOpen}
              aria-controls="rf-settings-hub-nav"
            >
              <h2 className="rf-settings-hub__header-title min-w-0">
                <MdSettings className="text-lg shrink-0" />
                <span className="truncate">
                  Opciones sistema
                  {activeMenuLabel && !settingsNavOpen ? (
                    <span className="md:hidden font-medium text-[var(--ui-muted)]"> · {activeMenuLabel}</span>
                  ) : null}
                </span>
              </h2>
              <MdExpandMore
                className={`md:hidden text-2xl shrink-0 text-[var(--ui-muted)] transition-transform duration-200 ${
                  settingsNavOpen ? 'rotate-180' : ''
                }`}
                aria-hidden
              />
            </button>
          </div>
          <nav
            id="rf-settings-hub-nav"
            className={[
              'rf-settings-hub__nav rf-settings-hub__nav--scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain',
              settingsNavOpen ? 'block' : 'hidden',
              'md:block',
            ].join(' ')}
          >
            {MENU_ITEMS.map(item => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectSettingsSection(item.id)}
                  className={`rf-settings-hub__item ${isActive ? 'rf-settings-hub__item--active' : ''}`}
                >
                  <Icon className="text-lg flex-shrink-0" />
                  <span className="flex-1 text-left">{item.label}</span>
                  <MdChevronRight className={`text-lg flex-shrink-0 rf-settings-hub__item-chevron`} />
                </button>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Content Area — scroll independiente */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-y-contain scrollbar-hide p-3 sm:p-6">
        {(activeSection === 'regional' || (activeSection && PARTIAL_SECTIONS.has(activeSection))) ? (
        <div className="flex items-center gap-3 mb-3">
          {activeSection === 'regional' && (
            <span
              className={`text-xs px-2 py-1 rounded-full border border-[color:var(--ui-border)] ${
                isSavingAppSettings
                  ? 'bg-[var(--ui-sidebar-active-bg)] text-[var(--ui-body-text)]'
                  : hasUnsavedRegional
                    ? 'bg-amber-100 text-amber-950 border-amber-200/80'
                    : 'bg-emerald-100 text-emerald-900 border-emerald-200/80'
              }`}
            >
              {isSavingAppSettings
                ? 'Guardando…'
                : hasUnsavedRegional
                  ? 'Sin guardar — usa «Guardar regional»'
                  : 'Guardado en servidor'}
            </span>
          )}
          {activeSection && PARTIAL_SECTIONS.has(activeSection) && (
            <span className={`text-xs px-2 py-1 rounded-full border border-[color:var(--ui-border)] ${isSavingAppSettings ? 'bg-[var(--ui-sidebar-active-bg)] text-[var(--ui-body-text)]' : hasUnsavedAppSettings ? 'bg-amber-100 text-amber-950 border-amber-200/80' : 'bg-[var(--ui-surface-2)] text-[var(--ui-muted)]'}`}>
              {isSavingAppSettings ? 'Guardando...' : hasUnsavedAppSettings ? 'Cambios sin guardar' : 'Sincronizado'}
            </span>
          )}
        </div>
        ) : null}
        {activeSection && activeSection !== 'config_historial' ? (
          <SettingsConfigHubBanner
            hub={configHub}
            loading={configHubLoading}
            onRefresh={() => void reloadConfigHub()}
            sectionId={activeSection}
          />
        ) : null}
        {activeSection ? <SettingsSectionInsights sectionId={activeSection} hub={configHub} /> : null}
        {activeSection === 'apariencia' && (
          <SettingsAppearancePanel
            appSettings={appSettings}
            setAppSettings={setAppSettings}
            currentUserId={currentUser?.id}
            onSaveRestaurantAppearance={saveRestaurantAppearance}
          />
        )}
        {activeSection === 'config_historial' && (
          <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-slate-700">Historial reciente de configuración</p>
              <div className="flex items-center gap-3">
                <button onClick={exportHistoryCsv} className="text-xs text-emerald-600 hover:underline">Exportar CSV</button>
                <button onClick={clearHistoryFilters} className="text-xs text-[var(--ui-accent-muted)] hover:underline">Limpiar filtros</button>
                <button onClick={loadAppSettingsHistory} className="text-xs text-sky-600 hover:underline">Actualizar</button>
              </div>
            </div>
            <p className="text-xs ui-text-muted mb-3">
              Consulta y restaura versiones anteriores de la configuración del sistema. Los cambios en otras secciones siguen registrándose aquí.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
              <input
                value={historySearch}
                onChange={e => {
                  setHistoryOffset(0);
                  setHistorySearch(e.target.value);
                }}
                placeholder="Buscar en historial..."
                className="input-field"
              />
              <select value={historyFilterSection} onChange={e => {
                setHistoryOffset(0);
                setHistoryFilterSection(e.target.value);
              }} className="input-field">
                <option value="all">Todas las secciones</option>
                {HISTORY_FILTER_SECTIONS.map(section => (
                  <option key={section} value={section}>{section}</option>
                ))}
              </select>
              <select value={historyFilterActor} onChange={e => {
                setHistoryOffset(0);
                setHistoryFilterActor(e.target.value);
              }} className="input-field">
                <option value="all">Todos los usuarios</option>
                {historyActors.map(actor => (
                  <option key={actor} value={actor}>{actor}</option>
                ))}
                <option value="__empty__">Sistema</option>
              </select>
              <select
                value={historyLimit}
                onChange={e => {
                  setHistoryOffset(0);
                  setHistoryLimit(Number(e.target.value) || 8);
                }}
                className="input-field"
              >
                <option value={8}>8 por página</option>
                <option value={20}>20 por página</option>
                <option value={50}>50 por página</option>
              </select>
            </div>
            {settingsHistoryLoading ? (
              <p className="text-xs ui-text-muted">Cargando historial...</p>
            ) : settingsHistoryFiltered.length === 0 ? (
              <p className="text-xs ui-text-muted">Aún no hay cambios registrados.</p>
            ) : (
              <div className="space-y-2">
                {settingsHistoryFiltered.map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-700 truncate">
                        {Array.isArray(item.changed_keys) && item.changed_keys.length ? item.changed_keys.join(', ') : 'sin cambios'}
                      </p>
                      <p className="text-[11px] ui-text-muted">
                        {formatDateTime(item.created_at)} · {item.actor_name || 'Sistema'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setHistoryPreview(item)}
                        className="px-2 py-1 text-xs rounded border border-slate-200 hover:bg-slate-50"
                      >
                        Ver cambios
                      </button>
                      <button
                        onClick={() => rollbackAppSettings(item.id)}
                        disabled={isRollingBackSettings}
                        className="px-2 py-1 text-xs rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
                      >
                        Restaurar
                      </button>
                    </div>
                  </div>
                ))}
                <div className="pt-2 flex items-center justify-between">
                  <p className="text-[11px] ui-text-muted">
                    {historyPageStart}-{historyPageEnd} de {historyTotal}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-2 py-1 text-xs rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
                      disabled={!historyHasPrev}
                      onClick={() => setHistoryOffset(prev => Math.max(0, prev - historyLimit))}
                    >
                      Anterior
                    </button>
                    <button
                      className="px-2 py-1 text-xs rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
                      disabled={!historyHasNext}
                      onClick={() => setHistoryOffset(prev => prev + historyLimit)}
                    >
                      Siguiente
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* BIENVENIDA */}
        {!activeSection && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-20 h-20 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
              <MdSettings className="text-4xl text-[var(--ui-muted)]" />
            </div>
            <h2 className="text-xl font-bold text-slate-700 mb-2">Configuración del Sistema</h2>
            <p className="text-sm text-[var(--ui-muted)] max-w-md">Selecciona una opción del menú lateral para configurar los parámetros de tu restaurante.</p>
          </div>
        )}

        {/* CONFIGURACIÓN REGIONAL */}
        {activeSection === 'regional' && restaurant && (
          <SettingsRegionalPanel
            regional={regionalDraft}
            setRegional={setRegionalDraft}
            onSave={(regional) => saveRegionalSettings(regional)}
            saving={isSavingAppSettings}
            hasUnsaved={hasUnsavedRegional}
          />
        )}

        {/* LOCALES */}
        {activeSection === 'locales' && restaurant && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button
                onClick={() => openSettingsCrudModal('locales')}
                className="btn-primary flex items-center gap-2 text-sm"
              ><MdAdd /> Nuevo Local</button>
            </div>
            <div className="space-y-3">
              {(appSettings.locales || []).map((loc, i) => (
                <div key={`${loc.name}-${i}`} className="card flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-gold-100 rounded-xl flex items-center justify-center">
                      <MdStorefront className="text-2xl text-gold-600" />
                    </div>
                    <div>
                      <p className="font-bold rf-section-title">{loc.name}</p>
                      <p className="text-sm ui-text-muted">{loc.address || 'Sin dirección'}</p>
                      <p className="text-sm text-[var(--ui-muted)]">{loc.phone || 'Sin teléfono'}</p>
                      {loc.whatsapp ? (
                        <a href={`https://wa.me/${String(loc.whatsapp).replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 hover:underline mt-0.5 inline-block">
                          WhatsApp
                        </a>
                      ) : null}
                      {loc.maps_url ? (
                        <a href={loc.maps_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline mt-0.5 inline-block ml-2">
                          Mapa
                        </a>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleAppSection('locales', i)} className={`px-3 py-1 text-xs rounded-full ${loc.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 ui-text-muted'}`}>
                      {loc.active ? 'Activo' : 'Inactivo'}
                    </button>
                    <button
                      onClick={() => openSettingsCrudModal('locales', i)}
                      className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]"
                    ><MdEdit /></button>
                    <button
                      onClick={() => deleteAppSectionItem('locales', i, `el local "${loc.name}"`)}
                      className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]"
                    ><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* USUARIOS */}
        {activeSection === 'users' && (
          <UsersSection
            users={users}
            appSettings={appSettings}
            currentUser={currentUser}
            openNewUser={openNewUser}
            openEditUser={openEditUser}
            handleDelete={handleDelete}
            toggleActive={toggleActive}
            showModal={showModal}
            closeUserModal={closeUserModal}
            editUser={editUser}
            handleSubmit={handleSubmit}
            form={form}
            setForm={setForm}
            showPw={showPw}
            setShowPw={setShowPw}
          />
        )}

        {/* ALMACENES Y PRODUCCIÓN */}
        {activeSection === 'almacenes' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button
                onClick={() => openSettingsCrudModal('almacenes')}
                className="btn-primary flex items-center gap-2 text-sm"
              ><MdAdd /> Nuevo Almacén</button>
            </div>
            <div className="card">
              {(appSettings.almacenes || []).map((wh, i) => (
                <div key={`${wh.name}-${i}`} className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-sky-100 rounded-lg flex items-center justify-center"><MdWarehouse className="text-sky-600" /></div>
                    <div><p className="font-medium">{wh.name}</p><p className="text-sm ui-text-muted">{wh.description || 'Sin descripción'}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleAppSection('almacenes', i)} className={`px-2 py-1 text-xs rounded-full ${wh.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 ui-text-muted'}`}>{wh.active ? 'Activo' : 'Inactivo'}</button>
                    <button onClick={() => openSettingsCrudModal('almacenes', i)} className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]"><MdEdit /></button>
                    <button onClick={() => deleteAppSectionItem('almacenes', i, `el almacén "${wh.name}"`)} className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]"><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* SALONES Y MESAS */}
        {activeSection === 'salones' && (
          <SalonMesasSection appSettings={appSettings} />
        )}

        {activeSection === 'production_areas' && (
          <ProductionAreasSection />
        )}

        {/* CAJAS */}
        {activeSection === 'cajas' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button onClick={() => openSettingsCrudModal('cajas')} className="btn-primary flex items-center gap-2 text-sm"><MdAdd /> Nueva Caja</button>
            </div>
            <div className="card">
              {!(appSettings.cajas || []).length && (
                <p className="text-sm ui-text-muted py-6 text-center">Aún no hay cajas. Use «Nueva Caja» para crear la primera.</p>
              )}
              {(appSettings.cajas || []).map((caja, i) => (
                <div key={String(caja.id || '').trim() || `${caja.name}-${i}`} className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-sky-100 rounded-lg flex items-center justify-center"><MdPointOfSale className="text-sky-600" /></div>
                    <div><p className="font-medium">{caja.name}</p><p className="text-sm ui-text-muted">{caja.description || 'Sin descripción'}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleAppSection('cajas', i)} className={`px-2 py-1 text-xs rounded-full ${caja.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 ui-text-muted'}`}>{caja.active ? 'Activa' : 'Inactiva'}</button>
                    <button onClick={() => openSettingsCrudModal('cajas', i)} className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]"><MdEdit /></button>
                    <button onClick={() => deleteAppSectionItem('cajas', i, `la caja "${caja.name}"`)} className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]"><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* COMPROBANTES */}
        {activeSection === 'comprobantes' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('comprobantes')}><MdAdd /> Nuevo Comprobante</button>
            </div>
            <div className="card space-y-4">
              <h3 className="font-semibold rf-section-title">Tipos de Comprobante</h3>
              {(appSettings.comprobantes || []).map((tipo, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <MdReceipt className="text-[var(--ui-muted)] text-xl" />
                    <div><p className="font-medium text-sm">{tipo.name}</p><p className="text-xs text-[var(--ui-muted)]">Serie: {tipo.series || '-'}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={!!tipo.active} onChange={() => toggleAppSection('comprobantes', i)} className="sr-only peer" />
                      <div className="w-9 h-5 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                    </label>
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('comprobantes', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('comprobantes', i, `el comprobante "${tipo.name}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {activeSection === 'impresoras' && (
          <div className="space-y-4">
            <div className="card space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-1">
                  <p className={`text-sm font-semibold ${printingLinkStatus.connected ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {printingLinkStatus.connected ? 'Vinculación activa' : 'Sin vinculación'}
                  </p>
                  <p className="text-xs ui-text-muted mt-1">
                    {printingLinkStatus.checking
                      ? 'Verificando vínculo…'
                      : `${printingLinkStatus.source}${printingLinkStatus.detail ? ` · ${printingLinkStatus.detail}` : ''}`}
                  </p>
                </div>
                <div className="md:col-span-2 flex flex-wrap items-center gap-2">
                  <input
                    className="input-field flex-1 min-w-[220px]"
                    value={manualPrintingApi}
                    onChange={(e) => setManualPrintingApi(e.target.value)}
                    placeholder="http://127.0.0.1:3002"
                  />
                  <button type="button" className="btn-secondary text-sm" onClick={linkPrintingAssistantManually} disabled={printingBusy || printingLinkStatus.checking}>
                    Vincular manual
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={() => void verifyPrintingLink()} disabled={printingBusy || printingLinkStatus.checking}>
                    Verificar vínculo
                  </button>
                  <PrintingAssistantDownloadButton disabled={printingBusy} />
                </div>
              </div>
              <div className="flex justify-end">
                <button type="button" className="btn-primary text-sm flex items-center gap-2" onClick={savePrintingConfig} disabled={printingBusy}>
                  <MdSave /> Guardar configuración
                </button>
              </div>
            </div>

            {printingModuleEntries.map(({ key: moduleKey, label: moduleLabel }) => {
              const cfg = printingConfig?.[moduleKey] || {};
              const modulePrinters = detectedPrintersByModule[moduleKey] || [];
              const selectedName = String(cfg.nombre || '').trim();
              const visiblePrinters = selectedName && !modulePrinters.some((p) => p.name === selectedName)
                ? [{ name: selectedName }, ...modulePrinters]
                : modulePrinters;
              const moduleNetworkPrinters = detectedNetworkPrintersByModule[moduleKey] || [];
              return (
                <div key={moduleKey} className="card space-y-3">
                  <h3 className="font-semibold rf-section-title">{moduleLabel}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Tipo</label>
                      <select
                        className="input-field"
                        value={cfg.tipo || 'usb'}
                        onChange={(e) => setPrintingConfig((prev) => ({
                          ...prev,
                          [moduleKey]: { ...(prev[moduleKey] || {}), tipo: e.target.value },
                        }))}
                      >
                        <option value="usb">USB</option>
                        <option value="red">Red</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Ancho de papel</label>
                      <select
                        className="input-field"
                        value={Number(cfg.anchoPapel ?? cfg.paperWidth ?? 80)}
                        onChange={(e) => setPrintingConfig((prev) => {
                          const selected = Number(e.target.value);
                          const width =
                            selected === 50 ? 50 : selected === 58 ? 58 : selected === 75 ? 75 : 80;
                          return {
                            ...prev,
                            [moduleKey]: {
                              ...(prev[moduleKey] || {}),
                              anchoPapel: width,
                              paperWidth: width,
                            },
                          };
                        })}
                      >
                        <option value={50}>50 mm</option>
                        <option value={58}>58 mm</option>
                        <option value={75}>75 mm</option>
                        <option value={80}>80 mm</option>
                      </select>
                    </div>

                    {(cfg.tipo || 'usb') === 'usb' ? (
                      <div className="md:col-span-1 space-y-2">
                        <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Impresora USB</label>
                        <select
                          className="input-field"
                          value={cfg.nombre || ''}
                          onChange={(e) => setPrintingConfig((prev) => ({
                            ...prev,
                            [moduleKey]: { ...(prev[moduleKey] || {}), nombre: e.target.value },
                          }))}
                        >
                          <option value="">Seleccione una impresora</option>
                          {visiblePrinters.map((p) => (
                            <option key={p.name} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn-secondary text-sm w-full sm:w-auto"
                          onClick={() => detectUsbPrintersForModule(moduleKey)}
                          disabled={printingBusy}
                        >
                          Detectar impresoras USB ({moduleLabel})
                        </button>
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">IP</label>
                          <input
                            className="input-field"
                            value={cfg.ip || ''}
                            onChange={(e) => setPrintingConfig((prev) => ({
                              ...prev,
                              [moduleKey]: { ...(prev[moduleKey] || {}), ip: e.target.value },
                            }))}
                            placeholder="192.168.1.50"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Puerto</label>
                          <input
                            className="input-field"
                            type="number"
                            min="1"
                            max="65535"
                            value={Number(cfg.puerto || 9100)}
                            onChange={(e) => setPrintingConfig((prev) => ({
                              ...prev,
                              [moduleKey]: { ...(prev[moduleKey] || {}), puerto: Number(e.target.value || 9100) },
                            }))}
                          />
                        </div>
                        <div className="md:col-span-1 space-y-2">
                          <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Impresoras de red detectadas</label>
                          <select
                            className="input-field"
                            value=""
                            onChange={(e) => {
                              const selected = moduleNetworkPrinters.find((it) => `${it.ip}:${it.port}` === e.target.value);
                              if (!selected) return;
                              setPrintingConfig((prev) => ({
                                ...prev,
                                [moduleKey]: {
                                  ...(prev[moduleKey] || {}),
                                  ip: selected.ip,
                                  puerto: Number(selected.port || 9100),
                                },
                              }));
                            }}
                          >
                            <option value="">Seleccione impresora de red</option>
                            {moduleNetworkPrinters.map((it) => (
                              <option key={`${it.name}-${it.ip}-${it.port}`} value={`${it.ip}:${it.port}`}>
                                {it.name || 'Impresora'} - {it.ip}:{it.port}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn-secondary text-sm w-full sm:w-auto"
                            onClick={() => detectNetworkPrintersForModule(moduleKey)}
                            disabled={printingBusy}
                          >
                            Detectar impresoras de red ({moduleLabel})
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary text-sm"
                      onClick={() => printTestByModule(moduleKey)}
                      disabled={printingBusy}
                    >
                      Imprimir prueba
                    </button>
                  </div>

                  <p className={`text-sm ${printerStatus?.[moduleKey]?.connected ? 'text-emerald-600' : 'text-rose-600'}`}>
                    Estado de impresora: {printerStatus?.[moduleKey]?.status || 'No disponible'}
                  </p>

                  {moduleKey !== 'caja' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs px-2 py-1 rounded-full border ${Boolean(cfg.autoPrint) ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-[var(--ui-muted)] border-slate-200'}`}>
                        {Boolean(cfg.autoPrint) ? 'Impresora activa' : 'Impresora desactivada'}
                      </span>
                      <button
                        type="button"
                        className={`btn-secondary text-sm ${Boolean(cfg.autoPrint) ? 'border-rose-200 text-rose-700 hover:bg-rose-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
                        onClick={() => toggleModuleAutoPrint(moduleKey)}
                        disabled={printingBusy}
                      >
                        {Boolean(cfg.autoPrint) ? `Desactivar impresora (${moduleLabel})` : `Activar impresora (${moduleLabel})`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* IMPUESTOS */}
        {activeSection === 'impuestos' && restaurant && (
          <div className="space-y-4">
            <div className="card space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Tasa de Impuesto (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={appSettings.impuestos?.rate ?? restaurant.tax_rate}
                    onChange={e => {
                      const nextRate = Number(e.target.value);
                      updateR('tax_rate', Number.isNaN(nextRate) ? 0 : nextRate);
                      setAppSettings(prev => ({ ...prev, impuestos: { ...(prev.impuestos || {}), rate: Number.isNaN(nextRate) ? 0 : nextRate } }));
                    }}
                    className="input-field"
                  />
                  <p className="text-xs text-[var(--ui-muted)] mt-1">IGV Perú: 18%</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Nombre del Impuesto</label>
                  <input
                    className="input-field"
                    value={appSettings.impuestos?.name || 'IGV'}
                    onChange={e => setAppSettings(prev => ({ ...prev, impuestos: { ...(prev.impuestos || {}), name: e.target.value } }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Incluido en precio</label>
                  <select
                    className="input-field"
                    value={appSettings.impuestos?.included_in_price ? '1' : '0'}
                    onChange={e => setAppSettings(prev => ({ ...prev, impuestos: { ...(prev.impuestos || {}), included_in_price: Number(e.target.value) } }))}
                  >
                    <option value="1">Sí - Precio incluye impuesto</option>
                    <option value="0">No - Impuesto se agrega al precio</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={saveTaxSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* TARJETAS */}
        {activeSection === 'tarjetas' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('tarjetas')}><MdAdd /> Nueva Tarjeta</button>
            </div>
            <div className="card">
              {(appSettings.tarjetas || []).map((t, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <MdCreditCard className="text-[var(--ui-muted)] text-xl" />
                    <p className="font-medium text-sm">{t.name}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--ui-muted)]">Comisión: {Number(t.fee_percent || 0).toFixed(1)}%</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={!!t.active} onChange={() => toggleAppSection('tarjetas', i)} className="sr-only peer" />
                      <div className="w-9 h-5 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                    </label>
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('tarjetas', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('tarjetas', i, `la tarjeta "${t.name}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* TURNOS */}
        {activeSection === 'turnos' && restaurant && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button onClick={saveRestaurant} className="btn-primary flex items-center gap-2 text-sm"><MdSave /> Guardar</button>
            </div>
            <div className="card">
              <div className="space-y-3">
                {DAYS.map(day => (
                  <div key={day} className="flex items-center gap-4 py-2 border-b border-slate-50 last:border-0">
                    <label className="flex items-center gap-2 w-32">
                      <input type="checkbox" checked={restaurant.schedule[day]?.enabled} onChange={e => updateSchedule(day, 'enabled', e.target.checked)} className="rounded text-gold-600" />
                      <span className="font-medium text-sm">{DAY_NAMES[day]}</span>
                    </label>
                    <input type="time" value={restaurant.schedule[day]?.open || '11:00'} onChange={e => updateSchedule(day, 'open', e.target.value)} className="input-field w-auto" disabled={!restaurant.schedule[day]?.enabled} />
                    <span className="text-[var(--ui-muted)]">a</span>
                    <input type="time" value={restaurant.schedule[day]?.close || '23:00'} onChange={e => updateSchedule(day, 'close', e.target.value)} className="input-field w-auto" disabled={!restaurant.schedule[day]?.enabled} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* JORNADA Y ASISTENCIA (foto inicio/fin) */}
        {activeSection === 'jornada_laboral' && (() => {
          const { inicio: jlInicio, fin: jlFin } = getJornadaLaboralToggles(appSettings.jornada_laboral);
          const setJlField = (field, checked) => {
            setAppSettings((prev) => {
              const cur = prev.jornada_laboral || {};
              const t = getJornadaLaboralToggles(cur);
              const nextInicio = field === 'inicio' ? checked : t.inicio;
              const nextFin = field === 'fin' ? checked : t.fin;
              return {
                ...prev,
                jornada_laboral: {
                  ...cur,
                  requiere_foto_inicio_sesion: nextInicio ? 1 : 0,
                  requiere_foto_fin_jornada: nextFin ? 1 : 0,
                  requiere_foto_asistencia: nextInicio || nextFin ? 1 : 0,
                },
              };
            });
          };
          return (
            <div className="space-y-4">
              <div className="card space-y-0 divide-y divide-slate-100">
                <div className="flex items-center justify-between gap-4 py-4 first:pt-0">
                  <span className="font-medium text-slate-800 text-sm">Exigir foto al iniciar sesión</span>
                  <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={jlInicio}
                      onChange={(e) => setJlField('inicio', e.target.checked)}
                    />
                    <div className="w-11 h-6 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full" />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-4 py-4 last:pb-0">
                  <span className="font-medium text-slate-800 text-sm">Exigir foto al finalizar jornada</span>
                  <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={jlFin}
                      onChange={(e) => setJlField('fin', e.target.checked)}
                    />
                    <div className="w-11 h-6 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full" />
                  </label>
                </div>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={() => void saveAppSettings()} className="btn-primary flex items-center gap-2 text-sm">
                  <MdSave /> Guardar
                </button>
              </div>
            </div>
          );
        })()}

        {/* MONEDAS */}
        {activeSection === 'monedas' && restaurant && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('monedas')}>
                <MdAdd /> Nueva Moneda
              </button>
            </div>
            <div className="card">
              {(appSettings.monedas || []).map((m, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gold-100 rounded-lg flex items-center justify-center font-bold text-gold-700">{m.symbol}</div>
                    <div><p className="font-medium text-sm">{m.name}</p><p className="text-xs text-[var(--ui-muted)]">{m.code}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={!!m.active} onChange={() => toggleAppSection('monedas', i)} className="sr-only peer" />
                      <div className="w-9 h-5 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                    </label>
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('monedas', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('monedas', i, `la moneda "${m.code}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* MONEDA DE FACTURACIÓN */}
        {activeSection === 'moneda_facturacion' && restaurant && (
          <div className="space-y-4">
            <div className="card space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Moneda Principal</label>
                  <select className="input-field" value={restaurant.currency} onChange={e => updateR('currency', e.target.value)}>
                    <option value="PEN">Sol Peruano (PEN)</option><option value="USD">Dólar (USD)</option><option value="EUR">Euro (EUR)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Símbolo</label>
                  <input value={restaurant.currency_symbol} onChange={e => updateR('currency_symbol', e.target.value)} className="input-field" />
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={saveRestaurant} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* CUENTAS DE TRANSFERENCIA */}
        {activeSection === 'cuentas_transferencia' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('cuentas_transferencia')}><MdAdd /> Nueva Cuenta</button>
            </div>
            <div className="card">
              {(appSettings.cuentas_transferencia || []).map((c, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-sky-100 rounded-lg flex items-center justify-center"><MdAccountBalanceWallet className="text-sky-600" /></div>
                    <div><p className="font-medium text-sm">{c.bank}</p><p className="text-xs text-[var(--ui-muted)]">{c.type} · {c.account}</p></div>
                  </div>
                  <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('cuentas_transferencia', i)}><MdEdit /></button>
                  <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('cuentas_transferencia', i, `la cuenta de ${c.bank}`)}><MdDelete /></button>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* GESTIÓN DE MARCAS */}
        {activeSection === 'marcas' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('marcas')}><MdAdd /> Nueva Marca</button>
            </div>
            <div className="card">
              {!(appSettings.marcas || []).length ? (
                <div className="text-center py-8 text-[var(--ui-muted)]">
                  <MdLabel className="text-4xl mx-auto mb-2" />
                  <p className="text-sm">No hay marcas registradas</p>
                  <p className="text-xs mt-1">Agrega marcas para organizar tus productos</p>
                </div>
              ) : (appSettings.marcas || []).map((m, i) => (
                <div key={`${m.name}-${i}`} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3"><MdLabel className="text-[var(--ui-muted)]" /><p className="text-sm font-medium">{m.name}</p></div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleAppSection('marcas', i)} className={`px-2 py-1 text-xs rounded-full ${m.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 ui-text-muted'}`}>{m.active ? 'Activa' : 'Inactiva'}</button>
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('marcas', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('marcas', i, `la marca "${m.name}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* CATEGORÍA ANULAR VENTA */}
        {activeSection === 'categoria_anular' && (
          <div className="space-y-4">
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('categoria_anular')}><MdAdd /> Nuevo Motivo</button>
            </div>
            <div className="card">
              {(appSettings.categoria_anular || []).map((motivo, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <MdDoNotDisturb className="text-[#60A5FA]" />
                    <p className="text-sm font-medium">{motivo}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('categoria_anular', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('categoria_anular', i, `el motivo "${motivo}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {/* FORMAS DE PAGO */}
        {activeSection === 'formas_pago' && (
          <div className="space-y-4">
            <div className="card flex items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <MdCreditCard className="text-[var(--ui-muted)] text-xl shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium text-sm">Usar POS (terminal de tarjetas)</p>
                  <p className="text-xs text-[var(--ui-muted)]">
                    Culqi, Izipay, Niubiz… Si su negocio no usa POS, desactívelo: no aparece «Tarjeta (POS)» al cobrar
                    y el cierre de caja no pide el «Total en el POS».
                  </p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={Number(appSettings.pos_terminal_enabled ?? 1) === 1}
                  onChange={(e) => {
                    const next = { ...appSettings, pos_terminal_enabled: e.target.checked ? 1 : 0 };
                    setAppSettings(next);
                    void saveAppSettings({ nextSettings: next });
                  }}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
              </label>
            </div>
            <div className="flex justify-end items-center">
              <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => openSettingsCrudModal('formas_pago')}><MdAdd /> Nueva Forma de Pago</button>
            </div>
            <div className="card">
              {(appSettings.formas_pago || []).map((fp, i) => (
                <div key={i} className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <MdPayment className="text-[var(--ui-muted)] text-xl" />
                    <div><p className="font-medium text-sm">{fp.name}</p><p className="text-xs text-[var(--ui-muted)]">{fp.desc}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={!!fp.active} onChange={() => toggleAppSection('formas_pago', i)} className="sr-only peer" />
                      <div className="w-9 h-5 bg-slate-300 peer-checked:bg-gold-600 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                    </label>
                    <button className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]" onClick={() => openSettingsCrudModal('formas_pago', i)}><MdEdit /></button>
                    <button className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]" onClick={() => deleteAppSectionItem('formas_pago', i, `la forma de pago "${fp.name}"`)}><MdDelete /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={saveAppSettings} className="btn-primary flex items-center gap-2"><MdSave /> Guardar</button>
            </div>
          </div>
        )}

        {activeSection === 'modulo_empresarial' && (
          <div className="space-y-6">
            <div className="rounded-xl border border-[color:var(--ui-border)] bg-[var(--ui-surface)] p-4 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--ui-body-text)] flex items-center gap-2">
                    <MdAutoGraph className="text-[var(--ui-accent)]" /> Módulo empresarial (Fase A)
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary text-sm" onClick={() => loadBusinessConfigEffective()} disabled={bizLoading}>
                    Recargar
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={loadBusinessConfigHistory}>Historial</button>
                  <button type="button" className="btn-primary text-sm" onClick={() => void saveBusinessModule()} disabled={bizLoading || bizSaving}>
                    {bizSaving ? 'Guardando…' : 'Guardar cambios'}
                  </button>
                </div>
              </div>
              {bizLoading && !bizEffective && (
                <p className="text-sm text-[var(--ui-muted)]">Cargando…</p>
              )}
              {bizEffective?.domains?.map((dom) => (
                <div key={dom.id} className="mb-8 last:mb-0">
                  <h3 className="text-sm font-semibold text-sky-800 mb-3 border-b border-slate-100 pb-2">{dom.label}</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    {(dom.entries || []).map((e) => (
                      <div key={e.key} className="rounded-lg border border-slate-100 p-3 bg-slate-50/80">
                        <label className="block text-sm font-medium text-slate-800">{e.label}</label>
                        {e.description ? <p className="text-xs ui-text-muted mt-0.5 mb-2">{e.description}</p> : null}
                        {e.value_type === 'boolean' && (
                          <label className="inline-flex items-center gap-2 mt-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!bizDraft[e.key]}
                              onChange={(ev) => setBizDraft((p) => ({ ...p, [e.key]: ev.target.checked }))}
                              className="rounded border-slate-300"
                            />
                            <span className="text-sm text-[var(--ui-muted)]">{bizDraft[e.key] ? 'Activo' : 'Inactivo'}</span>
                          </label>
                        )}
                        {e.value_type === 'number' && (
                          <input
                            type="number"
                            className="input-field mt-1"
                            value={bizDraft[e.key] === undefined || bizDraft[e.key] === null ? '' : bizDraft[e.key]}
                            min={e.constraints?.min}
                            max={e.constraints?.max}
                            step={e.key === 'com_promo_sensitivity' ? 0.05 : e.key === 'prod_yield_factor_default' ? 0.01 : 1}
                            onChange={(ev) => {
                              const raw = ev.target.value;
                              if (raw === '') {
                                setBizDraft((p) => ({ ...p, [e.key]: e.value }));
                                return;
                              }
                              const v = Number(raw);
                              setBizDraft((p) => ({ ...p, [e.key]: Number.isFinite(v) ? v : e.value }));
                            }}
                          />
                        )}
                        {e.value_type === 'string' && Array.isArray(e.constraints?.allowed) && (
                          <select
                            className="input-field mt-1"
                            value={String(bizDraft[e.key] ?? '')}
                            onChange={(ev) => setBizDraft((p) => ({ ...p, [e.key]: ev.target.value }))}
                          >
                            {e.constraints.allowed.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt === 'weighted_average'
                                  ? 'Promedio ponderado'
                                  : opt === 'fifo'
                                    ? 'FIFO'
                                    : opt === 'last_cost'
                                      ? 'Último costo'
                                      : opt === 'basic'
                                        ? 'Básico'
                                        : opt === 'operations'
                                          ? 'Operaciones'
                                          : opt === 'finance'
                                            ? 'Finanzas'
                                            : opt}
                              </option>
                            ))}
                          </select>
                        )}
                        {e.value_type === 'string' && !Array.isArray(e.constraints?.allowed) && (
                          <input
                            type="text"
                            className="input-field mt-1"
                            value={String(bizDraft[e.key] ?? '')}
                            onChange={(ev) => setBizDraft((p) => ({ ...p, [e.key]: ev.target.value }))}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {bizHistRows && (
              <div className="card">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-medium text-sm">Últimos cambios</h3>
                  <button type="button" className="text-xs ui-text-muted hover:underline" onClick={() => setBizHistRows(null)}>Cerrar</button>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto text-xs">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left ui-text-muted border-b">
                        <th className="py-1 pr-2">Parámetro</th>
                        <th className="py-1 pr-2">Antes</th>
                        <th className="py-1 pr-2">Después</th>
                        <th className="py-1 pr-2">Usuario</th>
                        <th className="py-1">Fecha</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bizHistRows.map((h) => (
                        <tr key={h.id} className="border-b border-slate-50 align-top">
                          <td className="py-1 pr-2 font-mono">{h.config_key}</td>
                          <td className="py-1 pr-2 break-all">{h.value_before}</td>
                          <td className="py-1 pr-2 break-all">{h.value_after}</td>
                          <td className="py-1 pr-2">{h.actor_name || h.actor_user_id || '—'}</td>
                          <td className="py-1 whitespace-nowrap">{formatDateTime(h.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <Modal
          isOpen={settingsCrudModal.isOpen}
          onClose={closeSettingsCrudModal}
          title={`${settingsCrudModal.index === null ? 'Nuevo' : 'Editar'} ${SETTINGS_SECTION_FORMS[settingsCrudModal.section]?.title || 'registro'}`}
          size={settingsCrudModal.section === 'locales' && settingsCrudModal.index === null ? 'xl' : 'sm'}
        >
          {settingsCrudModal.section === 'locales' && settingsCrudModal.index === null ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 space-y-3">
                <p className="font-medium text-amber-900">Sucursal o local adicional</p>
                <p className="text-amber-900/90">
                  La creación de nuevas sucursales está disponible como servicio adicional. Su activación requiere coordinación directa con el proveedor.
                </p>
                <p className="text-amber-900/90">
                  Para obtener información detallada y proceder con la habilitación, por favor comunícate mediante el botón de contacto.
                </p>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={closeSettingsCrudModal} className="btn-secondary flex-1">Cancelar</button>
                <a
                  href={WHATSAPP_PROVEEDOR_LOCALES}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary flex-[1.35] inline-flex items-center justify-center gap-2 no-underline whitespace-nowrap text-center px-5"
                  onClick={() => closeSettingsCrudModal()}
                >
                  CONTACTAR AL PROVEEDOR
                </a>
              </div>
            </div>
          ) : (
            <form onSubmit={submitSettingsCrudModal} className="space-y-4">
              {(SETTINGS_SECTION_FORMS[settingsCrudModal.section]?.fields || []).map(field => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">{field.label}</label>
                  {field.type === 'select' && field.options ? (
                    <select
                      value={settingsCrudForm[field.key] ?? ''}
                      onChange={e => setSettingsCrudForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="input-field"
                      required={!!field.required}
                    >
                      {field.options.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      step={field.type === 'number' ? '1' : undefined}
                      min={field.type === 'number' && field.key === 'port' ? 1 : undefined}
                      max={field.type === 'number' && field.key === 'port' ? 65535 : undefined}
                      value={settingsCrudForm[field.key] ?? ''}
                      onChange={e => setSettingsCrudForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="input-field"
                      required={!!field.required}
                    />
                  )}
                </div>
              ))}
              <div className="flex gap-3">
                <button type="button" onClick={closeSettingsCrudModal} className="btn-secondary flex-1">Cancelar</button>
                <button type="submit" className="btn-primary flex-1">Guardar</button>
              </div>
            </form>
          )}
        </Modal>

        <Modal
          isOpen={!!historyPreview}
          onClose={() => setHistoryPreview(null)}
          title="Detalle de cambios"
          size="lg"
        >
          {!historyPreview ? null : (
            <div className="space-y-4">
              <div className="text-xs ui-text-muted">
                {formatDateTime(historyPreview.created_at)} · {historyPreview.actor_name || 'Sistema'}
              </div>
              {(getHistoryDiff(historyPreview) || []).map(diff => (
                <div key={diff.key} className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">{diff.key}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <p className="text-[11px] ui-text-muted mb-1">Antes</p>
                      <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-auto max-h-40">{diff.beforeText}</pre>
                    </div>
                    <div>
                      <p className="text-[11px] ui-text-muted mb-1">Después</p>
                      <pre className="text-[11px] bg-emerald-50 border border-emerald-200 rounded p-2 overflow-auto max-h-40">{diff.afterText}</pre>
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-3 pt-2">
                <button className="btn-secondary" onClick={() => setHistoryPreview(null)}>Cerrar</button>
                <button
                  className="btn-primary"
                  disabled={isRollingBackSettings}
                  onClick={() => {
                    const id = historyPreview.id;
                    setHistoryPreview(null);
                    rollbackAppSettings(id);
                  }}
                >
                  Restaurar esta versión
                </button>
              </div>
            </div>
          )}
        </Modal>
      </div>
      </div>
    </div>
  );
}

function UsersSection({
  users,
  appSettings,
  currentUser,
  openNewUser,
  openEditUser,
  handleDelete,
  toggleActive,
  showModal,
  closeUserModal,
  editUser,
  handleSubmit,
  form,
  setForm,
  showPw,
  setShowPw,
}) {
  const [showPermsModal, setShowPermsModal] = useState(false);
  const [permsUser, setPermsUser] = useState(null);
  const [perms, setPerms] = useState({});
  const [permsLoading, setPermsLoading] = useState(false);

  const openPermissions = async (u) => {
    let userForPerms = u;
    // Si no trae área en el listado, resolver por encargado en Áreas de producción.
    if (isProductionStaffRole(u?.role) && !String(u?.production_area_id || '').trim()) {
      const linked = (appSettings?.production_areas || []).find((a) =>
        (Array.isArray(a?.encargado_user_ids) ? a.encargado_user_ids : []).map(String).includes(String(u.id))
      );
      if (linked?.id) {
        userForPerms = { ...u, production_area_id: String(linked.id).trim() };
      }
    }
    setPermsUser(userForPerms);
    setPermsLoading(true);
    setShowPermsModal(true);
    try {
      const data = await api.get(`/users/${u.id}/permissions`);
      const defaults = {};
      ALL_MODULES.forEach((m) => {
        defaults[m.id] = data[m.id] === true;
      });
      CAJA_EXTRA_PERMISSIONS.forEach((p) => {
        defaults[p.key] = data[p.key] === true;
      });
      if (isProductionStaffRole(userForPerms.role)) {
        const areaDefaults = defaultProductionAreaPermissions(userForPerms);
        defaults.cocina = areaDefaults.cocina;
        defaults.bar = areaDefaults.bar;
        defaults.produccion = areaDefaults.produccion;
        defaults._production_area = Boolean(
          areaDefaults.cocina || areaDefaults.bar || areaDefaults.produccion || String(userForPerms.production_area_id || '').trim()
        );
      }
      setPerms(defaults);
    } catch {
      const defaults = {};
      ALL_MODULES.forEach((m) => { defaults[m.id] = false; });
      if (isProductionStaffRole(userForPerms.role)) {
        const areaDefaults = defaultProductionAreaPermissions(userForPerms);
        Object.assign(defaults, areaDefaults);
        defaults._production_area = Boolean(
          areaDefaults.cocina || areaDefaults.bar || areaDefaults.produccion || String(userForPerms.production_area_id || '').trim()
        );
      }
      setPerms(defaults);
    } finally { setPermsLoading(false); }
  };

  const savePermissions = async () => {
    try {
      const payload = { ...perms };
      delete payload._production_area;
      if (isProductionStaffRole(permsUser?.role)) {
        const areaDefaults = defaultProductionAreaPermissions(permsUser);
        const areaOn = perms._production_area !== false;
        payload.cocina = false;
        payload.bar = false;
        payload.produccion = false;
        if (areaOn) {
          payload.cocina = areaDefaults.cocina;
          payload.bar = areaDefaults.bar;
          payload.produccion = areaDefaults.produccion;
        }
      }
      await api.put(`/users/${permsUser.id}/permissions`, { permissions: payload });
      toast.success(`Permisos actualizados para ${permsUser.full_name}. Si ya está conectado, que cierre sesión y vuelva a entrar (o cambie de pestaña).`);
      setShowPermsModal(false);
    } catch (err) { toast.error(err.message); }
  };

  const togglePerm = (moduleId) => {
    setPerms((prev) => ({ ...prev, [moduleId]: !prev[moduleId] }));
  };

  const resetToDefaults = () => {
    if (!permsUser) return;
    const defaults = {};
    ALL_MODULES.forEach((m) => {
      defaults[m.id] = isModuleDefaultForUser(m, permsUser);
    });
    if (isProductionStaffRole(permsUser.role)) {
      const areaDefaults = defaultProductionAreaPermissions(permsUser);
      defaults.cocina = areaDefaults.cocina;
      defaults.bar = areaDefaults.bar;
      defaults.produccion = areaDefaults.produccion;
      defaults._production_area = Boolean(
        areaDefaults.cocina || areaDefaults.bar || areaDefaults.produccion || String(permsUser.production_area_id || '').trim()
      );
    }
    CAJA_EXTRA_PERMISSIONS.forEach((p) => {
      defaults[p.key] = false;
    });
    setPerms(defaults);
  };

  const cajaNameById = useMemo(() => {
    const m = new Map();
    (appSettings?.cajas || []).forEach((c) => {
      const id = String(c?.id || '').trim();
      if (id) m.set(id, String(c?.name || '').trim() || 'Caja');
    });
    return m;
  }, [appSettings?.cajas]);

  const areaNameById = useMemo(() => {
    const m = new Map();
    (appSettings?.production_areas || []).forEach((a) => {
      const id = String(a?.id || '').trim();
      if (id) m.set(id, String(a?.name || '').trim() || id);
    });
    return m;
  }, [appSettings?.production_areas]);

  const cajaOptionsForForm = (() => {
    const assigned = new Map();
    (users || []).forEach((u) => {
      if (String(u.role || '').toLowerCase() !== 'cajero') return;
      const cid = String(u.caja_station_id || '').trim();
      if (!cid) return;
      assigned.set(cid, u.id);
    });
    const list = Array.isArray(appSettings?.cajas) ? appSettings.cajas : [];
    return list
      .filter((c) => Number(c?.active || 0) === 1 && String(c?.id || '').trim())
      .filter((c) => {
        const uid = assigned.get(String(c.id).trim());
        return !uid || uid === editUser?.id;
      })
      .map((c) => ({ id: String(c.id).trim(), name: String(c.name || '').trim() || 'Caja' }));
  })();

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm ui-text-muted">{users.length} usuario(s) registrado(s)</p>
        <button onClick={openNewUser} className="btn-primary flex items-center gap-2 text-sm"><MdAdd /> Nuevo Usuario</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {Object.entries(ROLES).map(([key, role]) => {
          const count = users.filter((u) => uiStaffRole(u.role) === key).length;
          const Icon = role.icon;
          return (
            <div key={key} className="card flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${role.color}`}><Icon className="text-xl" /></div>
              <div><p className="text-xs ui-text-muted">{role.label}</p><p className="text-lg font-bold">{count}</p></div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div
          className="overflow-x-auto overscroll-x-contain touch-pan-x [-webkit-overflow-scrolling:touch] scrollbar-thin"
          style={{ touchAction: 'pan-x pan-y' }}
        >
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left p-3 font-semibold text-[var(--ui-muted)] whitespace-nowrap">Usuario</th>
              <th className="text-left p-3 font-semibold text-[var(--ui-muted)] whitespace-nowrap">Rol</th>
              <th className="text-center p-3 font-semibold text-[var(--ui-muted)] whitespace-nowrap">Estado</th>
              <th className="text-center p-3 font-semibold text-[var(--ui-muted)] whitespace-nowrap">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const roleInfo = ROLES[uiStaffRole(u.role)] || ROLES.mozo;
              const RoleIcon = roleInfo.icon;
              return (
                <tr key={u.id} className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${!u.is_active ? 'opacity-50' : ''}`}>
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-bold text-[var(--ui-muted)]">{(u.full_name || u.username || '?').charAt(0)}</span>
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold rf-section-title">{u.full_name}</p>
                        <p className="text-xs text-[var(--ui-muted)]">@{u.username}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    <span className={`${roleInfo.color} px-3 py-1 inline-flex items-center gap-1`}>
                      <RoleIcon className="text-sm" /> {roleInfo.label}
                    </span>
                    {Number(u.is_buyer_admin || 0) === 1 ? (
                      <p className="text-[10px] text-amber-700 mt-1 font-medium">Dueño del negocio</p>
                    ) : null}
                    {(String(u.role || '').toLowerCase() === 'cajero' || String(u.role || '').toLowerCase() === 'mozo')
                      && String(u.caja_station_id || '').trim() && (
                      <p className="text-[10px] text-[var(--ui-muted)] mt-1">
                        Caja: {cajaNameById.get(String(u.caja_station_id).trim()) || '—'}
                      </p>
                    )}
                    {isProductionStaffRole(u.role) && String(u.production_area_id || '').trim() && (
                      <p className="text-[10px] text-[var(--ui-muted)] mt-1">
                        Área: {areaNameById.get(String(u.production_area_id).trim()) || u.production_area_id}
                      </p>
                    )}
                  </td>
                  <td className="p-3 text-center whitespace-nowrap">
                    <button onClick={() => toggleActive(u)} className={`px-3 py-1 text-xs font-bold ${u.is_active ? UI_BADGE.emerald : UI_BADGE.slate}`}>
                      {u.is_active ? 'ACTIVO' : 'INACTIVO'}
                    </button>
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    <div className="flex items-center justify-center gap-2">
                      <button onClick={() => openEditUser(u)} className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-50 text-sky-600 rounded-lg hover:bg-sky-100 text-xs font-medium border border-sky-200">
                        <MdEdit className="text-sm" /> Editar
                      </button>
                      <button onClick={() => openPermissions(u)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 text-xs font-medium border border-emerald-200">
                        <MdSecurity className="text-sm" /> Permisos POS
                      </button>
                      {u.id !== currentUser?.id && Number(u.is_buyer_admin || 0) !== 1 && (
                        <button onClick={() => handleDelete(u)} className="p-1.5 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]">
                          <MdDelete className="text-sm" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Modal Editar Usuario */}
      <Modal isOpen={showModal} onClose={closeUserModal} title={editUser ? 'Editar Usuario' : 'Nuevo Usuario'} size="md">
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Nombre Completo</label>
            <input type="text" value={form.full_name} onChange={e => setForm({ ...form, full_name: formatCatalogNameInput(e.target.value) })} className="input-field" required placeholder="Nombre del empleado" autoComplete="off" name="user-create-full-name" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Usuario</label><input type="text" value={form.username} onChange={e => setForm({ ...form, username: formatCatalogNameInput(e.target.value) })} className="input-field" required placeholder="usuario" autoComplete="off" name="user-create-username" /></div>
            <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Email <span className="text-[var(--ui-muted)] font-normal">(opcional)</span></label><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="input-field" placeholder="email@ejemplo.com" autoComplete="off" name="user-create-email" /></div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Contraseña {editUser && <span className="text-[var(--ui-muted)] font-normal">(dejar vacío para no cambiar)</span>}</label>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} className="input-field pr-10" required={!editUser} placeholder={editUser ? 'Escribe nueva contraseña' : '••••••••'} minLength={editUser ? 0 : 4} autoComplete="new-password" name="user-create-password" />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ui-muted)] hover:text-[var(--ui-muted)]">{showPw ? <MdVisibilityOff /> : <MdVisibility />}</button>
            </div>
            {editUser && (
              <p className="text-[11px] text-[var(--ui-muted)] mt-1">
                Por seguridad no se puede mostrar la contraseña actual. Puedes ingresar una nueva y verla con el icono de ojo.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-2">Rol</label>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(ROLES).map(([key, role]) => {
                const Icon = role.icon;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        role: key,
                        caja_station_id:
                          key === 'cajero' || key === 'mozo' ? form.caja_station_id : '',
                      })
                    }
                    className={`p-3 rounded-xl border-2 text-center transition-all ${form.role === key ? 'border-gold-500 bg-gold-50' : 'border-slate-200 hover:border-slate-300'}`}
                  >
                    <Icon className={`text-2xl mx-auto mb-1 ${form.role === key ? 'text-gold-600' : 'text-[var(--ui-muted)]'}`} />
                    <p className="text-xs font-medium">{role.label}</p>
                    <p className="text-[10px] text-[var(--ui-muted)] mt-0.5">{role.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>
          {String(form.role || '').toLowerCase() === 'cajero' && (
            <div>
              <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Caja asignada</label>
              <select
                value={String(form.caja_station_id || '')}
                onChange={(e) => setForm({ ...form, caja_station_id: e.target.value })}
                className="input-field"
              >
                <option value="">— Seleccione una caja —</option>
                {cajaOptionsForForm.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {cajaOptionsForForm.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  No hay cajas activas disponibles (o ya están asignadas a otros cajeros). Cree una en Configuración → Cajas.
                </p>
              )}
              {cajaOptionsForForm.length > 0 && (
                <p className="text-xs text-[var(--ui-muted)] mt-1">
                  Si es el primer cajero del local, puede dejar «Seleccione» y se vinculará solo a la Caja Principal.
                </p>
              )}
            </div>
          )}
          {(String(form.role || '').toLowerCase() === 'mozo') && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Caja asignada (obligatorio)</label>
                <select
                  value={String(form.caja_station_id || '')}
                  onChange={(e) => setForm({ ...form, caja_station_id: e.target.value })}
                  className="input-field"
                  required
                >
                  <option value="">— Seleccione una caja —</option>
                  {(appSettings?.cajas || [])
                    .filter((c) => Number(c?.active || 0) === 1 && String(c?.id || '').trim())
                    .map((c) => (
                      <option key={c.id} value={String(c.id).trim()}>{c.name || 'Caja'}</option>
                    ))}
                </select>
                <p className="text-xs text-[var(--ui-muted)] mt-1">Sus comandas y mesas pertenecen a esta caja.</p>
              </div>
            </div>
          )}
          {String(form.role || '').toLowerCase() === 'produccion' && (
            <p className="text-xs ui-text-muted rounded-lg border border-[color:var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-2">
              No se elige área aquí. Vincula este usuario como encargado en Configuración → Áreas de producción.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Teléfono</label><input type="text" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="input-field" placeholder="999 999 999" autoComplete="off" name="user-create-phone" /></div>
            <div>
              <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Estado</label>
              <select
                value={Number(form.is_active || 0) === 1 ? 1 : 0}
                onChange={(e) => setForm({ ...form, is_active: Number(e.target.value || 0) === 1 ? 1 : 0 })}
                className="input-field"
              >
                <option value={1}>Activo</option>
                <option value={0}>Inactivo</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={closeUserModal} className="btn-secondary flex-1">Cancelar</button>
            <button type="submit" className="btn-primary flex-1">{editUser ? 'Guardar' : 'Crear Usuario'}</button>
          </div>
        </form>
      </Modal>

      {/* Modal Permisos POS */}
      <Modal isOpen={showPermsModal} onClose={() => setShowPermsModal(false)} title={`Permisos POS — ${permsUser?.full_name || ''}`} size="md">
        {permsLoading ? (
          <div className="flex justify-center py-8"><div className="animate-spin w-8 h-8 border-4 border-gold-500 border-t-transparent rounded-full" /></div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm ui-text-muted">Rol actual: <span className="font-semibold text-slate-700">{ROLES[uiStaffRole(permsUser?.role)]?.label}</span></p>
                <p className="text-xs text-[var(--ui-muted)] mt-0.5">Los módulos marcados serán accesibles para este usuario</p>
              </div>
              <button onClick={resetToDefaults} className="text-xs px-3 py-1.5 bg-slate-100 text-[var(--ui-muted)] rounded-lg hover:bg-slate-200">
                Restaurar por defecto
              </button>
            </div>

            <div className="space-y-1 max-h-96 overflow-y-auto">
              {buildPermModulesForUser(permsUser, areaNameById).map((mod) => {
                const Icon = mod.icon;
                const isDefault = isModuleDefaultForUser(mod, permsUser);
                const isEnabled = Boolean(perms[mod.id]);
                return (
                  <div
                    key={mod.id}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-colors cursor-pointer ${
                      isEnabled ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
                    }`}
                    onClick={() => togglePerm(mod.id)}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${isEnabled ? 'bg-emerald-100' : 'bg-slate-200'}`}>
                        <Icon className={`text-lg ${isEnabled ? 'text-emerald-600' : 'text-[var(--ui-muted)]'}`} />
                      </div>
                      <div>
                        <p className={`text-sm font-medium ${isEnabled ? 'text-emerald-800' : 'ui-text-muted'}`}>{mod.label}</p>
                        {mod.isProductionAreaLink ? (
                          <p className="text-[10px] text-[var(--ui-muted)]">
                            {mod.hint || 'Área de producción vinculada'}
                          </p>
                        ) : isDefault ? (
                          <p className="text-[10px] text-[var(--ui-muted)]">Incluido por defecto en rol {ROLES[uiStaffRole(permsUser?.role)]?.label}</p>
                        ) : null}
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isEnabled} onChange={() => togglePerm(mod.id)} className="sr-only peer" />
                      <div className="w-10 h-5 bg-slate-300 peer-checked:bg-emerald-500 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
                    </label>
                  </div>
                );
              })}
            </div>

            {(perms.caja || permsUser?.role === 'cajero') && (
              <div className="mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm font-semibold text-[var(--ui-body-text)] mb-2">Permisos extra de caja</p>
                <div className="space-y-1">
                  {CAJA_EXTRA_PERMISSIONS.map((extra) => {
                    const isEnabled = Boolean(perms[extra.key]);
                    return (
                      <div
                        key={extra.key}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-colors cursor-pointer ${
                          isEnabled ? 'bg-sky-50 border-sky-200' : 'bg-slate-50 border-slate-200'
                        }`}
                        onClick={() => setPerms((prev) => ({ ...prev, [extra.key]: !prev[extra.key] }))}
                      >
                        <div>
                          <p className={`text-sm font-medium ${isEnabled ? 'text-sky-800' : 'ui-text-muted'}`}>{extra.label}</p>
                          <p className="text-[10px] text-[var(--ui-muted)]">{extra.hint}</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={() => setPerms((prev) => ({ ...prev, [extra.key]: !prev[extra.key] }))}
                            className="sr-only peer"
                          />
                          <div className="w-10 h-5 bg-slate-300 peer-checked:bg-sky-500 rounded-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-4 mt-4 border-t border-slate-200">
              <button onClick={() => setShowPermsModal(false)} className="btn-secondary flex-1">Cancelar</button>
              <button onClick={savePermissions} className="btn-primary flex-1 flex items-center justify-center gap-2"><MdSave /> Guardar Permisos</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function SalonMesasSection({ appSettings }) {
  const PRIMARY_CAJA_ID = 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001';
  const activeCajas = useMemo(
    () =>
      (Array.isArray(appSettings?.cajas) ? appSettings.cajas : [])
        .filter((c) => Number(c?.active || 0) === 1 && String(c?.id || '').trim())
        .map((c) => ({ id: String(c.id).trim(), name: String(c.name || '').trim() || 'Caja' })),
    [appSettings?.cajas],
  );
  const defaultCajaId = activeCajas[0]?.id || PRIMARY_CAJA_ID;
  const [selectedCajaId, setSelectedCajaId] = useState(defaultCajaId);
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [salones, setSalones] = useState([]);
  const [showSalonModal, setShowSalonModal] = useState(false);
  const [editSalon, setEditSalon] = useState(null);
  const [salonForm, setSalonForm] = useState({ name: '', description: '', caja_station_id: defaultCajaId });
  const [savingSalones, setSavingSalones] = useState(false);
  const [salonOrderEditing, setSalonOrderEditing] = useState(false);
  const [salonOrderPosition, setSalonOrderPosition] = useState(1);

  const [showMesaModal, setShowMesaModal] = useState(false);
  const [editMesa, setEditMesa] = useState(null);
  const [mesaForm, setMesaForm] = useState({ number: '', name: '', capacity: 4, zone: 'principal', caja_station_id: defaultCajaId, display_label: 'number' });

  useEffect(() => {
    if (!activeCajas.some((c) => c.id === selectedCajaId)) {
      setSelectedCajaId(defaultCajaId);
    }
  }, [activeCajas, defaultCajaId, selectedCajaId]);

  const loadTables = () => {
    Promise.all([
      api.get('/tables'),
      api.get('/tables/salones').catch(() => ({ salones: [] })),
    ])
      .then(([data, salonesRes]) => {
        setTables(data);
        const raw = Array.isArray(salonesRes?.salones) ? salonesRes.salones : [];
        setSalones([...raw].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadTables(); }, []);

  const salonCajaId = (s) => String(s?.caja_station_id || '').trim() || PRIMARY_CAJA_ID;
  const mesaCajaId = (t) => String(t?.caja_station_id || '').trim() || PRIMARY_CAJA_ID;

  const filteredSalones = useMemo(
    () => salones.filter((s) => salonCajaId(s) === selectedCajaId),
    [salones, selectedCajaId],
  );
  const filteredTables = useMemo(
    () => tables.filter((t) => mesaCajaId(t) === selectedCajaId),
    [tables, selectedCajaId],
  );

  const persistSalones = async (nextSalones) => {
    setSavingSalones(true);
    try {
      const res = await api.put('/tables/salones', {
        salones: nextSalones.map((s, idx) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          sort_order: idx,
          caja_station_id: String(s.caja_station_id || '').trim() || PRIMARY_CAJA_ID,
        })),
      });
      const saved = Array.isArray(res?.salones) ? res.salones : nextSalones;
      setSalones(saved);
      return saved;
    } catch (err) {
      toast.error(err.message || 'No se pudieron guardar los salones');
      throw err;
    } finally {
      setSavingSalones(false);
    }
  };

  const openNewSalon = () => {
    setEditSalon(null);
    setSalonForm({ name: '', description: '', caja_station_id: selectedCajaId });
    setSalonOrderEditing(false);
    setShowSalonModal(true);
  };
  const openEditSalon = (s) => {
    const currentIdx = filteredSalones.findIndex((sal) => sal.id === s.id);
    setEditSalon(s);
    setSalonForm({
      name: String(s.name || '').toUpperCase(),
      description: s.description || '',
      caja_station_id: salonCajaId(s),
    });
    setSalonOrderPosition(currentIdx >= 0 ? currentIdx + 1 : 1);
    setSalonOrderEditing(false);
    setShowSalonModal(true);
  };

  const handleSalonSubmit = async (e) => {
    e.preventDefault();
    const name = String(salonForm.name || '').trim().toUpperCase();
    if (!name) return toast.error('Ingresa el nombre del salón');
    const cajaId = String(salonForm.caja_station_id || selectedCajaId || PRIMARY_CAJA_ID).trim() || PRIMARY_CAJA_ID;
    try {
      let next;
      if (editSalon) {
        next = salones.map((s) =>
          s.id === editSalon.id
            ? { ...s, name, description: String(salonForm.description || '').trim(), caja_station_id: cajaId }
            : s
        );
      } else {
        const baseId = salonSlugFromName(name) || `salon_${Date.now()}`;
        let id = baseId;
        let n = 2;
        while (salones.some((s) => s.id === id)) {
          id = `${baseId}_${n}`;
          n += 1;
        }
        next = [
          ...salones,
          {
            id,
            name,
            description: String(salonForm.description || '').trim(),
            sort_order: salones.length,
            caja_station_id: cajaId,
          },
        ];
      }
      await persistSalones(next);
      toast.success(editSalon ? 'Salón actualizado' : 'Salón creado');
      setShowSalonModal(false);
    } catch (_) {
      /* toast en persistSalones */
    }
  };

  const deleteSalon = async (s) => {
    const mesasEnSalon = tablesForSalon(s, filteredTables, filteredSalones);
    if (mesasEnSalon.length > 0) return toast.error('Elimina primero las mesas de este salón');
    if (!confirm(`¿Eliminar salón "${s.name}"?`)) return;
    try {
      const next = salones.filter((sal) => sal.id !== s.id);
      await persistSalones(next);
      toast.success('Salón eliminado');
    } catch (_) {
      /* toast en persistSalones */
    }
  };

  const applySalonOrderFromEdit = async () => {
    if (!editSalon) return;
    const currentIdx = filteredSalones.findIndex((s) => s.id === editSalon.id);
    if (currentIdx + 1 === salonOrderPosition) {
      toast.error('El salón ya está en esa posición');
      return;
    }
    try {
      const others = salones.filter((s) => salonCajaId(s) !== selectedCajaId);
      const reordered = reorderSalonList(filteredSalones, editSalon.id, salonOrderPosition);
      const next = [...others, ...reordered].map((s, idx) => ({ ...s, sort_order: idx }));
      await persistSalones(next);
      toast.success(`"${editSalon.name}" movido a la posición ${salonOrderPosition}`);
      setSalonOrderEditing(false);
      setShowSalonModal(false);
    } catch (_) {
      /* toast en persistSalones */
    }
  };

  const openNewMesa = (salonId) => {
    const nextNum = tables.length > 0 ? Math.max(...tables.map(t => t.number)) + 1 : 1;
    setEditMesa(null);
    setMesaForm({ number: nextNum, name: '', capacity: 4, zone: salonId, caja_station_id: selectedCajaId, display_label: 'number' });
    setShowMesaModal(true);
  };

  const openEditMesa = (t) => {
    setEditMesa(t);
    setMesaForm({
      number: t.number,
      name: t.name || '',
      capacity: t.capacity || 4,
      zone: t.zone || 'principal',
      caja_station_id: mesaCajaId(t) || selectedCajaId,
      display_label: normalizeTableDisplayLabel(t.display_label),
    });
    setShowMesaModal(true);
  };

  const handleMesaSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...mesaForm,
      caja_station_id: String(mesaForm.caja_station_id || selectedCajaId || PRIMARY_CAJA_ID).trim() || PRIMARY_CAJA_ID,
    };
    try {
      if (editMesa) {
        await api.put(`/tables/${editMesa.id}`, payload);
        toast.success('Mesa actualizada');
      } else {
        await api.post('/tables', { ...payload, name: payload.name || `Mesa ${payload.number}` });
        toast.success('Mesa creada');
      }
      setShowMesaModal(false);
      loadTables();
    } catch (err) { toast.error(err.message); }
  };

  const deleteMesa = async (t) => {
    if (!confirm(`¿Eliminar "${getTableDisplayLabel(t)}"?`)) return;
    try {
      await api.delete(`/tables/${t.id}`);
      toast.success('Mesa eliminada');
      loadTables();
    } catch (err) { toast.error(err.message); }
  };

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin w-8 h-8 border-4 border-gold-500 border-t-transparent rounded-full" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[200px]">
          <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Caja</label>
          <select
            value={selectedCajaId}
            onChange={(e) => setSelectedCajaId(e.target.value)}
            className="input-field"
          >
            {activeCajas.length === 0 ? (
              <option value={PRIMARY_CAJA_ID}>Caja Principal</option>
            ) : (
              activeCajas.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))
            )}
          </select>
        </div>
        <div className="flex items-center gap-3 ml-auto">
          <p className="text-sm ui-text-muted">
            {filteredSalones.length} salón(es) · {filteredTables.length} mesa(s)
            {savingSalones ? ' · Guardando…' : ''}
          </p>
          <button onClick={openNewSalon} className="btn-primary flex items-center gap-2 text-sm"><MdAdd /> Nuevo Salón</button>
        </div>
      </div>

      {filteredSalones.map(salon => {
        const mesasSalon = tablesForSalon(salon, filteredTables, filteredSalones);
        return (
          <div key={salon.id} className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gold-100 rounded-xl flex items-center justify-center">
                  <MdTableRestaurant className="text-xl text-gold-600" />
                </div>
                <div>
                  <h3 className="font-bold rf-section-title">
                    {salon.name}
                  </h3>
                  {salon.description && <p className="text-xs text-[var(--ui-muted)]">{salon.description}</p>}
                </div>
                <span className="px-2 py-0.5 bg-slate-100 ui-text-muted text-xs rounded-full">{mesasSalon.length} mesas</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openNewMesa(salon.id)} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-600 text-xs rounded-lg hover:bg-emerald-100 font-medium">
                  <MdAdd /> Agregar Mesa
                </button>
                <button onClick={() => openEditSalon(salon)} className="p-2 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)]"><MdEdit /></button>
                <button onClick={() => deleteSalon(salon)} className="p-2 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]"><MdDelete /></button>
              </div>
            </div>

            {mesasSalon.length === 0 ? (
              <div className="text-center py-6 border-2 border-dashed border-slate-200 rounded-xl">
                <MdTableRestaurant className="text-3xl text-[var(--ui-muted)] mx-auto mb-2" />
                <p className="text-sm text-[var(--ui-muted)]">No hay mesas en este salón</p>
                <button onClick={() => openNewMesa(salon.id)} className="text-xs text-gold-600 font-medium mt-1 hover:underline">Agregar primera mesa</button>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left p-3 font-semibold text-[var(--ui-muted)]">Mesa</th>
                      <th className="text-left p-3 font-semibold text-[var(--ui-muted)]">Nombre</th>
                      <th className="text-center p-3 font-semibold text-[var(--ui-muted)]">Personas</th>
                      <th className="text-center p-3 font-semibold text-[var(--ui-muted)]">Estado</th>
                      <th className="text-center p-3 font-semibold text-[var(--ui-muted)] w-28">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mesasSalon.map(t => (
                      <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                              t.status === 'occupied' ? 'bg-[#DBEAFE]' : t.status === 'reserved' ? 'bg-gold-100' : 'bg-emerald-100'
                            }`}>
                              <span className={`text-xs font-bold ${
                                t.status === 'occupied' ? 'text-[#1D4ED8]' : t.status === 'reserved' ? 'text-gold-600' : 'text-emerald-600'
                              }`}>#{t.number}</span>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 font-medium text-slate-700">{getTableDisplayLabel(t)}</td>
                        <td className="p-3 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 rounded-full text-xs font-medium text-[var(--ui-muted)]">
                            <MdPeople className="text-sm" /> {t.capacity}
                          </span>
                        </td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            t.status === 'occupied' ? 'bg-[#DBEAFE] text-[#1D4ED8]' :
                            t.status === 'reserved' ? 'bg-gold-100 text-gold-700' :
                            t.status === 'maintenance' ? 'bg-slate-200 text-[var(--ui-muted)]' :
                            'bg-emerald-100 text-emerald-700'
                          }`}>
                            {t.status === 'occupied' ? 'Ocupada' : t.status === 'reserved' ? 'Reservada' : t.status === 'maintenance' ? 'Mantenimiento' : 'Disponible'}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => openEditMesa(t)} className="p-1.5 hover:bg-slate-100 rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-muted)]"><MdEdit className="text-sm" /></button>
                            <button onClick={() => deleteMesa(t)} className="p-1.5 hover:bg-[var(--ui-sidebar-hover)] rounded-lg text-[var(--ui-muted)] hover:text-[var(--ui-accent)]"><MdDelete className="text-sm" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* SALON MODAL */}
      <Modal isOpen={showSalonModal} onClose={() => { setShowSalonModal(false); setSalonOrderEditing(false); }} title={editSalon ? 'Editar Salón' : 'Nuevo Salón'} size="sm">
        <form onSubmit={handleSalonSubmit} className="space-y-4">
          <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Nombre del Salón</label><input value={salonForm.name} onChange={e => setSalonForm({ ...salonForm, name: e.target.value.toUpperCase() })} className="input-field uppercase" required placeholder="Ej: TERRAZA, SEGUNDO PISO" autoCapitalize="characters" /></div>
          <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Descripción</label><textarea value={salonForm.description} onChange={e => setSalonForm({ ...salonForm, description: e.target.value })} className="input-field" rows="2" placeholder="Descripción del salón..." /></div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Caja</label>
            <select
              value={String(salonForm.caja_station_id || selectedCajaId)}
              onChange={(e) => setSalonForm({ ...salonForm, caja_station_id: e.target.value })}
              className="input-field"
            >
              {(activeCajas.length ? activeCajas : [{ id: PRIMARY_CAJA_ID, name: 'Caja Principal' }]).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {editSalon ? (
            <div className="rounded-xl border border-[color:var(--ui-border)] p-3 space-y-3">
              <p className="text-sm font-medium text-[var(--ui-body-text)]">Orden en listado</p>
              {!salonOrderEditing ? (
                <button
                  type="button"
                  onClick={() => setSalonOrderEditing(true)}
                  className="text-xs px-3 py-1.5 border border-[color:var(--ui-border)] rounded-lg hover:bg-[var(--ui-sidebar-hover)]"
                >
                  Cambiar orden de salón
                </button>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-[var(--ui-muted)] mb-1">Nueva posición (1–{filteredSalones.length})</label>
                    <select
                      value={salonOrderPosition}
                      onChange={(e) => setSalonOrderPosition(Number(e.target.value))}
                      className="input-field"
                    >
                      {filteredSalones.map((s, idx) => (
                        <option key={s.id} value={idx + 1}>
                          {idx + 1} — {s.id === editSalon.id ? `${s.name} (actual)` : s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void applySalonOrderFromEdit()}
                      className="text-xs px-3 py-1.5 bg-[#3B82F6] text-white rounded-lg hover:bg-[#2563EB] disabled:opacity-50"
                      disabled={savingSalones}
                    >
                      Aplicar posición
                    </button>
                    <button
                      type="button"
                      onClick={() => setSalonOrderEditing(false)}
                      className="text-xs px-3 py-1.5 border border-[color:var(--ui-border)] rounded-lg"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          <div className="flex gap-3"><button type="button" onClick={() => { setShowSalonModal(false); setSalonOrderEditing(false); }} className="btn-secondary flex-1">Cancelar</button><button type="submit" className="btn-primary flex-1">{editSalon ? 'Guardar' : 'Crear Salón'}</button></div>
        </form>
      </Modal>

      {/* MESA MODAL */}
      <Modal isOpen={showMesaModal} onClose={() => setShowMesaModal(false)} title={editMesa ? 'Editar Mesa' : 'Nueva Mesa'} size="sm">
        <form onSubmit={handleMesaSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Número</label><input type="number" value={mesaForm.number} onChange={e => setMesaForm({ ...mesaForm, number: parseInt(e.target.value) })} className="input-field" required min="1" /></div>
            <div><label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Capacidad (personas)</label><input type="number" value={mesaForm.capacity} onChange={e => setMesaForm({ ...mesaForm, capacity: parseInt(e.target.value) })} className="input-field" required min="1" max="20" /></div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Nombre (opcional)</label>
            <input
              value={mesaForm.name}
              onChange={(e) => {
                const nextName = e.target.value;
                setMesaForm((prev) => ({
                  ...prev,
                  name: nextName,
                  display_label: String(nextName || '').trim() ? prev.display_label : 'number',
                }));
              }}
              className="input-field"
              placeholder={`Mesa ${mesaForm.number}`}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Mostrar en Caja y Mesas</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMesaForm({ ...mesaForm, display_label: 'number' })}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  mesaForm.display_label === 'number'
                    ? 'border-[var(--ui-accent)] bg-[var(--ui-accent)]/10 text-[var(--ui-body-text)]'
                    : 'border-[color:var(--ui-border)] text-[var(--ui-muted)]'
                }`}
              >
                Número ({mesaForm.number || '—'})
              </button>
              <button
                type="button"
                onClick={() => setMesaForm({ ...mesaForm, display_label: 'name' })}
                disabled={!String(mesaForm.name || '').trim()}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  mesaForm.display_label === 'name'
                    ? 'border-[var(--ui-accent)] bg-[var(--ui-accent)]/10 text-[var(--ui-body-text)]'
                    : 'border-[color:var(--ui-border)] text-[var(--ui-muted)]'
                }`}
              >
                Nombre ({String(mesaForm.name || '').trim() || '…'})
              </button>
            </div>
            <p className="mt-1 text-xs text-[var(--ui-muted)]">Así se verá la mesa en el mapa y en cobros.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--ui-body-text)] mb-1">Salón</label>
            <select value={mesaForm.zone} onChange={e => setMesaForm({ ...mesaForm, zone: e.target.value })} className="input-field">
              {filteredSalones.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex gap-3"><button type="button" onClick={() => setShowMesaModal(false)} className="btn-secondary flex-1">Cancelar</button><button type="submit" className="btn-primary flex-1">{editMesa ? 'Guardar' : 'Crear Mesa'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
