// api/generate.js — Claude proxy, only for valid Crypode licence keys
const { checkLicense } = require('./_lib.js');
const MAX_PROMPT_CHARS = 20000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { prompt, license } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  if (prompt.length > MAX_PROMPT_CHARS) return res.status(413).json({ error: 'Input too long' });

  let lic;
  try { lic = await checkLicense(license); }
  catch (e) { console.error('Licence check error:', e); return res.status(502).json({ error: 'Could not verify licence, please try again' }); }
  if (!lic.valid) return res.status(402).json({ error: 'licence_required', reason: lic.reason });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-opus-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) { console.error('Claude API error:', data); return res.status(response.status).json({ error: 'Failed to generate response' }); }
    return res.status(200).json(data);
  } catch (error) {
    console.error('Error calling Claude API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
