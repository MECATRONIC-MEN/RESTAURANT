const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { queryAll, queryOne, runSql, hasUsersColumn, ensureUsersSchemaColumns, ensureUsersRoleAllowsProduccion, persistedProductionRole } = require('../database');
const { normalizeCatalogDisplayName } = require('../utils/catalogNameFormat');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getActiveCajaById, getFirstAutoAssignCajaId } = require('../cajaSettings');
const {
  rawWorkedMinutesExpr,
  effectiveWorkedMinutesExpr,
} = require('../lib/workSessionSql');
const { buildAnalyticsBundle } = require('../services/workProductivityService');
const {
  queryAggregatedJornadas,
  queryDeviceSessions,
  summarizeJornadas,
  parseDateKey,
  ensureOpenWorkSession,
} = require('../services/workSessionService');
const { cajaSubPermissionKey, CAJA_USER_OPT_IN_SUBS } = require('../planModuleCatalog');
const { buildWorkModulePermissions } = require('../utils/staffWorkPermissions');
const { getRawUserPermissionsJson } = require('../lib/cajaPermissions');
const { purgeUserFromSystem } = require('../utils/purgeUserFromSystem');
const { emitStaffDataUpdate } = require('../socketBroadcast');

const router = express.Router();
const VALID_ROLES = new Set(['admin', 'cajero', 'mozo', 'cocina', 'bar', 'delivery', 'produccion']);
/** Placeholder único cuando el correo es opcional (columna UNIQUE NOT NULL). */
const NO_EMAIL_SUFFIX = '@no-email.local';

function isNoEmailPlaceholder(email) {
  return String(email || '').toLowerCase().endsWith(NO_EMAIL_SUFFIX);
}

/** Correo opcional: vacío → placeholder por userId; no choca con UNIQUE. */
function resolveStoredEmail(raw, userId) {
  const e = String(raw || '').trim();
  if (!e || isNoEmailPlaceholder(e)) return `${userId}${NO_EMAIL_SUFFIX}`;
  return e;
}

function publicEmail(email) {
  if (!email || isNoEmailPlaceholder(email)) return '';
  return String(email);
}

function withPublicEmail(user) {
  if (!user || typeof user !== 'object') return user;
  return { ...user, email: publicEmail(user.email) };
}
const MODULE_IDS = [
  'escritorio', 'ventas', 'caja', 'mesas', 'reservas', 'auto_pedido', 'creditos', 'clientes',
  'productos', 'ofertas', 'descuentos', 'almacen', 'delivery', 'informes',
  'indicadores', 'fidelizacion', 'mi_restaurant', 'configuracion', 'cocina', 'bar', 'produccion', 'tiempo_trabajado',
];
function isPermissionEnabled(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

const FINAL_ATTENDANCE = new Set(['asistente', 'justificado', 'ausente']);

function createEmptyPermissions() {
  return MODULE_IDS.reduce((acc, id) => {
    acc[id] = false;
    return acc;
  }, {});
}

function createFullPermissions() {
  return MODULE_IDS.reduce((acc, id) => {
    acc[id] = true;
    return acc;
  }, {});
}

function countCajerosExcluding(excludeUserId) {
  const ex = String(excludeUserId || '').trim();
  if (!ex) {
    return queryOne(`SELECT COUNT(*) as c FROM users WHERE lower(trim(coalesce(role, ''))) = 'cajero'`);
  }
  return queryOne(
    `SELECT COUNT(*) as c FROM users WHERE lower(trim(coalesce(role, ''))) = 'cajero' AND id != ?`,
    [ex]
  );
}

function normalizeCajaStationId(role, rawCajaId, { excludeUserId = '' } = {}) {
  const roleLc = String(role || '').trim().toLowerCase();
  if (roleLc !== 'cajero' && roleLc !== 'mozo') return { caja_station_id: '' };
  let id = String(rawCajaId ?? '').trim();
  const exclude = String(excludeUserId || '').trim();

  if (roleLc === 'mozo') {
    if (!id) {
      id = getFirstAutoAssignCajaId() || '';
      if (!id) return { error: 'Seleccione la caja para este mozo (Configuración → Cajas).' };
    }
    if (!getActiveCajaById(id)) {
      return { error: 'La caja no existe o está inactiva.' };
    }
    return { caja_station_id: id };
  }

  const otherCajeros = Number(countCajerosExcluding(exclude)?.c || 0);
  if (!id) {
    if (otherCajeros === 0) {
      id = getFirstAutoAssignCajaId() || '';
      if (!id) {
        return { error: 'Debe existir al menos una caja activa en Configuración → Cajas.' };
      }
    } else {
      return { error: 'Seleccione la caja para este cajero' };
    }
  }
  if (!getActiveCajaById(id)) {
    return { error: 'La caja no existe o está inactiva. Créela o actívela en Configuración → Cajas.' };
  }
  const taken = queryOne(
    `SELECT id, full_name FROM users
     WHERE lower(trim(coalesce(role, ''))) = 'cajero'
       AND trim(coalesce(caja_station_id, '')) = ?
       AND id != ?
     LIMIT 1`,
    [id, exclude]
  );
  if (taken?.id) {
    return { error: `Esa caja ya está asignada a ${taken.full_name || 'otro cajero'}` };
  }
  return { caja_station_id: id };
}

function normalizeProductionFields(role, body = {}) {
  const roleLc = String(role || '').trim().toLowerCase();
  if (roleLc === 'produccion' || roleLc === 'cocina' || roleLc === 'bar') {
    // El área se asigna solo en Configuración → Áreas de producción. Aquí no se exige ni se escribe.
    return {
      role: 'produccion',
      production_area_id: '',
      production_area_ids: '[]',
    };
  }
  if (roleLc === 'mozo') {
    return {
      role: 'mozo',
      production_area_id: '',
      production_area_ids: '[]',
    };
  }
  return {
    role: roleLc,
    production_area_id: '',
    production_area_ids: '[]',
  };
}

function listUsersRows() {
  const queries = [
    `SELECT id, username, email, full_name, role, is_active, phone, avatar, caja_station_id,
        production_area_id, production_area_ids,
        payroll_pay_mode, payroll_amount, payroll_schedule_note, payroll_payment_day,
        COALESCE(is_buyer_admin, 0) AS is_buyer_admin, created_at
       FROM users ORDER BY datetime(created_at) DESC`,
    `SELECT id, username, email, full_name, role, is_active, phone, avatar, caja_station_id,
        production_area_id, production_area_ids,
        COALESCE(is_buyer_admin, 0) AS is_buyer_admin, created_at
       FROM users ORDER BY datetime(created_at) DESC`,
    `SELECT id, username, email, full_name, role, is_active, phone, avatar, created_at
       FROM users ORDER BY datetime(created_at) DESC`,
  ];
  let lastErr;
  for (const sql of queries) {
    try {
      return queryAll(sql);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No se pudieron listar usuarios');
}

/** Mensaje de error si ya se alcanzó el máximo de usuarios activos del plan; null si hay cupo. */
function planUserLimitError(excludeUserId = '') {
  const { getServicePlanMaxUsers, getControlConfig } = require('../masterAdminService');
  const { getPlanInfo } = require('../servicePlan');
  const control = getControlConfig();
  const max = getServicePlanMaxUsers(control);
  if (max == null) return null;
  const row = queryOne(
    `SELECT COUNT(*) AS n FROM users WHERE IFNULL(is_active, 1) = 1 AND role != 'master_admin' AND id != ?`,
    [String(excludeUserId || '')],
  );
  if (Number(row?.n || 0) < max) return null;
  return `Tu plan ${getPlanInfo(control.service_plan).label} permite hasta ${max} usuarios activos. Desactiva un usuario o mejora tu plan.`;
}

router.get('/', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    res.json(listUsersRows().map(withPublicEmail));
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudieron listar usuarios' });
  }
});

router.post('/', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const username = normalizeCatalogDisplayName(req.body?.username || '');
    const emailRaw = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const fullName = normalizeCatalogDisplayName(req.body?.full_name || '');
    const role = String(req.body?.role || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim();
    const isActive = req.body?.is_active === undefined ? 1 : (Number(req.body.is_active || 0) === 1 ? 1 : 0);
    if (!username || !password || !fullName || !role) {
      return res.status(400).json({ error: 'Usuario, contraseña, nombre y rol son obligatorios' });
    }
    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    const id = uuidv4();
    const email = resolveStoredEmail(emailRaw, id);
    const existingUser = queryOne(
      'SELECT id FROM users WHERE lower(trim(username)) = lower(?)',
      [username],
    );
    if (existingUser) return res.status(400).json({ error: 'El usuario ya existe' });
    if (emailRaw && !isNoEmailPlaceholder(emailRaw)) {
      const existingEmail = queryOne('SELECT id FROM users WHERE email = ?', [email]);
      if (existingEmail) return res.status(400).json({ error: 'El email ya está en uso' });
    }

    if (isActive) {
      const limitError = planUserLimitError();
      if (limitError) return res.status(400).json({ error: limitError });
    }

    const cajaNorm = normalizeCajaStationId(role, req.body?.caja_station_id, { excludeUserId: '' });
    if (cajaNorm.error) return res.status(400).json({ error: cajaNorm.error });
    const cajaStationId = cajaNorm.caja_station_id;

    const prodNorm = normalizeProductionFields(role, req.body || {});
    const finalRole = prodNorm.role === 'produccion'
      ? persistedProductionRole(prodNorm.production_area_id)
      : prodNorm.role;

    const restaurant = queryOne('SELECT id FROM restaurants LIMIT 1');
    const hash = bcrypt.hashSync(password, 10);
    const isMaster = req.user?.role === 'master_admin';
    /** Solo el maestro crea al dueño del negocio; admins del personal no llevan esta marca. */
    const isBuyerAdmin = isMaster && finalRole === 'admin' ? 1 : 0;
    try { ensureUsersSchemaColumns(); } catch (_) { /* el INSERT omite columnas que no existan */ }
    try { ensureUsersRoleAllowsProduccion(); } catch (migErr) {
      console.warn('[users] CHECK produccion:', migErr.message || migErr);
    }

    const insertFields = {
      id,
      username,
      email,
      password_hash: hash,
      full_name: fullName,
      role: finalRole,
      restaurant_id: restaurant?.id || '',
      phone,
      is_active: isActive,
      caja_station_id: cajaStationId,
      is_buyer_admin: isBuyerAdmin,
      production_area_id: prodNorm.production_area_id || '',
    };
    const insertCols = Object.keys(insertFields).filter((col) => {
      if (['id', 'username', 'email', 'password_hash', 'full_name', 'role'].includes(col)) return true;
      return hasUsersColumn(col);
    });
    const insertSql = `INSERT INTO users (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`;
    try {
      runSql(insertSql, insertCols.map((col) => insertFields[col]));
    } catch (insErr) {
      const msg = String(insErr?.message || insErr || '');
      if (prodNorm.role !== 'produccion' || !/CHECK constraint/i.test(msg)) throw insErr;
      insertFields.role = String(prodNorm.production_area_id || '').toLowerCase() === 'bar' ? 'bar' : 'cocina';
      runSql(insertSql, insertCols.map((col) => insertFields[col]));
    }
    const permissionsObj =
      isMaster && finalRole === 'admin'
        ? createFullPermissions()
        : (finalRole === 'admin'
          ? createEmptyPermissions()
          : buildWorkModulePermissions(insertFields.role, insertFields.production_area_id));
    runSql(
      'INSERT INTO user_permissions (id, user_id, permissions) VALUES (?, ?, ?)',
      [uuidv4(), id, JSON.stringify(permissionsObj)]
    );
    const created = listUsersRows().find((u) => u.id === id) || queryOne(
      'SELECT id, username, email, full_name, role, is_active, phone, created_at FROM users WHERE id = ?',
      [id],
    );
    return res.status(201).json(withPublicEmail(created));
  } catch (err) {
    return res.status(400).json({ error: err.message || 'No se pudo crear el usuario' });
  }
});

router.put('/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    try { ensureUsersSchemaColumns(); } catch (_) { /* noop */ }
    try { ensureUsersRoleAllowsProduccion(); } catch (migErr) {
      console.warn('[users] CHECK produccion:', migErr.message || migErr);
    }
    const current = queryOne(
      'SELECT id, username, email, full_name, role, phone, is_active FROM users WHERE id = ?',
      [req.params.id]
    );
    if (!current?.id) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (hasUsersColumn('caja_station_id')) {
      const extra = queryOne('SELECT caja_station_id FROM users WHERE id = ?', [req.params.id]);
      current.caja_station_id = extra?.caja_station_id || '';
    }
    if (!current?.id) return res.status(404).json({ error: 'Usuario no encontrado' });

    const username = req.body?.username === undefined
      ? current.username
      : normalizeCatalogDisplayName(req.body.username || '');
    const emailRaw =
      req.body?.email === undefined ? publicEmail(current.email) : String(req.body.email || '').trim();
    const fullName = req.body?.full_name === undefined
      ? current.full_name
      : normalizeCatalogDisplayName(req.body.full_name || '');
    const role = req.body?.role === undefined ? current.role : String(req.body.role || '').trim().toLowerCase();
    const phone = req.body?.phone === undefined ? current.phone : String(req.body.phone || '').trim();
    const isActive = req.body?.is_active === undefined ? current.is_active : (Number(req.body.is_active || 0) === 1 ? 1 : 0);
    if (Number(isActive) === 1 && Number(current.is_active) !== 1 && current.role !== 'master_admin') {
      const limitError = planUserLimitError(current.id);
      if (limitError) return res.status(400).json({ error: limitError });
    }
    const password = String(req.body?.password || '').trim();
    const rawCaja =
      req.body?.caja_station_id === undefined ? current.caja_station_id : req.body.caja_station_id;

    if (!username || !fullName || !role) {
      return res.status(400).json({ error: 'Usuario, nombre y rol son obligatorios' });
    }
    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const email = resolveStoredEmail(emailRaw, req.params.id);
    const duplicatedUser = queryOne(
      'SELECT id FROM users WHERE lower(trim(username)) = lower(?) AND id != ? LIMIT 1',
      [username, req.params.id]
    );
    if (duplicatedUser?.id) {
      return res.status(400).json({ error: 'El usuario ya está en uso por otro registro' });
    }
    if (emailRaw && !isNoEmailPlaceholder(emailRaw)) {
      const duplicatedEmail = queryOne(
        'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
        [email, req.params.id]
      );
      if (duplicatedEmail?.id) {
        return res.status(400).json({ error: 'El email ya está en uso por otro registro' });
      }
    }

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      runSql('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    }

    const cajaNorm = normalizeCajaStationId(role, rawCaja, { excludeUserId: req.params.id });
    if (cajaNorm.error) return res.status(400).json({ error: cajaNorm.error });
    const cajaStationId = cajaNorm.caja_station_id;

    const prodNorm = normalizeProductionFields(role, req.body || {});
    const persistedRole = prodNorm.role === 'produccion'
      ? persistedProductionRole(prodNorm.production_area_id)
      : prodNorm.role;

    const setCols = {
      username,
      email,
      full_name: fullName,
      role: persistedRole,
      phone,
      is_active: isActive,
    };
    if (hasUsersColumn('caja_station_id')) setCols.caja_station_id = cajaStationId;
    const setNames = Object.keys(setCols);
    const updateSql = `UPDATE users SET ${setNames.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    const updateParams = [...setNames.map((c) => setCols[c]), req.params.id];
    try {
      runSql(updateSql, updateParams);
    } catch (updErr) {
      const msg = String(updErr?.message || updErr || '');
      if (prodNorm.role !== 'produccion' || !/CHECK constraint/i.test(msg)) throw updErr;
      setCols.role = String(prodNorm.production_area_id || '').toLowerCase() === 'bar' ? 'bar' : 'cocina';
      runSql(updateSql, [...setNames.map((c) => setCols[c]), req.params.id]);
    }

    const payrollPatch = {};
    if (req.body?.payroll_pay_mode !== undefined) {
      const m = String(req.body.payroll_pay_mode || '').trim().toLowerCase();
      if (!['', 'hora', 'dia', 'mes', 'jornada'].includes(m)) {
        return res.status(400).json({ error: 'Modo de nómina inválido (hora, dia o mes)' });
      }
      payrollPatch.payroll_pay_mode = m === 'jornada' ? 'dia' : m;
    }
    if (req.body?.payroll_amount !== undefined) {
      const pa = Number(req.body.payroll_amount);
      if (!Number.isFinite(pa) || pa < 0) {
        return res.status(400).json({ error: 'Monto de nómina inválido' });
      }
      payrollPatch.payroll_amount = pa;
    }
    if (req.body?.payroll_schedule_note !== undefined) {
      payrollPatch.payroll_schedule_note = String(req.body.payroll_schedule_note || '');
    }
    if (req.body?.payroll_payment_day !== undefined) {
      const d = parseInt(req.body.payroll_payment_day, 10);
      if (!Number.isFinite(d) || d < 0 || d > 31) {
        return res.status(400).json({ error: 'Día de pago inválido (0–31)' });
      }
      payrollPatch.payroll_payment_day = d;
    }
    if (Object.keys(payrollPatch).length) {
      const cols = Object.keys(payrollPatch);
      runSql(
        `UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...cols.map((c) => payrollPatch[c]), req.params.id]
      );
    }

    const nextRole = String(setCols.role || persistedRole || '').toLowerCase();
    const prevRole = String(current.role || '').toLowerCase();
    if (nextRole && nextRole !== 'admin' && nextRole !== prevRole) {
      const existingPerms = queryOne('SELECT id, permissions FROM user_permissions WHERE user_id = ?', [req.params.id]);
      let parsedPerms = {};
      try { parsedPerms = JSON.parse(existingPerms?.permissions || '{}') || {}; } catch { parsedPerms = {}; }
      const nextPerms = buildWorkModulePermissions(nextRole, prodNorm.production_area_id);
      if (parsedPerms['caja:eliminar_liberar_mesa'] === true) nextPerms['caja:eliminar_liberar_mesa'] = true;
      const permJson = JSON.stringify(nextPerms);
      if (existingPerms?.id) {
        runSql("UPDATE user_permissions SET permissions = ?, updated_at = datetime('now') WHERE user_id = ?", [permJson, req.params.id]);
      } else {
        runSql('INSERT INTO user_permissions (id, user_id, permissions) VALUES (?, ?, ?)', [uuidv4(), req.params.id, permJson]);
      }
    }

    const updated = listUsersRows().find((u) => u.id === req.params.id) || queryOne(
      'SELECT id, username, email, full_name, role, is_active, phone, created_at FROM users WHERE id = ?',
      [req.params.id],
    );
    return res.json(withPublicEmail(updated));
  } catch (err) {
    return res.status(400).json({ error: err.message || 'No se pudo actualizar el usuario' });
  }
});

router.post('/:id/payroll-investment', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const user = queryOne(
      'SELECT id, full_name, payroll_pay_mode, payroll_amount FROM users WHERE id = ?',
      [req.params.id]
    );
    if (!user?.id) return res.status(404).json({ error: 'Usuario no encontrado' });
    const mode = String(user.payroll_pay_mode || '').toLowerCase();
    let amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      if (mode === 'hora') {
        const hours = Number(req.body?.hours);
        const rate = Number(user.payroll_amount || 0);
        if (!Number.isFinite(hours) || hours <= 0) {
          return res.status(400).json({ error: 'Indica las horas trabajadas para pago por hora' });
        }
        if (!Number.isFinite(rate) || rate <= 0) {
          return res.status(400).json({ error: 'Define la tarifa por hora en el perfil del usuario' });
        }
        amount = Math.round(hours * rate * 100) / 100;
      } else {
        amount = Math.round(Number(user.payroll_amount || 0) * 100) / 100;
      }
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'El monto de nómina debe ser mayor a cero' });
    }
    const concept = String(req.body?.concept || '').trim() || `Nómina: ${user.full_name || 'personal'}`.trim();
    const id = uuidv4();
    runSql(
      `INSERT INTO investment_movements (id, amount, concept, user_id, source, created_at)
       VALUES (?, ?, ?, ?, 'payroll', datetime('now'))`,
      [id, amount, concept, user.id]
    );
    const row = queryOne('SELECT * FROM investment_movements WHERE id = ?', [id]);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message || 'No se pudo registrar el pago' });
  }
});

router.delete('/:id', authenticateToken, requireRole('admin', 'master_admin'), (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  }
  const target = queryOne(
    'SELECT id, role, COALESCE(is_buyer_admin, 0) AS is_buyer_admin FROM users WHERE id = ?',
    [req.params.id],
  );
  if (!target) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }
  /** El dueño (creado por el maestro) solo lo elimina el administrador maestro. */
  if (Number(target.is_buyer_admin) === 1 && req.user?.role !== 'master_admin') {
    return res.status(403).json({
      error: 'El administrador dueño del negocio solo puede eliminarlo el administrador maestro',
    });
  }
  try {
    purgeUserFromSystem(req.params.id);
    emitStaffDataUpdate({ domain: 'loyalty' });
    emitStaffDataUpdate({ domain: 'hr' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo eliminar el usuario' });
  }
});

/** Panel de productividad, alertas, rankings e IA operativa (extiende Tiempo trabajado). */
router.get('/work-analytics', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    ensureOpenWorkSession(req.user);
    res.json(buildAnalyticsBundle(req.query || {}));
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo cargar analítica laboral' });
  }
});

router.get('/work-sessions', authenticateToken, requireRole('admin'), (req, res) => {
  ensureOpenWorkSession(req.user);
  const from = parseDateKey(req.query?.from);
  const to = parseDateKey(req.query?.to);
  const userId = String(req.query?.user_id || '').trim();

  const jornadas = queryAggregatedJornadas({ from, to, userId });
  const deviceSessions = queryDeviceSessions({ from, to, userId });
  const summary = summarizeJornadas(jornadas);
  let jornadaSource = 'session';
  try {
    jornadaSource = require('../services/hrService').isAsistenciaQrActiva() ? 'qr' : 'session';
  } catch (_) {
    /* */
  }

  res.json({
    filters: { from, to, user_id: userId || 'all' },
    jornada_source: jornadaSource,
    jornadas,
    device_sessions: deviceSessions,
    sessions: jornadas,
    summary,
  });
});

router.get('/work-sessions/:sessionId/photos', authenticateToken, requireRole('admin'), (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'Sesión inválida' });
  const row = queryOne(
    'SELECT photo_login, photo_logout FROM user_work_sessions WHERE id = ? LIMIT 1',
    [sessionId]
  );
  if (!row) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json({
    photo_login: row.photo_login || null,
    photo_logout: row.photo_logout || null,
  });
});

/** Galería del día actual (hora local del servidor) por usuario. */
router.get('/attendance-gallery/:userId', authenticateToken, requireRole('admin'), (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'Usuario requerido' });
  const target = queryOne('SELECT id FROM users WHERE id = ?', [userId]);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
  const day = parseDateKey(req.query?.date) || null;
  const dayFilter = day
    ? 'date(datetime(s.login_at, \'localtime\')) = date(?)'
    : "date(datetime(s.login_at, 'localtime')) = date('now', 'localtime')";
  const params = day ? [userId, day] : [userId];
  const sessions = queryAll(
    `SELECT s.id, s.login_at, s.logout_at, s.photo_login, s.photo_logout,
            COALESCE(s.attendance_status, 'pending') AS attendance_status
     FROM user_work_sessions s
     WHERE s.user_id = ? AND ${dayFilter}
     ORDER BY datetime(s.login_at) DESC
     LIMIT 50`,
    params
  );
  res.json({ sessions: sessions || [], date: day || 'today' });
});

/** Sesiones del día con asistencia pendiente de clasificar (solo admin). */
router.get('/attendance-review/today', authenticateToken, requireRole('admin'), (req, res) => {
  /** Con asistencia QR el tiempo trabajado sale de hr_attendance; las sesiones de login no se clasifican. */
  let qrActiva = false;
  try {
    qrActiva = require('../services/hrService').isAsistenciaQrActiva();
  } catch (_) {
    qrActiva = false;
  }
  if (qrActiva) {
    return res.json({ pending: [], complete: true, jornada_source: 'qr' });
  }
  const rows = queryAll(
    `SELECT s.id, s.user_id, s.login_at, s.logout_at,
            COALESCE(s.attendance_status, 'pending') AS attendance_status,
            ${rawWorkedMinutesExpr('s')} AS raw_worked_minutes,
            COALESCE(NULLIF(u.full_name, ''), s.full_name) AS full_name,
            COALESCE(NULLIF(u.username, ''), s.username) AS username,
            COALESCE(NULLIF(u.role, ''), s.role) AS role
     FROM user_work_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE date(datetime(s.login_at, 'localtime')) = date('now', 'localtime')
       AND COALESCE(s.attendance_status, 'pending') = 'pending'
       AND COALESCE(s.session_kind, 'jornada') = 'jornada'
       AND lower(coalesce(nullif(u.role, ''), nullif(s.role, ''), '')) != 'admin'
     ORDER BY datetime(s.login_at) ASC`
  );
  res.json({
    pending: rows || [],
    complete: !rows || rows.length === 0,
  });
});

/** Aplicar estado de asistencia por sesión (cualquier día, solo si sigue pendiente). */
router.post('/attendance-review/apply', authenticateToken, requireRole('admin'), (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Debe enviar items: [{ session_id, status }]' });
  }
  let n = 0;
  for (const it of items) {
    const sid = String(it.session_id || it.id || '').trim();
    const status = String(it.status || '').trim();
    if (!sid || !FINAL_ATTENDANCE.has(status)) continue;
    const row = queryOne(
      `SELECT s.id FROM user_work_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
         AND COALESCE(NULLIF(trim(s.attendance_status), ''), 'pending') = 'pending'
         AND lower(coalesce(nullif(u.role, ''), nullif(s.role, ''), '')) != 'admin'`,
      [sid]
    );
    if (!row?.id) continue;
    runSql(
      `UPDATE user_work_sessions SET attendance_status = ?, updated_at = datetime('now') WHERE id = ?`,
      [status, sid]
    );
    n += 1;
  }
  res.json({ success: true, updated: n });
});

/** Clasificar una jornada concreta (pendiente → asistente / justificado / ausente). No aplica al administrador. */
router.patch('/work-sessions/:sessionId/attendance', authenticateToken, requireRole('admin'), (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const status = String(req.body?.status || '').trim();
  if (!sessionId || !FINAL_ATTENDANCE.has(status)) {
    return res.status(400).json({ error: 'Sesión o estado inválido' });
  }
  const row = queryOne(
    `SELECT s.id FROM user_work_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ?
       AND COALESCE(NULLIF(trim(s.attendance_status), ''), 'pending') = 'pending'
       AND lower(coalesce(nullif(u.role, ''), nullif(s.role, ''), '')) != 'admin'`,
    [sessionId]
  );
  if (!row?.id) {
    return res.status(404).json({ error: 'Sesión no encontrada, ya clasificada o es de un administrador (no requiere clasificación)' });
  }
  runSql(
    `UPDATE user_work_sessions SET attendance_status = ?, updated_at = datetime('now') WHERE id = ?`,
    [status, sessionId]
  );
  res.json({ success: true });
});

router.get('/:id/permissions', authenticateToken, requireRole('admin'), (req, res) => {
  const parsed = getRawUserPermissionsJson(req.params.id);
  const permissions = MODULE_IDS.reduce((acc, id) => {
    acc[id] = isPermissionEnabled(parsed[id]);
    return acc;
  }, {});
  for (const subId of CAJA_USER_OPT_IN_SUBS) {
    permissions[cajaSubPermissionKey(subId)] = isPermissionEnabled(parsed[cajaSubPermissionKey(subId)]);
  }
  const userRow = queryOne('SELECT role, production_area_id FROM users WHERE id = ?', [req.params.id]);
  const roleLc = String(userRow?.role || '').toLowerCase();
  if (['produccion', 'cocina', 'bar'].includes(roleLc)) {
    const area = String(userRow?.production_area_id || '').trim().toLowerCase();
    // Siempre alinear a su área vinculada (Parrilla ≠ Cocina).
    permissions.produccion = false;
    permissions.cocina = false;
    permissions.bar = false;
    if (roleLc === 'bar' || area === 'bar') permissions.bar = true;
    else if (roleLc === 'cocina' || area === 'cocina') permissions.cocina = true;
    else if (area) permissions.produccion = true;
  }
  res.json(permissions);
});

router.put('/:id/permissions', authenticateToken, requireRole('admin'), (req, res) => {
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'Permisos inválidos' });
  const normalized = MODULE_IDS.reduce((acc, id) => {
    acc[id] = isPermissionEnabled(permissions[id]);
    return acc;
  }, {});
  for (const subId of CAJA_USER_OPT_IN_SUBS) {
    normalized[cajaSubPermissionKey(subId)] = isPermissionEnabled(permissions[cajaSubPermissionKey(subId)]);
  }
  const userRow = queryOne('SELECT role, production_area_id FROM users WHERE id = ?', [req.params.id]);
  const roleLc = String(userRow?.role || '').toLowerCase();
  if (['produccion', 'cocina', 'bar'].includes(roleLc)) {
    const area = String(userRow?.production_area_id || '').trim().toLowerCase();
    const areaOn = isPermissionEnabled(permissions.cocina)
      || isPermissionEnabled(permissions.bar)
      || isPermissionEnabled(permissions.produccion)
      || isPermissionEnabled(permissions._production_area);
    normalized.produccion = false;
    normalized.cocina = false;
    normalized.bar = false;
    if (areaOn) {
      if (roleLc === 'bar' || area === 'bar') normalized.bar = true;
      else if (roleLc === 'cocina' || area === 'cocina') normalized.cocina = true;
      else if (area) normalized.produccion = true;
    }
  }
  const existing = queryOne('SELECT id FROM user_permissions WHERE user_id = ?', [req.params.id]);
  const json = JSON.stringify(normalized);
  if (existing) {
    runSql("UPDATE user_permissions SET permissions = ?, updated_at = datetime('now') WHERE user_id = ?", [json, req.params.id]);
  } else {
    runSql('INSERT INTO user_permissions (id, user_id, permissions) VALUES (?, ?, ?)', [uuidv4(), req.params.id, json]);
  }
  res.json({ success: true, permissions: normalized });
});

module.exports = router;
