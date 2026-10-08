const { queryOne, queryAll } = require('./database');

/** Misma id en seed (database) y en DEFAULT_APP_SETTINGS del cliente. */
const DEFAULT_PRIMARY_CAJA_ID = 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001';

function readSettingsObject() {
  const row = queryOne("SELECT value FROM app_settings WHERE key = 'settings'");
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

/** Cajas con id no vacío (activas o no). */
function listCajasWithIds() {
  const s = readSettingsObject();
  const cajas = Array.isArray(s.cajas) ? s.cajas : [];
  return cajas.map((c) => ({
    id: String(c?.id || '').trim(),
    name: String(c?.name || '').trim(),
    active: Number(c?.active || 0) === 1,
  })).filter((c) => c.id);
}

function getActiveCajaById(cajaId) {
  const needle = String(cajaId || '').trim();
  if (!needle) return null;
  return listCajasWithIds().find((c) => c.id === needle && c.active) || null;
}

/** Primera caja activa para auto-asignar al primer cajero (prioriza la principal por id). */
function getFirstAutoAssignCajaId() {
  const list = listCajasWithIds().filter((c) => c.active);
  if (!list.length) return null;
  const preferred = list.find((c) => c.id === DEFAULT_PRIMARY_CAJA_ID);
  return (preferred || list[0]).id;
}

/** Turnos abiertos vinculados a una caja activa del local (misma lógica que GET /pos/caja-stations). */
function getOpenRegistersOnActiveStations() {
  const active = listCajasWithIds().filter((c) => c.active);
  const activeIds = new Set(active.map((c) => c.id));
  const stationNameById = Object.fromEntries(active.map((c) => [c.id, c.name]));
  if (!activeIds.size) return [];

  const opens = queryAll(
    `SELECT cr.id, cr.opened_at, cr.user_id, cr.caja_station_id, u.full_name AS user_name
     FROM cash_registers cr
     LEFT JOIN users u ON u.id = cr.user_id
     WHERE cr.closed_at IS NULL
     ORDER BY datetime(cr.opened_at) DESC`
  );

  const seen = new Set();
  const out = [];
  for (const row of opens || []) {
    const sid = String(row.caja_station_id || '').trim();
    if (!activeIds.has(sid) || seen.has(sid)) continue;
    seen.add(sid);
    out.push({
      ...row,
      caja_station_id: sid,
      user_name: row.user_name || '',
      station_name: stationNameById[sid] || 'Caja',
    });
  }
  return out;
}

module.exports = {
  readSettingsObject,
  listCajasWithIds,
  getActiveCajaById,
  DEFAULT_PRIMARY_CAJA_ID,
  getFirstAutoAssignCajaId,
  getOpenRegistersOnActiveStations,
};
