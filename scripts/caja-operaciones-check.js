/**
 * Operaciones de caja: cobro, ingresos, egresos, notas, arqueo, cierre y aviso.
 * Cada movimiento queda en la caja del turno, no en la otra.
 * Base temporal. No envía correo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();
process.env.CASH_CLOSE_NOTIFY_ENABLED = '0';
if (!String(process.env.JWT_SECRET || '').trim()) {
  process.env.JWT_SECRET = 'caja-operaciones-check-secret';
}
const dbDir = path.join(os.tmpdir(), `fadey-caja-ops-${Date.now()}`);
fs.mkdirSync(dbDir, { recursive: true });
const dbFile = path.join(dbDir, 'ops.db');
process.env.DB_PATH = dbFile;

const express = require('express');
const { initDatabase, queryOne, runSql } = require('../server/database');
const { signStaffToken, signMasterToken } = require('../server/utils/staffJwt');
const posRouter = require('../server/routes/pos');

const CAJA_A = 'caja-a';
const CAJA_B = 'caja-b';

function fail(msg) {
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function esperado(reg) {
  return round2(
    Number(reg.opening_amount || 0)
    + Number(reg.total_cash || 0)
    + Number(reg.tips_cash || 0)
    + Number(reg.total_income || 0)
    - Number(reg.total_expense || 0)
    + Number(reg.notes_credit || 0)
    - Number(reg.notes_debit || 0),
  );
}
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
async function api(server, method, urlPath, { token, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
function cleanup() {
  for (const extra of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + extra); } catch (_) { /* temp */ }
  }
  try { fs.rmdirSync(dbDir); } catch (_) { /* temp */ }
}
function insertPendingOrder(restaurantId, total, tableNumber) {
  const id = uuidv4();
  runSql(
    `INSERT INTO orders (
      id, order_number, restaurant_id, type, status, subtotal, tax, discount, total,
      payment_method, payment_status, table_number
    ) VALUES (?, 1, ?, 'dine_in', 'pending', ?, 0, 0, ?, 'efectivo', 'pending', ?)`,
    [id, restaurantId, total, total, tableNumber],
  );
  runSql(
    `INSERT INTO order_items (id, order_id, product_name, quantity, unit_price, subtotal)
     VALUES (?, ?, 'Plato prueba', 1, ?, ?)`,
    [uuidv4(), id, total, total],
  );
  return id;
}

async function main() {
  await initDatabase();
  const settingsRow = queryOne("SELECT value FROM app_settings WHERE key = 'settings'");
  const settings = JSON.parse(settingsRow.value);
  settings.cajas = [
    { id: CAJA_A, name: 'Caja recepción', active: 1 },
    { id: CAJA_B, name: 'Caja terraza', active: 1 },
  ];
  runSql("UPDATE app_settings SET value = ? WHERE key = 'settings'", [JSON.stringify(settings)]);

  const restaurant = queryOne('SELECT id FROM restaurants LIMIT 1');
  const restaurantId = restaurant?.id || null;
  const adminId = uuidv4();
  const fabianId = uuidv4();
  const luisId = uuidv4();
  const insertUser = (id, username, name, role, station) => {
    runSql(
      `INSERT INTO users (id, username, email, password_hash, full_name, role, restaurant_id, caja_station_id, is_active)
       VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 1)`,
      [id, username, `${username}@test.pe`, name, role, restaurantId, station],
    );
  };
  insertUser(adminId, 'adminops', 'Administrador', 'admin', '');
  insertUser(fabianId, 'fabianops', 'Fabián', 'cajero', CAJA_A);
  insertUser(luisId, 'luisops', 'Luis', 'cajero', CAJA_B);

  const token = (id, username, role, name) => signStaffToken({
    id, username, role, full_name: name, restaurant_id: restaurantId,
  });
  const adminToken = token(adminId, 'adminops', 'admin', 'Administrador');
  const fabianToken = token(fabianId, 'fabianops', 'cajero', 'Fabián');
  const luisToken = token(luisId, 'luisops', 'cajero', 'Luis');
  const masterToken = signMasterToken({
    id: 'master-admin', username: 'maestro', role: 'master_admin', full_name: 'Administrador Maestro',
  });

  const app = express();
  app.use(express.json());
  app.use('/pos', posRouter);
  const server = await listen(app);

  try {
    const sinToken = await api(server, 'GET', '/pos/current-register');
    assert(sinToken.status === 401, 'sin sesión no se lee la caja');

    const abreA = await api(server, 'POST', '/pos/open-register', {
      token: adminToken,
      body: { opening_amount: 100, caja_station_id: CAJA_A },
    });
    const abreB = await api(server, 'POST', '/pos/open-register', {
      token: adminToken,
      body: { opening_amount: 80, caja_station_id: CAJA_B },
    });
    assert(abreA.status === 201 && abreB.status === 201, 'el administrador abre las dos cajas');
    const idA = abreA.json.id;
    const idB = abreB.json.id;

    const metodos = await api(server, 'GET', '/pos/payment-methods', { token: fabianToken });
    assert(metodos.status === 200 && Array.isArray(metodos.json.options) && metodos.json.options.length > 0, 'hay métodos de pago');

    const precios = await api(server, 'GET', '/pos/price-lookup?q=plato', { token: fabianToken });
    assert(precios.status === 200 && Array.isArray(precios.json), 'la consulta de precios responde');

    const estadoFabian = await api(server, 'GET', '/pos/register-status', { token: fabianToken });
    const estadoAdmin = await api(server, 'GET', '/pos/register-status', { token: adminToken });
    assert(estadoFabian.json.is_open === true && estadoFabian.json.open_count === 1, 'el cajero ve solo su caja abierta');
    assert(estadoFabian.json.register?.id === idA, 'el estado de Fabián es recepción');
    assert(estadoAdmin.json.open_count === 2, 'el administrador ve las dos cajas abiertas');

    const adminSinCaja = await api(server, 'GET', '/pos/current-register', { token: adminToken });
    assert(adminSinCaja.json == null, 'el administrador elige la caja; no hereda el turno del cajero');

    const montoMal = await api(server, 'POST', '/pos/movements', {
      token: fabianToken,
      body: { type: 'income', amount: 0, concept: 'cero' },
    });
    assert(montoMal.status === 400, 'un monto en cero no se registra');
    const tipoMal = await api(server, 'POST', '/pos/notes', {
      token: fabianToken,
      body: { note_type: 'otro', amount: 5, reason: 'x' },
    });
    assert(tipoMal.status === 400, 'una nota de tipo desconocido se rechaza');

    const pedidoEfectivo = insertPendingOrder(restaurantId, 50, '5');
    const cobraFabian = await api(server, 'POST', '/pos/checkout-table', {
      token: fabianToken,
      body: { order_ids: [pedidoEfectivo], payment_method: 'efectivo', tip_amount: 5 },
    });
    assert(cobraFabian.status === 200, `Fabián cobra en efectivo (${cobraFabian.status} ${JSON.stringify(cobraFabian.json)})`);
    const pagadoA = queryOne('SELECT payment_status, cash_register_id, payment_method, tip_amount FROM orders WHERE id = ?', [pedidoEfectivo]);
    assert(pagadoA.payment_status === 'paid' && pagadoA.cash_register_id === idA, 'el cobro de Fabián queda en su caja');
    assert(Number(pagadoA.tip_amount) === 5, 'la propina queda en el pedido');

    const pedidoMixto = insertPendingOrder(restaurantId, 60, '6');
    const cobraAdmin = await api(server, 'POST', '/pos/checkout-table', {
      token: adminToken,
      body: {
        order_ids: [pedidoMixto],
        payment_method: 'efectivo',
        payment_breakdown: { efectivo: 40, yape: 20 },
        register_id: idA,
      },
    });
    assert(cobraAdmin.status === 200, `el administrador cobra en la caja de Fabián (${cobraAdmin.status} ${JSON.stringify(cobraAdmin.json)})`);
    const pagadoMixto = queryOne('SELECT cash_register_id, payment_status FROM orders WHERE id = ?', [pedidoMixto]);
    assert(pagadoMixto.cash_register_id === idA && pagadoMixto.payment_status === 'paid', 'el multipago queda en recepción');

    const pedidoYape = insertPendingOrder(restaurantId, 30, '8');
    const cobraLuis = await api(server, 'POST', '/pos/checkout-table', {
      token: luisToken,
      body: { order_ids: [pedidoYape], payment_method: 'yape', register_id: idA },
    });
    assert(cobraLuis.status === 200, `Luis cobra en su caja (${cobraLuis.status} ${JSON.stringify(cobraLuis.json)})`);
    const pagadoB = queryOne('SELECT cash_register_id, payment_method FROM orders WHERE id = ?', [pedidoYape]);
    assert(pagadoB.cash_register_id === idB && pagadoB.payment_method === 'yape', 'aunque indique la otra caja, Luis cobra en la suya');

    const ingresoA = await api(server, 'POST', '/pos/movements', {
      token: fabianToken,
      body: { type: 'income', amount: 20, concept: 'Fondo recepción' },
    });
    const egresoA = await api(server, 'POST', '/pos/movements', {
      token: fabianToken,
      body: { type: 'expense', amount: 8, concept: 'Compra menuda' },
    });
    assert(ingresoA.status === 201 && egresoA.status === 201, 'ingreso y egreso se registran');
    assert(ingresoA.json.register_id === idA && egresoA.json.register_id === idA, 'los movimientos quedan en recepción');

    const notaCredito = await api(server, 'POST', '/pos/notes', {
      token: fabianToken,
      body: { note_type: 'credit', amount: 4, reason: 'Sencillo de más' },
    });
    const notaDebito = await api(server, 'POST', '/pos/notes', {
      token: fabianToken,
      body: { note_type: 'debit', amount: 2, reason: 'Faltante' },
    });
    assert(notaCredito.status === 201 && notaDebito.status === 201, 'las notas de caja se registran');

    const ingresoAjeno = await api(server, 'POST', '/pos/movements', {
      token: luisToken,
      body: { type: 'income', amount: 15, concept: 'Fondo terraza', register_id: idA },
    });
    assert(ingresoAjeno.status === 400, `Luis no carga movimientos en la caja de Fabián (${ingresoAjeno.status} ${JSON.stringify(ingresoAjeno.json)})`);
    const ingresoLuis = await api(server, 'POST', '/pos/movements', {
      token: luisToken,
      body: { type: 'income', amount: 15, concept: 'Fondo terraza' },
    });
    assert(ingresoLuis.status === 201 && ingresoLuis.json.register_id === idB, 'el ingreso de Luis queda en su caja');

    const adminSinTurno = await api(server, 'POST', '/pos/movements', {
      token: adminToken,
      body: { type: 'income', amount: 10, concept: 'Sin caja' },
    });
    assert(adminSinTurno.status === 400, 'el administrador indica qué caja recibe el movimiento');

    const ingresoAdmin = await api(server, 'POST', '/pos/movements', {
      token: adminToken,
      body: { type: 'income', amount: 10, concept: 'Refuerzo admin', register_id: idA },
    });
    assert(ingresoAdmin.status === 201 && ingresoAdmin.json.register_id === idA, 'el administrador registra en la caja que eligió');

    const listaA = await api(server, 'GET', `/pos/movements?register_id=${idA}`, { token: adminToken });
    const listaB = await api(server, 'GET', '/pos/movements', { token: luisToken });
    const conceptosA = (listaA.json || []).map((m) => m.concept);
    assert(conceptosA.includes('Fondo recepción') && conceptosA.includes('Refuerzo admin'), 'recepción lista sus ingresos');
    assert(!conceptosA.includes('Fondo terraza'), 'el fondo de terraza no aparece en recepción');
    assert((listaB.json || []).some((m) => m.concept === 'Fondo terraza'), 'Luis ve su ingreso');

    const notasA = await api(server, 'GET', '/pos/notes', { token: fabianToken });
    assert((notasA.json || []).length === 2, 'Fabián ve sus dos notas');

    const turnoA = await api(server, 'GET', `/pos/current-register?register_id=${idA}`, { token: adminToken });
    const turnoB = await api(server, 'GET', '/pos/current-register', { token: luisToken });
    assert(turnoA.status === 200 && turnoB.status === 200, 'se lee el turno abierto');
    assert(Number(turnoA.json.total_sales) === 110, `ventas de recepción ${turnoA.json.total_sales}`);
    assert(Number(turnoA.json.total_cash) === 90, `efectivo de recepción ${turnoA.json.total_cash}`);
    assert(Number(turnoA.json.total_yape) === 20, `yape de recepción ${turnoA.json.total_yape}`);
    assert(Number(turnoA.json.tips_cash) === 5, `propina en efectivo ${turnoA.json.tips_cash}`);
    assert(Number(turnoA.json.total_income) === 30, `ingresos de recepción ${turnoA.json.total_income}`);
    assert(Number(turnoA.json.total_expense) === 8, `egresos de recepción ${turnoA.json.total_expense}`);
    assert(esperado(turnoA.json) === 219, `efectivo esperado de recepción ${esperado(turnoA.json)}`);
    assert(Number(turnoA.json.expected_cash) === 219, `el arqueo cuadra con 219, dio ${turnoA.json.expected_cash}`);
    assert(Number(turnoB.json.total_sales) === 30 && Number(turnoB.json.total_cash) === 0, 'el yape de terraza no suma efectivo');
    assert(Number(turnoB.json.expected_cash) === 95, `efectivo esperado de terraza ${turnoB.json.expected_cash}`);

    const monitorA = await api(server, 'GET', `/pos/sales-monitor?register_id=${idA}`, { token: adminToken });
    const monitorB = await api(server, 'GET', '/pos/sales-monitor', { token: luisToken });
    assert(Number(monitorA.json.total_sales) === 110, 'el monitor de ventas de recepción coincide');
    assert(Number(monitorB.json.total_sales) === 30, 'el monitor de terraza no incluye las ventas de recepción');

    const noMaestro = await api(server, 'PUT', `/pos/register/${idA}/opening-amount`, {
      token: adminToken,
      body: { opening_amount: 110 },
    });
    assert(noMaestro.status === 403, 'solo el administrador maestro corrige la apertura');
    const maestro = await api(server, 'PUT', `/pos/register/${idA}/opening-amount`, {
      token: masterToken,
      body: { opening_amount: 110 },
    });
    assert(maestro.status === 200 && Number(maestro.json.opening_amount) === 110, 'el maestro corrige el monto de apertura');
    assert(Number(maestro.json.expected_cash) === 229, `al subir la apertura, el esperado pasa a 229, dio ${maestro.json.expected_cash}`);

    const aviso = await api(server, 'POST', '/pos/send-close-email', {
      token: adminToken,
      body: { closing_amount: 229, register_id: idA, notes: 'Prueba' },
    });
    assert(aviso.status === 200 && aviso.json.skipped === true, `con el aviso apagado no dice que el correo salió (${JSON.stringify(aviso.json)})`);
    const sigueAbierta = queryOne('SELECT closed_at FROM cash_registers WHERE id = ?', [idA]);
    assert(!sigueAbierta.closed_at, 'enviar el aviso no cierra la caja');

    const cierreNegativo = await api(server, 'POST', '/pos/close-register', {
      token: adminToken,
      body: { closing_amount: -1, register_id: idA },
    });
    assert(cierreNegativo.status === 400, 'no se cierra con efectivo negativo');

    const cierraA = await api(server, 'POST', '/pos/close-register', {
      token: adminToken,
      body: { closing_amount: 229, notes: 'Cuadre recepción', register_id: idA },
    });
    assert(cierraA.status === 200 && cierraA.json.id === idA, `se cierra recepción (${cierraA.status} ${JSON.stringify(cierraA.json)})`);
    assert(Number(cierraA.json.closing_amount) === 229, 'guarda el efectivo contado');
    assert(Number(cierraA.json.total_sales) === 110, 'el cierre guarda las ventas del turno');
    const arqueo = JSON.parse(cierraA.json.arqueo_data || '{}');
    assert(Number(arqueo.expected_cash) === 229 && Number(arqueo.difference) === 0, 'el arqueo queda en cero');
    assert(arqueo.closed_by_name === 'Administrador', 'el arqueo dice quién cerró');
    assert(Number(arqueo.payment_breakdown?.efectivo) === 90, 'el arqueo desglosa el efectivo');
    assert(Number(arqueo.payment_breakdown?.yape) === 20, 'el arqueo desglosa el yape');

    const terraza = await api(server, 'GET', '/pos/current-register', { token: luisToken });
    assert(terraza.json?.id === idB, 'cerrar recepción deja la terraza abierta');

    const movimientoCerrado = await api(server, 'POST', '/pos/movements', {
      token: adminToken,
      body: { type: 'expense', amount: 1, concept: 'Tarde', register_id: idA },
    });
    assert(movimientoCerrado.status === 400, 'no se cargan movimientos a un turno cerrado');

    const historial = await api(server, 'GET', '/pos/history', { token: adminToken });
    assert((historial.json || []).some((r) => r.id === idA && r.closed_at), 'el historial muestra el cierre');

    const reporteZ = await api(server, 'GET', '/pos/z-report', { token: fabianToken });
    assert(reporteZ.status === 200 && reporteZ.json.id === idA, 'el reporte Z es el último cierre');
    assert((reporteZ.json.movements || []).length === 3, 'el Z de recepción incluye sus tres movimientos');
    assert((reporteZ.json.notes || []).length === 2, 'el Z incluye las notas');

    const cierraB = await api(server, 'POST', '/pos/close-register', {
      token: luisToken,
      body: { closing_amount: 95 },
    });
    assert(cierraB.status === 200 && cierraB.json.id === idB, 'Luis cierra su caja');
    assert(Number(cierraB.json.total_yape) === 30 && Number(cierraB.json.total_cash) === 0, 'el cierre de terraza guarda el yape y no el efectivo de la otra caja');

    const zFinal = await api(server, 'GET', '/pos/z-report', { token: adminToken });
    assert(zFinal.json.id === idB && zFinal.json.user_name === 'Luis', 'el Z pasa a ser el cierre más reciente');

    const sinCaja = await api(server, 'POST', '/pos/checkout-table', {
      token: fabianToken,
      body: { order_ids: [insertPendingOrder(restaurantId, 10, '9')], payment_method: 'efectivo' },
    });
    assert(sinCaja.status === 400, 'no se cobra si la caja del cajero está cerrada');

    const reabre = await api(server, 'POST', '/pos/open-register', {
      token: fabianToken,
      body: { opening_amount: 40 },
    });
    assert(reabre.status === 201 && reabre.json.id !== idA, 'al abrir de nuevo nace otro turno');
    assert(reabre.json.user_id === fabianId && reabre.json.caja_station_id === CAJA_A, 'el turno nuevo sigue siendo de Fabián en su caja');
    const luisCerrado = await api(server, 'GET', '/pos/current-register', { token: luisToken });
    assert(luisCerrado.json == null, 'la caja de Luis sigue cerrada');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  cleanup();
  console.log('caja-operaciones-check: ok');
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
