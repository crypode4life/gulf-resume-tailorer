// api/paypal-order.js — create a PayPal order, then capture it and issue a licence key
// POST { action: 'create' }            -> { id }
// POST { action: 'capture', orderID }  -> { license, email }
const { cfg, redis, paypal, newKey, maskEmail } = require('./_lib.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { action, orderID } = req.body || {};
  const c = cfg();

  try {
    if (action === 'create') {
      if (!c.product || Number(c.price) <= 0) return res.status(500).json({ error: 'Product not configured' });
      const r = await paypal('/v2/checkout/orders', 'POST', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: c.product,
          custom_id: c.product,
          description: `${c.productName} – lifetime licence`,
          amount: { currency_code: 'USD', value: c.price }
        }],
        application_context: { brand_name: 'Crypode', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
      });
      if (!r.ok || !r.data.id) { console.error('Create order failed', r.data); return res.status(502).json({ error: 'Could not start payment' }); }
      return res.status(200).json({ id: r.data.id });
    }

    if (action === 'capture') {
      if (!orderID || !/^[A-Z0-9]{5,40}$/.test(orderID)) return res.status(400).json({ error: 'Invalid order' });

      // Already issued for this order? Return the same key (safe to retry).
      const existing = await redis('GET', 'order:' + orderID);
      if (existing) {
        const lic = JSON.parse(await redis('GET', 'license:' + existing));
        return res.status(200).json({ license: existing, email: maskEmail(lic.email) });
      }

      const r = await paypal(`/v2/checkout/orders/${orderID}/capture`, 'POST', {});
      if (!r.ok) { console.error('Capture failed', r.status, r.data); return res.status(402).json({ error: 'Payment was not completed' }); }

      const pu = (r.data.purchase_units || [])[0] || {};
      const cap = ((pu.payments || {}).captures || [])[0] || {};
      const amount = cap.amount || {};

      // Only issue a key for a completed payment of the full price, in USD, for THIS product
      if (r.data.status !== 'COMPLETED' || cap.status !== 'COMPLETED') return res.status(402).json({ error: 'Payment pending or declined' });
      if (amount.currency_code !== 'USD' || Number(amount.value) < Number(c.price)) return res.status(402).json({ error: 'Payment amount mismatch' });
      if ((cap.custom_id || pu.custom_id || pu.reference_id) && (cap.custom_id || pu.custom_id || pu.reference_id) !== c.product) {
        return res.status(402).json({ error: 'Order is for a different product' });
      }

      const email = (r.data.payer && r.data.payer.email_address) || '';
      const key = newKey(c.product);
      const record = {
        product: c.product, orderId: orderID, captureId: cap.id || '', email,
        amount: amount.value, currency: amount.currency_code, env: c.env,
        created: new Date().toISOString(), revoked: false
      };

      // NX = only set if this order hasn't been processed in parallel
      const ok = await redis('SET', 'order:' + orderID, key, 'NX');
      if (ok !== 'OK') {
        const k = await redis('GET', 'order:' + orderID);
        return res.status(200).json({ license: k, email: maskEmail(email) });
      }
      await redis('SET', 'license:' + key, JSON.stringify(record));
      if (email) await redis('SADD', 'email:' + email.toLowerCase(), key);

      return res.status(200).json({ license: key, email: maskEmail(email) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('paypal-order error:', e);
    return res.status(500).json({ error: 'Server error, please contact support@crypode.com with your PayPal receipt' });
  }
};
