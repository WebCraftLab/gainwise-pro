// ════════════════════════════════════════════════════════════════════
//  Gainwise Pro — AI Portfolio Audit function (VERCEL VERSION)
//  File: api/ai-audit.js
//  Route: POST /api/ai-audit   (Vercel auto-routes any file in /api/
//         to a matching path — no vercel.json redirect needed)
//
//  WHY THIS FILE EXISTS:
//  The Anthropic API requires a secret API key on every request. That
//  key must NEVER be shipped in browser JavaScript — anyone can open
//  dev tools / view-source and steal it, then run up your bill or
//  exhaust your rate limit. So the browser calls THIS function, and
//  THIS function (running on Vercel's server, not the user's device)
//  attaches the real key and talks to Anthropic on the browser's behalf.
//
//  SETUP (required — do this once):
//    1. Get an API key: https://console.anthropic.com/settings/keys
//    2. Vercel Dashboard → Project → Settings → Environment Variables → Add:
//         ANTHROPIC_API_KEY = sk-ant-xxxxxxxxxxxxxxxx
//    3. Redeploy. That's it — no key ever touches the browser.
//
//  Until step 2 is done, this function returns a clear 500 error
//  instead of silently pretending to work.
// ════════════════════════════════════════════════════════════════════
'use strict';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = 'claude-sonnet-4-6';

/* ── CORS headers ───────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ══════════════════════════════════════════════════════════════════
   VERCEL SERVERLESS FUNCTION HANDLER
   Vercel's Node.js runtime automatically parses a JSON request body
   into req.body when the request's Content-Type is application/json,
   so — unlike the webhook route in api/whop.js — we do NOT need to
   disable the body parser here.
══════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  setCors(res);

  /* Preflight */
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    // Honest failure instead of a fake/simulated response.
    res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Project → Settings → Environment Variables and redeploy.'
    });
    return;
  }

  let payload = req.body;

  // Defensive: some edge configs / older Vercel runtimes hand back a
  // raw string instead of a parsed object. Handle both cases so this
  // never silently 500s on a perfectly valid request.
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.status(400).json({ error: 'Bad JSON body' });
      return;
    }
  }
  if (!payload || typeof payload !== 'object') {
    payload = {};
  }

  const { portfolio, gains, losses, liability } = payload;

  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    res.status(400).json({ error: 'Portfolio is empty. Add at least one position first.' });
    return;
  }

  // Basic shape/sanity check on each position so we never forward
  // garbage or absurdly long input to the model.
  const MAX_POSITIONS = 200;
  const clean = portfolio.slice(0, MAX_POSITIONS).map(p => ({
    symbol:    String((p && p.symbol) || '?').slice(0, 20),
    buyPrice:  Number(p && p.buyPrice)  || 0,
    sellPrice: Number(p && p.sellPrice) || 0,
    size:      Number(p && p.size)      || 0,
  }));

  const summary = clean.map(i => {
    const pnl = ((i.sellPrice - i.buyPrice) * i.size).toFixed(2);
    return `${i.symbol}: Buy $${i.buyPrice}, Sell $${i.sellPrice}, Size ${i.size}, PnL $${pnl}`;
  }).join('\n');

  const g = Number(gains)     || 0;
  const l = Number(losses)    || 0;
  const t = Number(liability) || 0;

  const prompt = `You are an institutional-grade crypto portfolio risk analyst. Analyze this portfolio and provide EXACTLY 3 concise, specific, actionable risk-management recommendations. Format each as: "RISK [N]: [Title]\n[2-sentence explanation and action]".

Portfolio:
${summary}

Summary:
- Gains: $${g.toFixed(2)}
- Losses: $${l.toFixed(2)}
- Tax Liability: $${t.toFixed(2)}

Respond with exactly 3 numbered risk insights. Keep each under 60 words.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[ai-audit] Anthropic error', anthropicRes.status, errText);
      res.status(502).json({ error: `Anthropic API returned ${anthropicRes.status}` });
      return;
    }

    const data = await anthropicRes.json();
    const text = (data.content || []).map(c => c.text || '').join('');

    res.status(200).json({ text });
  } catch (err) {
    console.error('[ai-audit] Fetch failed:', err.message);
    res.status(500).json({ error: 'Could not reach Anthropic API: ' + err.message });
  }
};
