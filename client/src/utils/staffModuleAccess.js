/** Rutas de módulos admin y roles base (permiso fino vía `user.permissions`). */
import { isMasterViewingAsOwner } from './masterViewMode';

export const ADMIN_MODULE_PATHS = [
  { path: '/admin', moduleId: 'escritorio', roles: ['admin'] },
  { path: '/admin/caja', moduleId: 'caja', roles: ['admin', 'cajero'] },
  { path: '/admin/mesas', moduleId: 'mesas', roles: ['admin', 'mozo'] },
  { path: '/admin/produccion/cocina', moduleId: 'produccion', roles: ['admin', 'produccion', 'cocina', 'bar'] },
  { path: '/admin/cocina', moduleId: 'cocina', roles: ['admin', 'produccion', 'cocina'] },
  { path: '/admin/bar', moduleId: 'bar', roles: ['admin', 'produccion', 'bar'] },
  { path: '/admin/delivery', moduleId: 'delivery', roles: ['admin', 'delivery'] },
  { path: '/admin/reservas', moduleId: 'reservas', roles: ['admin'] },
  { path: '/admin/auto-pedido', moduleId: 'auto_pedido', roles: ['admin'] },
  { path: '/admin/clientes', moduleId: 'clientes', roles: ['admin'] },
  { path: '/admin/fidelizacion', moduleId: 'fidelizacion', roles: ['admin'] },
  { path: '/admin/creditos', moduleId: 'creditos', roles: ['admin'] },
  { path: '/admin/promociones', moduleId: 'ofertas', moduleIds: ['ofertas', 'descuentos'], roles: ['admin'] },
  { path: '/admin/almacen', moduleId: 'almacen', roles: ['admin'] },
  { path: '/admin/productos', moduleId: 'productos', roles: ['admin'] },
  { path: '/admin/informes', moduleId: 'informes', roles: ['admin'] },
  { path: '/admin/ventas', moduleId: 'ventas', roles: ['admin'] },
  { path: '/admin/indicadores', moduleId: 'indicadores', roles: ['admin'] },
  { path: '/admin/mi-restaurant', moduleId: 'mi_restaurant', roles: ['admin', 'master_admin'] },
  { path: '/admin/tiempo-trabajado', moduleId: 'tiempo_trabajado', roles: ['admin'] },
  { path: '/admin/configuracion', moduleId: 'configuracion', roles: ['admin'] },
];

/** Módulo de trabajo de cada rol: va primero en el menú y es la entrada al iniciar sesión. */
export const PRIMARY_MODULE_BY_ROLE = {
  cajero: 'caja',
  mozo: 'mesas',
};

export function isPermissionEnabled(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function isPermissionExplicitlyDenied(value) {
  return value === false || value === 0 || value === '0' || value === 'false';
}

const PRODUCTION_ROLES = ['produccion', 'cocina', 'bar'];

/** Área propia del personal de producción; mismas reglas que `userCanAccessKitchenStation` del API. */
export function getOwnProductionAreaId(user) {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'cocina') return 'cocina';
  if (role === 'bar') return 'bar';
  if (role === 'produccion') return String(user?.production_area_id || '').trim();
  return '';
}

/** El API siempre deja al personal de producción abrir su propia estación, sin depender de permisos. */
function isOwnRoleStation(user, moduleId) {
  const own = getOwnProductionAreaId(user).toLowerCase();
  if (!own || !moduleId) return false;
  const ownModule = own === 'cocina' || own === 'bar' ? own : 'produccion';
  return moduleId === ownModule;
}

export function hasModulePermission(user, moduleId) {
  if (!moduleId) return true;
  if (user?.role === 'master_admin') {
    // En vista «como dueño» respeta el plan comercial; en panel maestro no aplica.
    if (user.permissions && typeof user.permissions === 'object') {
      return isPermissionEnabled(user.permissions[moduleId]);
    }
    return true;
  }
  const role = String(user?.role || '').toLowerCase();
  const area = String(user?.production_area_id || '').trim().toLowerCase();
  const perms = user && typeof user.permissions === 'object' && user.permissions !== null
    ? user.permissions
    : null;

  if (isOwnRoleStation(user, moduleId)) return true;

  const isProdStaff = role === 'produccion' || role === 'cocina' || role === 'bar';
  if (isProdStaff && (moduleId === 'cocina' || moduleId === 'bar' || moduleId === 'produccion')) {
    if (perms && isPermissionExplicitlyDenied(perms[moduleId])) return false;
    if (perms && isPermissionEnabled(perms[moduleId])) return true;

    if (moduleId === 'cocina') {
      if (perms && isPermissionEnabled(perms.produccion) && (!area || area === 'cocina')) return true;
      if (perms) return false;
      return role === 'cocina' || area === 'cocina' || (role === 'produccion' && !area);
    }
    if (moduleId === 'bar') {
      if (perms && isPermissionEnabled(perms.produccion) && area === 'bar') return true;
      if (perms) return false;
      return role === 'bar' || area === 'bar';
    }
    // moduleId === 'produccion' (áreas custom / nav genérica)
    if (area && area !== 'cocina' && area !== 'bar') return true;
    if (perms && (isPermissionEnabled(perms.cocina) || isPermissionEnabled(perms.bar))) return true;
    return false;
  }

  if (!user || typeof user.permissions !== 'object' || user.permissions === null) return false;
  if (isPermissionEnabled(user.permissions[moduleId])) return true;
  // Compat: permiso cocina/bar puede abrir rutas de producción del mismo área
  if (moduleId === 'produccion') {
    return isPermissionEnabled(user.permissions.cocina) || isPermissionEnabled(user.permissions.bar);
  }
  return false;
}

/**
 * Acceso a ruta admin: permiso explícito del usuario prevalece sobre la lista de roles por defecto.
 * - true → permitir
 * - false → denegar
 * - ausente → permitir si el rol está en la lista por defecto del módulo
 */
export function canAccessStaffModule(user, { moduleId, roles } = {}) {
  if (!user) return false;
  if (user.role === 'master_admin') {
    if (isMasterViewingAsOwner()) {
      if (moduleId && typeof user.permissions === 'object' && user.permissions != null) {
        if (isPermissionExplicitlyDenied(user.permissions[moduleId])) return false;
      }
      if (moduleId && hasModulePermission(user, moduleId)) return true;
      const roleList = Array.isArray(roles) ? roles : [];
      if (roleList.includes('admin') || roleList.includes('master_admin')) {
        return !moduleId || hasModulePermission(user, moduleId);
      }
      return false;
    }
    return moduleId === 'mi_restaurant' || !moduleId;
  }
  if (isOwnRoleStation(user, moduleId)) return true;
  if (moduleId && typeof user.permissions === 'object' && user.permissions != null) {
    if (isPermissionExplicitlyDenied(user.permissions[moduleId])) return false;
  }
  if (moduleId && hasModulePermission(user, moduleId)) return true;
  const roleList = Array.isArray(roles) ? roles : [];
  if (roleList.length > 0) return roleList.includes(user.role);
  return !moduleId;
}

export function getProductionStaffPath(user) {
  if (!user) return '/';
  if (!PRODUCTION_ROLES.includes(String(user.role || '').toLowerCase())) return '/admin';
  const own = getOwnProductionAreaId(user);
  return own ? `/admin/produccion/${own}` : '/';
}

/** Personal que debe marcar ingreso QR antes de entrar a su módulo. */
export function requiresQrCheckIn(user, opts = {}) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (!PRODUCTION_ROLES.includes(role) && role !== 'cajero' && role !== 'mozo') return false;
  const qrOn = opts.asistenciaQrActiva != null
    ? Boolean(opts.asistenciaQrActiva)
    : (user.asistencia_qr_activa == null ? true : Boolean(user.asistencia_qr_activa));
  const jornadaAbierta = opts.jornadaQrAbierta != null
    ? Boolean(opts.jornadaQrAbierta)
    : Boolean(user.jornada_qr_abierta);
  if (!qrOn || jornadaAbierta) return false;
  // Sin ficha de empleado no puede marcar; API antiguo no envía el campo (producción mantiene el QR).
  if (PRODUCTION_ROLES.includes(role)) return user.asistencia_qr_aplica !== false;
  return user.asistencia_qr_aplica === true;
}

export function getDefaultStaffPath(user, opts = {}) {
  if (!user) return '/';
  if (user.role === 'master_admin') {
    return isMasterViewingAsOwner() ? '/admin' : '/master';
  }
  // QR activo y sin jornada → marcar; si ya está activa → ir directo al módulo.
  if (requiresQrCheckIn(user, opts)) return '/admin/asistencia';
  if (PRODUCTION_ROLES.includes(String(user.role || '').toLowerCase())) {
    const prodPath = getProductionStaffPath(user);
    // `/` con sesión staff redirige otra vez aquí: sin módulo, mostrar aviso en /admin.
    return prodPath === '/' ? '/admin' : prodPath;
  }
  if (user.role === 'delivery') return hasModulePermission(user, 'delivery') ? '/delivery' : '/';
  if (!['admin', 'cajero', 'mozo'].includes(user.role)) return '/admin';
  const primaryId = PRIMARY_MODULE_BY_ROLE[user.role];
  const primary = primaryId && ADMIN_MODULE_PATHS.find((item) => item.moduleId === primaryId);
  if (primary && canAccessStaffModule(user, { moduleId: primary.moduleId, roles: primary.roles })) {
    return primary.path;
  }
  const first = ADMIN_MODULE_PATHS.find((item) => hasModulePermission(user, item.moduleId));
  return first?.path || '/admin';
}

/**
 * Enlaces rápidos operativos (p. ej. monitoreo en vivo en Escritorio).
 * salvo la vista móvil de reparto (`/delivery`).
 */
const OPERATIONAL_NOTIFICATION_LINK_DEFS = [
  { moduleId: 'escritorio', label: 'Escritorio', routeRoles: ['admin', 'cajero', 'master_admin'] },
  { moduleId: 'mesas', label: 'Mesas', routeRoles: ['admin', 'mozo', 'master_admin'] },
  { moduleId: 'delivery', label: 'Delivery', routeRoles: ['admin', 'cajero', 'mozo', 'master_admin'] },
  { moduleId: 'cocina', label: 'Cocina', routeRoles: ['admin', 'master_admin'] },
  { moduleId: 'bar', label: 'Bar', routeRoles: ['admin', 'master_admin'] },
  { moduleId: 'almacen', label: 'Control De Recursos', routeRoles: ['admin', 'master_admin'] },
  { moduleId: 'caja', label: 'Caja', routeRoles: ['admin', 'cajero', 'master_admin'] },
  { moduleId: 'informes', label: 'Facturación', path: '/admin/informes?seccion=facturacion', routeRoles: ['admin', 'cajero', 'master_admin'] },
  { moduleId: 'delivery', label: 'Reparto', path: '/delivery', routeRoles: ['delivery'] },
];

function adminPathForModule(moduleId) {
  return ADMIN_MODULE_PATHS.find((r) => r.moduleId === moduleId)?.path;
}

/** @returns {{ to: string, label: string, moduleId: string }[]} */
export function getOperationalNotificationQuickLinks(user) {
  const role = user?.role;
  if (!role) return [];
  const out = [];
  for (const def of OPERATIONAL_NOTIFICATION_LINK_DEFS) {
    if (!def.routeRoles.includes(role)) continue;
    if (!hasModulePermission(user, def.moduleId)) continue;
    const to = def.path ?? adminPathForModule(def.moduleId);
    if (!to) continue;
    out.push({ to, label: def.label, moduleId: def.moduleId });
  }
  return out;
}

if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
  for (const def of OPERATIONAL_NOTIFICATION_LINK_DEFS) {
    if (def.path) continue;
    if (!adminPathForModule(def.moduleId)) {
      console.warn(
        `[staffModuleAccess] OPERATIONAL_NOTIFICATION_LINK_DEFS: moduleId "${def.moduleId}" sin entrada en ADMIN_MODULE_PATHS`
      );
    }
  }
}
