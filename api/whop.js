// ════════════════════════════════════════════════════════════════════
//  Gainwise Pro — Whop Serverless Functions (VERCEL VERSION)
//  File: api/whop.js
//  Route: /api/whop  (Vercel auto-routes /api/whop.js → /api/whop)
//
//  This single Vercel serverless function handles:
//    1. GET  /api/whop?action=verify    → verify a Whop access token
//    2. POST /api/whop?action=webhook   → receive Whop membership events
//
//  HOW TO SET ENV VARS on Vercel:
//    Vercel Dashboard → Project → Settings → Environment Variables → Add:
//      WHOP_API_KEY              (from whop.com/dashboard → API Keys)
//      WHOP_WEBHOOK_SECRET       (from whop.com/dashboard → Webhooks)
//      WHOP_PRODUCT_ID_PRO       (e.g. prod_xxxxxxxx)
//      WHOP_PRODUCT_ID_PREMIUM   (e.g. prod_yyyyyyyy)
//
//  NOTE: The frontend does its own Whop OAuth + membership check
//  directly via the Whop API, so this file is OPTIONAL — it's only
//  needed if you want server-side webhook handling (e.g. sending
//  welcome emails or logging purchases) or an extra server-side
//  double-check of a token.
// ════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');

/* ── Env vars (set in Vercel dashboard) ─────────────────────────── */
const WHOP_API_KEY            = process.env.WHOP_API_KEY            || '';
const WHOP_WEBHOOK_SECRET     = process.env.WHOP_WEBHOOK_SECRET     || '';
const WHOP_PRODUCT_ID_PRO     = process.env.WHOP_PRODUCT_ID_PRO     || '';
const WHOP_PRODUCT_ID_PREMIUM = process.env.WHOP_PRODUCT_ID_PREMIUM || '';

/* ══════════════════════════════════════════════════════════════════
   IMPORTANT — RAW BODY REQUIRED FOR WEBHOOK SIGNATURE VERIFICATION
   ──────────────────────────────────────────────────────────────────
   Vercel's Node.js runtime parses a JSON request body into req.body
   by default. That's convenient, but it's WRONG for the webhook route:
   HMAC signature verification must run over the *exact original bytes*
   Whop sent. Any re-serialization (even reordering keys or changing
   whitespace) produces a different hash and breaks verification.

   So we turn OFF Vercel's automatic body parsing for this whole file
   and read + parse the raw body ourselves inside the handler below.
══════════════════════════════════════════════════════════════════ */
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

/* ── CORS headers ───────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ── Tier resolver ──────────────────────────────────────────────── */
function resolveTier(memberships) {
  const ids = (memberships || []).map(m => (m.product && m.product.id) || m.product_id || '');
  if (ids.includes(WHOP_PRODUCT_ID_PREMIUM)) return 'premium';
  if (ids.includes(WHOP_PRODUCT_ID_PRO))     return 'pro';
  return 'free';
}

/* ── Read the raw request body as a string (since bodyParser is off) */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ══════════════════════════════════════════════════════════════════
   VERCEL SERVERLESS FUNCTION HANDLER
   Path: /api/whop
══════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  setCors(res);

  /* Preflight */
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const action = (req.query && req.query.action) || '';

  /* ────────────────────────────────────────────────────────────────
     ACTION: verify
     Called by the frontend after OAuth to double-check the token
     server-side and return the resolved tier.
     GET /api/whop?action=verify
     Header: Authorization: Bearer <whop_access_token>
  ──────────────────────────────────────────────────────────────── */
  if (req.method === 'GET' && action === 'verify') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }

    try {
      const [userRes, membershipsRes] = await Promise.all([
        fetch('https://api.whop.com/v5/me', {
          headers: { Authorization: 'Bearer ' + token }
        }),
        fetch('https://api.whop.com/v5/me/memberships?expand[]=product&status=active', {
          headers: { Authorization: 'Bearer ' + token }
        })
      ]);

      if (!userRes.ok) {
        throw new Error('Whop /me returned ' + userRes.status);
      }

      const user       = await userRes.json();
      const memberData = membershipsRes.ok ? await membershipsRes.json() : { data: [] };
      const tier        = resolveTier(memberData.data || []);

      res.status(200).json({ user, tier });
      return;
    } catch (err) {
      console.error('[whop/verify] Error:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }
  }

  /* ────────────────────────────────────────────────────────────────
     ACTION: webhook
     Whop posts membership events here. We verify the HMAC signature
     against the raw body and can trigger side-effects (email, logging).
     POST /api/whop?action=webhook
     Header: x-whop-signature: <hmac-sha256>
  ──────────────────────────────────────────────────────────────── */
  if (req.method === 'POST' && action === 'webhook') {
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      console.error('[whop/webhook] Failed to read raw body:', err.message);
      res.status(400).send('Could not read request body');
      return;
    }

    const sigHeader = req.headers['x-whop-signature'] || '';

    /* Verify HMAC signature */
    if (WHOP_WEBHOOK_SECRET) {
      const expected = crypto
        .createHmac('sha256', WHOP_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

      // Constant-time comparison to avoid leaking timing information
      // about how much of the signature matched.
      const sigBuf = Buffer.from(sigHeader);
      const expBuf = Buffer.from(expected);
      const validSig =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf);

      if (!validSig) {
        console.warn('[whop/webhook] Invalid signature — rejecting');
        res.status(401).send('Invalid signature');
        return;
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.status(400).send('Bad JSON');
      return;
    }

    const whopAction = payload.action;
    const data       = payload.data;
    console.log('[whop/webhook] Event:', whopAction, (data && data.id) || '');

    /*
      Handle membership events:
        membership.went_valid   → user purchased or renewed
        membership.went_invalid → payment failed or cancelled
        membership.cancelled    → user cancelled

      Since we use the Whop OAuth flow + real-time membership check
      on the frontend, no database update is needed here.
      Add any side-effects you want below (e.g. send welcome email).
    */
    switch (whopAction) {
      case 'membership.went_valid':
        console.log(
          '[whop/webhook] New/renewed member:',
          data && data.user_id,
          '| Plan:',
          data && data.plan && data.plan.id
        );
        // TODO: send welcome email, log to analytics, etc.
        break;

      case 'membership.went_invalid':
      case 'membership.cancelled':
        console.log('[whop/webhook] Membership ended:', data && data.user_id);
        // TODO: send cancellation email, log, etc.
        break;

      default:
        console.log('[whop/webhook] Unhandled event type:', whopAction);
    }

    res.status(200).send('OK');
    return;
  }

  /* Unknown route */
  res.status(400).json({ error: 'Unknown action. Use ?action=verify or ?action=webhook' });
};
