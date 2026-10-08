const { v4: uuidv4 } = require('uuid');
const { queryOne, runSql } = require('../database');

function getUserCajaStationId(userId) {
  const row = queryOne('SELECT caja_station_id FROM users WHERE id = ?', [userId]);
  return String(row?.caja_station_id || '').trim();
}

function getOpenRegisterByStation(stationId) {
  const sid = String(stationId || '').trim();
  if (!sid) return null;
  return (
    queryOne(
      `SELECT * FROM cash_registers
       WHERE closed_at IS NULL AND trim(coalesce(caja_station_id, '')) = ?
       ORDER BY datetime(opened_at) DESC
       LIMIT 1`,
      [sid],
    ) || null
  );
}

/** Cajero asignado a esa caja. Es el responsable del turno, aunque lo abra el administrador. */
function findResponsibleCashierId(stationId) {
  const sid = String(stationId || '').trim();
  if (!sid) return '';
  const row = queryOne(
    `SELECT id FROM users
     WHERE lower(trim(coalesce(role, ''))) = 'cajero'
       AND trim(coalesce(caja_station_id, '')) = ?
       AND COALESCE(is_active, 1) = 1
     ORDER BY datetime(created_at) ASC
     LIMIT 1`,
    [sid],
  );
  return String(row?.id || '').trim();
}

/**
 * Una caja, un responsable. El cajero solo abre la suya.
 * El administrador (y el maestro) abre cualquiera que esté activa.
 */
function resolveOpenStationForActor({ role, assignedStationId, requestedStationId, isActiveStation }) {
  const r = String(role || '').toLowerCase();
  const assigned = String(assignedStationId || '').trim();
  const requested = String(requestedStationId || '').trim();
  if (r === 'cajero') {
    if (!assigned) {
      return { status: 400, error: 'Su usuario no tiene una caja asignada. Configúrelo en Usuarios.' };
    }
    if (requested && requested !== assigned) {
      return { status: 403, error: 'Solo puede abrir su caja asignada' };
    }
    return { stationId: assigned };
  }
  if (r === 'admin' || r === 'master_admin') {
    if (!requested) return { status: 400, error: 'Seleccione la caja a abrir' };
    if (!isActiveStation) return { status: 400, error: 'La caja no existe o está inactiva' };
    return { stationId: requested };
  }
  return { status: 403, error: 'Rol no autorizado para abrir caja' };
}

/**
 * Abre el turno de una caja. Si ya está abierto, devuelve ese mismo turno:
 * no puede haber dos turnos de la misma caja.
 * El user_id del turno es el cajero responsable; si no hay, quien lo abre.
 */
function openStationShift({ stationId, openerUserId, openingAmount, restaurantId }) {
  const sid = String(stationId || '').trim();
  const existing = getOpenRegisterByStation(sid);
  if (existing) return { register: existing, already_open: true };
  const responsibleId = findResponsibleCashierId(sid) || String(openerUserId || '').trim();
  const id = uuidv4();
  runSql(
    'INSERT INTO cash_registers (id, user_id, restaurant_id, opening_amount, caja_station_id) VALUES (?, ?, ?, ?, ?)',
    [id, responsibleId, restaurantId || null, Number(openingAmount), sid],
  );
  return { register: queryOne('SELECT * FROM cash_registers WHERE id = ?', [id]), already_open: false };
}

/** Al cerrar una caja solo se cierran los turnos de ESA caja, no los de las demás. */
function closeOtherShiftsOfStation(registerId, stationId) {
  const sid = String(stationId || '').trim();
  const rid = String(registerId || '').trim();
  if (!sid || !rid) return;
  runSql(
    `UPDATE cash_registers
     SET closed_at = datetime('now'),
         notes = CASE WHEN trim(coalesce(notes, '')) = '' THEN 'Cierre del turno de esta caja' ELSE notes END
     WHERE closed_at IS NULL
       AND id != ?
       AND trim(coalesce(caja_station_id, '')) = ?`,
    [rid, sid],
  );
}

/**
 * Cajero: solo el turno de su caja, aunque lo haya abierto el administrador.
 * No usa un turno suelto de otra caja.
 */
function getOpenRegisterForUser(user) {
  const userId = user?.id;
  if (!userId) return null;
  const role = String(user?.role || '').toLowerCase();
  if (role === 'cajero') {
    return getOpenRegisterByStation(getUserCajaStationId(userId));
  }
  return queryOne(
    `SELECT * FROM cash_registers
     WHERE user_id = ? AND closed_at IS NULL
     ORDER BY datetime(opened_at) DESC
     LIMIT 1`,
    [userId],
  );
}

module.exports = {
  getUserCajaStationId,
  getOpenRegisterByStation,
  getOpenRegisterForUser,
  findResponsibleCashierId,
  resolveOpenStationForActor,
  openStationShift,
  closeOtherShiftsOfStation,
};
