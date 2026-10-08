/**
 * Aviso de cierre de caja al correo del administrador del restaurante.
 * Prioridad de envío: SMTP (correo real al admin) → Resend API → Formspree (solo respaldo;
 * Formspree entrega al dueño del formulario en formspree.io, no al campo to_email).
 */
const { queryOne } = require('../database');

const DEFAULT_CASH_CLOSE_FORM_URL = 'https://formspree.io/f/mlgpdblo';

function getCashCloseFormUrl() {
  const raw = process.env.CASH_CLOSE_FORM_URL;
  const trimmed = String(raw || '').trim();
  return trimmed || DEFAULT_CASH_CLOSE_FORM_URL;
}

/**
 * @returns {{ email: string, name: string }}
 */
function getCashCloseRecipient() {
  const adminRow = queryOne(
    `SELECT email, full_name, username FROM users
     WHERE lower(trim(coalesce(role, ''))) = 'admin'
       AND COALESCE(is_active, 1) = 1
       AND trim(coalesce(email, '')) != ''
     ORDER BY datetime(created_at) DESC
     LIMIT 1`
  );
  if (adminRow?.email) {
    return {
      email: String(adminRow.email).trim(),
      name: String(adminRow.full_name || adminRow.username || 'Administrador').trim() || 'Administrador',
    };
  }
  const env = String(process.env.CASH_CLOSE_EMAIL || '').trim();
  if (env) return { email: env, name: 'Administrador' };
  const r = queryOne('SELECT email FROM restaurants LIMIT 1');
  const re = String(r?.email || '').trim();
  if (re) return { email: re, name: 'Restaurante' };
  return { email: '', name: '' };
}

function buildCashCloseContent({
  register,
  sales,
  movements,
  expectedCash,
  countedCash,
  difference,
  notes,
  closedByName,
  toEmail,
  recipientName,
  stationName = '',
  responsibleName = '',
}) {
  const restaurant = queryOne('SELECT name FROM restaurants LIMIT 1');
  const restaurantName = restaurant?.name || 'Resto-FADEY';
  const closeDate = new Date().toISOString();
  const subject = `[Caja] Cierre registrado - ${restaurantName}`;
  const messageLines = [
    `Restaurante: ${restaurantName}`,
    `Caja: ${stationName || register.caja_station_id || register.id}`,
    `Responsable: ${responsibleName || '-'}`,
    `Cerró: ${closedByName || '-'}`,
    `Apertura: ${register.opened_at || '-'}`,
    `Cierre: ${closeDate}`,
    `Ventas: ${Number(sales.total_sales || 0)}`,
    `Efectivo ventas: ${Number(sales.total_cash || 0)}`,
    `Propinas (registradas): ${Number(sales.total_tips || 0)}`,
    `Yape: ${Number(sales.total_yape || 0)}${Number(sales.tips_yape || 0) > 0 ? ` + propina ${Number(sales.tips_yape)}` : ''}`,
    `Plin: ${Number(sales.total_plin || 0)}${Number(sales.tips_plin || 0) > 0 ? ` + propina ${Number(sales.tips_plin)}` : ''}`,
    `Tarjeta: ${Number(sales.total_card || 0)}${Number(sales.tips_card || 0) > 0 ? ` + propina ${Number(sales.tips_card)}` : ''}`,
    `Online / otros digitales: ${Number(sales.total_online || 0)}${Number(sales.tips_online || 0) > 0 ? ` + propina ${Number(sales.tips_online)}` : ''}`,
    `Ingresos caja: ${Number(movements.total_income || 0)}`,
    `Egresos caja: ${Number(movements.total_expense || 0)}`,
    `Efectivo esperado: ${Number(expectedCash || 0)}`,
    `Efectivo contado: ${Number(countedCash || 0)}`,
    `Diferencia: ${Number(difference || 0)}`,
    `Observaciones: ${notes || '-'}`,
    '',
    `Destinatario configurado: ${toEmail} (${recipientName})`,
  ];
  const plainMessage = messageLines.join('\n');
  return { restaurantName, closeDate, subject, plainMessage };
}

function smtpConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || '').trim() &&
      String(process.env.SMTP_USER || '').trim() &&
      String(process.env.SMTP_PASS || '').trim()
  );
}

async function sendViaSmtp({ toEmail, subject, plainMessage, recipientName }) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    throw new Error('Instale nodemailer (npm install nodemailer) o configure RESEND_API_KEY para envío directo al administrador.');
  }
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').trim() === '1' || port === 465;
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const from =
    String(process.env.SMTP_FROM || '').trim() ||
    `Resto Fadey <${user}>`;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });

  await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    text: plainMessage,
    replyTo: toEmail,
  });
  return { channel: 'smtp', to: toEmail, name: recipientName };
}

async function sendViaResend({ toEmail, subject, plainMessage, recipientName }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return null;
  const from = String(process.env.RESEND_FROM || 'Resto Fadey <onboarding@resend.dev>').trim();
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject,
      text: plainMessage,
    }),
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`Resend (${response.status}): ${payload}`.trim());
  }
  return { channel: 'resend', to: toEmail, name: recipientName };
}

async function sendViaFormspree({ toEmail, subject, plainMessage, recipientName, register, sales, movements, expectedCash, countedCash, difference, notes, closedByName, restaurantName, closeDate }) {
  const endpoint = getCashCloseFormUrl();
  const body = {
    subject,
    message: plainMessage,
    restaurant_name: restaurantName,
    register_id: register.id,
    opened_at: register.opened_at,
    closed_at: closeDate,
    closed_by: closedByName || '',
    order_count: Number(sales.order_count || 0),
    total_sales: Number(sales.total_sales || 0),
    total_cash: Number(sales.total_cash || 0),
    total_yape: Number(sales.total_yape || 0),
    total_plin: Number(sales.total_plin || 0),
    total_card: Number(sales.total_card || 0),
    total_online: Number(sales.total_online || 0),
    total_tips: Number(sales.total_tips || 0),
    total_income: Number(movements.total_income || 0),
    total_expense: Number(movements.total_expense || 0),
    expected_cash: Number(expectedCash || 0),
    counted_cash: Number(countedCash || 0),
    difference: Number(difference || 0),
    notes: notes || '',
    to_email: toEmail,
    admin_email: toEmail,
    name: recipientName,
    email: toEmail,
    _replyto: toEmail,
    _subject: subject,
  };

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => ctrl?.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
    if (!response.ok) {
      const payload = await response.text().catch(() => '');
      throw new Error(`Formspree (${response.status}): ${payload}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }

  console.warn(
    `[cash-close] Aviso enviado vía Formspree. El correo llega al destinatario del formulario en formspree.io, ` +
      `no necesariamente a ${toEmail}. Configure SMTP_HOST/SMTP_USER/SMTP_PASS para enviar al administrador.`
  );
  return {
    channel: 'formspree',
    to: toEmail,
    name: recipientName,
    warning:
      'Formspree entrega al correo del formulario (panel formspree.io), no al del administrador. Configure SMTP en .env para envío directo.',
  };
}

async function sendCashCloseNotification(params) {
  const notifyEnabled = String(process.env.CASH_CLOSE_NOTIFY_ENABLED || '1').trim() !== '0';
  if (!notifyEnabled) return { skipped: true };

  const { email: toEmail, name: recipientName } = getCashCloseRecipient();
  if (!toEmail) {
    throw new Error(
      'No hay correo del administrador: asigne email al usuario con rol Administrador en Configuración → Usuarios, o defina CASH_CLOSE_EMAIL en .env.'
    );
  }

  const { subject, plainMessage, restaurantName, closeDate } = buildCashCloseContent({
    ...params,
    toEmail,
    recipientName,
  });

  if (smtpConfigured()) {
    return sendViaSmtp({ toEmail, subject, plainMessage, recipientName });
  }

  const resend = await sendViaResend({ toEmail, subject, plainMessage, recipientName }).catch((err) => {
    if (String(process.env.RESEND_API_KEY || '').trim()) throw err;
    return null;
  });
  if (resend) return resend;

  return sendViaFormspree({
    toEmail,
    subject,
    plainMessage,
    recipientName,
    restaurantName,
    closeDate,
    ...params,
  });
}

module.exports = {
  getCashCloseRecipient,
  sendCashCloseNotification,
  buildCashCloseContent,
  smtpConfigured,
};
