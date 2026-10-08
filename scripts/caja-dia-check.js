/**
 * Una caja solo suma ventas propias desde su apertura hasta su cierre.
 * Base temporal. No toca la base del local.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();
if (!String(process.env.JWT_SECRET || '').trim()) {
  process.env.JWT_SECRET = 'caja-dia-check-secret';
}
const dbDir = path.join(os.tmpdir(), `fadey-caja-dia-${Date.now()}`);
fs.mkdirSync(dbDir, { recursive: true });
const dbFile = path.join(dbDir, 'dia.db');
process.env.DB_PATH = dbFile;

const { initDatabase, queryOne, runSql } = require('../server/database');
const { getOpenRegistersOnActiveStations, getActiveCajaById } = require('../server/cajaSettings');
const { queryRegisterSessionSales } = require('../server/services/registerSessionSales');

const CAJA_A = 'caja-a';

function fail(msg) {
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function cleanup() {
  for (const extra of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + extra); } catch (_) { /* temp */ }
  }
  try { fs.rmdirSync(dbDir); } catch (_) { /* temp */ }
}

function insertPaid(restaurantId, total, registerId, paidAtSql) {
  const id = uuidv4();
  runSql(
    `INSERT INTO orders (
      id, order_number, restaurant_id, type, status, subtotal, tax, discount, total,
      payment_method, payment_status, table_number, cash_register_id, paid_at
    ) VALUES (?, 1, ?, 'dine_in', 'ready', ?, 0, 0, ?, 'efectivo', 'paid', '1', ?, ${paidAtSql})`,
    [id, restaurantId, total, total, registerId || ''],
  );
  return id;
}

async function main() {
  await initDatabase();
  const settingsRow = queryOne("SELECT value FROM app_settings WHERE key = 'settings'");
  const settings = JSON.parse(settingsRow.value);
  settings.cajas = [{ id: CAJA_A, name: 'Caja Principal', active: 1 }];
  runSql("UPDATE app_settings SET value = ? WHERE key = 'settings'", [JSON.stringify(settings)]);

  const restaurantId = queryOne('SELECT id FROM restaurants LIMIT 1')?.id || null;
  const userId = uuidv4();
  runSql(
    `INSERT INTO users (id, username, email, password_hash, full_name, role, restaurant_id, caja_station_id, is_active)
     VALUES (?, 'cajadia', 'cajadia@test.pe', 'x', 'Cajero Día', 'cajero', ?, ?, 1)`,
    [userId, restaurantId, CAJA_A],
  );

  const openId = uuidv4();
  const closedId = uuidv4();
  const orphanId = uuidv4();
  runSql(
    'INSERT INTO cash_registers (id, user_id, restaurant_id, opening_amount, caja_station_id) VALUES (?, ?, ?, 0, ?)',
    [openId, userId, restaurantId, CAJA_A],
  );
  runSql("UPDATE cash_registers SET opened_at = datetime('now', '-2 days') WHERE id = ?", [openId]);
  runSql(
    'INSERT INTO cash_registers (id, user_id, restaurant_id, opening_amount, caja_station_id) VALUES (?, ?, ?, 0, ?)',
    [closedId, userId, restaurantId, CAJA_A],
  );
  runSql(
    "UPDATE cash_registers SET opened_at = datetime('now', '-3 days'), closed_at = datetime('now', '-1 hour') WHERE id = ?",
    [closedId],
  );
  runSql(
    'INSERT INTO cash_registers (id, user_id, restaurant_id, opening_amount, caja_station_id) VALUES (?, ?, ?, 0, \'\')',
    [orphanId, userId, restaurantId],
  );

  insertPaid(restaurantId, 40, openId, "datetime('now', '-1 day')");
  insertPaid(restaurantId, 18000, openId, "datetime('now', '-10 days')");
  insertPaid(restaurantId, 500, '', "datetime('now', '-1 day')");
  insertPaid(restaurantId, 15, closedId, "datetime('now', '-2 days')");
  insertPaid(restaurantId, 77, closedId, "datetime('now')");
  insertPaid(restaurantId, 999, orphanId, "datetime('now')");

  const openRow = queryOne('SELECT * FROM cash_registers WHERE id = ?', [openId]);
  const shift = queryRegisterSessionSales(openRow);
  assert(Number(shift.total_sales) === 40, `el turno abierto debe sumar 40, salió ${shift.total_sales}`);

  const closedRow = queryOne('SELECT * FROM cash_registers WHERE id = ?', [closedId]);
  const closedSales = queryRegisterSessionSales(closedRow);
  assert(Number(closedSales.total_sales) === 15, `el turno cerrado debe guardar 15, salió ${closedSales.total_sales}`);

  const opens = getOpenRegistersOnActiveStations();
  assert(opens.some((row) => row.id === openId), 'el monitoreo ve el turno abierto');
  assert(!opens.some((row) => row.id === closedId), 'un turno cerrado no sigue en la caja');
  assert(!opens.some((row) => row.id === orphanId), 'un turno sin estación no es una caja del local');
  assert(!getActiveCajaById(''), 'un turno sin estación no es una caja abierta');

  console.log('caja-dia-check: ok');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
