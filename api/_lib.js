// api/_lib.js — shared helpers (files starting with _ are not public endpoints on Vercel)
const crypto = require('crypto');

// ── Config (Vercel environment variables) ──
const cfg = () => ({
  env: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
  clientId: process.env.PAYPAL_CLIENT_ID || '',
  secret: process.env.PAYPAL_CLIENT_SECRET || '',
  product: (process.env.PRODUCT_CODE || '').toLowerCase(),          // resume | bank | gratuity
  productName: process.env.PRODUCT_NAME || 'Crypode Tool',
  price: Number(process.env.PRICE_USD || '0').toFixed(2),            // e.g. 15.00
  accepted: (process.env.ACCEPTED_PRODUCTS || process.env.PRODUCT_CODE || '')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
});

// ── Upstash Redis over REST (no npm packages needed) ──
async function redis(...command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Database not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  if (data.error) throw new Error('Redis: ' + data.error);
  return data.result;
}

// ── PayPal ──
const paypalBase = () => cfg().env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function paypalToken() {
  const { clientId, secret } = cfg();
  if (!clientId || !secret) throw new Error('PayPal not configured');
  const r = await fetch(paypalBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('PayPal auth failed');
  return data.access_token;
}

async function paypal(path, method, body) {
  const token = await paypalToken();
  const r = await fetch(paypalBase() + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ── Licence keys ──
const PREFIX = { resume: 'RES', bank: 'BNK', gratuity: 'GRT' };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L confusion

function newKey(product) {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `CRY-${PREFIX[product] || 'GEN'}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const normKey = k => String(k || '').trim().toUpperCase();

async function checkLicense(key) {
  key = normKey(key);
  if (!/^CRY-[A-Z]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) return { valid: false, reason: 'invalid' };
  const raw = await redis('GET', 'license:' + key);
  if (!raw) return { valid: false, reason: 'invalid' };
  const lic = JSON.parse(raw);
  if (lic.revoked) return { valid: false, reason: 'disabled' };
  const { accepted } = cfg();
  if (accepted.length && !accepted.includes(lic.product)) return { valid: false, reason: 'wrong_product' };
  return { valid: true, product: lic.product, email: lic.email || '' };
}

function maskEmail(e) {
  if (!e || !e.includes('@')) return '';
  const [u, d] = e.split('@');
  return u.slice(0, 2) + '***@' + d;
}

module.exports = { cfg, redis, paypal, newKey, normKey, checkLicense, maskEmail };
