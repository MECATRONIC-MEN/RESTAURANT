const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { normalizeSqlParams } = require('./utils/sqlBind');
const { openOrRecoverSqliteFile } = require('./sqliteRecover');
const {
  writeFileAtomic,
  writeSnapshotBackup,
  ensureDailyBackup,
  ensureMonthlyBackup,
  getBackupMirrorDir,
  getPersistentBackupsDir,
  getLastGoodPath,
} = require('./sqlitePersist');
const { assertCompleteSqliteBuffer } = require('./utils/sqliteBackupIntegrity');
const {
  loadBetterSqlite3,
  openNativeWithRecover,
  reopenNative,
  probeSqliteBuffer,
  checkpointNative,
  vacuumNativeInto,
  isNativeDb,
  removeWalSidecars,
} = require('./sqliteEngine');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'restaurant.db');
const DB_PATH = path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);

let db = null;
let dbReady = null;
/** Si false, en este arranque se creó un archivo .db nuevo (vacío). */
let dbFileExistedBeforeInit = false;
let persistTimer = null;
let persistBusy = false;
let persistQueued = false;
let lastAutoBackupAt = 0;
/** true si sql.js no pudo abrir el .db y se arranca vacío para restaurar. */
let allowEmptyPersist = false;

let lastIntegrity = { ok: true, checkedAt: null, detail: '' };

/** PRAGMA quick_check: detecta páginas dañadas antes de que una copia buena se pise con datos rotos. */
function checkDatabaseIntegrity() {
  if (!db) return lastIntegrity;
  try {
    const row = queryOne('PRAGMA quick_check');
    const detail = String(row ? Object.values(row)[0] : 'ok');
    lastIntegrity = { ok: detail.toLowerCase() === 'ok', checkedAt: new Date().toISOString(), detail };
  } catch (err) {
    lastIntegrity = { ok: false, checkedAt: new Date().toISOString(), detail: err?.message || String(err) };
  }
  if (!lastIntegrity.ok) {
    console.error('[sqlite] INTEGRIDAD: quick_check falló →', lastIntegrity.detail);
  }
  return lastIntegrity;
}

/** OneDrive/Dropbox/Drive sincronizan el .db sin su -wal y pueden bloquearlo o revertirlo. */
function isInsideCloudSyncFolder(filePath) {
  return /[\\/](onedrive[^\\/]*|dropbox|google drive|googledrive|icloud ?drive)[\\/]/i.test(String(filePath || ''));
}

function getDatabasePersistenceInfo() {
  return {
    path: DB_PATH,
    fileExistedBeforeInit: dbFileExistedBeforeInit,
    dbPathFromEnv: !!process.env.DB_PATH,
    engine: isNativeDb(db) ? 'native-wal' : 'sqljs',
    integrity: lastIntegrity,
    backupsDir: getPersistentBackupsDir(DB_PATH),
    backupMirrorDir: getBackupMirrorDir() || null,
    cloudSyncFolder: isInsideCloudSyncFolder(DB_PATH),
  };
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function diskHasPopulatedCopy() {
  const guard = readDbGuard();
  const guardUsers = Number(guard?.users || 0);
  const guardProducts = Number(guard?.products || 0);
  let mainBytes = 0;
  try {
    mainBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  } catch {
    mainBytes = 0;
  }
  let lastGoodBytes = 0;
  try {
    const lastGood = getLastGoodPath(DB_PATH);
    lastGoodBytes = fs.existsSync(lastGood) ? fs.statSync(lastGood).size : 0;
  } catch {
    lastGoodBytes = 0;
  }
  if (guardUsers > 0 || guardProducts > 0) return true;
  if (mainBytes > 100 * 1024) return true;
  if (lastGoodBytes > 100 * 1024) return true;
  return false;
}

function saveDb() {
  if (!db) return;
  if (persistBusy) {
    persistQueued = true;
    return;
  }
  persistBusy = true;
  try {
    if (isNativeDb(db)) {
      checkpointNative(db._native, 'FULL');
      const usersCount = countTableRows('users');
      const productsCount = countTableRows('products');
      if (usersCount > 0 || productsCount > 0) {
        allowEmptyPersist = false;
        writeDbGuard({
          users: usersCount,
          products: productsCount,
          bytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
        });
      }
      return;
    }
    const parentDir = path.dirname(DB_PATH);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const usersCount = countTableRows('users');
    const productsCount = countTableRows('products');
    const populatedNow = usersCount > 0 || productsCount > 0;
    if (!populatedNow && !allowEmptyPersist && diskHasPopulatedCopy()) {
      console.error(
        '[sqlite] RECHAZADO: no se escribe una base vacía sobre datos existentes. Se conserva restaurant.db y .lastgood.',
      );
      return;
    }
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileAtomic(DB_PATH, buffer, { keepPrevious: populatedNow });
    if (populatedNow) {
      allowEmptyPersist = false;
      writeDbGuard({
        users: usersCount,
        products: productsCount,
        bytes: buffer.length,
      });
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'save_db_failed',
      path: DB_PATH,
      error: err?.message || String(err),
    }));
    if (allowEmptyPersist) {
      console.warn('[sqlite] persistencia omitida en arranque de cero:', err?.message || err);
      return;
    }
    throw new Error(
      'No se pudo guardar la base de datos. Cierre otras instancias del programa o verifique permisos del disco.',
    );
  } finally {
    persistBusy = false;
    if (persistQueued) {
      persistQueued = false;
      saveDb();
    }
  }
}

function scheduleSaveDb() {
  if (isNativeDb(db)) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      saveDb();
    } catch (err) {
      console.error('[sqlite] persistencia diferida:', err?.message || err);
    }
  }, 250);
}

function flushSaveDb() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  saveDb();
}

function createSafetyBackup({ force = false } = {}) {
  if (!db) return null;
  const now = Date.now();
  if (!force && lastAutoBackupAt && now - lastAutoBackupAt < 8 * 60 * 1000) {
    return null;
  }
  flushSaveDb();
  const usersCount = countTableRows('users');
  const productsCount = countTableRows('products');
  if (usersCount === 0 && productsCount === 0) return null;
  if (!checkDatabaseIntegrity().ok) {
    console.error('[sqlite-backup] OMITIDA: la base no pasa quick_check; se conservan las copias buenas anteriores.');
    return null;
  }
  let buffer;
  if (isNativeDb(db)) {
    const lastGood = getLastGoodPath(DB_PATH);
    vacuumNativeInto(db._native, lastGood);
    buffer = fs.readFileSync(lastGood);
  } else {
    if (!fs.existsSync(DB_PATH)) return null;
    buffer = fs.readFileSync(DB_PATH);
    if (buffer.length < 512) return null;
  }
  const autoPath = writeSnapshotBackup(DB_PATH, buffer, 'restaurant_auto');
  ensureDailyBackup(DB_PATH, buffer);
  ensureMonthlyBackup(DB_PATH, buffer);
  lastAutoBackupAt = now;
  console.info(`[sqlite-backup] Copia en ${getPersistentBackupsDir(DB_PATH)} (${usersCount} usuario(s))`);
  return autoPath;
}

function getDefaultSchedule() {
  return {
    lunes: { open: '11:00', close: '23:00', enabled: true },
    martes: { open: '11:00', close: '23:00', enabled: true },
    miercoles: { open: '11:00', close: '23:00', enabled: true },
    jueves: { open: '11:00', close: '23:00', enabled: true },
    viernes: { open: '11:00', close: '00:00', enabled: true },
    sabado: { open: '11:00', close: '00:00', enabled: true },
    domingo: { open: '11:00', close: '22:00', enabled: true },
  };
}

function getDbPath() {
  return DB_PATH;
}

function getDbGuardPath() {
  return path.join(path.dirname(DB_PATH), '.restaurant_db_guard.json');
}

function readDbGuard() {
  try {
    return JSON.parse(fs.readFileSync(getDbGuardPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeDbGuard(snapshot = {}) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getDbGuardPath(),
      JSON.stringify({ ...snapshot, updated_at: new Date().toISOString() }),
    );
  } catch (err) {
    console.warn('[db-guard] no se pudo guardar marcador:', err.message || err);
  }
}

function countTableRows(tableName) {
  try {
    return Number(queryOne(`SELECT COUNT(*) as c FROM ${tableName}`)?.c) || 0;
  } catch {
    return 0;
  }
}

function markEmptyBootGuard() {
  writeDbGuard({ users: 0, products: 0, empty_boot: true });
}

function enableEmptyBoot(reason) {
  allowEmptyPersist = true;
  markEmptyBootGuard();
  console.warn(`[db-guard] Arranque de cero: ${reason} Entre como maestro y restaure el backup .db.`);
}

function assertSafeDbBeforePersist({ usersCount, productsCount, previousBytes }) {
  if (allowEmptyPersist) {
    markEmptyBootGuard();
    console.warn('[db-guard] Arranque de cero. Entre como maestro y restaure el backup .db.');
    return;
  }
  const allowReset = String(process.env.ALLOW_EMPTY_DB_BOOT || '').trim() === '1';
  if (allowReset) {
    enableEmptyBoot('ALLOW_EMPTY_DB_BOOT=1.');
    return;
  }
  const guard = readDbGuard();
  const emptyNow = usersCount === 0 && productsCount === 0;
  if (guard && Number(guard.users || 0) > 0 && emptyNow) {
    enableEmptyBoot(
      `base vacía (marcador: ${guard.users} usuario(s), ${guard.products} producto(s)).`,
    );
    return;
  }
  if (dbFileExistedBeforeInit && previousBytes > 800000 && emptyNow && guard && Number(guard.users || 0) > 0) {
    enableEmptyBoot(`${DB_PATH} (${previousBytes} bytes) sin usuarios/productos.`);
  }
}

function createBackupFile() {
  flushSaveDb();
  if (isNativeDb(db)) {
    const destDir = getPersistentBackupsDir(DB_PATH);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    const dest = path.join(destDir, `restaurant_manual_${ts}.db`);
    vacuumNativeInto(db._native, dest);
    return dest;
  }
  const buffer = fs.readFileSync(DB_PATH);
  if (!buffer || buffer.length < 512) {
    throw new Error('No hay una base de datos válida para respaldar');
  }
  return writeSnapshotBackup(DB_PATH, buffer, 'restaurant_manual');
}

function migrateRestoredDatabase() {
  try {
    runSql('CREATE TABLE IF NOT EXISTS schema_migrations (migration_key TEXT PRIMARY KEY)');
  } catch (_) { /* noop */ }
  try {
    ensureUsersRoleAllowsProduccion();
  } catch (migErr) {
    console.warn('[backup] CHECK rol produccion tras restaurar:', migErr.message || migErr);
  }
  try {
    ensureUsersSchemaColumns();
  } catch (migErr) {
    console.warn('[backup] columnas users tras restaurar:', migErr.message || migErr);
  }
  try {
    ensureOrdersReportColumns();
  } catch (migErr) {
    console.warn('[backup] esquema orders tras restaurar:', migErr.message || migErr);
  }
  try {
    ensureLoyaltySurveysTable();
  } catch (migErr) {
    console.warn('[backup] loyalty_surveys tras restaurar:', migErr.message || migErr);
  }
  try {
    const { ensureJornadaLaboralDefaultsInSettings } = require('./services/jornadaLaboralService');
    ensureJornadaLaboralDefaultsInSettings();
  } catch (migErr) {
    console.warn('[backup] jornada_laboral tras restaurar:', migErr.message || migErr);
  }
  try {
    runSql(`
      CREATE TABLE IF NOT EXISTS order_product_removals (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_number INTEGER,
        product_id TEXT,
        product_name TEXT NOT NULL,
        quantity_removed REAL NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        removal_reason TEXT NOT NULL DEFAULT '',
        table_number TEXT,
        order_type TEXT,
        actor_user_id TEXT,
        actor_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    runSql('CREATE INDEX IF NOT EXISTS idx_order_product_removals_created ON order_product_removals(created_at)');
    runSql('CREATE INDEX IF NOT EXISTS idx_order_product_removals_order ON order_product_removals(order_id)');
  } catch (migErr) {
    console.warn('[backup] order_product_removals tras restaurar:', migErr.message || migErr);
  }
  try {
    require('./utils/ensureOrdersSchema').ensureOrdersSchema();
  } catch (migErr) {
    console.warn('[backup] ensureOrdersSchema:', migErr.message || migErr);
  }
  try {
    require('./utils/ensureUserWorkSessionSchema').ensureUserWorkSessionSchema();
  } catch (migErr) {
    console.warn('[backup] user_work_sessions tras restaurar:', migErr.message || migErr);
  }
  try {
    require('./utils/ensureHrSchema').ensureHrSchema();
  } catch (migErr) {
    console.warn('[backup] hr schema tras restaurar:', migErr.message || migErr);
  }
  try {
    require('./services/saleNumberService').backfillSaleNumbers();
  } catch (migErr) {
    console.warn('[backup] sale_number tras restaurar:', migErr.message || migErr);
  }
  try {
    flushSaveDb();
  } catch (migErr) {
    console.warn('[backup] persistir esquema tras restaurar:', migErr.message || migErr);
  }
}

async function restoreDbFromBuffer(fileBuffer, { expectedBytes } = {}) {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error('Archivo de backup inválido');
  }
  const source = Buffer.from(fileBuffer);
  assertCompleteSqliteBuffer(source, { expectedBytes });
  const BetterSqlite = loadBetterSqlite3();
  if (BetterSqlite) {
    try {
      probeSqliteBuffer(BetterSqlite, source);
    } catch (err) {
      throw new Error(`No se pudo leer el backup SQLite: ${err?.message || 'archivo corrupto o incompatible'}`);
    }
  } else {
    const SQL = await initSqlJs();
    let probe;
    try {
      probe = new SQL.Database(source);
      probe.run('PRAGMA foreign_keys = ON');
      probe.exec('SELECT 1');
      probe.close();
    } catch (err) {
      throw new Error(`No se pudo leer el backup SQLite: ${err?.message || 'archivo corrupto o incompatible'}`);
    }
  }

  if (db && typeof db.close === 'function') {
    try {
      db.close();
    } catch (_) {
      // noop
    }
    db = null;
  }

  const parentDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    writeFileAtomic(DB_PATH, source, { keepPrevious: true });
    const written = fs.statSync(DB_PATH).size;
    if (written !== source.length) {
      throw new Error(`El backup no se guardó completo en disco (${written} de ${source.length} bytes)`);
    }
    removeWalSidecars(DB_PATH);
  } catch (err) {
    throw new Error(
      `No se pudo guardar en ${DB_PATH}: ${err?.message || err}. En Render monte un disco en /data y use DB_PATH=/data/restaurant.db`,
    );
  }

  try {
    if (BetterSqlite) {
      db = reopenNative(BetterSqlite, DB_PATH);
    } else {
      const SQL = await initSqlJs();
      const diskBuffer = fs.readFileSync(DB_PATH);
      if (diskBuffer.length !== source.length) {
        throw new Error(`Lectura incompleta tras guardar (${diskBuffer.length} de ${source.length} bytes)`);
      }
      db = new SQL.Database(diskBuffer);
      db.run('PRAGMA foreign_keys = ON');
    }
  } catch (err) {
    throw new Error(`Backup guardado en disco pero no se pudo abrir: ${err?.message || err}`);
  }

  migrateRestoredDatabase();

  const restaurant = queryOne('SELECT name FROM restaurants LIMIT 1');
  const usersCount = countTableRows('users');
  const productsCount = countTableRows('products');
  allowEmptyPersist = false;
  if (usersCount > 0 || productsCount > 0) {
    writeDbGuard({
      users: usersCount,
      products: productsCount,
      bytes: source.length,
      restaurant_name: restaurant?.name || '',
    });
    try {
      createSafetyBackup({ force: true });
    } catch (backupErr) {
      console.warn('[sqlite-backup] copia tras restaurar:', backupErr.message || backupErr);
    }
  }
  console.info('[backup] Restaurado:', restaurant?.name || '(sin nombre)', '→', DB_PATH, `(${source.length} bytes)`);
}

function resetOperationalData({ keepAdminUserId = '', preserveContrato = false } = {}) {
  const keepId = String(keepAdminUserId || '').trim();
  withTransaction((tx) => {
    tx.run('PRAGMA foreign_keys = OFF');

    const clearTable = (tableName) => {
      try {
        tx.run(`DELETE FROM ${tableName}`);
      } catch (_) {
        /* tabla opcional en instalaciones antiguas */
      }
    };

    const tablesToClear = [
      /* RRHH (orden hijo → padre) */
      'hr_attendance_adjustments',
      'hr_attendance',
      'hr_leave_requests',
      'hr_qr_credentials',
      'hr_employees',
      'hr_schedules',
      /* jornadas / actividad */
      'user_work_activity_events',
      'user_work_sessions',
      /* fidelización */
      'loyalty_surveys',
      /* operaciones / ventas */
      'delivery_assignments',
      'order_product_removals',
      'order_station_state',
      'order_items',
      'orders',
      'table_unions',
      'cash_movements',
      'cash_notes',
      'cash_registers',
      'inventory_logs',
      'inventory_requirement_items',
      'inventory_requirements',
      'inventory_reconciliation_items',
      'inventory_reconciliations',
      'inventory_expenses',
      'inventory_warehouse_stocks',
      'purchase_order_items',
      'purchase_orders',
      'suppliers',
      'customer_credits',
      'credit_payments',
      'electronic_documents',
      'reservations',
      'audit_logs',
      'app_settings_history',
      'promotion_usages',
      'promotions',
      'discounts_catalog',
      'offers_catalog',
      'combo_items',
      'combos',
      'modifier_options',
      'modifiers',
      'product_variants',
      'products',
      'categories',
      'customers',
      'tables',
      'user_permissions',
      'warehouse_locations',
      'staff_internal_messages',
      'kardex',
      'receta_detalle',
      'recetas',
      'inventario_fisico_detalle',
      'inventario_fisico',
      'insumos',
      'investment_movements',
      'finance_loss_events',
      'operational_delay_events',
    ];

    tablesToClear.forEach((tableName) => clearTable(tableName));

    if (!preserveContrato) {
      clearTable('contract_signature');
      clearTable('contract_signature_request');
    }

    try {
      tx.run(
        `UPDATE internal_chat_state SET cycle_id = 1, all_staff_offline_at = NULL, cycle_started_at = datetime('now') WHERE id = 1`
      );
    } catch (_) {
      /* tabla puede no existir en backups antiguos */
    }

    if (keepId) {
      tx.run('DELETE FROM users WHERE id != ?', [keepId]);
      tx.run("UPDATE users SET role = 'admin', is_active = 1, is_buyer_admin = 1 WHERE id = ?", [keepId]);
    } else {
      tx.run('DELETE FROM users');
    }

    const restaurant = tx.queryOne('SELECT id FROM restaurants LIMIT 1');
    if (restaurant?.id) {
      tx.run(
        `UPDATE restaurants
         SET name = 'Resto Fadey App',
             address = '',
             phone = '',
             email = '',
             logo = '',
             tax_rate = 18,
             currency = 'PEN',
             currency_symbol = 'S/',
             delivery_enabled = 0,
             delivery_fee = 5,
             delivery_min_order = 20,
             delivery_radius_km = 10,
             company_ruc = '',
             legal_name = '',
             billing_enabled = 1,
             billing_provider = 'restaurant_efact',
             billing_api_url = '',
             billing_api_token = '',
             billing_series_boleta = '',
             billing_series_factura = '',
             billing_offline_mode = 1,
             billing_auto_retry_enabled = 1,
             billing_auto_retry_interval_sec = 120,
             billing_nombre_comercial = '',
             billing_emisor_ubigeo = '',
             billing_emisor_direccion = '',
             billing_emisor_provincia = '',
             billing_emisor_departamento = '',
             billing_emisor_distrito = '',
             schedule = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        [JSON.stringify(getDefaultSchedule()), restaurant.id]
      );
    } else {
      tx.run(
        'INSERT INTO restaurants (id, name, schedule) VALUES (?, ?, ?)',
        [uuidv4(), 'Resto Fadey App', JSON.stringify(getDefaultSchedule())]
      );
    }

    let preservedContratoValue = null;
    if (preserveContrato) {
      try {
        const contratoRow = tx.queryOne('SELECT value FROM app_settings WHERE key = ?', ['contrato']);
        if (contratoRow && contratoRow.value != null) preservedContratoValue = contratoRow.value;
      } catch (_) {
        /* backup antiguo sin fila contrato */
      }
    }

    tx.run('DELETE FROM app_settings');
    const defaultSettings = {
      regional: { country: 'Peru', timezone: 'America/Lima', language: 'es', date_format: 'DD/MM/YYYY' },
      series_contingencia: { boleta: 'BC01', factura: 'FC01', enabled: 1 },
      contrato: {
        texto_contrato: '',
        documento_word_url: '',
        documento_word_nombre: '',
        firma_comprador_url: '',
        firma_vendedor_url: '',
      },
      pagos_sistema: {
        acepta_efectivo: 1,
        acepta_tarjeta: 1,
        acepta_yape: 1,
        acepta_plin: 1,
        requiere_referencia_digital: 0,
        propina_sugerida_pct: 10,
        tolerancia_diferencia_caja: 2,
        dias_max_credito: 15,
        monto_max_credito: 500,
        notificar_mora: 1,
        texto_politica_cobro: 'Todo crédito debe regularizarse dentro del plazo acordado.',
      },
      pago_uso_sistema: {
        periodo_facturacion: 'mensual',
        fecha_proxima_facturacion: '',
        numero_cuenta: '',
        numero_telefono: '',
        nombre_empresa_cobro: '',
        precio_plan: '',
        comprobante_pago_url: '',
        comprobante_grace_days_after_due: 3,
        comprobante_alert_sent_for: '',
      },
      settings: {
        regional: { country: 'Peru', timezone: 'America/Lima', language: 'es', date_format: 'DD/MM/YYYY' },
        locales: [{ name: 'Principal', address: '', phone: '', active: 1 }],
        almacenes: [{ name: 'Almacén Principal', description: 'Almacén general de insumos', active: 1 }],
        cajas: [{
          id: 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001',
          name: 'Caja Principal',
          description: 'Caja #1 - Recepción',
          active: 1,
        }],
        comprobantes: [
          { name: 'Boleta de Venta', series: 'B001', active: 1 },
          { name: 'Factura', series: 'F001', active: 1 },
          { name: 'Nota de Venta', series: 'N001', active: 1 },
        ],
        impresoras: [
          { name: 'Impresora Cocina', area: 'Comandas', width_mm: 80, copies: 1, active: 1 },
          { name: 'Impresora Bar', area: 'Comandas Bar', width_mm: 80, copies: 1, active: 1 },
          { name: 'Impresora Caja', area: 'Comprobantes', width_mm: 80, copies: 1, active: 1 },
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
      },
      master_admin_control: {
        contract_title: 'Contrato de venta',
        contract_notes: '',
        billing_date: '',
        notify_days_before: 5,
        auto_block_on_overdue: 1,
        global_lock_enabled: 0,
        global_lock_reason: 'Bloqueo por falta de pago',
        lock_enabled_by: '',
        lock_enabled_at: '',
        billing_alert_sent_for: '',
      },
      master_admin_notifications: [],
    };
    Object.entries(defaultSettings).forEach(([key, value]) => {
      tx.run(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [key, JSON.stringify(value)]
      );
    });

    if (preserveContrato && preservedContratoValue != null) {
      tx.run(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('contrato', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [preservedContratoValue]
      );
    }

    tx.run('DELETE FROM order_sequence');
    tx.run('INSERT INTO order_sequence (id, current_number) VALUES (1, 0)');

    try {
      tx.run('DELETE FROM sale_sequence');
      tx.run('INSERT INTO sale_sequence (id, current_number) VALUES (1, 0)');
    } catch (_) {
      /* sale_sequence puede no existir aún */
    }

    const activeRestaurant = tx.queryOne('SELECT id FROM restaurants LIMIT 1');
    if (activeRestaurant?.id) {
      for (let i = 1; i <= 5; i += 1) {
        tx.run(
          'INSERT INTO tables (id, number, name, capacity, zone, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
          [uuidv4(), i, `Mesa ${i}`, 4, 'principal', activeRestaurant.id]
        );
      }
    }

    tx.run('PRAGMA foreign_keys = ON');
  });
}

async function initDatabase() {
  if (dbReady) return dbReady;

  dbReady = (async () => {
    let previousBytes = 0;
    dbFileExistedBeforeInit = fs.existsSync(DB_PATH);
    if (dbFileExistedBeforeInit) {
      try {
        previousBytes = fs.statSync(DB_PATH).size;
      } catch {
        previousBytes = 0;
      }
    }

    const BetterSqlite = loadBetterSqlite3();
    if (BetterSqlite) {
      const opened = await openNativeWithRecover(BetterSqlite, DB_PATH, {
        minUsers: Number(readDbGuard()?.users || 0),
      });
      db = opened.db;
      if (opened.emptyBoot) {
        enableEmptyBoot(opened.reason || 'arranque nativo vacío.');
      }
      if (opened.recovered && fs.existsSync(DB_PATH)) {
        previousBytes = fs.statSync(DB_PATH).size;
        dbFileExistedBeforeInit = true;
      }
    } else {
      const SQL = await initSqlJs();
      if (dbFileExistedBeforeInit) {
        let fileBuffer = Buffer.alloc(0);
        try {
          fileBuffer = fs.readFileSync(DB_PATH);
        } catch (readErr) {
          console.error('[sqlite] no se pudo leer el archivo; arranque vacío:', readErr?.message || readErr);
          db = new SQL.Database();
          enableEmptyBoot('no se pudo leer el archivo.');
        }
        if (!db) {
          if (fileBuffer.length < 512) {
            console.warn(
              `[sqlite] ${DB_PATH} está vacío o truncado (${fileBuffer.length} bytes); se buscará copia en el disco.`,
            );
          }
          try {
            const opened = openOrRecoverSqliteFile(SQL, DB_PATH, fileBuffer, {
              minUsers: Number(readDbGuard()?.users || 0),
            });
            if (opened.error) {
              console.error('[sqlite] no se pudo recuperar la base:', opened.error.message || opened.error);
              db = new SQL.Database();
              enableEmptyBoot('no hay copia usable.');
            } else {
              db = opened.db;
              if (opened.recovered) {
                previousBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : previousBytes;
              }
              try {
                const u = Number(queryOne('SELECT COUNT(*) as c FROM users')?.c) || 0;
                const p = Number(queryOne('SELECT COUNT(*) as c FROM products')?.c) || 0;
                if (u === 0 && p === 0) {
                  try { db.close(); } catch { /* ignore */ }
                  db = new SQL.Database();
                  enableEmptyBoot('copia sin usuarios/productos.');
                }
              } catch {
                try { db.close(); } catch { /* ignore */ }
                db = new SQL.Database();
                enableEmptyBoot('esquema ilegible.');
              }
            }
          } catch (err) {
            console.error('[sqlite] error abriendo la base; arranque vacío:', err?.message || err);
            db = new SQL.Database();
            enableEmptyBoot('error al abrir el archivo.');
          }
        }
      } else {
        try {
          const guard = readDbGuard();
          if (guard && Number(guard.users || 0) > 0) {
            console.warn(`[sqlite] Falta ${DB_PATH}; se buscará copia (marcador: ${guard.users} usuario(s)).`);
            const opened = openOrRecoverSqliteFile(SQL, DB_PATH, Buffer.alloc(0), {
              minUsers: Number(guard.users || 0),
            });
            if (opened.error) {
              db = new SQL.Database();
              enableEmptyBoot('no hay copia usable.');
            } else {
              db = opened.db;
              previousBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
              dbFileExistedBeforeInit = true;
            }
          } else {
            db = new SQL.Database();
          }
        } catch (missingErr) {
          console.error('[sqlite] error buscando copia; arranque vacío:', missingErr?.message || missingErr);
          db = new SQL.Database();
          enableEmptyBoot('error buscando copia.');
        }
      }

      if (!db) {
        db = new SQL.Database();
        enableEmptyBoot('sin instancia sql.js.');
      }
    }

    if (!db) {
      throw new Error('No se pudo inicializar SQLite');
    }

    db.run('PRAGMA foreign_keys = ON');

    db.run(`
      CREATE TABLE IF NOT EXISTS restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Resto Fadey App',
        address TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        email TEXT DEFAULT '',
        logo TEXT DEFAULT '',
        tax_rate REAL DEFAULT 18.0,
        currency TEXT DEFAULT 'PEN',
        currency_symbol TEXT DEFAULT 'S/',
        delivery_enabled INTEGER DEFAULT 0,
        delivery_fee REAL DEFAULT 5.00,
        delivery_min_order REAL DEFAULT 20.00,
        delivery_radius_km REAL DEFAULT 10.0,
        company_ruc TEXT DEFAULT '',
        legal_name TEXT DEFAULT '',
        billing_enabled INTEGER DEFAULT 1,
        billing_provider TEXT DEFAULT 'restaurant_efact',
        billing_api_url TEXT DEFAULT '',
        billing_api_token TEXT DEFAULT '',
        billing_series_boleta TEXT DEFAULT '',
        billing_series_factura TEXT DEFAULT '',
        billing_offline_mode INTEGER DEFAULT 1,
        billing_auto_retry_enabled INTEGER DEFAULT 1,
        billing_auto_retry_interval_sec INTEGER DEFAULT 120,
        billing_nombre_comercial TEXT DEFAULT '',
        billing_emisor_ubigeo TEXT DEFAULT '',
        billing_emisor_direccion TEXT DEFAULT '',
        billing_emisor_provincia TEXT DEFAULT '',
        billing_emisor_departamento TEXT DEFAULT '',
        billing_emisor_distrito TEXT DEFAULT '',
        schedule TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','cajero','mozo','cocina','bar','delivery','produccion')),
        restaurant_id TEXT,
        is_active INTEGER DEFAULT 1,
        phone TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        caja_station_id TEXT DEFAULT '',
        production_area_id TEXT DEFAULT '',
        production_area_ids TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS user_work_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_token_id TEXT UNIQUE,
        username TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL,
        login_at TEXT DEFAULT (datetime('now')),
        logout_at TEXT,
        worked_minutes INTEGER DEFAULT 0,
        close_reason TEXT DEFAULT '',
        photo_login TEXT,
        photo_logout TEXT,
        attendance_status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS internal_chat_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cycle_id INTEGER NOT NULL DEFAULT 1,
        cycle_started_at TEXT DEFAULT (datetime('now')),
        all_staff_offline_at TEXT
      )
    `);
    db.run(`INSERT OR IGNORE INTO internal_chat_state (id, cycle_id, cycle_started_at) VALUES (1, 1, datetime('now'))`);

    db.run(`
      CREATE TABLE IF NOT EXISTS staff_internal_messages (
        id TEXT PRIMARY KEY,
        cycle_id INTEGER NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_staff_chat_cycle ON staff_internal_messages(cycle_id, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_staff_chat_pair ON staff_internal_messages(cycle_id, sender_id, recipient_id)');

    db.run(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        doc_type TEXT DEFAULT '1',
        doc_number TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS loyalty_surveys (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        comment TEXT DEFAULT '',
        rating INTEGER NOT NULL,
        answers_json TEXT DEFAULT '{}',
        waiter_user_id TEXT DEFAULT '',
        waiter_name TEXT DEFAULT '',
        visit_date TEXT DEFAULT '',
        visit_area TEXT DEFAULT '',
        party_size INTEGER DEFAULT 0,
        liked_json TEXT DEFAULT '[]',
        improve_json TEXT DEFAULT '[]',
        liked_other TEXT DEFAULT '',
        improve_other TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_loyalty_surveys_created_at ON loyalty_surveys(created_at)');
    /** Índice waiter solo tras ensureLoyaltySurveysTable (ALTER en DBs antiguas). */
    db.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        image TEXT DEFAULT '',
        restaurant_id TEXT,
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL NOT NULL,
        image TEXT DEFAULT '',
        category_id TEXT,
        restaurant_id TEXT,
        stock INTEGER DEFAULT 100,
        note_required INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS product_variants (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        price_modifier REAL DEFAULT 0,
        is_active INTEGER DEFAULT 1
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_number INTEGER,
        customer_id TEXT,
        customer_name TEXT DEFAULT '',
        restaurant_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('dine_in','delivery','pickup')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','ready','delivered','cancelled')),
        subtotal REAL DEFAULT 0,
        tax REAL DEFAULT 0,
        discount REAL DEFAULT 0,
        delivery_fee REAL DEFAULT 0,
        total REAL DEFAULT 0,
        payment_method TEXT DEFAULT 'efectivo' CHECK(payment_method IN ('efectivo','yape','plin','tarjeta','online','cuenta_cliente','cortesia')),
        payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','refunded')),
        table_number TEXT DEFAULT '',
        delivery_address TEXT DEFAULT '',
        delivery_lat REAL,
        delivery_lng REAL,
        notes TEXT DEFAULT '',
        sale_document_type TEXT DEFAULT 'nota_venta' CHECK(sale_document_type IN ('nota_venta','boleta','factura')),
        sale_document_number TEXT DEFAULT '',
        created_by_user_id TEXT DEFAULT '',
        created_by_user_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT NOT NULL,
        variant_name TEXT DEFAULT '',
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL,
        subtotal REAL NOT NULL,
        notes TEXT DEFAULT ''
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS delivery_assignments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        status TEXT DEFAULT 'assigned' CHECK(status IN ('assigned','picking_up','on_the_way','delivered')),
        assigned_at TEXT DEFAULT (datetime('now')),
        picked_up_at TEXT,
        delivered_at TEXT,
        rating INTEGER,
        notes TEXT DEFAULT ''
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS cash_registers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        restaurant_id TEXT,
        opened_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT,
        opening_amount REAL DEFAULT 0,
        closing_amount REAL,
        total_sales REAL DEFAULT 0,
        total_cash REAL DEFAULT 0,
        total_yape REAL DEFAULT 0,
        total_plin REAL DEFAULT 0,
        total_card REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        arqueo_data TEXT DEFAULT '{}',
        caja_station_id TEXT DEFAULT ''
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id TEXT PRIMARY KEY,
        register_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('income','expense')),
        amount REAL NOT NULL,
        concept TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS cash_notes (
        id TEXT PRIMARY KEY,
        register_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        note_type TEXT NOT NULL CHECK(note_type IN ('credit','debit')),
        amount REAL NOT NULL,
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS inventory_logs (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        quantity_change INTEGER NOT NULL,
        previous_stock INTEGER,
        new_stock INTEGER,
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS warehouse_locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        is_active INTEGER DEFAULT 1,
        linked_insumos INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    try {
      const wlCols = queryAll('PRAGMA table_info(warehouse_locations)');
      if (!wlCols.some((c) => c.name === 'linked_insumos')) {
        db.run('ALTER TABLE warehouse_locations ADD COLUMN linked_insumos INTEGER NOT NULL DEFAULT 0');
        db.run(`UPDATE warehouse_locations SET linked_insumos = 1 WHERE LOWER(name) LIKE '%insumo%'`);
      }
    } catch (_) {
      /* noop */
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS inventory_warehouse_stocks (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        warehouse_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(product_id, warehouse_id)
      )
    `);

    /* Kardex / insumos / recetas (módulo logística valorizado) */
    db.run(`
      CREATE TABLE IF NOT EXISTS insumos (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        unidad_medida TEXT NOT NULL DEFAULT 'unidad',
        stock_actual REAL NOT NULL DEFAULT 0,
        stock_unidades REAL NOT NULL DEFAULT 0,
        minimo_unidades REAL NOT NULL DEFAULT 0,
        kg_por_unidad REAL NOT NULL DEFAULT 0,
        stock_minimo REAL NOT NULL DEFAULT 0,
        costo_promedio REAL NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1,
        insumo_area TEXT NOT NULL DEFAULT 'cocina',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS kardex (
        id TEXT PRIMARY KEY,
        id_insumo TEXT NOT NULL,
        tipo_movimiento TEXT NOT NULL CHECK(tipo_movimiento IN ('entrada','salida','ajuste')),
        cantidad REAL NOT NULL,
        costo_unitario REAL NOT NULL DEFAULT 0,
        costo_total REAL NOT NULL DEFAULT 0,
        stock_anterior REAL NOT NULL DEFAULT 0,
        stock_resultante REAL NOT NULL DEFAULT 0,
        metodo_valorizacion TEXT NOT NULL DEFAULT 'promedio',
        referencia TEXT NOT NULL,
        referencia_id TEXT DEFAULT '',
        fecha TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT,
        FOREIGN KEY (id_insumo) REFERENCES insumos(id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS recetas (
        id TEXT PRIMARY KEY,
        nombre_plato TEXT NOT NULL,
        product_id TEXT,
        activo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS receta_detalle (
        id TEXT PRIMARY KEY,
        receta_id TEXT NOT NULL,
        insumo_id TEXT NOT NULL,
        cantidad_usada REAL NOT NULL,
        FOREIGN KEY (receta_id) REFERENCES recetas(id) ON DELETE CASCADE,
        FOREIGN KEY (insumo_id) REFERENCES insumos(id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS inventario_fisico (
        id TEXT PRIMARY KEY,
        fecha TEXT DEFAULT (datetime('now')),
        estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','cerrado')),
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS inventario_fisico_detalle (
        id TEXT PRIMARY KEY,
        inventario_id TEXT NOT NULL,
        insumo_id TEXT NOT NULL,
        stock_sistema REAL NOT NULL,
        stock_real REAL NOT NULL,
        diferencia REAL NOT NULL,
        FOREIGN KEY (inventario_id) REFERENCES inventario_fisico(id) ON DELETE CASCADE,
        FOREIGN KEY (insumo_id) REFERENCES insumos(id)
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_kardex_insumo_fecha ON kardex(id_insumo, fecha)');
    db.run('CREATE INDEX IF NOT EXISTS idx_kardex_referencia ON kardex(referencia, referencia_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recetas_product_id ON recetas(product_id)');

    db.run(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        contact_name TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        email TEXT DEFAULT '',
        address TEXT DEFAULT '',
        restaurant_id TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id TEXT PRIMARY KEY,
        supplier_id TEXT,
        restaurant_id TEXT,
        total REAL DEFAULT 0,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','received','cancelled')),
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id TEXT PRIMARY KEY,
        purchase_order_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_cost REAL NOT NULL,
        subtotal REAL NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        name TEXT DEFAULT '',
        capacity INTEGER DEFAULT 4,
        status TEXT DEFAULT 'available' CHECK(status IN ('available','occupied','reserved','maintenance')),
        current_order_id TEXT,
        restaurant_id TEXT,
        zone TEXT DEFAULT 'principal',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        permissions TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_key TEXT UNIQUE NOT NULL,
        executed_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT DEFAULT '',
        actor_name TEXT DEFAULT '',
        action TEXT NOT NULL,
        resource_type TEXT DEFAULT '',
        resource_id TEXT DEFAULT '',
        details TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS order_sequence (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        current_number INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS electronic_documents (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        order_number INTEGER,
        doc_type TEXT NOT NULL CHECK(doc_type IN ('boleta','factura','nota_venta')),
        series TEXT NOT NULL,
        correlative INTEGER NOT NULL,
        full_number TEXT NOT NULL,
        customer_doc_type TEXT DEFAULT '',
        customer_doc_number TEXT DEFAULT '',
        customer_name TEXT DEFAULT '',
        customer_address TEXT DEFAULT '',
        customer_phone TEXT DEFAULT '',
        subtotal REAL DEFAULT 0,
        tax REAL DEFAULT 0,
        total REAL DEFAULT 0,
        currency TEXT DEFAULT 'PEN',
        payment_method TEXT DEFAULT '',
        provider TEXT DEFAULT 'nubefact',
        provider_status TEXT DEFAULT 'pending',
        provider_message TEXT DEFAULT '',
        hash_code TEXT DEFAULT '',
        sunat_description TEXT DEFAULT '',
        xml_url TEXT DEFAULT '',
        cdr_url TEXT DEFAULT '',
        pdf_url TEXT DEFAULT '',
        provider_payload TEXT DEFAULT '{}',
        provider_response TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        phone TEXT DEFAULT '',
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        guests INTEGER DEFAULT 2,
        table_id TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending','cancelled','completed')),
        created_by_user_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS customer_credits (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        phone TEXT DEFAULT '',
        total REAL DEFAULT 0,
        paid REAL DEFAULT 0,
        items TEXT DEFAULT '',
        status TEXT DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
        created_by_user_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS credit_payments (
        id TEXT PRIMARY KEY,
        credit_id TEXT NOT NULL,
        amount REAL DEFAULT 0,
        created_by_user_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS discounts_catalog (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('percentage','fixed')),
        value REAL DEFAULT 0,
        applies_to TEXT DEFAULT 'all' CHECK(applies_to IN ('all','total')),
        conditions TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS offers_catalog (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT DEFAULT 'promo' CHECK(type IN ('promo','combo')),
        discount REAL DEFAULT 0,
        start_date TEXT DEFAULT '',
        end_date TEXT DEFAULT '',
        products TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'percent',
        value REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        start_date TEXT DEFAULT '',
        end_date TEXT DEFAULT '',
        no_end_date INTEGER DEFAULT 0,
        days TEXT DEFAULT '[]',
        start_time TEXT DEFAULT '',
        end_time TEXT DEFAULT '',
        product_ids TEXT DEFAULT '[]',
        category_ids TEXT DEFAULT '[]',
        min_quantity INTEGER DEFAULT 0,
        min_purchase REAL DEFAULT 0,
        usage_limit INTEGER DEFAULT 0,
        per_customer_limit INTEGER DEFAULT 0,
        combinable INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        legacy_source TEXT DEFAULT '',
        legacy_id TEXT DEFAULT '',
        created_by_user_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS promotion_usages (
        id TEXT PRIMARY KEY,
        promotion_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        order_item_id TEXT DEFAULT '',
        product_id TEXT DEFAULT '',
        product_name TEXT DEFAULT '',
        quantity INTEGER DEFAULT 0,
        original_amount REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        final_amount REAL DEFAULT 0,
        source TEXT DEFAULT '',
        user_id TEXT DEFAULT '',
        user_name TEXT DEFAULT '',
        customer_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_usages_promo ON promotion_usages(promotion_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_usages_order ON promotion_usages(order_id)');

    db.run(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS combo_items (
        id TEXT PRIMARY KEY,
        combo_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity REAL DEFAULT 1
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS modifiers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        required INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS modifier_options (
        id TEXT PRIMARY KEY,
        modifier_id TEXT NOT NULL,
        option_name TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS app_settings_history (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT DEFAULT '',
        actor_name TEXT DEFAULT '',
        changed_keys TEXT DEFAULT '[]',
        before_state TEXT DEFAULT '{}',
        after_state TEXT DEFAULT '{}',
        details TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Migration: ensure arqueo_data exists in older databases
    const cashColumns = queryAll('PRAGMA table_info(cash_registers)');
    if (!cashColumns.some(col => col.name === 'arqueo_data')) {
      db.run("ALTER TABLE cash_registers ADD COLUMN arqueo_data TEXT DEFAULT '{}'");
    }
    if (!cashColumns.some(col => col.name === 'caja_station_id')) {
      db.run("ALTER TABLE cash_registers ADD COLUMN caja_station_id TEXT DEFAULT ''");
    }
    if (!cashColumns.some(col => col.name === 'business_date')) {
      db.run("ALTER TABLE cash_registers ADD COLUMN business_date TEXT DEFAULT ''");
    }
    try {
      const { backfillCashRegisterBusinessDates } = require('./utils/registerBusinessDate');
      backfillCashRegisterBusinessDates(queryOne, (sql, params = []) => {
        if (params.length) db.run(sql, params);
        else db.run(sql);
      });
    } catch (err) {
      console.warn('[cash_registers] business_date backfill omitido:', err.message || err);
    }
    try {
      db.run(`UPDATE cash_registers SET caja_station_id = (
        SELECT trim(coalesce(u.caja_station_id, '')) FROM users u WHERE u.id = cash_registers.user_id
      ) WHERE trim(coalesce(caja_station_id, '')) = ''`);
    } catch (_) {
      /* backup antiguo */
    }

    const productColumns = queryAll('PRAGMA table_info(products)');
    if (!productColumns.some(col => col.name === 'process_type')) {
      db.run("ALTER TABLE products ADD COLUMN process_type TEXT DEFAULT 'transformed'");
    }
    if (!productColumns.some(col => col.name === 'stock_warehouse_id')) {
      db.run("ALTER TABLE products ADD COLUMN stock_warehouse_id TEXT DEFAULT ''");
    }
    if (!productColumns.some(col => col.name === 'production_area')) {
      db.run("ALTER TABLE products ADD COLUMN production_area TEXT DEFAULT 'cocina'");
    }
    if (!productColumns.some(col => col.name === 'tax_type')) {
      db.run("ALTER TABLE products ADD COLUMN tax_type TEXT DEFAULT 'igv'");
    }
    if (!productColumns.some(col => col.name === 'modifier_id')) {
      db.run("ALTER TABLE products ADD COLUMN modifier_id TEXT DEFAULT ''");
    }
    if (!productColumns.some(col => col.name === 'note_required')) {
      db.run("ALTER TABLE products ADD COLUMN note_required INTEGER DEFAULT 0");
    }
    const addProductColIfMissing = (col, ddl) => {
      const cols = queryAll('PRAGMA table_info(products)');
      if (!cols.some((c) => c.name === col)) db.run(ddl);
    };
    addProductColIfMissing('kardex_insumo_id', "ALTER TABLE products ADD COLUMN kardex_insumo_id TEXT DEFAULT ''");
    addProductColIfMissing('kardex_insumo_num', "ALTER TABLE products ADD COLUMN kardex_insumo_num REAL DEFAULT 1");
    addProductColIfMissing('kardex_insumo_den', "ALTER TABLE products ADD COLUMN kardex_insumo_den REAL DEFAULT 1");
    addProductColIfMissing('kardex_insumo_modo', "ALTER TABLE products ADD COLUMN kardex_insumo_modo TEXT DEFAULT 'unidad'");
    addProductColIfMissing('kardex_insumo_gramos', "ALTER TABLE products ADD COLUMN kardex_insumo_gramos REAL NOT NULL DEFAULT 0");
    addProductColIfMissing('kardex_insumos', "ALTER TABLE products ADD COLUMN kardex_insumos TEXT DEFAULT '[]'");
    addProductColIfMissing('purchase_price', 'ALTER TABLE products ADD COLUMN purchase_price REAL');
    addProductColIfMissing('schedule_enabled', 'ALTER TABLE products ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0');
    addProductColIfMissing('available_from', "ALTER TABLE products ADD COLUMN available_from TEXT DEFAULT ''");
    addProductColIfMissing('available_to', "ALTER TABLE products ADD COLUMN available_to TEXT DEFAULT ''");
    addProductColIfMissing('available_days', "ALTER TABLE products ADD COLUMN available_days TEXT DEFAULT '[]'");
    addProductColIfMissing('schedule_type', "ALTER TABLE products ADD COLUMN schedule_type TEXT DEFAULT 'personalizado'");
    addProductColIfMissing('catalog_listed_at', "ALTER TABLE products ADD COLUMN catalog_listed_at TEXT DEFAULT ''");
    addProductColIfMissing('last_paid_sale_at', "ALTER TABLE products ADD COLUMN last_paid_sale_at TEXT DEFAULT ''");
    addProductColIfMissing('idle_sales_days', 'ALTER TABLE products ADD COLUMN idle_sales_days INTEGER NOT NULL DEFAULT 0');
    addProductColIfMissing('min_stock', 'ALTER TABLE products ADD COLUMN min_stock INTEGER NOT NULL DEFAULT 0');
    addProductColIfMissing('max_stock', 'ALTER TABLE products ADD COLUMN max_stock INTEGER NOT NULL DEFAULT 0');
    addProductColIfMissing('image_source', "ALTER TABLE products ADD COLUMN image_source TEXT DEFAULT ''");
    addProductColIfMissing('hide_in_self_order', 'ALTER TABLE products ADD COLUMN hide_in_self_order INTEGER NOT NULL DEFAULT 0');
    try {
      const { backfillProductSalesTracking } = require('./services/productSalesTrackingService');
      backfillProductSalesTracking();
    } catch (err) {
      console.warn('[product-sales-idle] backfill omitido:', err.message || err);
    }

    const addInsumoColIfMissing = (col, ddl) => {
      const cols = queryAll('PRAGMA table_info(insumos)');
      if (!cols.some((c) => c.name === col)) db.run(ddl);
    };
    addInsumoColIfMissing('stock_unidades', 'ALTER TABLE insumos ADD COLUMN stock_unidades REAL NOT NULL DEFAULT 0');
    addInsumoColIfMissing('minimo_unidades', 'ALTER TABLE insumos ADD COLUMN minimo_unidades REAL NOT NULL DEFAULT 0');
    addInsumoColIfMissing('kg_por_unidad', 'ALTER TABLE insumos ADD COLUMN kg_por_unidad REAL NOT NULL DEFAULT 0');
    addInsumoColIfMissing('stock_minimo', 'ALTER TABLE insumos ADD COLUMN stock_minimo REAL NOT NULL DEFAULT 0');
    addInsumoColIfMissing('insumo_area', "ALTER TABLE insumos ADD COLUMN insumo_area TEXT NOT NULL DEFAULT 'cocina'");
    addInsumoColIfMissing('insumo_clase', "ALTER TABLE insumos ADD COLUMN insumo_clase TEXT NOT NULL DEFAULT 'directo'");
    addInsumoColIfMissing('tipo', "ALTER TABLE insumos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'insumo'");
    addInsumoColIfMissing('stock_maximo', 'ALTER TABLE insumos ADD COLUMN stock_maximo REAL NOT NULL DEFAULT 0');
    try {
      db.run(
        "UPDATE insumos SET tipo = 'insumo' WHERE tipo IS NULL OR TRIM(tipo) NOT IN ('insumo','transformable')"
      );
      db.run(
        "UPDATE insumos SET insumo_clase = 'directo' WHERE insumo_clase IS NULL OR TRIM(insumo_clase) NOT IN ('directo','doble')"
      );
    } catch (_) {
      /* tabla ausente */
    }
    const addRecetaColIfMissing = (col, ddl) => {
      const cols = queryAll('PRAGMA table_info(recetas)');
      if (!cols.some((c) => c.name === col)) db.run(ddl);
    };
    addRecetaColIfMissing('insumo_resultado_id', "ALTER TABLE recetas ADD COLUMN insumo_resultado_id TEXT DEFAULT ''");
    addRecetaColIfMissing('rendimiento', 'ALTER TABLE recetas ADD COLUMN rendimiento REAL NOT NULL DEFAULT 0');
    const addKardexColIfMissing = (col, ddl) => {
      const cols = queryAll('PRAGMA table_info(kardex)');
      if (!cols.some((c) => c.name === col)) db.run(ddl);
    };
    addKardexColIfMissing('motivo', "ALTER TABLE kardex ADD COLUMN motivo TEXT DEFAULT ''");
    addKardexColIfMissing('receta_id', "ALTER TABLE kardex ADD COLUMN receta_id TEXT DEFAULT ''");
    addKardexColIfMissing('almacen_id', "ALTER TABLE kardex ADD COLUMN almacen_id TEXT DEFAULT ''");
    addKardexColIfMissing('unidad_original', "ALTER TABLE kardex ADD COLUMN unidad_original TEXT DEFAULT ''");
    addKardexColIfMissing('cantidad_original', 'ALTER TABLE kardex ADD COLUMN cantidad_original REAL');
    addKardexColIfMissing('ip', "ALTER TABLE kardex ADD COLUMN ip TEXT DEFAULT ''");
    db.run(`
      CREATE TABLE IF NOT EXISTS transformaciones (
        id TEXT PRIMARY KEY,
        receta_id TEXT NOT NULL,
        insumo_resultado_id TEXT NOT NULL,
        lotes REAL NOT NULL,
        cantidad_producida REAL NOT NULL,
        costo_unitario REAL NOT NULL DEFAULT 0,
        costo_total REAL NOT NULL DEFAULT 0,
        motivo TEXT DEFAULT '',
        estado TEXT NOT NULL DEFAULT 'confirmada',
        anulacion_id TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_transformaciones_resultado ON transformaciones(insumo_resultado_id, created_at)');
    try {
      db.run(
        "UPDATE insumos SET insumo_area = 'cocina' WHERE insumo_area IS NULL OR TRIM(insumo_area) NOT IN ('cocina','bar')"
      );
    } catch (_) {
      /* tabla ausente */
    }
    db.run('CREATE INDEX IF NOT EXISTS idx_insumos_area_activo ON insumos(insumo_area, activo)');
    /* Evitar códigos tipo "kg5" en U.M. (solo letras) */
    try {
      const insM = queryAll('SELECT id, unidad_medida FROM insumos');
      for (const row of insM) {
        const u = String(row.unidad_medida || '')
          .replace(/[0-9]/g, '')
          .trim();
        if (u && u !== row.unidad_medida) {
          db.run('UPDATE insumos SET unidad_medida = ? WHERE id = ?', [u, row.id]);
        } else if (!u && String(row.unidad_medida || '').length) {
          db.run("UPDATE insumos SET unidad_medida = 'kg' WHERE id = ?", [row.id]);
        }
      }
    } catch (_) {
      /* tabla insumos ausente aún */
    }
    try {
      db.run(
        `UPDATE insumos
         SET stock_unidades = stock_actual
         WHERE LOWER(REPLACE(TRIM(COALESCE(unidad_medida,'')), ' ', '')) IN ('unidad', 'u', 'und', 'unidades')
           AND COALESCE(stock_unidades, 0) < 0.0000001
           AND COALESCE(stock_actual, 0) > 0.0000001`
      );
    } catch (_) {
      /* insumos aún no listos */
    }

    const orderColumns = queryAll('PRAGMA table_info(orders)');
    if (!orderColumns.some(col => col.name === 'sale_document_type')) {
      db.run("ALTER TABLE orders ADD COLUMN sale_document_type TEXT DEFAULT 'nota_venta'");
    }
    if (!orderColumns.some(col => col.name === 'sale_document_number')) {
      db.run("ALTER TABLE orders ADD COLUMN sale_document_number TEXT DEFAULT ''");
    }
    if (!orderColumns.some(col => col.name === 'created_by_user_id')) {
      db.run("ALTER TABLE orders ADD COLUMN created_by_user_id TEXT DEFAULT ''");
    }
    if (!orderColumns.some(col => col.name === 'created_by_user_name')) {
      db.run("ALTER TABLE orders ADD COLUMN created_by_user_name TEXT DEFAULT ''");
    }
    const addOrderColIfMissing = (colName, ddl) => {
      const cols = queryAll('PRAGMA table_info(orders)');
      if (!cols.some((col) => col.name === colName)) db.run(ddl);
    };
    addOrderColIfMissing('delivery_driver_started_at', 'ALTER TABLE orders ADD COLUMN delivery_driver_started_at TEXT');
    addOrderColIfMissing('delivery_driver_completed_at', 'ALTER TABLE orders ADD COLUMN delivery_driver_completed_at TEXT');
    addOrderColIfMissing('delivery_route_driver_id', "ALTER TABLE orders ADD COLUMN delivery_route_driver_id TEXT DEFAULT ''");
    addOrderColIfMissing(
      'delivery_payment_modality',
      "ALTER TABLE orders ADD COLUMN delivery_payment_modality TEXT DEFAULT ''"
    );
    addOrderColIfMissing(
      'cancellation_reason',
      "ALTER TABLE orders ADD COLUMN cancellation_reason TEXT DEFAULT ''"
    );
    addOrderColIfMissing('payment_breakdown', "ALTER TABLE orders ADD COLUMN payment_breakdown TEXT DEFAULT NULL");
    addOrderColIfMissing('tip_amount', 'ALTER TABLE orders ADD COLUMN tip_amount REAL NOT NULL DEFAULT 0');
    addOrderColIfMissing('payment_note', "ALTER TABLE orders ADD COLUMN payment_note TEXT DEFAULT ''");
    addOrderColIfMissing('kitchen_release_at', 'ALTER TABLE orders ADD COLUMN kitchen_release_at TEXT');
    addOrderColIfMissing('preparing_at', 'ALTER TABLE orders ADD COLUMN preparing_at TEXT');
    addOrderColIfMissing('station_cocina_ready_at', 'ALTER TABLE orders ADD COLUMN station_cocina_ready_at TEXT');
    addOrderColIfMissing('station_bar_ready_at', 'ALTER TABLE orders ADD COLUMN station_bar_ready_at TEXT');
    addOrderColIfMissing('station_cocina_preparing_at', 'ALTER TABLE orders ADD COLUMN station_cocina_preparing_at TEXT');
    addOrderColIfMissing('station_bar_preparing_at', 'ALTER TABLE orders ADD COLUMN station_bar_preparing_at TEXT');
    addOrderColIfMissing('kitchen_last_send_at', 'ALTER TABLE orders ADD COLUMN kitchen_last_send_at TEXT');
    addOrderColIfMissing('table_id', "ALTER TABLE orders ADD COLUMN table_id TEXT DEFAULT ''");
    addOrderColIfMissing('sale_number', 'ALTER TABLE orders ADD COLUMN sale_number INTEGER');
    try {
      db.run(`
        UPDATE orders
        SET table_id = (
          SELECT t.id FROM tables t
          WHERE TRIM(CAST(t.number AS TEXT)) = TRIM(CAST(orders.table_number AS TEXT))
          LIMIT 1
        )
        WHERE type = 'dine_in'
          AND IFNULL(TRIM(table_id), '') = ''
          AND IFNULL(TRIM(table_number), '') != ''
      `);
    } catch (_) {
      /* backfill table_id histórico */
    }
    try {
      db.run(`
        UPDATE orders SET status = 'preparing',
          preparing_at = COALESCE(preparing_at, datetime('now'))
        WHERE status = 'ready'
          AND IFNULL(TRIM(payment_status), 'pending') = 'pending'
          AND TRIM(COALESCE(station_cocina_ready_at, '')) = ''
          AND TRIM(COALESCE(station_bar_ready_at, '')) = ''
          AND TRIM(COALESCE(station_cocina_preparing_at, '')) = ''
          AND TRIM(COALESCE(station_bar_preparing_at, '')) = ''
      `);
    } catch (_) {
      /* recuperar comandas atascadas en listo sin cierre por estación */
    }
    try {
      db.run(`
        UPDATE orders SET status = 'delivered', updated_at = datetime('now')
        WHERE IFNULL(TRIM(payment_status), '') = 'paid'
          AND status IN ('pending', 'preparing', 'ready')
      `);
    } catch (_) {
      /* mesas cobradas pero pedido aún «activo» */
    }

    const addOrderItemColIfMissing = (colName, ddl) => {
      const cols = queryAll('PRAGMA table_info(order_items)');
      if (!cols.some((col) => col.name === colName)) db.run(ddl);
    };
    addOrderItemColIfMissing('station_cocina_ready_at', 'ALTER TABLE order_items ADD COLUMN station_cocina_ready_at TEXT');
    addOrderItemColIfMissing('station_bar_ready_at', 'ALTER TABLE order_items ADD COLUMN station_bar_ready_at TEXT');
    addOrderItemColIfMissing('kitchen_highlight_at', 'ALTER TABLE order_items ADD COLUMN kitchen_highlight_at TEXT');
    addOrderItemColIfMissing('original_unit_price', 'ALTER TABLE order_items ADD COLUMN original_unit_price REAL');
    addOrderItemColIfMissing('promo_discount', 'ALTER TABLE order_items ADD COLUMN promo_discount REAL DEFAULT 0');
    addOrderItemColIfMissing('promotion_id', "ALTER TABLE order_items ADD COLUMN promotion_id TEXT DEFAULT ''");
    addOrderItemColIfMissing('promotion_label', "ALTER TABLE order_items ADD COLUMN promotion_label TEXT DEFAULT ''");

    const reservationColumns = queryAll('PRAGMA table_info(reservations)');
    const addReservationColIfMissing = (colName, ddl) => {
      const cols = queryAll('PRAGMA table_info(reservations)');
      if (!cols.some((col) => col.name === colName)) db.run(ddl);
    };
    if (!reservationColumns.some((col) => col.name === 'kitchen_prep_sent_at')) {
      addReservationColIfMissing('kitchen_prep_sent_at', 'ALTER TABLE reservations ADD COLUMN kitchen_prep_sent_at TEXT');
    }
    if (!reservationColumns.some((col) => col.name === 'caja_verify_sent_at')) {
      addReservationColIfMissing('caja_verify_sent_at', 'ALTER TABLE reservations ADD COLUMN caja_verify_sent_at TEXT');
    }
    try {
      db.run(
        "UPDATE orders SET delivery_payment_modality = 'contra_entrega' WHERE type = 'delivery' AND (delivery_payment_modality IS NULL OR TRIM(delivery_payment_modality) = '')"
      );
    } catch (_) {
      /* columna recién añadida en instancias antiguas */
    }
    db.run("UPDATE orders SET sale_document_type = COALESCE(NULLIF(sale_document_type, ''), 'nota_venta')");
    db.run(
      "UPDATE orders SET sale_document_number = printf('001-%08d', COALESCE(order_number, 0)) WHERE COALESCE(sale_document_number, '') = ''"
    );
    db.run(
      "UPDATE orders SET created_by_user_name = COALESCE(NULLIF(created_by_user_name, ''), customer_name, '') WHERE COALESCE(created_by_user_name, '') = ''"
    );

    const customerColumns = queryAll('PRAGMA table_info(customers)');
    if (!customerColumns.some(col => col.name === 'doc_type')) {
      db.run("ALTER TABLE customers ADD COLUMN doc_type TEXT DEFAULT '1'");
    }
    if (!customerColumns.some(col => col.name === 'doc_number')) {
      db.run("ALTER TABLE customers ADD COLUMN doc_number TEXT DEFAULT ''");
    }

    const restaurantColumns = queryAll('PRAGMA table_info(restaurants)');
    if (!restaurantColumns.some(col => col.name === 'company_ruc')) {
      db.run("ALTER TABLE restaurants ADD COLUMN company_ruc TEXT DEFAULT ''");
    }
    if (!restaurantColumns.some(col => col.name === 'legal_name')) {
      db.run("ALTER TABLE restaurants ADD COLUMN legal_name TEXT DEFAULT ''");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_enabled')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_enabled INTEGER DEFAULT 0");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_provider')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_provider TEXT DEFAULT 'nubefact'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_api_url')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_api_url TEXT DEFAULT 'https://api.nubefact.com/api/v1/9c66b892-4f9e-4f4f-b6ba-95bb89ee7b82'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_api_token')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_api_token TEXT DEFAULT ''");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_series_boleta')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_series_boleta TEXT DEFAULT 'B001'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_series_factura')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_series_factura TEXT DEFAULT 'F001'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_offline_mode')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_offline_mode INTEGER DEFAULT 1");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_auto_retry_enabled')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_auto_retry_enabled INTEGER DEFAULT 1");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_auto_retry_interval_sec')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_auto_retry_interval_sec INTEGER DEFAULT 120");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_nombre_comercial')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_nombre_comercial TEXT DEFAULT ''");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_emisor_ubigeo')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_emisor_ubigeo TEXT DEFAULT '150101'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_emisor_direccion')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_emisor_direccion TEXT DEFAULT ''");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_emisor_provincia')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_emisor_provincia TEXT DEFAULT 'LIMA'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_emisor_departamento')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_emisor_departamento TEXT DEFAULT 'LIMA'");
    }
    if (!restaurantColumns.some(col => col.name === 'billing_emisor_distrito')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_emisor_distrito TEXT DEFAULT 'LIMA'");
    }

    const rcPanelJson = queryAll('PRAGMA table_info(restaurants)');
    if (!rcPanelJson.some((col) => col.name === 'billing_panel_json')) {
      db.run("ALTER TABLE restaurants ADD COLUMN billing_panel_json TEXT DEFAULT '{}'");
    }

    const billingBotDefaultsMigrated = queryOne(
      'SELECT 1 AS ok FROM app_settings WHERE key = ?',
      ['billing_sunat_bot_defaults_v1']
    );
    if (!billingBotDefaultsMigrated) {
      db.run(`
        UPDATE restaurants SET
          billing_enabled = 1,
          billing_provider = 'restaurant_efact',
          billing_api_url = CASE
            WHEN billing_api_url LIKE '%nubefact%' OR billing_api_url LIKE '%9c66b892%' THEN ''
            ELSE billing_api_url
          END
        WHERE billing_provider = 'nubefact'
           OR billing_api_url LIKE '%nubefact%'
           OR billing_api_url LIKE '%9c66b892%'
           OR trim(coalesce(billing_provider, '')) = ''
      `);
      db.run(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('billing_sunat_bot_defaults_v1', '\"1\"')"
      );
    }

    const invalidEfactUrlCleaned = queryOne(
      'SELECT 1 AS ok FROM app_settings WHERE key = ?',
      ['billing_invalid_efact_url_cleared_v1']
    );
    if (!invalidEfactUrlCleaned) {
      db.run(`
        UPDATE restaurants SET billing_api_url = ''
        WHERE trim(coalesce(billing_api_url, '')) != ''
          AND lower(trim(billing_api_url)) NOT LIKE 'http://%'
          AND lower(trim(billing_api_url)) NOT LIKE 'https://%'
      `);
      db.run(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('billing_invalid_efact_url_cleared_v1', '\"1\"')"
      );
    }

    const workSessionCols = queryAll('PRAGMA table_info(user_work_sessions)');
    const workSessionColNames = new Set((workSessionCols || []).map((c) => c.name));
    if (!workSessionColNames.has('photo_login')) {
      db.run('ALTER TABLE user_work_sessions ADD COLUMN photo_login TEXT');
    }
    if (!workSessionColNames.has('photo_logout')) {
      db.run('ALTER TABLE user_work_sessions ADD COLUMN photo_logout TEXT');
    }
    if (!workSessionColNames.has('attendance_status')) {
      db.run('ALTER TABLE user_work_sessions ADD COLUMN attendance_status TEXT');
      db.run(`UPDATE user_work_sessions SET attendance_status = 'asistente'
        WHERE date(datetime(login_at, 'localtime')) < date('now', 'localtime')`);
      db.run(`UPDATE user_work_sessions SET attendance_status = 'pending'
        WHERE date(datetime(login_at, 'localtime')) = date('now', 'localtime')`);
      db.run(`UPDATE user_work_sessions SET attendance_status = 'asistente'
        WHERE attendance_status IS NULL OR trim(attendance_status) = ''`);
    }

    db.run(`UPDATE user_work_sessions SET attendance_status = 'asistente', updated_at = datetime('now')
      WHERE lower(trim(coalesce(role, ''))) = 'admin'
        AND COALESCE(NULLIF(trim(attendance_status), ''), 'pending') = 'pending'`);

    if (!workSessionColNames.has('last_activity_at')) {
      db.run('ALTER TABLE user_work_sessions ADD COLUMN last_activity_at TEXT');
      db.run(`UPDATE user_work_sessions SET last_activity_at = COALESCE(logout_at, login_at, datetime('now'))
        WHERE last_activity_at IS NULL OR trim(last_activity_at) = ''`);
    }
    if (!workSessionColNames.has('shift_label')) {
      db.run("ALTER TABLE user_work_sessions ADD COLUMN shift_label TEXT DEFAULT ''");
    }
    if (!workSessionColNames.has('pause_minutes')) {
      db.run('ALTER TABLE user_work_sessions ADD COLUMN pause_minutes INTEGER DEFAULT 0');
    }
    if (!workSessionColNames.has('session_kind')) {
      db.run("ALTER TABLE user_work_sessions ADD COLUMN session_kind TEXT DEFAULT 'jornada'");
      db.run("UPDATE user_work_sessions SET session_kind = 'jornada' WHERE session_kind IS NULL OR trim(session_kind) = ''");
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS user_work_activity_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT NOT NULL,
        module TEXT DEFAULT '',
        ref_id TEXT DEFAULT '',
        meta_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_work_activity_user_created ON user_work_activity_events(user_id, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_work_activity_session ON user_work_activity_events(session_id)');

    const usersTableSql = queryOne("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (usersTableSql?.sql && !usersTableSql.sql.includes("'bar'")) {
      /** Crear nueva → copiar → borrar vieja → renombrar: renombrar `users` primero rompe las FK de otras tablas. */
      db.run('PRAGMA foreign_keys = OFF');
      db.run('BEGIN IMMEDIATE');
      try {
      db.run('DROP TABLE IF EXISTS users_legacy_new');
      db.run(`
        CREATE TABLE users_legacy_new (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','cajero','mozo','cocina','bar','delivery','produccion')),
          restaurant_id TEXT,
          is_active INTEGER DEFAULT 1,
          phone TEXT DEFAULT '',
          avatar TEXT DEFAULT '',
          caja_station_id TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`
        INSERT INTO users_legacy_new (id, username, email, password_hash, full_name, role, restaurant_id, is_active, phone, avatar, created_at, caja_station_id)
        SELECT id, username, email, password_hash, full_name, role, restaurant_id, is_active, phone, avatar, created_at, ''
        FROM users
      `);
      db.run('DROP TABLE users');
      db.run('ALTER TABLE users_legacy_new RENAME TO users');
      db.run('COMMIT');
      } catch (legacyErr) {
        try { db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[migration] users legacy (revertido):', legacyErr.message || legacyErr);
      } finally {
        db.run('PRAGMA foreign_keys = ON');
      }
    }
    repairDanglingUserForeignKeys();

    const userColsCaja = queryAll('PRAGMA table_info(users)');
    const userColNamesCaja = new Set((userColsCaja || []).map((c) => c.name));
    if (!userColNamesCaja.has('caja_station_id')) {
      db.run("ALTER TABLE users ADD COLUMN caja_station_id TEXT DEFAULT ''");
    }
    const addUserColIfMissing = (colName, ddl) => {
      const cols = queryAll('PRAGMA table_info(users)');
      if (!cols.some((c) => c.name === colName)) db.run(ddl);
    };
    addUserColIfMissing('payroll_pay_mode', "ALTER TABLE users ADD COLUMN payroll_pay_mode TEXT DEFAULT ''");
    addUserColIfMissing('payroll_amount', 'ALTER TABLE users ADD COLUMN payroll_amount REAL DEFAULT 0');
    addUserColIfMissing('payroll_schedule_note', "ALTER TABLE users ADD COLUMN payroll_schedule_note TEXT DEFAULT ''");
    addUserColIfMissing('payroll_payment_day', 'ALTER TABLE users ADD COLUMN payroll_payment_day INTEGER DEFAULT 0');
    addUserColIfMissing('payroll_payment_method', "ALTER TABLE users ADD COLUMN payroll_payment_method TEXT DEFAULT ''");
    addUserColIfMissing('payroll_payment_ref', "ALTER TABLE users ADD COLUMN payroll_payment_ref TEXT DEFAULT ''");
    /** Admin dueño del negocio (creado solo desde Administrador maestro). Distinto de admins del personal. */
    addUserColIfMissing('is_buyer_admin', 'ALTER TABLE users ADD COLUMN is_buyer_admin INTEGER DEFAULT 0');
    try {
      const buyerCount = queryOne(
        `SELECT COUNT(*) AS c FROM users
         WHERE lower(trim(coalesce(role, ''))) = 'admin' AND COALESCE(is_buyer_admin, 0) = 1`,
      );
      if (Number(buyerCount?.c || 0) === 0) {
        const oldest = queryOne(
          `SELECT id FROM users
           WHERE lower(trim(coalesce(role, ''))) = 'admin'
           ORDER BY datetime(created_at) ASC
           LIMIT 1`,
        );
        if (oldest?.id) {
          runSql('UPDATE users SET is_buyer_admin = 1 WHERE id = ?', [oldest.id]);
          console.log('[migration] is_buyer_admin: marcado admin más antiguo como dueño/comprador');
        }
      }
    } catch (e) {
      console.warn('[migration] is_buyer_admin backfill:', e.message || e);
    }
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_caja_station_unique
       ON users(caja_station_id)
       WHERE trim(coalesce(caja_station_id, '')) != ''
         AND lower(trim(coalesce(role, ''))) = 'cajero'`
    );

    addUserColIfMissing('production_area_id', "ALTER TABLE users ADD COLUMN production_area_id TEXT DEFAULT ''");
    addUserColIfMissing('production_area_ids', "ALTER TABLE users ADD COLUMN production_area_ids TEXT DEFAULT '[]'");
    ensureUsersSchemaColumns();

    try {
      ensureUsersRoleAllowsProduccion();
      if (probeUsersRoleAllowsProduccion()) {
        db.run(`UPDATE users SET role = 'produccion', production_area_id = 'cocina'
                WHERE lower(trim(role)) = 'cocina' AND trim(coalesce(production_area_id, '')) = ''`);
        db.run(`UPDATE users SET role = 'produccion', production_area_id = 'bar'
                WHERE lower(trim(role)) = 'bar' AND trim(coalesce(production_area_id, '')) = ''`);
        db.run(`UPDATE users SET role = 'produccion'
                WHERE lower(trim(role)) IN ('cocina', 'bar')`);
      }
    } catch (e) {
      console.warn('[migration] users produccion role:', e.message || e);
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS order_station_state (
        order_id TEXT NOT NULL,
        area_id TEXT NOT NULL,
        preparing_at TEXT,
        ready_at TEXT,
        PRIMARY KEY (order_id, area_id)
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_order_station_state_area ON order_station_state(area_id)');

    const tableColsCaja = queryAll('PRAGMA table_info(tables)');
    if (!(tableColsCaja || []).some((c) => c.name === 'caja_station_id')) {
      db.run("ALTER TABLE tables ADD COLUMN caja_station_id TEXT DEFAULT ''");
    }
    if (!(tableColsCaja || []).some((c) => c.name === 'display_label')) {
      db.run("ALTER TABLE tables ADD COLUMN display_label TEXT DEFAULT 'number'");
    }

    const seqExists = queryOne('SELECT COUNT(*) as c FROM order_sequence');
    if (seqExists.c === 0) {
      db.run('INSERT INTO order_sequence (id, current_number) VALUES (1, 0)');
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_user_work_sessions_user_login ON user_work_sessions(user_id, login_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_user_work_sessions_open ON user_work_sessions(user_id, logout_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_orders_status_payment ON orders(status, payment_status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_orders_table_number ON orders(table_number)');
    db.run('CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_delivery_assignments_order ON delivery_assignments(order_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_delivery_assignments_driver ON delivery_assignments(driver_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_inventory_logs_product_created ON inventory_logs(product_id, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_documents_order ON electronic_documents(order_id)');

    db.run(`
      CREATE TABLE IF NOT EXISTS investment_movements (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        concept TEXT DEFAULT '',
        user_id TEXT,
        source TEXT DEFAULT 'payroll',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS finance_loss_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        concept TEXT DEFAULT '',
        order_id TEXT,
        items_json TEXT DEFAULT '',
        occurred_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS operational_delay_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        station TEXT NOT NULL,
        order_number TEXT DEFAULT '',
        table_number TEXT DEFAULT '',
        order_type TEXT DEFAULT '',
        status_at_detect TEXT DEFAULT '',
        threshold_minutes REAL NOT NULL DEFAULT 0,
        elapsed_minutes REAL NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_op_delay_detected ON operational_delay_events(detected_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_op_delay_order_station ON operational_delay_events(order_id, station)');

    const electronicDocCols = queryAll('PRAGMA table_info(electronic_documents)');
    const electronicDocColNames = new Set((electronicDocCols || []).map((c) => c.name));
    if (!electronicDocColNames.has('customer_phone')) {
      db.run("ALTER TABLE electronic_documents ADD COLUMN customer_phone TEXT DEFAULT ''");
    }

    const migNotaTableDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-04-electronic-doc-nota-venta-table']
    );
    if (!migNotaTableDone?.ok) {
      try {
        withTransaction((tx) => {
          tx.run(`CREATE TABLE electronic_documents_mig (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL UNIQUE,
            order_number INTEGER,
            doc_type TEXT NOT NULL CHECK(doc_type IN ('boleta','factura','nota_venta')),
            series TEXT NOT NULL,
            correlative INTEGER NOT NULL,
            full_number TEXT NOT NULL,
            customer_doc_type TEXT DEFAULT '',
            customer_doc_number TEXT DEFAULT '',
            customer_name TEXT DEFAULT '',
            customer_address TEXT DEFAULT '',
            customer_phone TEXT DEFAULT '',
            subtotal REAL DEFAULT 0,
            tax REAL DEFAULT 0,
            total REAL DEFAULT 0,
            currency TEXT DEFAULT 'PEN',
            payment_method TEXT DEFAULT '',
            provider TEXT DEFAULT 'nubefact',
            provider_status TEXT DEFAULT 'pending',
            provider_message TEXT DEFAULT '',
            hash_code TEXT DEFAULT '',
            sunat_description TEXT DEFAULT '',
            xml_url TEXT DEFAULT '',
            cdr_url TEXT DEFAULT '',
            pdf_url TEXT DEFAULT '',
            provider_payload TEXT DEFAULT '{}',
            provider_response TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )`);
          tx.run('INSERT INTO electronic_documents_mig SELECT * FROM electronic_documents');
          tx.run('DROP TABLE electronic_documents');
          tx.run('ALTER TABLE electronic_documents_mig RENAME TO electronic_documents');
          tx.run('CREATE INDEX IF NOT EXISTS idx_documents_order ON electronic_documents(order_id)');
        });
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-04-electronic-doc-nota-venta-table',
        ]);
      } catch (e) {
        console.error('[migration] electronic_documents nota_venta:', e.message || e);
      }
    }

    const migNotaBackfillDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-04-nota-venta-backfill']
    );
    if (!migNotaBackfillDone?.ok) {
      try {
        const restaurant = queryOne('SELECT * FROM restaurants LIMIT 1');
        const currency = restaurant?.currency || 'PEN';
        const orphans = queryAll(`
          SELECT o.* FROM orders o
          WHERE lower(coalesce(o.sale_document_type, '')) = 'nota_venta'
          AND coalesce(o.payment_status, '') = 'paid'
          AND lower(coalesce(o.status, '')) != 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM electronic_documents d WHERE d.order_id = o.id)
        `);
        for (const o of orphans) {
          const noteNumber =
            String(o.sale_document_number || '').trim() ||
            `001-${String(o.order_number || 0).padStart(8, '0')}`;
          const dash = noteNumber.indexOf('-');
          const series = dash >= 0 ? noteNumber.slice(0, dash).trim() || '001' : '001';
          let correlative = 0;
          if (dash >= 0) {
            const tail = noteNumber.slice(dash + 1).replace(/\D/g, '');
            correlative = parseInt(tail, 10) || 0;
          }
          if (!correlative) correlative = Number(o.order_number) || 0;
          const docId = uuidv4();
          const custName = String(o.customer_name || '').trim() || 'CLIENTE VARIOS';
          runSql(
            `INSERT INTO electronic_documents (
              id, order_id, order_number, doc_type, series, correlative, full_number,
              customer_doc_type, customer_doc_number, customer_name, customer_address, customer_phone,
              subtotal, tax, total, currency, payment_method,
              provider, provider_status, provider_message, hash_code, sunat_description,
              xml_url, cdr_url, pdf_url, provider_payload, provider_response,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'nota_venta', ?, ?, ?, '', '', ?, '', '', ?, ?, ?, ?, ?, 'local', 'local', 'Nota de venta (histórico)', '', '', '', '', '', '', '{}', '{}', COALESCE(?, datetime('now')), datetime('now'))`,
            [
              docId,
              o.id,
              o.order_number,
              series,
              correlative,
              noteNumber,
              custName,
              o.subtotal,
              o.tax,
              o.total,
              currency,
              o.payment_method || 'efectivo',
              o.created_at,
            ]
          );
        }
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-04-nota-venta-backfill',
        ]);
      } catch (e) {
        console.error('[migration] nota_venta backfill:', e.message || e);
      }
    }

    const migPrinterRoutes = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-04-printer-routes-v1']
    );
    if (!migPrinterRoutes?.ok) {
      db.run(`
        CREATE TABLE IF NOT EXISTS printer_routes (
          id TEXT PRIMARY KEY,
          restaurant_id TEXT NOT NULL,
          area TEXT NOT NULL,
          printer_name TEXT DEFAULT '',
          printer_type TEXT NOT NULL DEFAULT 'browser',
          ip_address TEXT DEFAULT '',
          port INTEGER NOT NULL DEFAULT 9100,
          paper_width INTEGER NOT NULL DEFAULT 80,
          auto_print INTEGER NOT NULL DEFAULT 1,
          copies INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          local_printer_name TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(restaurant_id, area)
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_printer_routes_restaurant ON printer_routes(restaurant_id)');
      try {
        const { normalizePrinterStation, KNOWN_PRINT_AREAS } = require('./printerStation');
        const rest = queryOne('SELECT id FROM restaurants ORDER BY created_at ASC LIMIT 1');
        const rid = String(rest?.id || '').trim();
        if (rid) {
          const settingsRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['settings']);
          let impresoras = [];
          try {
            const parsed = settingsRow?.value ? JSON.parse(settingsRow.value) : {};
            impresoras = Array.isArray(parsed.impresoras) ? parsed.impresoras : [];
          } catch (_) {
            impresoras = [];
          }
          const byArea = new Map();
          for (const p of impresoras) {
            const area = normalizePrinterStation(p);
            if (!KNOWN_PRINT_AREAS.includes(area)) continue;
            byArea.set(area, p);
          }
          for (const [area, p] of byArea) {
            const ip = String(p.ip_address || '').trim();
            const conn = String(p.connection || 'browser').toLowerCase();
            let printerType = 'browser';
            if (ip || conn === 'wifi') printerType = 'lan';
            const port = Math.min(65535, Math.max(1, Number(p.port || 9100) || 9100));
            const paper = [58, 80].includes(Number(p.width_mm)) ? Number(p.width_mm) : 80;
            const copies = Math.min(5, Math.max(1, Number(p.copies || 1)));
            const enabled = Number(p.active ?? 1) === 1 ? 1 : 0;
            const autoPrint = Number(p.auto_print ?? 1) === 0 ? 0 : 1;
            db.run(
              `INSERT INTO printer_routes (
                id, restaurant_id, area, printer_name, printer_type, ip_address, port, paper_width,
                auto_print, copies, enabled, local_printer_name, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
              [
                uuidv4(),
                rid,
                area,
                String(p.name || '').trim() || area,
                printerType,
                ip,
                port,
                paper,
                autoPrint,
                copies,
                enabled,
                String(p.local_printer_name || '').trim(),
              ]
            );
          }
        }
      } catch (e) {
        console.error('[migration] printer_routes seed:', e.message || e);
      }
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', ['2026-04-printer-routes-v1']);
    }

    const migPrinterSettings = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-04-printer-settings-v1']
    );
    if (!migPrinterSettings?.ok) {
      db.run(`
        CREATE TABLE IF NOT EXISTS printer_settings (
          id TEXT PRIMARY KEY,
          restaurant_id TEXT NOT NULL,
          sucursal_id TEXT NOT NULL DEFAULT '',
          area TEXT NOT NULL,
          connection_type TEXT NOT NULL DEFAULT 'browser',
          printer_name TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          port INTEGER NOT NULL DEFAULT 9100,
          paper_width INTEGER NOT NULL DEFAULT 80,
          copies INTEGER NOT NULL DEFAULT 1,
          auto_print INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          local_printer_name TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(restaurant_id, sucursal_id, area)
        )
      `);
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_printer_settings_restaurant ON printer_settings(restaurant_id)'
      );
      try {
        const routes = queryAll('SELECT * FROM printer_routes', []);
        for (const row of routes) {
          db.run(
            `INSERT OR REPLACE INTO printer_settings (
              id, restaurant_id, sucursal_id, area, connection_type, printer_name, ip, port,
              paper_width, copies, auto_print, enabled, local_printer_name, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
              row.id,
              row.restaurant_id,
              '',
              row.area,
              String(row.printer_type || 'browser'),
              String(row.printer_name || ''),
              String(row.ip_address || ''),
              Number(row.port || 9100),
              Number(row.paper_width || 80),
              Number(row.copies || 1),
              Number(row.auto_print ?? 1),
              Number(row.enabled ?? 1),
              String(row.local_printer_name || ''),
            ]
          );
        }
      } catch (e) {
        console.error('[migration] printer_settings seed:', e.message || e);
      }
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
        '2026-04-printer-settings-v1',
      ]);
    }

    const migBusinessConfig = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-05-business-config-v1']
    );
    if (!migBusinessConfig?.ok) {
      db.run(`
        CREATE TABLE IF NOT EXISTS business_config_definitions (
          config_key TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          label TEXT NOT NULL,
          value_type TEXT NOT NULL CHECK(value_type IN ('number','boolean','string','json')),
          default_value TEXT NOT NULL,
          constraints_json TEXT NOT NULL DEFAULT '{}',
          description TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS business_config_values (
          config_key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT DEFAULT '',
          FOREIGN KEY (config_key) REFERENCES business_config_definitions(config_key)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS business_config_history (
          id TEXT PRIMARY KEY,
          config_key TEXT NOT NULL,
          value_before TEXT NOT NULL,
          value_after TEXT NOT NULL,
          actor_user_id TEXT DEFAULT '',
          actor_name TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_business_config_history_key ON business_config_history(config_key, created_at)');
      db.run('CREATE INDEX IF NOT EXISTS idx_business_config_history_created ON business_config_history(created_at)');

      const bizSeeds = [
        ['gen_currency_primary', 'general', 'Moneda principal (código ISO)', 'string', '"PEN"', '{}', 'Usada en etiquetas y reportes exportables.', 10],
        ['gen_tip_suggested_pct', 'general', 'Propina sugerida (%)', 'number', '10', '{"min":0,"max":40}', 'Referencia para UI de cobro; no calcula propina sola.', 20],
        ['gen_indirect_overhead_pct', 'general', 'Costos indirectos estimados (%)', 'number', '0', '{"min":0,"max":100}', 'Sobre costo de venta para análisis de margen ampliado.', 30],
        ['prof_margin_min_pct', 'profitability', 'Margen bruto mínimo objetivo (%)', 'number', '15', '{"min":-100,"max":100}', 'Umbral de alerta en análisis de rentabilidad.', 10],
        ['prof_margin_ideal_pct', 'profitability', 'Margen bruto ideal (%)', 'number', '35', '{"min":0,"max":100}', 'Meta de referencia para platos o categorías.', 20],
        ['prof_margin_critical_pct', 'profitability', 'Margen crítico (%)', 'number', '5', '{"min":-100,"max":50}', 'Por debajo: producto en zona de pérdida relativa.', 30],
        ['prof_target_net_margin_pct', 'profitability', 'Utilidad neta objetivo (%)', 'number', '12', '{"min":-100,"max":100}', 'Referencia para paneles ejecutivos.', 40],
        ['inv_valuation_method', 'inventory', 'Método de valorización declarado', 'string', '"weighted_average"', '{"allowed":["weighted_average","fifo","last_cost"]}', 'Se registra en kardex; cálculo actual sigue siendo promedio ponderado salvo evolución futura.', 10],
        ['inv_waste_tolerance_pct', 'inventory', 'Tolerancia de merma / variación (%)', 'number', '3', '{"min":0,"max":100}', 'Base para comparación teórico vs real.', 20],
        ['prod_yield_factor_default', 'production', 'Factor de rendimiento por defecto', 'number', '1', '{"min":0.5,"max":1.5}', '1 = 100% de rendimiento teórico en recetas.', 10],
        ['prod_max_waste_pct', 'production', 'Merma máxima aceptada en producción (%)', 'number', '10', '{"min":0,"max":100}', 'Para alertas y reglas de automatización.', 20],
        ['auto_alerts_enabled', 'automation', 'Automatización de alertas activa', 'boolean', 'true', '{}', 'Habilita evaluación de reglas automáticas (extensible).', 10],
        ['auto_slow_moving_days', 'automation', 'Días para considerar producto lento', 'number', '14', '{"min":1,"max":365}', 'Ventana para clasificación de rotación.', 20],
        ['com_engine_enabled', 'commercial', 'Motor comercial (recomendaciones) activo', 'boolean', 'false', '{}', 'Activa heurísticas de upsell/combos cuando estén cableadas.', 10],
        ['com_promo_sensitivity', 'commercial', 'Sensibilidad promociones (0–1)', 'number', '0.5', '{"min":0,"max":1}', 'Control fino de agresividad de sugerencias.', 20],
        ['pred_horizon_days', 'predictive', 'Horizonte de predicción (días)', 'number', '14', '{"min":1,"max":180}', 'Para modelos de demanda y compras (fases posteriores).', 10],
        ['var_tolerance_pct', 'variance', 'Tolerancia teórico vs real (%)', 'number', '8', '{"min":0,"max":100}', 'Desviación aceptable antes de alertar.', 10],
        ['alert_low_margin_enabled', 'alerts', 'Alerta por margen bajo', 'boolean', 'true', '{}', 'Notificaciones cuando el margen cae bajo el mínimo.', 10],
        ['alert_critical_stock_enabled', 'alerts', 'Alerta por stock crítico', 'boolean', 'true', '{}', 'Integración con umbrales de insumos/almacén.', 20],
        ['dash_kpi_preset', 'dashboard', 'Preset de KPIs ejecutivos', 'string', '"basic"', '{"allowed":["basic","operations","finance"]}', 'Define conjunto de widgets por defecto (fase dashboard).', 10],
      ];
      for (const s of bizSeeds) {
        db.run(
          `INSERT OR IGNORE INTO business_config_definitions
           (config_key, domain, label, value_type, default_value, constraints_json, description, sort_order, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          s
        );
      }
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', ['2026-05-business-config-v1']);
    }

    const migPagosYapePlin = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-05-pagos-yape-plin-default-v1']
    );
    if (!migPagosYapePlin?.ok) {
      const pagosRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['pagos_sistema']);
      if (pagosRow?.value) {
        try {
          const pagos = JSON.parse(pagosRow.value);
          let changed = false;
          if (Number(pagos.acepta_yape ?? 0) !== 1) {
            pagos.acepta_yape = 1;
            changed = true;
          }
          if (Number(pagos.acepta_plin ?? 0) !== 1) {
            pagos.acepta_plin = 1;
            changed = true;
          }
          if (changed) {
            db.run('UPDATE app_settings SET value = ? WHERE key = ?', [JSON.stringify(pagos), 'pagos_sistema']);
          }
        } catch (_) {
          /* ignore malformed pagos_sistema */
        }
      }
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', ['2026-05-pagos-yape-plin-default-v1']);
    }

    const ordersPayMethodMigDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-06-orders-payment-method-cortesia-v1']
    );
    if (!ordersPayMethodMigDone?.ok) {
      try {
        withTransaction((tx) => {
          const formatOrderColDefault = (dflt) => {
            if (dflt == null || String(dflt).trim() === '') return '';
            const d = String(dflt).trim();
            if (d.toUpperCase() === 'NULL') return ' DEFAULT NULL';
            if (/^[a-z_]+\(/i.test(d)) return ` DEFAULT (${d})`;
            return ` DEFAULT ${d}`;
          };
          const cols = tx.queryAll('PRAGMA table_info(orders)');
          const colNames = cols.map((c) => c.name);
          const colDefs = cols.map((col) => {
            if (col.name === 'payment_method') {
              return "payment_method TEXT DEFAULT 'efectivo' CHECK(payment_method IN ('efectivo','yape','plin','tarjeta','online','cuenta_cliente','cortesia'))";
            }
            if (col.name === 'type') {
              return "type TEXT NOT NULL CHECK(type IN ('dine_in','delivery','pickup'))";
            }
            if (col.name === 'status') {
              return "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','ready','delivered','cancelled'))";
            }
            if (col.name === 'payment_status') {
              return "payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','refunded'))";
            }
            if (col.name === 'sale_document_type') {
              return "sale_document_type TEXT DEFAULT 'nota_venta' CHECK(sale_document_type IN ('nota_venta','boleta','factura'))";
            }
            let sql = `${col.name} ${String(col.type || 'TEXT').toUpperCase()}`;
            if (col.pk) sql += ' PRIMARY KEY';
            if (col.notnull && !col.pk) sql += ' NOT NULL';
            sql += formatOrderColDefault(col.dflt_value);
            return sql;
          });
          tx.run(`CREATE TABLE orders_payment_mig (${colDefs.join(', ')})`);
          const list = colNames.join(', ');
          tx.run(`INSERT INTO orders_payment_mig (${list}) SELECT ${list} FROM orders`);
          tx.run('DROP TABLE orders');
          tx.run('ALTER TABLE orders_payment_mig RENAME TO orders');
          tx.run('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)');
          tx.run('CREATE INDEX IF NOT EXISTS idx_orders_status_payment ON orders(status, payment_status)');
          tx.run('CREATE INDEX IF NOT EXISTS idx_orders_table_number ON orders(table_number)');
        });
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-06-orders-payment-method-cortesia-v1',
        ]);
        console.log('[migration] orders: payment_method admite cortesia y cuenta_cliente');
      } catch (e) {
        console.error('[migration] orders payment_method cortesia:', e.message || e);
      }
    }

    const courtesyBackfillDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-06-courtesy-backfill-v2']
    );
    if (!courtesyBackfillDone?.ok) {
      try {
        runSql(
          `UPDATE orders
           SET payment_method = 'cortesia',
               discount = COALESCE(subtotal, 0) + COALESCE(delivery_fee, 0),
               total = 0,
               tip_amount = 0,
               payment_breakdown = NULL,
               updated_at = datetime('now')
           WHERE status != 'cancelled'
             AND payment_status = 'paid'
             AND IFNULL(payment_method, '') != 'cortesia'
             AND (
               notes LIKE '%[DESCUENTO: Cortes%'
               OR notes LIKE '%[DESCUENTO: cortes%'
             )`
        );
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-06-courtesy-backfill-v2',
        ]);
        console.log('[migration] cortesías históricas normalizadas');
      } catch (e) {
        console.error('[migration] cortesía backfill:', e.message || e);
      }
    }

    const kardexVentasBackfillDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-06-kardex-ventas-backfill-v1']
    );
    if (!kardexVentasBackfillDone?.ok) {
      try {
        const { backfillKardexVentasPagadas } = require('./services/kardexBackfillService');
        const result = backfillKardexVentasPagadas({ limit: 10000 });
        console.log('[migration] kardex ventas históricas:', JSON.stringify(result));
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-06-kardex-ventas-backfill-v1',
        ]);
      } catch (e) {
        console.error('[migration] kardex ventas backfill:', e.message || e);
      }
    }

    const productRemovalsTableDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-06-order-product-removals-v1']
    );
    if (!productRemovalsTableDone?.ok) {
      try {
        runSql(
          `CREATE TABLE IF NOT EXISTS order_product_removals (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            order_number INTEGER,
            product_id TEXT,
            product_name TEXT NOT NULL,
            quantity_removed REAL NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL DEFAULT 0,
            removal_reason TEXT NOT NULL DEFAULT '',
            table_number TEXT,
            order_type TEXT,
            actor_user_id TEXT,
            actor_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
        );
        runSql('CREATE INDEX IF NOT EXISTS idx_order_product_removals_created ON order_product_removals(created_at)');
        runSql('CREATE INDEX IF NOT EXISTS idx_order_product_removals_order ON order_product_removals(order_id)');
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-06-order-product-removals-v1',
        ]);
        console.log('[migration] order_product_removals table ready');
      } catch (e) {
        console.error('[migration] order_product_removals:', e.message || e);
      }
    }

    try {
      const { migrateProductInsumosToRecetas } = require('./utils/productKardexInsumos');
      const r = migrateProductInsumosToRecetas({ queryAll, withTransaction });
      if (r.cleared) console.log('[migration] insumos de productos → recetas:', JSON.stringify(r));
    } catch (e) {
      console.error('[migration] insumos de productos → recetas:', e.message || e);
    }

    const ordersRegisterColDone = queryOne(
      'SELECT 1 as ok FROM schema_migrations WHERE migration_key = ?',
      ['2026-07-orders-cash-register-v1'],
    );
    if (!ordersRegisterColDone?.ok) {
      try {
        const orderCols = queryAll('PRAGMA table_info(orders)');
        const names = new Set(orderCols.map((c) => c.name));
        if (!names.has('cash_register_id')) {
          runSql("ALTER TABLE orders ADD COLUMN cash_register_id TEXT DEFAULT ''");
        }
        if (!names.has('paid_at')) {
          runSql("ALTER TABLE orders ADD COLUMN paid_at TEXT DEFAULT NULL");
        }
        runSql('CREATE INDEX IF NOT EXISTS idx_orders_cash_register_id ON orders(cash_register_id)');
        runSql('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', [
          '2026-07-orders-cash-register-v1',
        ]);
        console.log('[migration] orders.cash_register_id + paid_at ready');
      } catch (e) {
        console.error('[migration] orders cash register cols:', e.message || e);
      }
    }

    /** Backups restaurados pueden tener migration_key sin columnas nuevas en orders. */
    ensureOrdersPaidAtColumns();
    try {
      ensureLoyaltySurveysTable();
    } catch (e) {
      console.warn('[migration] loyalty_surveys:', e.message || e);
    }
    try {
      const { ensureJornadaLaboralDefaultsInSettings, applyJornadaFotoDefaultOffMigration } = require('./services/jornadaLaboralService');
      ensureJornadaLaboralDefaultsInSettings();
      applyJornadaFotoDefaultOffMigration();
    } catch (e) {
      console.warn('[migration] jornada_laboral:', e.message || e);
    }
    try {
      const { backfillSaleNumbers } = require('./services/saleNumberService');
      backfillSaleNumbers();
    } catch (e) {
      console.warn('[migration] sale_number:', e.message || e);
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_customers_doc_number ON customers(doc_number)');
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_doc_number_unique ON customers(doc_number) WHERE COALESCE(doc_number, '') != ''");
    db.run('CREATE INDEX IF NOT EXISTS idx_app_settings_history_created_at ON app_settings_history(created_at)');
    db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', ['2026-02-professionalization-indexes-audit']);

    try {
      const { ensureTableUnionsSchema } = require('./services/tableUnionService');
      ensureTableUnionsSchema();
    } catch (e) {
      console.warn('[migration] table_unions:', e.message || e);
    }

    try {
      const { ensureSignatureTables } = require('./services/contractSignature/contractSignatureService');
      ensureSignatureTables();
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_key) VALUES (?)', ['2026-08-contract-signature-v1']);
    } catch (e) {
      console.warn('[migration] contract_signature:', e.message || e);
    }

    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['regional', JSON.stringify({ country: 'Peru', timezone: 'America/Lima', language: 'es', date_format: 'DD/MM/YYYY' })]);
    db.run(
      'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)',
      [
        'mi_restaurant',
        JSON.stringify({
          general: {
            address_reference: '',
            phone_secondary: '',
            whatsapp: '',
            website: '',
            social_facebook: '',
            social_instagram: '',
            social_tiktok: '',
            description: '',
          },
          branding: { logo_ticket: '', favicon: '', qr_hero_image: '', encuesta_cover_image: '' },
          ticket: {
            paper_width_mm: 80,
            alignment: 'center',
            show_logo: 1,
            show_qr: 0,
            show_social: 1,
            welcome_message: '',
            footer_message: '',
            promo_message: '',
            auto_notes: '',
            custom_footer: '',
          },
          tax_display: { rounding_mode: 'standard', show_tax_breakdown: 1 },
          delivery_extra: {
            estimated_minutes: 45,
            message: '',
            auto_notes: '',
            contact_phone: '',
            coverage_zones: '',
          },
          qr: {
            cover_title: '',
            welcome_message: '',
            primary_color: '#f04438',
            banner_url: '',
            show_social: 1,
            terms_text: '',
          },
          messages: {
            ticket: '',
            reservas: '',
            delivery: '',
            promos: '',
            clientes: '',
            whatsapp: '',
          },
          meta: { updated_at: '', updated_by: '' },
        }),
      ]
    );
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['series_contingencia', JSON.stringify({ boleta: 'BC01', factura: 'FC01', enabled: 1 })]);
    db.run(
      'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)',
      [
        'contrato',
        JSON.stringify({
          texto_contrato: '',
          documento_word_url: '',
          documento_word_nombre: '',
          firma_comprador_url: '',
          firma_vendedor_url: '',
        }),
      ]
    );
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['master_admin_control', JSON.stringify({
      contract_title: 'Contrato de venta',
      contract_notes: '',
      billing_date: '',
      notify_days_before: 5,
      auto_block_on_overdue: 1,
      global_lock_enabled: 0,
      global_lock_reason: 'Bloqueo por falta de pago',
      lock_enabled_by: '',
      lock_enabled_at: '',
      billing_alert_sent_for: '',
    })]);
    /* master_admin_auth: se inicializa al primer uso en masterAdminService. */
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['master_admin_notifications', JSON.stringify([])]);
    /* production: sin usuarios ni mesas demo; el maestro crea el administrador desde /master */
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['bootstrap_mode', JSON.stringify({ mode: 'sale_ready' })]);
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['pagos_sistema', JSON.stringify({
      acepta_efectivo: 1,
      acepta_tarjeta: 1,
      acepta_yape: 1,
      acepta_plin: 1,
      requiere_referencia_digital: 0,
      propina_sugerida_pct: 10,
      tolerancia_diferencia_caja: 2,
      dias_max_credito: 15,
      monto_max_credito: 500,
      notificar_mora: 1,
      texto_politica_cobro: 'Todo crédito debe regularizarse dentro del plazo acordado.',
    })]);
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['pago_uso_sistema', JSON.stringify({
      periodo_facturacion: 'mensual',
      fecha_proxima_facturacion: '',
      numero_cuenta: '',
      numero_telefono: '',
      nombre_empresa_cobro: '',
      precio_plan: '',
      comprobante_pago_url: '',
      comprobante_grace_days_after_due: 3,
      comprobante_alert_sent_for: '',
    })]);
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', ['settings', JSON.stringify({
      regional: { country: 'Peru', timezone: 'America/Lima', language: 'es', date_format: 'DD/MM/YYYY' },
      locales: [{ name: 'Principal', address: '', phone: '', active: 1 }],
      almacenes: [{ name: 'Almacén Principal', description: 'Almacén general de insumos', active: 1 }],
      salones: [{
        id: 'principal',
        name: 'Salón Principal',
        description: 'Área principal del restaurante',
        sort_order: 0,
        caja_station_id: 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001',
      }],
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
      comprobantes: [
        { name: 'Boleta de Venta', series: 'B001', active: 1 },
        { name: 'Factura', series: 'F001', active: 1 },
        { name: 'Nota de Venta', series: 'N001', active: 1 },
      ],
      impresoras: [
        { name: 'Impresora Cocina', area: 'Comandas', width_mm: 80, copies: 1, active: 1 },
        { name: 'Impresora Bar', area: 'Comandas Bar', width_mm: 80, copies: 1, active: 1 },
        { name: 'Impresora Caja', area: 'Comprobantes', width_mm: 80, copies: 1, active: 1 },
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
      jornada_laboral: {
        requiere_foto_inicio_sesion: 0,
        requiere_foto_fin_jornada: 0,
        requiere_foto_asistencia: 0,
      },
    })]);
    const settingsRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['settings']);
    if (settingsRow?.value) {
      let parsed = {};
      try {
        parsed = JSON.parse(settingsRow.value);
      } catch (_) {
        parsed = {};
      }
      const printers = Array.isArray(parsed.impresoras) ? parsed.impresoras : [];
      const inferPrinterStation = (p) => {
        const s = String(p?.station || '').toLowerCase();
        if (['cocina', 'bar', 'caja', 'delivery', 'parrilla'].includes(s)) return s;
        const n = String(p?.name || '').toLowerCase();
        if (n.includes('parrilla')) return 'parrilla';
        if (n.includes('delivery')) return 'delivery';
        if (n.includes('caja')) return 'caja';
        if (n.includes('bar')) return 'bar';
        if (n.includes('cocina')) return 'cocina';
        return 'cocina';
      };
      const hasBarPrinter = printers.some(p => String(p?.name || '').toLowerCase().includes('bar'));
      const normalizedPrinters = printers.map((p) => ({
        ...p,
        station: inferPrinterStation(p),
        connection: String(p?.connection || 'browser').toLowerCase() === 'wifi' ? 'wifi' : 'browser',
        ip_address: String(p?.ip_address || '').trim(),
        port: Math.min(65535, Math.max(1, Number(p?.port || 9100) || 9100)),
        width_mm: [58, 80].includes(Number(p?.width_mm)) ? Number(p.width_mm) : 80,
        copies: Math.min(5, Math.max(1, Number(p?.copies || 1))),
      }));
      let nextPrinters = normalizedPrinters;
      if (!hasBarPrinter) {
        nextPrinters = [...normalizedPrinters, { name: 'Impresora Bar', area: 'Comandas Bar', station: 'bar', connection: 'browser', ip_address: '', port: 9100, width_mm: 80, copies: 1, active: 1 }];
      }
      const printersChanged = JSON.stringify(printers) !== JSON.stringify(nextPrinters);
      let next = { ...parsed };
      if (printersChanged) {
        next.impresoras = nextPrinters;
      }
      const jl = next.jornada_laboral && typeof next.jornada_laboral === 'object' ? next.jornada_laboral : {};
      const hasInicio = Object.prototype.hasOwnProperty.call(jl, 'requiere_foto_inicio_sesion');
      const hasFin = Object.prototype.hasOwnProperty.call(jl, 'requiere_foto_fin_jornada');
      if (!hasInicio || !hasFin) {
        const { normalizeJornadaLaboral } = require('./services/jornadaLaboralService');
        next = {
          ...next,
          jornada_laboral: normalizeJornadaLaboral({
            ...jl,
            requiere_foto_inicio_sesion: hasInicio ? jl.requiere_foto_inicio_sesion : 0,
            requiere_foto_fin_jornada: hasFin ? jl.requiere_foto_fin_jornada : 0,
          }),
        };
      }
      const DEFAULT_PRIMARY_CAJA_ID = 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001';
      if (!Array.isArray(next.cajas) || next.cajas.length === 0) {
        next = {
          ...next,
          cajas: [{
            id: DEFAULT_PRIMARY_CAJA_ID,
            name: 'Caja Principal',
            description: 'Caja #1 - Recepción',
            active: 1,
          }],
        };
      }
      const cajasRaw = Array.isArray(next.cajas) ? next.cajas : [];
      const cajasWithIds = cajasRaw.map((c) => {
        const id = String(c?.id || '').trim();
        if (id) return c;
        return { ...c, id: uuidv4() };
      });
      if (JSON.stringify(cajasWithIds) !== JSON.stringify(cajasRaw)) {
        next = { ...next, cajas: cajasWithIds };
      }
      if (!Array.isArray(next.salones) || next.salones.length === 0) {
        const { inferSalonesFromTables } = require('./services/salonesConfigService');
        const tableZones = queryAll('SELECT zone, number FROM tables ORDER BY number ASC');
        if (tableZones.length) {
          next = { ...next, salones: inferSalonesFromTables(tableZones) };
        }
      }
      const DEFAULT_PRIMARY_CAJA_ID_MIG = 'b0b0b0b0-b0b0-4000-b0b0-b0b0b0b0b001';
      if (!Array.isArray(next.production_areas) || next.production_areas.length === 0) {
        next = {
          ...next,
          production_areas: [
            { id: 'cocina', name: 'Cocina', active: 1, encargado_user_ids: [], mozo_user_ids: [] },
            { id: 'bar', name: 'Bar', active: 1, encargado_user_ids: [], mozo_user_ids: [] },
          ],
        };
      }
      if (Array.isArray(next.salones)) {
        const salonesWithCaja = next.salones.map((s) => ({
          ...s,
          caja_station_id: String(s?.caja_station_id || '').trim() || DEFAULT_PRIMARY_CAJA_ID_MIG,
        }));
        if (JSON.stringify(salonesWithCaja) !== JSON.stringify(next.salones)) {
          next = { ...next, salones: salonesWithCaja };
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(parsed)) {
        db.run("UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = 'settings'", [JSON.stringify(next)]);
      }
      try {
        const primaryCaja = DEFAULT_PRIMARY_CAJA_ID_MIG;
        db.run(
          `UPDATE tables SET caja_station_id = ? WHERE trim(coalesce(caja_station_id, '')) = ''`,
          [primaryCaja]
        );
        const mozos = queryAll(`SELECT id FROM users WHERE lower(trim(role)) = 'mozo'`);
        for (const m of mozos || []) {
          const u = queryOne('SELECT caja_station_id FROM users WHERE id = ?', [m.id]);
          const needsCaja = !String(u?.caja_station_id || '').trim();
          if (needsCaja) {
            db.run(
              `UPDATE users SET caja_station_id = ?
               WHERE id = ? AND trim(coalesce(caja_station_id,'')) = ''`,
              [primaryCaja, m.id]
            );
          }
        }
      } catch (e) {
        console.warn('[migration] mozo/tables caja backfill:', e.message || e);
      }
      const userHasCajaCol = (queryAll('PRAGMA table_info(users)') || []).some((c) => c.name === 'caja_station_id');
      if (userHasCajaCol) {
        const activeCajas = (Array.isArray(next.cajas) ? next.cajas : []).filter(
          (c) => Number(c?.active || 0) === 1 && String(c?.id || '').trim()
        );
        if (activeCajas.length === 1) {
          const unset = queryAll(
            `SELECT id FROM users WHERE lower(trim(coalesce(role, ''))) = 'cajero'
             AND trim(coalesce(caja_station_id, '')) = ''`
          );
          if (unset && unset.length === 1) {
            db.run('UPDATE users SET caja_station_id = ? WHERE id = ?', [
              String(activeCajas[0].id).trim(),
              unset[0].id,
            ]);
          }
        }
      }
    }

    seedData();
    ensureOperationalUsers();
    try {
      const { syncEncargadoUserRoles, enforceSingleEncargadoPerArea } = require('./services/productionAreasService');
      enforceSingleEncargadoPerArea();
      syncEncargadoUserRoles();
    } catch (e) {
      console.warn('[migration] roles de encargados de producción:', e.message || e);
    }
    seedTables();
    seedWarehouses();
    try {
      const { ensureUserWorkSessionSchema } = require('./utils/ensureUserWorkSessionSchema');
      ensureUserWorkSessionSchema();
    } catch (err) {
      console.warn('[db] user_work_sessions schema check:', err.message || err);
    }
    try {
      const { ensureHrSchema } = require('./utils/ensureHrSchema');
      ensureHrSchema();
    } catch (err) {
      console.warn('[db] hr schema check:', err.message || err);
    }

    const usersCount = countTableRows('users');
    const productsCount = countTableRows('products');
    assertSafeDbBeforePersist({ usersCount, productsCount, previousBytes });
    try {
      flushSaveDb();
    } catch (persistErr) {
      console.error('[sqlite] no se pudo persistir al arrancar (el API sigue):', persistErr?.message || persistErr);
    }
    if (usersCount > 0 || productsCount > 0) {
      writeDbGuard({
        users: usersCount,
        products: productsCount,
        bytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
      });
      console.info(`[db-guard] Marcador actualizado: ${usersCount} usuario(s), ${productsCount} producto(s)`);
      try {
        createSafetyBackup({ force: true });
      } catch (backupErr) {
        console.warn('[sqlite-backup] no se pudo crear copia al arrancar:', backupErr.message || backupErr);
      }
    }
    return db;
  })().catch((err) => {
    console.error('[sqlite] initDatabase falló; arranque de cero:', err?.message || err);
    allowEmptyPersist = true;
    return db;
  });

  return dbReady;
}

function pragmaTableColumnNames(table) {
  const rows = queryAll(`PRAGMA table_info(${table})`) || [];
  return rows
    .map((c) => {
      if (c && c.name != null && String(c.name).trim()) return String(c.name);
      if (c && c.NAME != null && String(c.NAME).trim()) return String(c.NAME);
      const vals = Object.values(c || {});
      return vals.length > 1 ? String(vals[1] || '') : '';
    })
    .filter(Boolean);
}

function hasUsersColumn(colName) {
  return pragmaTableColumnNames('users').includes(String(colName || '').trim());
}

const USERS_ROLE_CHECK_SQL =
  "CHECK(role IN ('admin','cajero','mozo','cocina','bar','delivery','produccion'))";

function readUsersTableCreateSql() {
  try {
    const row = queryOne("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!row) return '';
    return String(row.sql || row.SQL || '');
  } catch {
    return '';
  }
}

function isUsersRoleCheckError(err) {
  const msg = String(err?.message || err || '');
  return /CHECK constraint/i.test(msg) && /role/i.test(msg);
}

/** El CHECK real está en sqlite_master. Un UPDATE de prueba puede no tocar filas y dar falso positivo. */
function usersCreateSqlAllowsProduccionRole(sql) {
  const raw = String(sql || '');
  if (!raw.trim()) return false;
  const m = raw.match(/CHECK\s*\(\s*(?:["']?role["']?)\s+IN\s*\(([^)]*)\)/i);
  if (!m) return true;
  return /['"]produccion['"]/i.test(m[1]);
}

function probeUsersRoleAllowsProduccion() {
  return usersCreateSqlAllowsProduccionRole(readUsersTableCreateSql());
}

/** Tablas temporales de migraciones antiguas de `users` que quedaron como destino de FK tras renombrar. */
const DANGLING_USER_FK_TARGETS = ['users_legacy', 'users_role_mig'];

/**
 * Migraciones antiguas renombraron `users` y SQLite reescribió las FK de otras tablas hacia la temporal
 * (luego borrada). Resultado: «no such table: main.users_legacy» al insertar. Se reconstruye cada tabla
 * afectada con la FK apuntando otra vez a `users`, conservando todas las filas.
 */
function repairDanglingUserForeignKeys() {
  if (!db) return 0;
  const existing = new Set(
    (queryAll("SELECT name FROM sqlite_master WHERE type = 'table'") || []).map((r) => String(r.name)),
  );
  const targets = DANGLING_USER_FK_TARGETS.filter((t) => !existing.has(t));
  if (!targets.length) return 0;
  const refRe = new RegExp(`REFERENCES\\s+["'\`\\[]?(${targets.join('|')})["'\`\\]]?`, 'gi');
  const broken = (queryAll("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL") || [])
    .filter((r) => {
      refRe.lastIndex = 0;
      return refRe.test(String(r.sql || ''));
    });
  let repaired = 0;
  for (const row of broken) {
    const table = String(row.name);
    const tmp = `${table}__fkfix`;
    refRe.lastIndex = 0;
    const fixedSql = String(row.sql)
      .replace(refRe, 'REFERENCES users')
      .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?[^\s("'`\]]+["'`\]]?/i, `CREATE TABLE "${tmp}"`);
    const indexes = (queryAll(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
      [table],
    ) || []).map((r) => String(r.sql || '')).filter(Boolean);
    const cols = (queryAll(`PRAGMA table_info("${table}")`) || []).map((c) => `"${c.name}"`).join(', ');
    const before = Number(queryOne(`SELECT COUNT(*) AS c FROM "${table}"`)?.c || 0);
    db.run('PRAGMA foreign_keys = OFF');
    try {
      db.run('BEGIN IMMEDIATE');
      try {
        db.run(`DROP TABLE IF EXISTS "${tmp}"`);
        db.run(fixedSql);
        db.run(`INSERT INTO "${tmp}" (${cols}) SELECT ${cols} FROM "${table}"`);
        const after = Number(queryOne(`SELECT COUNT(*) AS c FROM "${tmp}"`)?.c || 0);
        if (after !== before) throw new Error(`copia incompleta (${after} de ${before})`);
        db.run(`DROP TABLE "${table}"`);
        db.run(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
        indexes.forEach((idxSql) => db.run(idxSql));
        db.run('COMMIT');
        repaired += 1;
        console.info(`[migration] FK reparada: ${table} → users (${before} fila(s))`);
      } catch (err) {
        try { db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error(`[migration] no se pudo reparar FK de ${table}:`, err.message || err);
      }
    } finally {
      try { db.run('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
    }
  }
  if (repaired) {
    try { flushSaveDb(); } catch { /* ignore */ }
  }
  return repaired;
}

/** El CHECK antiguo no incluye `produccion`; SQLite no deja ALTER CHECK, hay que recrear la tabla. */
function ensureUsersRoleAllowsProduccion() {
  if (!db) return false;
  if (probeUsersRoleAllowsProduccion()) return true;

  const cols = queryAll('PRAGMA table_info(users)') || [];
  if (!cols.length) return false;

  const ddlParts = cols.map((c) => {
    const name = String(c.name || c.NAME || '').trim();
    if (name === 'id') return 'id TEXT PRIMARY KEY';
    if (name === 'username') return 'username TEXT UNIQUE NOT NULL';
    if (name === 'email') return 'email TEXT UNIQUE NOT NULL';
    if (name === 'role') return `role TEXT NOT NULL ${USERS_ROLE_CHECK_SQL}`;
    const type = String(c.type || 'TEXT').trim() || 'TEXT';
    let piece = `${name} ${type}`;
    if (Number(c.notnull) === 1) piece += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined && String(c.dflt_value).trim() !== '') {
      /** PRAGMA devuelve expresiones sin paréntesis (datetime('now')); DEFAULT las exige entre paréntesis. */
      piece += ` DEFAULT (${c.dflt_value})`;
    }
    return piece;
  });

  const indexes = (queryAll(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL",
  ) || []).filter((idx) => String(idx.sql || idx.SQL || '').trim());
  const beforeCount = Number(queryOne('SELECT COUNT(*) AS c FROM users')?.c || 0);

  /**
   * Procedimiento oficial de SQLite para cambiar un CHECK: crear tabla nueva, copiar, borrar la vieja
   * y renombrar la nueva. Renombrar `users` primero reescribiría las FK de otras tablas hacia la temporal.
   * foreign_keys debe cambiarse fuera de la transacción.
   */
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.run('BEGIN IMMEDIATE');
    try {
      db.run('DROP TABLE IF EXISTS users_role_new');
      db.run(`CREATE TABLE users_role_new (\n${ddlParts.join(',\n')}\n)`);
      const destCols = (queryAll('PRAGMA table_info(users_role_new)') || []).map((c) => String(c.name));
      const srcCols = cols.map((c) => String(c.name || c.NAME || ''));
      const copy = destCols.filter((n) => srcCols.includes(n));
      db.run(`INSERT INTO users_role_new (${copy.join(', ')}) SELECT ${copy.join(', ')} FROM users`);
      const copied = Number(queryOne('SELECT COUNT(*) AS c FROM users_role_new')?.c || 0);
      if (copied !== beforeCount) {
        throw new Error(`copia incompleta de usuarios (${copied} de ${beforeCount})`);
      }
      db.run('DROP TABLE users');
      db.run('ALTER TABLE users_role_new RENAME TO users');
      for (const idx of indexes) {
        const idxSql = String(idx.sql || idx.SQL || '').trim();
        if (idxSql) db.run(idxSql);
      }
      db.run('COMMIT');
    } catch (err) {
      try { db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  } finally {
    try { db.run('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
  }
  console.info('[migration] users: CHECK de rol incluye produccion');
  try { flushSaveDb(); } catch { /* ignore */ }
  return true;
}

function productionRoleFallback(areaId) {
  return String(areaId || '').trim().toLowerCase() === 'bar' ? 'bar' : 'cocina';
}

function applyUserProductionArea(uid, aid, nextRole) {
  const hasArea = hasUsersColumn('production_area_id');
  const fallback = productionRoleFallback(aid);
  const rolesToTry = nextRole === fallback ? [nextRole] : [nextRole, fallback];
  let lastErr = null;
  for (const role of rolesToTry) {
    try {
      if (hasArea) {
        runSql('UPDATE users SET role = ?, production_area_id = ? WHERE id = ?', [role, aid, uid]);
      } else {
        runSql('UPDATE users SET role = ? WHERE id = ?', [role, uid]);
      }
      return role;
    } catch (err) {
      lastErr = err;
      if (!isUsersRoleCheckError(err)) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return nextRole;
}

function ensureProductionStaffPermissions(userId) {
  try {
    const user = queryOne('SELECT role, production_area_id FROM users WHERE id = ?', [userId]);
    const row = queryOne('SELECT permissions FROM user_permissions WHERE user_id = ?', [userId]);
    if (!row) return;
    let perms = {};
    try { perms = JSON.parse(row.permissions || '{}') || {}; } catch { perms = {}; }
    const { buildWorkModulePermissions } = require('./utils/staffWorkPermissions');
    const next = buildWorkModulePermissions(user?.role, user?.production_area_id);
    perms.produccion = next.produccion;
    perms.cocina = next.cocina;
    perms.bar = next.bar;
    runSql('UPDATE user_permissions SET permissions = ? WHERE user_id = ?', [JSON.stringify(perms), userId]);
  } catch (err) {
    console.warn('[users] permisos producción:', err.message || err);
  }
}

/** Persiste encargado de producción sin romper CHECK antiguo (cocina/bar). */
function assignUserProductionRole(userId, areaId) {
  const uid = String(userId || '').trim();
  const aid = String(areaId || '').trim();
  if (!uid) return;
  try {
    ensureUsersRoleAllowsProduccion();
  } catch (err) {
    console.warn('[users] no se pudo ampliar CHECK de rol:', err.message || err);
  }
  const current = queryOne('SELECT role FROM users WHERE id = ?', [uid]);
  if (!current) return;
  const roleLc = String(current.role || '').toLowerCase();
  if (!['produccion', 'cocina', 'bar', 'mozo'].includes(roleLc)) return;

  const allowsProduccion = probeUsersRoleAllowsProduccion();
  const nextRole = allowsProduccion ? 'produccion' : productionRoleFallback(aid);

  if (['produccion', 'cocina', 'bar'].includes(roleLc) && hasUsersColumn('production_area_id') && !allowsProduccion) {
    runSql('UPDATE users SET production_area_id = ? WHERE id = ?', [aid, uid]);
    ensureProductionStaffPermissions(uid);
    return;
  }

  applyUserProductionArea(uid, aid, nextRole);
  if (hasUsersColumn('caja_station_id') && roleLc === 'mozo') {
    try { runSql("UPDATE users SET caja_station_id = '' WHERE id = ?", [uid]); } catch { /* ignore */ }
  }
  ensureProductionStaffPermissions(uid);
}

function persistedProductionRole(areaId) {
  try {
    ensureUsersRoleAllowsProduccion();
  } catch (err) {
    console.warn('[users] no se pudo ampliar CHECK de rol:', err.message || err);
  }
  if (probeUsersRoleAllowsProduccion()) return 'produccion';
  return productionRoleFallback(areaId);
}

/** Añade columnas de users que el código espera (no falla el alta si el .db es antiguo). */
function ensureUsersSchemaColumns() {
  const needed = [
    ['caja_station_id', "ALTER TABLE users ADD COLUMN caja_station_id TEXT DEFAULT ''"],
    ['production_area_id', "ALTER TABLE users ADD COLUMN production_area_id TEXT DEFAULT ''"],
    ['production_area_ids', "ALTER TABLE users ADD COLUMN production_area_ids TEXT DEFAULT '[]'"],
    ['payroll_pay_mode', "ALTER TABLE users ADD COLUMN payroll_pay_mode TEXT DEFAULT ''"],
    ['payroll_amount', 'ALTER TABLE users ADD COLUMN payroll_amount REAL DEFAULT 0'],
    ['payroll_schedule_note', "ALTER TABLE users ADD COLUMN payroll_schedule_note TEXT DEFAULT ''"],
    ['payroll_payment_day', 'ALTER TABLE users ADD COLUMN payroll_payment_day INTEGER DEFAULT 0'],
    ['payroll_payment_method', "ALTER TABLE users ADD COLUMN payroll_payment_method TEXT DEFAULT ''"],
    ['payroll_payment_ref', "ALTER TABLE users ADD COLUMN payroll_payment_ref TEXT DEFAULT ''"],
    ['is_buyer_admin', 'ALTER TABLE users ADD COLUMN is_buyer_admin INTEGER DEFAULT 0'],
  ];
  let changed = false;
  const have = new Set(pragmaTableColumnNames('users'));
  for (const [col, ddl] of needed) {
    if (have.has(col)) continue;
    try {
      db.run(ddl);
      have.add(col);
      changed = true;
    } catch (err) {
      console.warn(`[migration] users ADD COLUMN ${col}:`, err?.message || err);
    }
  }
  if (changed) {
    try { saveDb(); } catch (_) { /* persist on next write */ }
  }
  return have;
}

function queryAll(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  const safeParams = normalizeSqlParams(params);
  if (safeParams.length) stmt.bind(safeParams);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  const safeParams = normalizeSqlParams(params);
  if (safeParams.length) stmt.bind(safeParams);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function runSql(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const safeParams = normalizeSqlParams(params);
  if (safeParams.length) {
    db.run(sql, safeParams);
  } else {
    db.run(sql);
  }
  scheduleSaveDb();
}

function withTransaction(work) {
  db.run('BEGIN IMMEDIATE');
  try {
    const tx = {
      queryAll,
      queryOne,
      run(sql, params = []) {
        const safeParams = normalizeSqlParams(params);
        if (safeParams.length) db.run(sql, safeParams);
        else db.run(sql);
      },
    };
    const result = work(tx);
    db.run('COMMIT');
    flushSaveDb();
    return result;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch (_) {
      // noop
    }
    throw err;
  }
}

function getNextOrderNumber() {
  db.run('UPDATE order_sequence SET current_number = current_number + 1 WHERE id = 1');
  const result = queryOne('SELECT current_number FROM order_sequence WHERE id = 1');
  flushSaveDb();
  return result.current_number;
}

function logAudit({ actorUserId = '', actorName = '', action, resourceType = '', resourceId = '', details = {} }) {
  if (!action) return;
  runSql(
    'INSERT INTO audit_logs (id, actor_user_id, actor_name, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), actorUserId, actorName, action, resourceType, resourceId, JSON.stringify(details || {})]
  );
}

function seedData() {
  const count = queryOne('SELECT COUNT(*) as c FROM restaurants');
  if (count.c > 0) return;

  const restaurantId = uuidv4();
  db.run(
    'INSERT INTO restaurants (id, name, address, phone, email, schedule) VALUES (?, ?, ?, ?, ?, ?)',
    [
      restaurantId,
      'Resto Fadey App',
      '',
      '',
      '',
      JSON.stringify(getDefaultSchedule()),
    ]
  );
  /* Sin usuarios por defecto: el administrador maestro crea el primer admin en /master */
}

function ensureOperationalUsers() {
  const bootstrapModeRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['bootstrap_mode']);
  let bootstrapMode = 'sale_ready';
  try {
    bootstrapMode = JSON.parse(bootstrapModeRow?.value || '{}')?.mode || 'sale_ready';
  } catch (_) {
    bootstrapMode = 'sale_ready';
  }
  /* Solo en modo explícito "demo" se crean usuarios cocina/bar/delivery automáticos */
  if (bootstrapMode !== 'demo') return;

  const restaurant = queryOne('SELECT id FROM restaurants LIMIT 1');
  if (!restaurant?.id) return;
  const defaults = [
    { username: 'cocina', email: 'cocina@saborperuano.pe', password: 'cocina123', full_name: 'Operador Cocina', role: 'cocina' },
    { username: 'bar', email: 'bar@saborperuano.pe', password: 'bar123', full_name: 'Operador Bar', role: 'bar' },
    { username: 'delivery', email: 'delivery@saborperuano.pe', password: 'delivery123', full_name: 'Operador Delivery', role: 'delivery' },
  ];
  defaults.forEach((user) => {
    const existing = queryOne('SELECT id, is_active FROM users WHERE username = ? OR email = ?', [user.username, user.email]);
    if (existing) {
      if (Number(existing.is_active) !== 1) {
        db.run('UPDATE users SET is_active = 1 WHERE id = ?', [existing.id]);
      }
      return;
    }
    db.run(
      'INSERT INTO users (id, username, email, password_hash, full_name, role, restaurant_id, is_active, phone, avatar, caja_station_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [uuidv4(), user.username, user.email, bcrypt.hashSync(user.password, 10), user.full_name, user.role, restaurant.id, '', '', '']
    );
  });
}

function seedTables() {
  const bootstrapModeRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['bootstrap_mode']);
  let bootstrapMode = 'sale_ready';
  try {
    bootstrapMode = JSON.parse(bootstrapModeRow?.value || '{}')?.mode || 'sale_ready';
  } catch (_) {
    bootstrapMode = 'sale_ready';
  }
  if (bootstrapMode !== 'demo') return;

  const tableCount = queryOne('SELECT COUNT(*) as c FROM tables');
  if (tableCount.c > 0) return;

  const restaurant = queryOne('SELECT id FROM restaurants LIMIT 1');
  if (!restaurant) return;

  for (let i = 1; i <= 5; i++) {
    db.run(
      'INSERT INTO tables (id, number, name, capacity, zone, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), i, `Mesa ${i}`, 4, 'principal', restaurant.id]
    );
  }
}

function seedWarehouses() {
  const bootstrapModeRow = queryOne('SELECT value FROM app_settings WHERE key = ?', ['bootstrap_mode']);
  let bootstrapMode = 'sale_ready';
  try {
    bootstrapMode = JSON.parse(bootstrapModeRow?.value || '{}')?.mode || 'sale_ready';
  } catch (_) {
    bootstrapMode = 'sale_ready';
  }
  if (bootstrapMode !== 'demo') return;

  const defaults = [
    { id: uuidv4(), name: 'Almacen Principal', description: 'Almacen principal de ventas directas' },
    { id: uuidv4(), name: 'Almacen Cocina', description: 'Almacen para cocina y transformados' },
  ];
  defaults.forEach(w => {
    db.run(
      'INSERT OR IGNORE INTO warehouse_locations (id, name, description, is_active, linked_insumos) VALUES (?, ?, ?, 1, 0)',
      [w.id, w.name, w.description]
    );
  });
}

function getOrderColumnSet() {
  return new Set(pragmaTableColumnNames('orders'));
}

function ensureOrdersPaymentNoteColumn() {
  if (!db) return false;
  try {
    if (getOrderColumnSet().has('payment_note')) return true;
    runSql("ALTER TABLE orders ADD COLUMN payment_note TEXT DEFAULT ''");
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) {
      console.warn('[ensureOrdersPaymentNoteColumn]', e.message || e);
    }
  }
  return getOrderColumnSet().has('payment_note');
}

function ensureLoyaltySurveysTable() {
  if (!db) return;
  try {
    runSql(`
      CREATE TABLE IF NOT EXISTS loyalty_surveys (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        comment TEXT DEFAULT '',
        rating INTEGER NOT NULL,
        answers_json TEXT DEFAULT '{}',
        waiter_user_id TEXT DEFAULT '',
        waiter_name TEXT DEFAULT '',
        visit_date TEXT DEFAULT '',
        visit_area TEXT DEFAULT '',
        party_size INTEGER DEFAULT 0,
        liked_json TEXT DEFAULT '[]',
        improve_json TEXT DEFAULT '[]',
        liked_other TEXT DEFAULT '',
        improve_other TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('[migration] create loyalty_surveys:', e?.message || e);
  }
  const needed = [
    ['waiter_user_id', "ALTER TABLE loyalty_surveys ADD COLUMN waiter_user_id TEXT DEFAULT ''"],
    ['waiter_name', "ALTER TABLE loyalty_surveys ADD COLUMN waiter_name TEXT DEFAULT ''"],
    ['visit_date', "ALTER TABLE loyalty_surveys ADD COLUMN visit_date TEXT DEFAULT ''"],
    ['visit_area', "ALTER TABLE loyalty_surveys ADD COLUMN visit_area TEXT DEFAULT ''"],
    ['party_size', 'ALTER TABLE loyalty_surveys ADD COLUMN party_size INTEGER DEFAULT 0'],
    ['liked_json', "ALTER TABLE loyalty_surveys ADD COLUMN liked_json TEXT DEFAULT '[]'"],
    ['improve_json', "ALTER TABLE loyalty_surveys ADD COLUMN improve_json TEXT DEFAULT '[]'"],
    ['liked_other', "ALTER TABLE loyalty_surveys ADD COLUMN liked_other TEXT DEFAULT ''"],
    ['improve_other', "ALTER TABLE loyalty_surveys ADD COLUMN improve_other TEXT DEFAULT ''"],
  ];
  /** Siempre intentar ALTER: en Render/sql.js el PRAGMA a veces no refleja columnas a tiempo. */
  for (const [colName, ddl] of needed) {
    try {
      runSql(ddl);
      console.log(`[migration] loyalty_surveys.${colName} añadida`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/duplicate column|already exists/i.test(msg)) {
        console.warn(`[migration] loyalty_surveys.${colName}:`, msg);
      }
    }
  }
  try {
    runSql('CREATE INDEX IF NOT EXISTS idx_loyalty_surveys_created_at ON loyalty_surveys(created_at)');
  } catch (_) {
    /* noop */
  }
  try {
    runSql('CREATE INDEX IF NOT EXISTS idx_loyalty_surveys_waiter ON loyalty_surveys(waiter_user_id)');
  } catch (e) {
    console.warn('[migration] loyalty_surveys waiter index:', e?.message || e);
  }
}

function ensureOrdersPaidAtColumns() {
  try {
    if (!db) return false;
    const names = getOrderColumnSet();
    let repaired = false;
    if (!names.has('cash_register_id')) {
      runSql("ALTER TABLE orders ADD COLUMN cash_register_id TEXT DEFAULT ''");
      repaired = true;
    }
    if (!names.has('paid_at')) {
      runSql("ALTER TABLE orders ADD COLUMN paid_at TEXT DEFAULT NULL");
      repaired = true;
    }
    if (repaired) {
      runSql('CREATE INDEX IF NOT EXISTS idx_orders_cash_register_id ON orders(cash_register_id)');
      runSql(
        `UPDATE orders SET paid_at = COALESCE(updated_at, created_at)
         WHERE payment_status = 'paid' AND (paid_at IS NULL OR trim(paid_at) = '')`,
      );
      console.log('[migration] ensure orders.cash_register_id / paid_at');
    }
    const after = getOrderColumnSet();
    return after.has('paid_at');
  } catch (e) {
    console.error('[ensureOrdersPaidAtColumns]', e.message || e);
    return false;
  }
}

/** Columnas que Informes / Indicadores necesitan en backups antiguos. */
function ensureOrdersReportColumns() {
  ensureOrdersPaidAtColumns();
  if (!db) return false;
  const needed = [
    ['sale_number', 'ALTER TABLE orders ADD COLUMN sale_number INTEGER'],
    ['tip_amount', 'ALTER TABLE orders ADD COLUMN tip_amount REAL NOT NULL DEFAULT 0'],
    ['payment_breakdown', 'ALTER TABLE orders ADD COLUMN payment_breakdown TEXT DEFAULT NULL'],
    ['payment_note', "ALTER TABLE orders ADD COLUMN payment_note TEXT DEFAULT ''"],
    ['created_by_user_id', "ALTER TABLE orders ADD COLUMN created_by_user_id TEXT DEFAULT ''"],
    ['created_by_user_name', "ALTER TABLE orders ADD COLUMN created_by_user_name TEXT DEFAULT ''"],
    ['sale_document_type', "ALTER TABLE orders ADD COLUMN sale_document_type TEXT DEFAULT 'nota_venta'"],
    ['sale_document_number', "ALTER TABLE orders ADD COLUMN sale_document_number TEXT DEFAULT ''"],
  ];
  for (const [colName, ddl] of needed) {
    try {
      if (getOrderColumnSet().has(colName)) continue;
      runSql(ddl);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/duplicate column/i.test(msg)) {
        console.warn('[ensureOrdersReportColumns]', colName, msg);
      }
    }
  }
  return getOrderColumnSet().has('sale_number');
}

module.exports = {
  getDb,
  initDatabase,
  getDatabasePersistenceInfo,
  getNextOrderNumber,
  queryAll,
  queryOne,
  runSql,
  saveDb,
  flushSaveDb,
  createSafetyBackup,
  checkDatabaseIntegrity,
  getDbPath,
  createBackupFile,
  restoreDbFromBuffer,
  resetOperationalData,
  withTransaction,
  logAudit,
  ensureOrdersPaidAtColumns,
  ensureOrdersReportColumns,
  ensureLoyaltySurveysTable,
  getOrderColumnSet,
  ensureOrdersPaymentNoteColumn,
  hasUsersColumn,
  ensureUsersSchemaColumns,
  ensureUsersRoleAllowsProduccion,
  assignUserProductionRole,
  persistedProductionRole,
};
