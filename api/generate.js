// api/generate.js — Claude proxy, only for valid Crypode licence keys
const { checkLicense, consumeQuota, refundQuota } = require('./_lib.js');
const MAX_PROMPT_CHARS = 20000;
// Optional uploaded document (Bank Explainer): PDF or image, sent as base64.
// Vercel limits request bodies to about 4.5 MB, so files are capped at about 3 MB before encoding.
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_B64 = 4300000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { prompt, license, file } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  if (prompt.length > MAX_PROMPT_CHARS) return res.status(413).json({ error: 'Input too long' });
  if (file) {
    if (!FILE_TYPES.includes(file.type) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(file.data.slice(0, 200)))
      return res.status(400).json({ error: 'unsupported_file' });
    if (file.data.length > MAX_FILE_B64) return res.status(413).json({ error: 'file_too_large' });
  }

  let lic;
  try { lic = await checkLicense(license); }
  catch (e) { console.error('Licence check error:', e); return res.status(502).json({ error: 'Could not verify licence, please try again' }); }
  if (!lic.valid) return res.status(402).json({ error: 'licence_required', reason: lic.reason });

  // Fair-use allowance (licences bought before FAIR_USE_FROM are exempt)
  let quota;
  try { quota = await consumeQuota(lic); }
  catch (e) { console.error('Quota check error:', e); quota = { ok: true, exempt: true }; }   // never block a paying user because of a database hiccup
  if (!quota.ok) return res.status(429).json({ error: 'fair_use', scope: quota.scope, limit: quota.limit, resets: quota.resets });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-opus-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: file
          ? [ file.type === 'application/pdf'
                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
                : { type: 'image', source: { type: 'base64', media_type: file.type, data: file.data } },
              { type: 'text', text: prompt } ]
          : prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) { console.error('Claude API error:', data); await refundQuota(lic, quota); return res.status(response.status).json({ error: 'Failed to generate response' }); }
    if (!quota.exempt) data.crypode_usage = { used: quota.used, limit: quota.limit, resets: quota.resets };
    return res.status(200).json(data);
  } catch (error) {
    console.error('Error calling Claude API:', error);
    await refundQuota(lic, quota);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
