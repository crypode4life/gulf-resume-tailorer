// api/verify-license.js
// GET  -> public config the page needs (PayPal client ID, price, product name)
// POST { license } -> { valid, reason?, email? }
const { cfg, checkLicense, maskEmail } = require('./_lib.js');

module.exports = async function handler(req, res) {
  const c = cfg();
  if (req.method === 'GET') {
    return res.status(200).json({ paypalClientId: c.clientId, price: c.price, currency: 'USD', productName: c.productName, env: c.env });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const r = await checkLicense((req.body || {}).license);
    if (r.valid) r.email = maskEmail(r.email);
    return res.status(r.valid ? 200 : 403).json(r);
  } catch (e) {
    console.error('verify error:', e);
    return res.status(502).json({ valid: false, reason: 'server_unreachable' });
  }
};
