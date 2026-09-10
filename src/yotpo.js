// src/yotpo.js
//
// Section 8 (Yotpo Loyalty) — added 2026-09-06 per Tomer: "add Yotpo Loyalty
// MCP connection to show the redeem and use of points by tier + new users
// and movement between the Tiers."
//
// ============================================================================
// READ THIS BEFORE TOUCHING ANYTHING IN THIS FILE
// ============================================================================
//
// There is NO Yotpo Loyalty MCP connector — checked the connector registry,
// nothing installed, nothing available to add. And unlike Shopify/Triple
// Whale/the P&L Google Sheet (every other data source on this dashboard),
// Yotpo's own Loyalty REST API (loyaltyapi.yotpo.com) has no bulk,
// date-ranged endpoint at all — it's customer-lookup-oriented (fetch ONE
// customer's own balance/history, or fetch the tier definitions), not a
// reporting API. There is no "give me every redemption across all
// customers this month" call to make.
//
// The only way to get real, cross-customer, date-ranged numbers is to
// receive Yotpo's own webhook events as they happen and accumulate them
// ourselves in a database — which is what this file does. Tomer confirmed
// this approach on 2026-09-06 (via AskUserQuestion) over the alternative
// (a manual periodic CSV export from Yotpo's own admin Reports page,
// closer to how the P&L sheet works today).
//
// CONSEQUENCE — Section 8 has NO historical backfill. It only knows about
// events from the moment the webhook registration (see
// scripts/register-yotpo-webhooks.js) actually goes live and Yotpo starts
// delivering. A month before that date shows "no data", not zero — the
// frontend must not silently render zeroes for a period we simply weren't
// listening yet.
//
// TOPIC STRINGS — VERIFY AGAINST REALITY. The event topic strings below
// (see the classifyTopic() patterns) are the best match found in Yotpo's
// own documentation (loyaltyapi.yotpo.com + core-api.yotpo.com's topics
// list) as of this writing — but Yotpo's docs are spread across several
// subdomains inconsistently, and none of this was verified against a real
// delivered webhook (no test account was available while building this).
// Parsing is deliberately DEFENSIVE — pattern-matched on topic substrings
// ('tier', 'redemption'/'coupon', 'account' + 'created') rather than exact
// string equality — and the full raw payload is ALWAYS stored in
// `raw_payload` regardless of whether the field-level parsing below
// recognizes it. So if Yotpo's real topic strings or payload shapes differ
// even slightly, nothing is silently dropped — check Render's logs for the
// first few real webhook deliveries after go-live, and re-parse
// `raw_payload` retroactively if any field mapping needs correcting.
//
// WHY A LOOKUP TABLE FOR "tier_from": Yotpo's tier-change webhook payload
// (confirmed from docs) carries the customer's CURRENT/new tier
// (`customer.vip_tier_name`) but no "previous tier" field at all. The only
// way to know what tier a customer is moving FROM is to remember what tier
// we last saw for them — that's what the yotpo_customers table is for.
// The very first tier event ever seen for a customer has no prior record,
// so tier_from is null for it — that's an initial classification, not a
// movement, and the aggregation query below excludes null-tier_from rows
// from the "movement between tiers" breakdown accordingly.

const { Pool } = require('pg');

// Tier-ID normalization constants — hoisted to module scope 2026-09-06 (were
// previously local to getYotpoSummary) so normalizeCustomerTier() below can
// share them for the new tier-revenue feature. See getYotpoSummary's
// redemptionsRes query for the original commentary on where these came from:
// IL's mapping is an inference (never confirmed against Yotpo's own admin),
// COM's was explicitly confirmed by Tomer.
const IL_TIER_ID_BRONZE = '23668';
const IL_TIER_ID_GLAM = '23667';
const COM_TIER_ID_BRONZE = '19818';
const COM_TIER_ID_GLOW = '19819';
const COM_TIER_ID_GLAM = '19820';

// Normalizes one yotpo_customers.current_tier value to a canonical tier name
// (BRONZE/GLOW/GLAM), applying the EXACT SAME rules as the CASE expression in
// getYotpoSummary's redemptionsRes query below — added 2026-09-06 for the
// Net Sales-by-tier feature (see computeYotpoTierRevenue in server.js), which
// needs this same normalization done in JS rather than SQL because the join
// against Shopify order data happens after the DB query, not inside it.
// KEEP THESE TWO IN SYNC if the ID mappings or fallback rules ever change.
//
// current_tier can hold a raw numeric ID (from the historical CSV import,
// which stores whatever the "vip_tier"/"tier" column literally said) OR a
// clean name (from live webhook events via extractTierName) — same
// dual-format issue tier_at_event has in yotpo_events, same fix here.
function normalizeCustomerTier(site, rawTier) {
  if (site === 'il') {
    if (rawTier === IL_TIER_ID_BRONZE) return 'BRONZE';
    if (rawTier === IL_TIER_ID_GLAM) return 'GLAM';
  }
  if (site === 'com') {
    if (rawTier === COM_TIER_ID_BRONZE) return 'BRONZE';
    if (rawTier === COM_TIER_ID_GLOW) return 'GLOW';
    if (rawTier === COM_TIER_ID_GLAM) return 'GLAM';
  }
  if (!rawTier || rawTier === 'Unknown') return 'BRONZE';
  if (site === 'com' && !['BRONZE', 'GLOW', 'GLAM'].includes(String(rawTier).toUpperCase())) {
    return 'BRONZE';
  }
  return String(rawTier).toUpperCase();
}

// Builds a Map<lowercased email, canonical tier name> of every KNOWN Yotpo
// loyalty member for a site — added 2026-09-06 for the Net Sales-by-tier
// feature. Deliberately only includes customers with a real yotpo_customers
// row: an email with no row here is a non-member (guest checkout, or a
// customer who's never triggered a new_member/tier_change webhook or
// appeared in the historical import), and the caller must exclude those
// entirely from tier revenue rather than folding them into BRONZE — folding
// every non-member order into BRONZE would badly inflate it with ordinary
// store revenue that has nothing to do with the loyalty program.
async function getYotpoCustomerTierMap(site) {
  const p = getPool();
  if (!p) return new Map();
  await ensureYotpoSchema();
  const { rows } = await p.query('SELECT email, current_tier FROM yotpo_customers WHERE site = $1', [site]);
  const tierByEmail = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    tierByEmail.set(r.email.toLowerCase(), normalizeCustomerTier(site, r.current_tier));
  }
  return tierByEmail;
}

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres requires SSL for external/internal
      // connections alike on most plans; rejectUnauthorized: false because
      // Render's own certs aren't in Node's default trust store the way a
      // public CA's would be — same pattern every Render Postgres quOKstart
      // example uses.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

let schemaReady = null;
// Idempotent — safe to call on every server startup. Returns a promise so
// callers can await it once; subsequent calls reuse the same promise rather
// than re-running the DDL.
function ensureYotpoSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p
      .query(`
        CREATE TABLE IF NOT EXISTS yotpo_customers (
          site TEXT NOT NULL,
          email TEXT NOT NULL,
          current_tier TEXT,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (site, email)
        );
        CREATE TABLE IF NOT EXISTS yotpo_events (
          id BIGSERIAL PRIMARY KEY,
          site TEXT NOT NULL,
          topic TEXT NOT NULL,
          event_type TEXT NOT NULL,
          email TEXT,
          tier_from TEXT,
          tier_to TEXT,
          tier_at_event TEXT,
          points NUMERIC,
          reward_name TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          raw_payload JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_yotpo_events_lookup
          ON yotpo_events (site, event_type, received_at);
      `)
      .then(() => true)
      .catch((err) => {
        console.error('yotpo: schema migration failed:', err.message);
        schemaReady = null; // allow a retry on the next call rather than wedging forever
        return false;
      });
  }
  return schemaReady;
}

const VALID_SITES = ['com', 'eu', 'il'];

// Points-to-currency conversion — added 2026-09-06 per Tomer's redemption
// tiers: US $15/$20/$25/$30 = 150/200/250/300 pts; EU same point costs for
// €15/€20/€25/€30; IL ₪25/₪30/₪40/₪45/₪50 = 250/300/400/450/500 pts. Every
// one of those reduces to the exact same ratio — 10 points = 1 unit of the
// site's own local currency — so this single constant covers all 3
// sites/currencies; no per-site conversion table is needed. getYotpoSummary
// returns this value in whatever currency the site itself uses (USD for
// com, EUR for eu, ILS for il) — the frontend already knows each site's
// currency (DATA.sites[site].meta.currency) and converts to USD itself for
// the combined "All Sites (USD)" tab, the same way it does for every other
// monetary figure (see FX_TO_USD in dashboard_v2.html). If Yotpo ever adds
// a reward tier that breaks this 10:1 ratio, this is the one place to fix.
const POINTS_PER_CURRENCY_UNIT = 10;

// Classifies a webhook's topic string into one of our 4 buckets. Substring
// matching, not exact equality — see the file header for why.
function classifyTopic(topic) {
  const t = (topic || '').toLowerCase();
  if (t.includes('tier')) return 'tier_change';
  if (t.includes('redemption') || t.includes('coupon') || t.includes('reward')) return 'redemption';
  if (t.includes('account') && t.includes('creat')) return 'new_member';
  return 'other';
}

// Best-effort extraction — Yotpo's payload nests customer fields
// differently across event types (sometimes top-level `email`, sometimes
// under a `customer` object). Try both rather than assuming one shape.
function extractEmail(payload) {
  return (
    payload.email ||
    (payload.customer && payload.customer.email) ||
    null
  );
}
function extractTierName(payload) {
  return (
    (payload.customer && payload.customer.vip_tier_name) ||
    payload.vip_tier_name ||
    payload.tier_name ||
    null
  );
}
function extractPoints(payload) {
  // Redemption events: the redemption_option's point cost ("amount") is
  // what was actually spent this transaction — prefer that over
  // points_balance (a running total, not a delta) or points_earned (a
  // lifetime figure, also not this transaction's delta).
  const opt = payload.redemption_option || {};
  const amount = opt.amount !== undefined ? opt.amount : payload.amount;
  return amount !== undefined && amount !== null ? Number(amount) : null;
}
function extractRewardName(payload) {
  const opt = payload.redemption_option || {};
  return opt.name || payload.reward_text || payload.name || null;
}

// Records one incoming webhook delivery. Never throws for a
// recognition/parsing miss — the raw payload is always saved, so a shape
// we don't fully understand yet still leaves a durable trail to fix later
// rather than silently vanishing.
async function recordYotpoEvent(site, topic, payload) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not configured — cannot record Yotpo event');
  await ensureYotpoSchema();

  const eventType = classifyTopic(topic);
  const email = extractEmail(payload || {});
  let tierFrom = null;
  let tierTo = null;
  let tierAtEvent = null;
  let points = null;
  let rewardName = null;

  // Look up (and, for tier events, update) this customer's last-known tier
  // — this is the whole reason yotpo_customers exists (see file header).
  let priorTier = null;
  if (email) {
    const { rows } = await p.query(
      'SELECT current_tier FROM yotpo_customers WHERE site = $1 AND email = $2',
      [site, email]
    );
    priorTier = rows.length ? rows[0].current_tier : null;
  }

  if (eventType === 'tier_change') {
    tierTo = extractTierName(payload || {});
    tierFrom = priorTier; // null on this customer's very first tier event — an initial classification, not a movement
    tierAtEvent = tierTo;
    if (email && tierTo) {
      await p.query(
        `INSERT INTO yotpo_customers (site, email, current_tier, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (site, email) DO UPDATE SET current_tier = $3, updated_at = now()`,
        [site, email, tierTo]
      );
    }
  } else if (eventType === 'redemption') {
    points = extractPoints(payload || {});
    rewardName = extractRewardName(payload || {});
    tierAtEvent = priorTier; // whatever tier they were standing at when they redeemed
  } else if (eventType === 'new_member') {
    tierAtEvent = extractTierName(payload || {}); // some programs assign a starting tier on enrollment
    if (email) {
      await p.query(
        `INSERT INTO yotpo_customers (site, email, current_tier, first_seen_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (site, email) DO NOTHING`,
        [site, email, tierAtEvent]
      );
    }
  }

  await p.query(
    `INSERT INTO yotpo_events (site, topic, event_type, email, tier_from, tier_to, tier_at_event, points, reward_name, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [site, topic || 'unknown', eventType, email, tierFrom, tierTo, tierAtEvent, points, rewardName, JSON.stringify(payload || {})]
  );
}

// Returns Section 8's summary for one site over [start, end) (ISO date
// strings, end-exclusive — same convention as every other date-ranged call
// in this backend). `earliest_event_at` tells the frontend whether this
// range is even covered by webhook collection yet — see the "no
// backfill" note in the file header; the frontend must show "no data
// collected yet" rather than a misleading all-zero summary for a period
// before go-live.
async function getYotpoSummary(site, start, end) {
  const p = getPool();
  if (!p) return null;
  await ensureYotpoSchema();

  const earliestRes = await p.query('SELECT MIN(received_at) AS earliest FROM yotpo_events WHERE site = $1', [site]);
  const earliestEventAt = earliestRes.rows[0].earliest;
  if (!earliestEventAt) {
    return { site, start, end, collecting_since: null, new_members: 0, redemptions_by_tier: [], tier_movement: [], no_data: true };
  }

  const newMembersRes = await p.query(
    `SELECT COUNT(*) AS n FROM yotpo_events
     WHERE site = $1 AND event_type = 'new_member' AND received_at >= $2 AND received_at < $3`,
    [site, start, end]
  );

  // IL/COM tier-ID normalization constants (IL_TIER_ID_BRONZE, IL_TIER_ID_GLAM,
  // COM_TIER_ID_BRONZE/GLOW/GLAM) moved to module scope 2026-09-06 — see the
  // block near the top of this file (above normalizeCustomerTier) for the
  // full history/commentary on where these values came from. Still used
  // below exactly as before, just no longer redeclared locally here.

  // Per Tomer's request (2026-09-06): any redemption whose tier couldn't be
  // resolved (no match in the imported Customers CSV, or a live event for a
  // customer we've never recorded a tier for — see COALESCE below) is folded
  // into BRONZE rather than shown as its own "Unknown" bucket. This is a
  // GROUP BY on the CASE expression itself, so a redemption that already had
  // a real BRONZE tier and one that fell back from "Unknown" land in the
  // exact same summed row, not two rows that happen to share a label. The IL
  // and COM tier-ID CASE arms run first so a known ID gets normalized to its
  // real name BEFORE the Unknown-vs-BRONZE check below ever sees it.
  //
  // ND.COM-only fallback (added 2026-09-06, kept as a safety net): any
  // ND.COM tier value that isn't one of the 3 known IDs above and isn't
  // literally BRONZE/GLOW/GLAM (case-insensitive) still folds into BRONZE
  // rather than showing as its own unnamed row — this keeps redemption/
  // points totals accurate (nothing silently disappears from the Total row)
  // while guaranteeing only the 3 canonical named tiers ever appear for
  // ND.COM, including for any future raw ID Yotpo might report that we
  // haven't mapped. Scoped to site='com' only — EU and IL are unaffected.
  //
  // "redemptions" = DISTINCT redeeming customers, not total redemption
  // transactions — changed 2026-09-06 per Tomer, who checked ND.COM against
  // Yotpo's own admin (Bronze 131, Glow 52, Glam 88 redeemers) and found our
  // number many times larger, because this used to be `COUNT(*)` — every
  // redemption EVENT, so one customer who redeemed 50 times counted as 50.
  // Yotpo's own "redeemers" metric counts each customer once regardless of
  // how many times they redeemed. `COUNT(DISTINCT email)` matches that.
  // Applied to every site, not just COM, since this is a metric-definition
  // fix, not a COM-specific data issue — EU/IL should mean the same thing.
  // `points_used` (SUM(points)) is unchanged — that's a real total, not a
  // per-customer count, so it wasn't wrong before and isn't touched here.
  //
  // `uses` added 2026-09-10 per Tomer: "add how many uses was out of the
  // redeemers" — i.e. show total redemption EVENTS alongside the distinct
  // redeemer count, so it's visible at a glance how many times an average
  // member redeems (e.g. 142 uses from 88 redeemers = frequent repeat
  // redeemers, not 142 different people). This is exactly the raw `COUNT(*)`
  // this query used BEFORE the 2026-09-06 redemptions->redeemers fix above —
  // that fix didn't delete the information, it just stopped labeling it
  // "redemptions"/showing it at all. Restoring it as its own `uses` column
  // alongside (not instead of) `redemptions` (redeemers) gives Tomer both
  // numbers together, which is what he's asking for here.
  const redemptionsRes = await p.query(
    `SELECT
       CASE
         WHEN $1 = 'il' AND tier_at_event = $4 THEN $5
         WHEN $1 = 'il' AND tier_at_event = $6 THEN $7
         WHEN $1 = 'com' AND tier_at_event = $8 THEN $9
         WHEN $1 = 'com' AND tier_at_event = $10 THEN $11
         WHEN $1 = 'com' AND tier_at_event = $12 THEN $13
         WHEN COALESCE(tier_at_event, 'Unknown') = 'Unknown' THEN 'BRONZE'
         WHEN $1 = 'com' AND UPPER(tier_at_event) NOT IN ('BRONZE', 'GLOW', 'GLAM') THEN 'BRONZE'
         ELSE tier_at_event
       END AS tier,
       COUNT(DISTINCT email) AS redemptions,
       COUNT(*) AS uses,
       COALESCE(SUM(points), 0) AS points_used
     FROM yotpo_events
     WHERE site = $1 AND event_type = 'redemption' AND received_at >= $2 AND received_at < $3
     GROUP BY tier
     ORDER BY points_used DESC`,
    [
      site, start, end,
      IL_TIER_ID_BRONZE, 'BRONZE', IL_TIER_ID_GLAM, 'GLAM',
      COM_TIER_ID_BRONZE, 'BRONZE', COM_TIER_ID_GLOW, 'GLOW', COM_TIER_ID_GLAM, 'GLAM',
    ]
  );

  // tier_movement — fixed 2026-09-07 per Tomer ("hide 19818 → GLOW" on the
  // dashboard's "Movement between tiers" table). Root cause: this query
  // never normalized tier_from/tier_to at all, unlike redemptionsRes just
  // above — a tier_change webhook event that reported the RAW numeric ID
  // (e.g. ND.COM's "19818", confirmed = BRONZE — see the tier-ID constants
  // above) in tier_from showed up verbatim as "19818 → GLOW" instead of
  // resolving to "BRONZE → GLOW" the way every other tier display on this
  // dashboard does. Reuses normalizeCustomerTier() (already shared with the
  // Net Sales-by-tier feature — see that function's own comment for why it
  // must stay in sync with redemptionsRes's CASE expression) instead of
  // duplicating the ID-mapping a third time as a second SQL CASE. Normalizes
  // in JS after the raw GROUP BY below, then re-aggregates: two different
  // raw values that normalize to the same name (e.g. a real "BRONZE"
  // tier_from and a raw "19818" tier_from both moving to GLOW in the same
  // period) now correctly merge into one summed row instead of appearing as
  // two separate ones. A pair that normalizes to the SAME name on both sides
  // (e.g. raw "19818" → literal "BRONZE" — not a real tier change, just an
  // ID/name inconsistency for the same tier) is dropped, same as the raw
  // query already dropped literal tier_from = tier_to pairs.
  const movementRaw = await p.query(
    `SELECT tier_from, tier_to, COUNT(*) AS n
     FROM yotpo_events
     WHERE site = $1 AND event_type = 'tier_change' AND tier_from IS NOT NULL AND tier_from <> tier_to
       AND received_at >= $2 AND received_at < $3
     GROUP BY tier_from, tier_to
     ORDER BY n DESC`,
    [site, start, end]
  );
  const movementByPair = new Map();
  for (const r of movementRaw.rows) {
    const fromName = normalizeCustomerTier(site, r.tier_from);
    const toName = normalizeCustomerTier(site, r.tier_to);
    if (fromName === toName) continue; // ID/name variants of the same real tier — not a real movement
    const key = `${fromName}→${toName}`;
    movementByPair.set(key, (movementByPair.get(key) || 0) + Number(r.n));
  }
  const movementRes = {
    rows: Array.from(movementByPair.entries())
      .map(([key, n]) => {
        const [tier_from, tier_to] = key.split('→');
        return { tier_from, tier_to, n };
      })
      .sort((a, b) => b.n - a.n),
  };

  return {
    site,
    start,
    end,
    collecting_since: earliestEventAt,
    no_data: false,
    new_members: Number(newMembersRes.rows[0].n),
    redemptions_by_tier: redemptionsRes.rows.map((r) => ({
      tier: r.tier,
      redemptions: Number(r.redemptions),
      uses: Number(r.uses),
      points_used: Number(r.points_used),
      points_value: Number(r.points_used) / POINTS_PER_CURRENCY_UNIT,
    })),
    tier_movement: movementRes.rows.map((r) => ({
      from: r.tier_from,
      to: r.tier_to,
      count: Number(r.n),
    })),
  };
}

module.exports = {
  VALID_SITES,
  getPool,
  ensureYotpoSchema,
  recordYotpoEvent,
  getYotpoSummary,
  getYotpoCustomerTierMap, // added 2026-09-06 for the Net Sales-by-tier feature (see server.js)
  normalizeCustomerTier, // exported for the test harness
  classifyTopic, // exported for the test harness
};
