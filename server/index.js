require('dotenv').config();
const path = require('path');

/** En Render, si arrancan `node server/index.js` sin render-start.sh, redirigir al script correcto. */
if (String(process.env.RENDER || '').toLowerCase() === 'true' && !process.env._RENDER_START_WRAPPER) {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'render-start.sh');
  console.warn('[render] Start debe ser bash scripts/render-start.sh — redirigiendo…');
  const result = spawnSync('bash', [script], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

const { getToken: getPadronConsultaToken } = require('./peruConsultaPadron');
if (!getPadronConsultaToken()) {
  console.warn(
    '[consulta padrón] Defina PERU_CONSULTAS_TOKEN o DECOLECTA_API_KEY (https://decolecta.com/profile) para el botón DNI/RUC en caja.'
  );
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const {
  initDatabase,
  getDbPath,
  getDatabasePersistenceInfo,
  flushSaveDb,
  createSafetyBackup,
  checkDatabaseIntegrity,
} = require('./database');
const { ensureUploadsRoot } = require('./uploadsPath');
const jwt = require('jsonwebtoken');
const { authenticateToken, authenticateTokenAllowLoopback, requireRole, JWT_SECRET } = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rateLimit');

const app = express();
const server = http.createServer(app);

/** En Render/Railway el API es público; en PC local el bridge debe aceptar el origen de la PWA (Vercel) y localhost. */
function isCloudDeployment() {
  return String(process.env.RENDER || '').toLowerCase() === 'true' || !!process.env.RAILWAY_ENVIRONMENT;
}

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegex(rule) {
  const escaped = escapeRegex(rule).replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function isOriginAllowed(origin) {
  // Electron empaquetado (file://) suele enviar Origin "null".
  if (!origin || origin === 'null') return true;
  if (!isCloudDeployment()) {
    if (/\.vercel\.app$/i.test(origin)) return true;
    if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return true;
    if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;
  }
  if (!corsOrigins.length) return true;
  if (corsOrigins.includes(origin)) return true;
  return corsOrigins
    .filter(rule => rule.includes('*'))
    .some((rule) => wildcardToRegex(rule).test(origin));
}

const corsOptions = {
  origin(origin, cb) {
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-Requested-With', 'X-Backup-Bytes', 'Access-Control-Request-Private-Network',
    'Cache-Control', 'Pragma',
  ],
  exposedHeaders: ['X-Refreshed-Token'],
};
const io = new Server(server, {
  cors: corsOptions,
});

{
  const { attachTableDisplayLabels } = require('./utils/tableDisplayLabel');
  const rawEmit = io.emit.bind(io);
  io.emit = (event, payload, ...rest) => {
    if ((event === 'new-order' || event === 'order-update') && payload && typeof payload === 'object'
      && payload.type === 'dine_in' && !payload.table_display_label) {
      try {
        attachTableDisplayLabels(payload);
      } catch (_) {
        /* la etiqueta es opcional */
      }
    }
    return rawEmit(event, payload, ...rest);
  };
}

app.set('io', io);
const { setSocketIo } = require('./socketBroadcast');
setSocketIo(io);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  req.requestId = requestId;
  next();
});
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    console.log(JSON.stringify({
      level: 'info',
      msg: 'http_request',
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      elapsed_ms: elapsed,
    }));
  });
  next();
});

let uploadsDir;
try {
  uploadsDir = ensureUploadsRoot();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
const billingCertsDir = path.join(uploadsDir, 'billing-certs');
if (!fs.existsSync(billingCertsDir)) fs.mkdirSync(billingCertsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
const productImagesDir = path.join(__dirname, '..', 'imagenes qr');
if (fs.existsSync(productImagesDir)) {
  app.use('/imagenes-qr', express.static(productImagesDir));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext && uploadExtByMime[mime]) ext = uploadExtByMime[mime];
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`);
  }
});
const uploadExtByMime = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const uploadImageExtOk = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.heic', '.heif', '.avif', '.bmp', '.pdf']);
const uploadWordExtOk = new Set(['.doc', '.docx']);
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedMime = new Set([
      'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif',
      'image/svg+xml', 'image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/x-ms-bmp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    if (allowedMime.has(mime)) return cb(null, true);
    if ((mime === 'application/octet-stream' || !mime) && uploadImageExtOk.has(ext)) return cb(null, true);
    if ((mime === 'application/octet-stream' || !mime) && uploadWordExtOk.has(ext)) return cb(null, true);
    return cb(new Error('Tipo de archivo no permitido (imagen, PDF o Word .doc / .docx)'));
  },
});

app.post('/api/upload', authenticateToken, requireRole('admin', 'cajero', 'mozo', 'master_admin'), (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo supera el límite de 15 MB' });
      }
      return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

const certStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, billingCertsDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    const safe = ext === '.p12' ? '.p12' : '.pfx';
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${safe}`);
  },
});
const certUpload = multer({
  storage: certStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (ext !== '.pfx' && ext !== '.p12') {
      return cb(new Error('Solo archivos .pfx o .p12'));
    }
    return cb(null, true);
  },
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/upload/billing-cert', authenticateToken, requireRole('admin', 'master_admin'), (req, res) => {
  certUpload.single('cert')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'No se pudo guardar el certificado' });
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
    res.json({ url: `/uploads/billing-certs/${req.file.filename}` });
  });
});

app.get('/api/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime(), bridge: 'restaurant-node' }));

function readPrintingAssistantOriginFromBridgeFile() {
  try {
    const cfgPath = String(process.env.PRINTING_CONFIG_PATH || '').trim();
    const baseDir = cfgPath ? path.dirname(cfgPath) : '';
    if (!baseDir) return '';
    const bridgeFile = path.join(baseDir, 'printing-bridge-port.json');
    if (!fs.existsSync(bridgeFile)) return '';
    const raw = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    const port = Number(raw?.port);
    if (!Number.isFinite(port) || port <= 0) return '';
    return `http://127.0.0.1:${port}`;
  } catch (_) {
    return '';
  }
}

/** Instalación Windows: el front local descubre impresión sin escanear puertos del asistente. */
app.get('/api/printing/bridge', (req, res) => {
  const port = Number(process.env.PORT) || 3001;
  const printingAssistantOrigin = readPrintingAssistantOriginFromBridgeFile();
  res.json({
    status: 'ok',
    mode: 'embedded',
    port,
    origin: `http://127.0.0.1:${port}`,
    service: 'resto-fadey-embedded-api',
    printingAssistantOrigin: printingAssistantOrigin || undefined,
  });
});
app.get('/api/readyz', async (req, res) => {
  try {
    await initDatabase();
    res.json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/customer/login', authLimiter);

app.use('/api/public/self-order', require('./routes/publicSelfOrder'));
app.use('/api/public/loyalty', require('./routes/publicLoyalty'));
app.use('/api/fadey', require('./routes/publicFadey'));
app.use('/fadey', require('./routes/publicFadey'));
app.get('/api/local', (req, res) => {
  try {
    const { buildPublicRestaurantDiscoveryPayload, touchSaasLastActivity } = require('./services/posSaasIdentityService');
    touchSaasLastActivity();
    return res.json(buildPublicRestaurantDiscoveryPayload());
  } catch (err) {
    return res.status(500).json({ error: err.message || 'No se pudo obtener el perfil del restaurante' });
  }
});
app.use('/api/loyalty', require('./routes/loyalty'));
app.use('/api/system', require('./routes/system'));
app.use('/api/license', require('./routes/license'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/push', require('./routes/push'));
app.use('/api/restaurant', require('./routes/restaurant'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/production-areas', require('./routes/productionAreas'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/users', require('./routes/users'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/staff-chat', require('./routes/staffChat'));
app.use('/api/fadey-ai', require('./routes/fadeyAi'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/kardex-inventory', require('./routes/kardexInventory'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/admin-modules', require('./routes/adminModules'));
app.use('/api/promotions', require('./routes/promotions'));
app.use('/api/contrato', require('./routes/contractSignature'));
app.use('/api/business-config', require('./routes/businessConfig'));
const { getPrinters } = require('./printing/printerDetector');
app.get('/printers', (req, res) => {
  try {
    const mod = String(req.query.module || '').trim().toLowerCase();
    const list = getPrinters().map((p) => ({ name: p.name }));
    console.log(
      `[printing] GET /printers → ${list.length} impresora(s)${mod ? ` (módulo solicitante: ${mod})` : ''}`,
    );
    res.json(list);
  } catch (err) {
    console.error('[printing] error GET /printers:', err.message || err);
    res.status(500).json({ error: 'No se pudieron detectar impresoras' });
  }
});
/** Alias solicitado: GET /api/printers → [{ "name": "..." }] (misma auth que /api/printing/printers). */
app.get(
  '/api/printers',
  authenticateTokenAllowLoopback,
  requireRole('admin', 'master_admin', 'cajero', 'mozo', 'cocina', 'bar'),
  (req, res) => {
    const mod = String(req.query.module || '').trim().toLowerCase();
    const list = getPrinters().map((p) => ({ name: p.name }));
    console.log(
      `[printing] GET /api/printers → ${list.length} impresora(s)${mod ? ` (módulo solicitante: ${mod})` : ''}`,
    );
    res.json(list);
  },
);
app.use('/api/printing', require('./routes/printing'));
app.use('/api/master-admin', require('./routes/masterAdmin'));
if (!process.env.ELECTRON_RUN_AS_NODE) {
  app.use('/api/central-sync', require('./routes/centralSync'));
  app.use('/api/platform-payments', require('./routes/platformPayments'));
}
const billingRoutes = require('./routes/billing');
app.use('/api/billing', billingRoutes);

app.use((err, req, res, next) => {
  if (!err) return next();
  const path = String(req.originalUrl || '');
  let fallback = 'Ocurrió un error. Intente nuevamente.';
  if (path.includes('/orders')) fallback = 'No se pudo procesar el pedido. Intente nuevamente.';
  else if (path.includes('/categories')) fallback = 'Error al guardar la categoría. Intente nuevamente.';
  const raw = String(err.message || '').trim();
  const safe =
    !raw || raw === 'undefined' || /^internal server error$/i.test(raw) ? fallback : raw;
  console.error(JSON.stringify({
    level: 'error',
    msg: 'unhandled_error',
    request_id: req.requestId,
    path: req.originalUrl,
    method: req.method,
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  }));
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: safe });
  }
});

const clientBuild = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => res.sendFile(path.join(clientBuild, 'index.html')));
}

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  socket.on('join-staff', (payload) => {
    try {
      const token = payload?.token;
      if (!token) return;
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type === 'customer') return;
      if (!decoded.id) return;
      const role = String(decoded.role || '').toLowerCase();
      const staffRoles = new Set(['admin', 'cajero', 'mozo', 'cocina', 'bar', 'delivery', 'produccion', 'master_admin']);
      if (role && !staffRoles.has(role)) return;
      socket.join(`staff-${decoded.id}`);
      socket.join('staff-broadcast');
    } catch (_) {
      /* token inválido: ignorar */
    }
  });
  socket.on('join-kitchen', () => { socket.join('kitchen'); });
  socket.on('join-bar', () => { socket.join('bar'); });
  socket.on('join-delivery', (driverId) => { socket.join(`delivery-${driverId}`); });
  socket.on('join-customer', (customerId) => { socket.join(`customer-${customerId}`); });
  socket.on('disconnect', () => { console.log(`Desconectado: ${socket.id}`); });
});

const PORT = Number(process.env.PORT) || 3001;
const LISTEN_HOST = process.env.LISTEN_HOST || (isCloudDeployment() ? '0.0.0.0' : '127.0.0.1');

function logSqlitePersistenceWarnings() {
  const info = getDatabasePersistenceInfo();
  const normalized = String(info.path || '').replace(/\\/g, '/');
  const onRender = String(process.env.RENDER || '').toLowerCase() === 'true';
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT;
  const cloudEphemeralHost = onRender || onRailway;

  const persistentMount =
    normalized.startsWith('/data/') ||
    normalized === '/data/restaurant.db' ||
    normalized.startsWith('/mnt/') ||
    normalized.startsWith('/var/persistent/');

  if (!info.fileExistedBeforeInit) {
    console.warn(`
********************************************************************************
* [SQLite] Se creó o encontró una base NUEVA (vacía) en: ${info.path}
* Si ya tenías productos/usuarios y desaparecieron: no los borró el código del
* deploy; estás usando otra ruta o un disco EFÍMERO (típico en Render sin Disk).
********************************************************************************
`);
  }

  if (cloudEphemeralHost && !persistentMount) {
    console.error(`
********************************************************************************
* [CRÍTICO] Riesgo de PERDER DATOS en cada deploy / rebuild
* El archivo SQLite está fuera de un volumen persistente (${info.path}).
* Sin Disk + DB_PATH, Render/Railway recrean el contenedor y el .db desaparece.
*
* Render: Service → Disks → Add disk → Mount path: /data
* Environment: DB_PATH=/data/restaurant.db  (sin comillas, ruta absoluta)
* Luego Manual Deploy. Guía: DEPLOY_GITHUB_VERCEL_RENDER.md sección 1b
********************************************************************************
`);
  } else if (cloudEphemeralHost && persistentMount) {
    console.log(`[SQLite] DB_PATH parece volumen persistente: ${info.path} (motor ${info.engine})`);
  }
}

async function start() {
  try {
    await initDatabase();
    try {
      const { ensureStaffWorkModulePermissions } = require('./utils/staffWorkPermissions');
      const perms = ensureStaffWorkModulePermissions();
      if (!perms.skipped && perms.updated) {
        console.log(`[permisos] Personal alineado a su módulo de trabajo: ${perms.updated}`);
      }
    } catch (permErr) {
      console.warn('[permisos] no se pudieron alinear los módulos de trabajo:', permErr.message || permErr);
    }
  } catch (err) {
    console.error('[server] initDatabase no bloquea el arranque (maestro puede restaurar .db):', err.message || err);
  }
  try {
    require('./services/promotionService').ensureLegacyMigrated();
  } catch (err) {
    console.warn('[promotions] migración inicial:', err.message || err);
  }
  try {
    const { ensureUserWorkSessionSchema } = require('./utils/ensureUserWorkSessionSchema');
    ensureUserWorkSessionSchema();
    const { backfillOpenSessionActivity, closeStaleOpenWorkSessions } = require('./services/workSessionService');
    backfillOpenSessionActivity();
    closeStaleOpenWorkSessions();
    setInterval(() => {
      try {
        closeStaleOpenWorkSessions();
      } catch (err) {
        console.warn('[work-session] auto-cierre inactividad:', err.message || err);
      }
    }, 60 * 60 * 1000);
  } catch (err) {
    console.warn('[db] user_work_sessions schema (startup):', err.message || err);
  }
  try {
    const { ensureOrdersSchema } = require('./utils/ensureOrdersSchema');
    ensureOrdersSchema();
  } catch (err) {
    console.warn('[db] orders schema (startup):', err.message || err);
  }
  try {
    const { ensureHrSchema } = require('./utils/ensureHrSchema');
    ensureHrSchema();
  } catch (err) {
    console.warn('[db] hr schema (startup):', err.message || err);
  }
  try {
    const { ensureFadeyAiSchema } = require('./services/fadeyAi/ensureFadeyAiSchema');
    ensureFadeyAiSchema();
  } catch (err) {
    console.warn('[db] fadey-ai schema (startup):', err.message || err);
  }
  try {
    require('./masterAdminService').migrateServicePlanKeysV2();
  } catch (err) {
    console.warn('[plan] migración de planes:', err.message || err);
  }
  try {
    const { ensureFadeyAiEnabledByDefault } = require('./masterAdminService');
    ensureFadeyAiEnabledByDefault();
  } catch (err) {
    console.warn('[fadey-ai] default enable:', err.message || err);
  }
  try {
    const { repairKitchenOrdersAtStartup } = require('./services/kitchenOrderRepairService');
    repairKitchenOrdersAtStartup();
  } catch (err) {
    console.warn('[kitchen-repair] no ejecutada:', err.message || err);
  }
  try {
    const { migrateCatalogNamesToUppercase } = require('./services/catalogNameMigration');
    migrateCatalogNamesToUppercase();
  } catch (err) {
    console.warn('[catalog-names] migración no ejecutada:', err.message || err);
  }
  if (!process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { initPosSaasIdentity } = require('./services/posSaasIdentityService');
      initPosSaasIdentity();
    } catch (err) {
      console.warn('[saas-pos] identidad no inicializada:', err.message || err);
    }
  }
  logSqlitePersistenceWarnings();
  console.log(`[DB] SQLite path: ${getDbPath()} (${getDatabasePersistenceInfo().engine})`);
  console.log(`[uploads] Archivos estáticos en: ${uploadsDir}`);
  console.log('[printing] Bridge de impresión: rutas /api/printing/* y GET /api/printers (USB vía Node en esta máquina).');
  if (typeof billingRoutes.startBillingAutoRetryJob === 'function') {
    billingRoutes.startBillingAutoRetryJob();
  }
  if (!process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { startPlatformPaymentPoller } = require('./services/platformPaymentService');
      startPlatformPaymentPoller();
    } catch (err) {
      console.warn('[platform-payment] poller no iniciado:', err.message || err);
    }
  }
  try {
    const { startProductSalesMidnightJob } = require('./services/productSalesTrackingService');
    startProductSalesMidnightJob();
  } catch (err) {
    console.warn('[product-sales-idle] job nocturno no iniciado:', err.message || err);
  }
  try {
    const { startReservationScheduler } = require('./services/reservationSchedulerService');
    startReservationScheduler();
  } catch (err) {
    console.warn('[reservation-scheduler] no iniciado:', err.message || err);
  }
  try {
    const { processStationAutoDismiss } = require('./services/stationAutoDismissService');
    setInterval(() => {
      try {
        processStationAutoDismiss({ io });
      } catch (err) {
        console.warn('[station-auto-dismiss] intervalo:', err.message || err);
      }
    }, 60 * 1000);
  } catch (err) {
    console.warn('[station-auto-dismiss] no iniciado:', err.message || err);
  }
  try {
    const { advanceStaffChatCycleIfDue } = require('./staffChatService');
    setInterval(() => {
      try {
        advanceStaffChatCycleIfDue();
      } catch (err) {
        console.warn('[staff-chat] reinicio 24h:', err.message || err);
      }
    }, 15 * 60 * 1000);
  } catch (err) {
    console.warn('[staff-chat] intervalo no iniciado:', err.message || err);
  }
  try {
    const { runFadeyAiMonitorCycle } = require('./services/fadeyAi/fadeyAiMonitorService');
    const { purgeFadeyAiChatIfNewDay } = require('./services/fadeyAi/fadeyAiChatService');
    const { flushAiTrainingQuestions } = require('./services/fadeyAi/fadeyAiQuestionExport');
    const flushTrainingQuestions = () => {
      flushAiTrainingQuestions()
        .catch((err) => {
          console.warn('[fadey-ai] envío de preguntas:', err.message || err);
        })
        .finally(() => {
          try {
            purgeFadeyAiChatIfNewDay();
          } catch (err) {
            console.warn('[fadey-ai] purge chat:', err.message || err);
          }
        });
    };
    setInterval(() => {
      try {
        runFadeyAiMonitorCycle();
      } catch (err) {
        console.warn('[fadey-ai] monitor:', err.message || err);
      }
    }, 20 * 60 * 1000);
    setInterval(() => {
      flushTrainingQuestions();
    }, 60 * 1000);
    setTimeout(() => {
      try {
        runFadeyAiMonitorCycle();
      } catch (_) {
        /* noop */
      }
      flushTrainingQuestions();
    }, 45 * 1000);
  } catch (err) {
    console.warn('[fadey-ai] monitor no iniciado:', err.message || err);
  }
  try {
    const persist = getDatabasePersistenceInfo();
    if (persist.cloudSyncFolder) {
      console.warn(
        `[sqlite] ATENCIÓN: la base está dentro de una carpeta sincronizada (${persist.path}). `
        + 'OneDrive/Dropbox pueden bloquear o revertir el archivo. Use DB_PATH fuera de esa carpeta.',
      );
    }
    checkDatabaseIntegrity();
  } catch (err) {
    console.warn('[sqlite] verificación inicial:', err.message || err);
  }
  setTimeout(() => {
    try {
      createSafetyBackup({ force: true });
    } catch (err) {
      console.warn('[sqlite-backup] copia inicial:', err.message || err);
    }
  }, 60 * 1000);
  setInterval(() => {
    try {
      createSafetyBackup();
    } catch (err) {
      console.warn('[sqlite-backup] copia periódica:', err.message || err);
    }
  }, 10 * 60 * 1000);
  const flushSqliteOnExit = (signal) => {
    try {
      flushSaveDb();
      createSafetyBackup({ force: true });
    } catch (err) {
      console.warn('[sqlite] flush al salir:', err.message || err);
    }
    if (signal) process.exit(0);
  };
  process.on('SIGTERM', () => flushSqliteOnExit('SIGTERM'));
  process.on('SIGINT', () => flushSqliteOnExit('SIGINT'));
  /** App de escritorio (Windows no entrega SIGTERM): Electron pide el cierre por IPC. */
  if (typeof process.send === 'function') {
    process.on('message', (msg) => {
      if (msg && msg.type === 'resto-shutdown') flushSqliteOnExit('ipc');
    });
    process.on('disconnect', () => flushSqliteOnExit('ipc-disconnect'));
  }
  process.on('beforeExit', () => {
    try {
      flushSaveDb();
    } catch (err) {
      console.warn('[sqlite] flush beforeExit:', err.message || err);
    }
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[server] puerto ocupado: ${LISTEN_HOST}:${PORT}. Cierre la instancia previa o cambie PORT.`);
      return;
    }
    console.error('[server] error en el socket HTTP:', err.message || err);
  });
  if (isCloudDeployment() && !corsOrigins.length) {
    console.warn(
      '[CRÍTICO] CORS_ORIGIN vacío en Render. Defina la URL de su front (Vercel o dominio propio) en Environment.',
    );
  }

  server.listen(PORT, LISTEN_HOST, () => {
    const localUrl = `http://${LISTEN_HOST === '0.0.0.0' ? '127.0.0.1' : LISTEN_HOST}:${PORT}`;
    console.log(`[server] escuchando en http://${LISTEN_HOST}:${PORT} (acceso local típico: ${localUrl})`);
    if (corsOrigins.length) {
      console.log(`[server] CORS_ORIGIN: ${corsOrigins.join(', ')}`);
    }
    console.log(`
======================================================
   RESTAURANT PLATFORM - SERVIDOR ACTIVO
   Host: ${LISTEN_HOST}  Puerto: ${PORT}
   Base de datos: ${getDbPath()}
   Impresión USB: ejecute este proceso en la PC caja (no se inicia solo desde el navegador/PWA).
   Staff: el administrador se crea desde el panel de control.
   Datos: en la nube use disco persistente y DB_PATH (ver .env.example).
======================================================
    `);
  });
}

start().catch((err) => {
  console.error('[server] error al iniciar la aplicación:', err.message || err);
  process.exit(1);
});
