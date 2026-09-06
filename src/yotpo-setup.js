// src/yotpo-setup.js
//
// One-time (per site) Yotpo webhook registration — added 2026-09-06
// alongside src/yotpo.js (read that file's header first for the overall
// architecture). This file handles the OTHER side of the integration:
// telling Yotpo where to send its webhook events in the first place.
//
// ============================================================================
// IMPORTANT — THIS IS THE LEAST-VERIFIED PART OF THE WHOLE FEATURE
// ============================================================================
// Yotpo's Core API docs (core-api.yotpo.com) describe this 3-step flow
// (generate an access token, create a target, create a filter, create a
// subscription linking target+filter) but the exact nested JSON body keys
// for the filter and subscription steps were NOT fully visible in the
// documentation as researched — ReadMe.io-style docs often render their
// JSON examples via a widget that a text fetch can't always extract, and
// no real Yotpo test account was available to verify against a live call.
// The bodies below are the best-supported guess from the docs and from
// Yotpo's typical naming conventions elsewhere in their API.
//
// EVERY step below logs Yotpo's raw response body on failure and rethrows
// it verbatim — so if a field name here is wrong, the fix is: run this
// once, read the exact error Yotpo sends back (it'll say something like
// "missing required field X" or "invalid property Y"), and adjust the one
// line that's wrong. This is expected to possibly need one iteration; it
// is NOT expected to need re-researching from scratch.
//
// CREDENTIALS NEEDED (per site, in Render's env vars — never through
// chat): these come from Yotpo's main Account Settings → General Settings
// page (NOT the Loyalty-specific admin) — "App Key" at the bottom of that
// page (= store_id below) and a Secret Key revealed via that same page's
// "Get secret key" button (admin-only, emails a verification code):
//   YOTPO_STORE_ID_COM / YOTPO_SECRET_COM
//   YOTPO_STORE_ID_EU  / YOTPO_SECRET_EU
//   YOTPO_STORE_ID_IL  / YOTPO_SECRET_IL
// Also needs YOTPO_WEBHOOK_SECRET (any random string you choose — this
// becomes the ?token= this script bakes into the callback URL it
// registers, and must match what src/yotpo.js's webhook route checks) and
// BACKEND_PUBLIC_URL (this service's own public URL, e.g.
// https://nd-dashboard-backend.onrender.com — used to build that callback
// URL; falls back to the request's own host if not set).

const CORE_API_BASE = 'https://api.yotpo.com/core/v3';

// Best-effort topic list — see src/yotpo.js's file header for the same
// caveat. classifyTopic() there matches by substring, so even if one of
// these exact strings is slightly off, a webhook that DOES arrive under a
// close variant will still be picked up and classified correctly; the
// filter step below is what determines whether Yotpo sends it to us AT
// ALL, which is why getting these topic strings right matters more here
// than in yotpo.js's parsing.
const TOPICS = [
  'swell/tier/status/changed',
  'swell/redemption/created',
  'swell/account/created',
];

async function callYotpo(url, { method = 'POST', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Yotpo-Token'] = token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(`Yotpo ${method} ${url} failed (${res.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// Tries a handful of plausible field paths for wherever Yotpo nested the
// value we need — defensive against exact-shape uncertainty (see file
// header). Throws a clear, specific error naming what was searched for and
// showing the full response, rather than a generic "undefined" failure
// three steps later.
function pluck(obj, paths, whatFor) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    if (val !== undefined && val !== null) return val;
  }
  throw new Error(`Could not find ${whatFor} in Yotpo's response — full response was: ${JSON.stringify(obj)}`);
}

async function generateAccessToken(storeId, secret) {
  const body = await callYotpo(`${CORE_API_BASE}/stores/${storeId}/access_tokens`, {
    method: 'POST',
    body: { secret },
  });
  return pluck(body, ['access_token', 'token', 'data.access_token', 'data.token'], 'the access token');
}

async function createTarget(storeId, token, callbackUrl) {
  const body = await callYotpo(`${CORE_API_BASE}/stores/${storeId}/webhooks/targets`, {
    method: 'POST',
    token,
    body: { webhook_target: { url: callbackUrl } },
  });
  return pluck(body, ['webhook_target.id', 'data.webhook_target.id', 'id', 'data.id'], 'the created target\'s id');
}

async function createFilter(storeId, token, topics) {
  const body = await callYotpo(`${CORE_API_BASE}/stores/${storeId}/webhooks/filters`, {
    method: 'POST',
    token,
    body: { webhook_filter: { event_types: topics.map((topic) => ({ event_type: topic })) } },
  });
  return pluck(body, ['webhook_filter.id', 'data.webhook_filter.id', 'id', 'data.id'], 'the created filter\'s id');
}

async function createSubscription(storeId, token, targetId, filterId) {
  const body = await callYotpo(`${CORE_API_BASE}/stores/${storeId}/webhooks/subscriptions`, {
    method: 'POST',
    token,
    body: { webhook_subscription: { target_id: targetId, filter_id: filterId } },
  });
  return body;
}

// Runs the full registration for one site. Returns a small report of what
// happened at each step — useful both as the admin endpoint's response and
// as a log trail, since this is the part most likely to need a manual
// tweak on the first real attempt.
async function registerYotpoWebhooksForSite(site, { storeId, secret, callbackUrl }) {
  if (!storeId || !secret) {
    throw new Error(`Missing YOTPO_STORE_ID_${site.toUpperCase()} / YOTPO_SECRET_${site.toUpperCase()} env vars`);
  }
  const steps = {};
  const token = await generateAccessToken(storeId, secret);
  steps.access_token_generated = true;
  const targetId = await createTarget(storeId, token, callbackUrl);
  steps.target_id = targetId;
  const filterId = await createFilter(storeId, token, TOPICS);
  steps.filter_id = filterId;
  const subscription = await createSubscription(storeId, token, targetId, filterId);
  steps.subscription = subscription;
  steps.callback_url = callbackUrl;
  steps.topics = TOPICS;
  return steps;
}

module.exports = { registerYotpoWebhooksForSite, TOPICS };
