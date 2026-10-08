/**
 * Cada caja es un turno único, ligado a su cajero.
 * El administrador abre y cierra cualquiera. Un cajero solo entra a la suya.
 * Cerrar una no cierra la otra. El aviso de cierre nombra caja y responsable.
 * Base temporal: no toca restaurant.db. No envía correo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();
process.env.CASH_CLOSE_NOTIFY_ENABLED = '0';
if (!String(process.env.JWT_SECRET || '').trim()) {
  process.env.JWT_SECRET = 'caja-turnos-check-secret';
}
const dbDir = path.join(os.tmpdir(), `fadey-caja-${Date.now()}`);
fs.mkdirSync(dbDir, { recursive: true });
const dbFile = path.join(dbDir, 'turnos.db');
process.env.DB_PATH = dbFile;

const express = require('express');
const { initDatabase, queryOne, runSql } = require('../server/database');
const { getOpenRegistersOnActiveStations } = require('../server/cajaSettings');
const { signStaffToken } = require('../server/utils/staffJwt');
const {
  getCashCloseRecipient,
  sendCashCloseNotification,
  buildCashCloseContent,
} = require('../server/services/cashCloseNotifyService');
const posRouter = require('../server/routes/pos');

const CAJA_A = 'caja-a';
const CAJA_B = 'caja-b';

function fail(msg) {
  throw new Error(msg);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
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

async function main() {
  await initDatabase();
  const settingsRow = queryOne("SELECT value FROM app_settings WHERE key = 'settings'");
  const settings = JSON.parse(settingsRow.value);
  settings.cajas = [
    { id: CAJA_A, name: 'Caja recepción', active: 1 },
    { id: CAJA_B, name: 'Caja terraza', active: 1 },
    { id: 'caja-off', name: 'Caja depósito', active: 0 },
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
  insertUser(adminId, 'admin', 'Administrador', 'admin', '');
  insertUser(fabianId, 'fabian', 'Fabián', 'cajero', CAJA_A);
  insertUser(luisId, 'luis', 'Luis', 'cajero', CAJA_B);

  const token = (id, username, role, name) => signStaffToken({
    id, username, role, full_name: name, restaurant_id: restaurantId,
  });
  const adminToken = token(adminId, 'admin', 'admin', 'Administrador');
  const fabianToken = token(fabianId, 'fabian', 'cajero', 'Fabián');
  const luisToken = token(luisId, 'luis', 'cajero', 'Luis');

  const app = express();
  app.use(express.json());
  app.use('/pos', posRouter);
  const server = await listen(app);

  try {
    const ajena = await api(server, 'POST', '/pos/open-register', {
      token: fabianToken,
      body: { opening_amount: 20, caja_station_id: CAJA_B },
    });
    assert(ajena.status === 403, `Fabián no puede abrir la terraza (status ${ajena.status} ${JSON.stringify(ajena.json)})`);

    const abreA = await api(server, 'POST', '/pos/open-register', {
      token: adminToken,
      body: { opening_amount: 100, caja_station_id: CAJA_A },
    });
    assert(abreA.status === 201, `el administrador abre recepción (${abreA.status} ${JSON.stringify(abreA.json)})`);
    assert(abreA.json.user_id === fabianId, 'el responsable del turno es Fabián');
    assert(abreA.json.caja_station_id === CAJA_A, 'el turno queda en recepción');

    const abreB = await api(server, 'POST', '/pos/open-register', {
      token: adminToken,
      body: { opening_amount: 80, caja_station_id: CAJA_B },
    });
    assert(abreB.status === 201, `el administrador abre la otra caja sin cerrar la primera (${abreB.status})`);
    assert(abreB.json.user_id === luisId, 'el responsable de terraza es Luis');
    assert(abreB.json.id !== abreA.json.id, 'son turnos distintos');

    const repetida = await api(server, 'POST', '/pos/open-register', {
      token: fabianToken,
      body: { opening_amount: 10 },
    });
    assert(repetida.status === 200 && repetida.json.already_open === true, 'la misma caja no abre un segundo turno');
    assert(repetida.json.id === abreA.json.id, 'Fabián entra al turno que ya abrió el administrador');

    const veFabian = await api(server, 'GET', '/pos/current-register', { token: fabianToken });
    const veLuis = await api(server, 'GET', '/pos/current-register', { token: luisToken });
    assert(veFabian.json?.id === abreA.json.id, 'Fabián solo ve su caja');
    assert(veLuis.json?.id === abreB.json.id, 'Luis solo ve su caja');

    const estacionesFabian = await api(server, 'GET', '/pos/caja-stations', { token: fabianToken });
    assert(estacionesFabian.json.stations.length === 1, 'el cajero no lista las otras cajas');
    assert(estacionesFabian.json.stations[0].id === CAJA_A, 'Fabián solo ve recepción');

    const monitor = getOpenRegistersOnActiveStations();
    assert(monitor.length === 2, `el monitoreo debe ver 2 cajas, vio ${monitor.length}`);
    assert(monitor.map((r) => r.user_name).sort().join(',') === 'Fabián,Luis', 'el monitoreo nombra a cada cajero');

    const duplicadoId = uuidv4();
    runSql(
      'INSERT INTO cash_registers (id, user_id, restaurant_id, opening_amount, caja_station_id) VALUES (?, ?, ?, ?, ?)',
      [duplicadoId, fabianId, restaurantId, 1, CAJA_A],
    );

    const inactiva = await api(server, 'POST', '/pos/open-register', {
      token: adminToken,
      body: { opening_amount: 10, caja_station_id: 'caja-off' },
    });
    assert(inactiva.status === 400, `una caja inactiva no se abre (${inactiva.status})`);

    const cierraAjena = await api(server, 'POST', '/pos/close-register', {
      token: fabianToken,
      body: { closing_amount: 100, register_id: abreB.json.id },
    });
    assert(cierraAjena.status === 200, `Fabián cierra solo su turno (${cierraAjena.status} ${JSON.stringify(cierraAjena.json)})`);
    assert(cierraAjena.json.caja_station_id === CAJA_A, 'aunque indique la terraza, se cierra recepción');
    const terrazaSigue = queryOne('SELECT closed_at FROM cash_registers WHERE id = ?', [abreB.json.id]);
    assert(!terrazaSigue.closed_at, 'la terraza sigue abierta');
    const recepcion = queryOne('SELECT closed_at FROM cash_registers WHERE id = ?', [abreA.json.id]);
    const duplicado = queryOne('SELECT closed_at FROM cash_registers WHERE id = ?', [duplicadoId]);
    assert(recepcion.closed_at && duplicado.closed_at, 'se cierran el turno de recepción y su duplicado');

    const fabianCerrado = await api(server, 'GET', '/pos/current-register', { token: fabianToken });
    const luisSigue = await api(server, 'GET', '/pos/current-register', { token: luisToken });
    assert(fabianCerrado.json == null, 'Fabián ya no tiene turno');
    assert(luisSigue.json?.id === abreB.json.id, 'Luis sigue en su caja');

    const monitorUno = getOpenRegistersOnActiveStations();
    assert(monitorUno.length === 1 && monitorUno[0].user_name === 'Luis', 'el monitoreo solo muestra la caja que queda abierta');

    const cierraAdmin = await api(server, 'POST', '/pos/close-register', {
      token: adminToken,
      body: { closing_amount: 80, register_id: abreB.json.id, notes: 'Cierre de terraza' },
    });
    assert(cierraAdmin.status === 200 && cierraAdmin.json.id === abreB.json.id, 'el administrador cierra la caja de Luis');
    assert(getOpenRegistersOnActiveStations().length === 0, 'no queda ninguna caja abierta');

    const destinatario = getCashCloseRecipient();
    assert(destinatario.email === 'admin@test.pe', `el aviso va al correo del administrador (${destinatario.email})`);
    assert(destinatario.name === 'Administrador', 'el aviso nombra al administrador');

    const aviso = buildCashCloseContent({
      register: { ...abreA.json, opened_at: abreA.json.opened_at },
      sales: { total_sales: 40, total_cash: 40, total_tips: 0, total_yape: 0, total_plin: 0, total_card: 0, total_online: 0 },
      movements: { total_income: 0, total_expense: 0 },
      expectedCash: 140,
      countedCash: 140,
      difference: 0,
      notes: '',
      closedByName: 'Administrador',
      toEmail: destinatario.email,
      recipientName: destinatario.name,
      stationName: 'Caja recepción',
      responsibleName: 'Fabián',
    });
    assert(aviso.plainMessage.includes('Caja: Caja recepción'), 'el aviso dice qué caja se cerró');
    assert(aviso.plainMessage.includes('Responsable: Fabián'), 'el aviso nombra al cajero responsable');
    assert(aviso.plainMessage.includes('Cerró: Administrador'), 'el aviso dice quién cerró');
    assert(aviso.subject.includes('Cierre registrado'), 'el aviso tiene asunto de cierre');

    const envio = await sendCashCloseNotification({
      register: abreB.json,
      sales: { total_sales: 0, total_cash: 0 },
      movements: { total_income: 0, total_expense: 0 },
      expectedCash: 80,
      countedCash: 80,
      difference: 0,
      notes: '',
      closedByName: 'Administrador',
      stationName: 'Caja terraza',
      responsibleName: 'Luis',
    });
    assert(envio?.skipped === true, 'con el aviso apagado no se intenta enviar correo');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  cleanup();
  console.log('caja-turnos-check: ok');
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
