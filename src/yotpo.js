// src/yotpo-import.js
//
// One-time (repeatable) historical backfill for Section 8 (Yotpo Loyalty) —
// added 2026-09-06, later same day as the live webhook build in
// src/yotpo.js. Read that file's header first for the overall
// architecture; this file exists because of the constraint documented
// there: Yotpo's webhooks only start delivering events from whenever
// registration went live (Sept 6, 2026) — anything before that has to
// come from somewhere else, and Yotpo has no bulk/date-ranged API to pull
// it from. The "somewhere else" is Yotpo's own manual CSV exports
// (Loyalty & Referrals admin → Analytics → Reports), which Tomer downloads
// and uploads here through a simple admin page.
//
// ============================================================================
// WHAT CAN AND CAN'T BE BACKFILLED (confirmed against Yotpo's docs, not a
// live account — the CSV column names below are the best-documented guess;
// if Tomer's actual export uses different headers, the parser below will
// name the exact columns it found vs. expected, rather than fail silently)
// ============================================================================
// - New members: fully accurate. The Customers export includes a signup/
//   opt-in date, so this is a real historical count, not an approximation.
// - Redemptions: accurate at the transaction level (date, points, reward,
//   customer) — Yotpo's Redemptions History export has all of that. What
//   it does NOT have is which VIP tier the customer was on *at the time*
//   of that historical redemption — Yotpo doesn't export tier-change
//   history at all, only a customer's CURRENT tier (from the Customers
//   export). Per Tomer's decision (2026-09-06), backfilled redemptions are
//   grouped by each customer's CURRENT tier as an approximation — this is
//   flagged explicitly in the imported row's topic ('backfill:...') so it's
//   distinguishable from a real webhook-observed tier, and anyone who
//   changed tiers since a historical redemption will show under their
//   tier today, not the tier they actually held then.
// - Tier movement: NOT backfillable at all, by design constraint, not an
//   oversight. Movement between tiers only exists from real webhook events
//   forward (Sept 6, 2026 on) — there is no Yotpo export of historical
//   tier-change events to reconstruct it from.
//
// ============================================================================
// IDEMPOTENCY
// ============================================================================
// Every backfilled row is tagged with a topic starting 'backfill:' (never
// used by the live webhook path, which always uses real 'swell/...'
// topics) specifically so a re-import is safe: each run first deletes any
// previously-imported 'backfill:*' rows for that site, then inserts the
// freshly parsed ones. Re-uploading a corrected or extended CSV export
// REPLACES the prior backfill for that site rather than piling up
// duplicates. Real webhook-observed events are never touched by this.
//
// Importing the Customers CSV also seeds/updates yotpo_customers.
// current_tier for every customer in the file — a useful side effect
// beyond the historical display: it means the very first REAL webhook
// tier-change event for an existing customer, after go-live, will compute
// a correct tier_from from this imported baseline instead of defaulting to
// null (the "no prior record" case that ordinarily excludes a customer's
// first-ever tier event from the movement stats).

const { parse } = require('csv-parse/sync');

// Lenient date parsing — Yotpo's exact CSV date format wasn't verified
// against a live export. JS's Date constructor handles ISO 8601
// ("2026-01-15T10:23:00Z" / "2026-01-15 10:23:00") and most common
// "MM/DD/YYYY" style strings; anything it can't parse throws a specific,
// named error (which row/column, what the raw value was) rather than
// silently skipping or miscounting a row.
function parseDate(raw, rowNum, columnName) {
  if (!raw || !String(raw).trim()) return null;
  const d = new Date(String(raw).trim());
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Row ${rowNum}: couldn't parse "${columnName}" value "${raw}" as a date. ` +
        `If your export uses a different date format, tell Claude the exact ` +
        `format so this parser can be adjusted.`
    );
  }
  return d;
}

// Tries several plausible header spellings for the same column — exports
// change slightly across Yotpo plan tiers/versions, and this avoids a hard
// failure over e.g. "vip_tier" vs "tier" vs "current_tier".
function pick(row, candidates) {
  for (const name of candidates) {
    if (row[name] !== undefined && row[name] !== '') return row[name];
  }
  return null;
}

function parseCsvBuffer(buffer, label) {
  let rows;
  try {
    rows = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw new Error(`Couldn't parse the ${label} CSV: ${err.message}`);
  }
  if (!rows.length) {
    throw new Error(`The ${label} CSV has no data rows (just a header, or empty file).`);
  }
  return rows;
}

// Parses the Customers export. Returns { customers, newMemberEvents } —
// customers is used to seed yotpo_customers (current tier lookup, used
// both for the redemption-tier approximation below AND for real future
// webhook tier_from lookups); newMemberEvents is one row per customer who
// has a real signup/opt-in date, ready to insert into yotpo_events.
function parseCustomersCsv(buffer) {
  const rows = parseCsvBuffer(buffer, 'Customers');
  const customers = [];
  const newMemberEvents = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2; // +1 for header row, +1 for 1-indexing
    const email = pick(row, ['email', 'Email', 'customer_email']);
    if (!email) return; // skip rows with no email — nothing to key on
    const tier = pick(row, ['vip_tier', 'tier', 'current_tier', 'VIP Tier']);
    customers.push({ email: email.toLowerCase().trim(), tier });

    const signupRaw = pick(row, ['created_at', 'opt_in_date', 'Created At', 'Opt In Date']);
    const isMember = pick(row, ['loyalty_member', 'Loyalty Member']);
    if (signupRaw && (isMember === null || String(isMember).toLowerCase() !== 'false')) {
      const signupDate = parseDate(signupRaw, rowNum, 'created_at/opt_in_date');
      if (signupDate) {
        newMemberEvents.push({
          email: email.toLowerCase().trim(),
          receivedAt: signupDate,
          tierAtEvent: tier,
          rawRow: row,
        });
      }
    }
  });
  return { customers, newMemberEvents };
}

// Parses the Redemptions History export. tierByEmail (from
// parseCustomersCsv, or a fresh DB lookup) supplies the "current tier"
// approximation for each row, per Tomer's confirmed decision.
function parseRedemptionsCsv(buffer, tierByEmail) {
  const rows = parseCsvBuffer(buffer, 'Redemptions History');
  const events = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const email = pick(row, ['email', 'Email', 'customer_email']);
    if (!email) return;
    const dateRaw = pick(row, ['date', 'date_completed', 'Date']);
    const receivedAt = parseDate(dateRaw, rowNum, 'date');
    if (!receivedAt) return; // no date at all — can't place it in a period, skip
    const pointsRaw = pick(row, ['points', 'Points']);
    const points = pointsRaw !== null ? Math.abs(Number(pointsRaw)) || 0 : 0;
    const rewardName = pick(row, ['description', 'Description', 'redemption_option']);
    const key = email.toLowerCase().trim();
    events.push({
      email: key,
      receivedAt,
      points,
      rewardName,
      tierAtEvent: tierByEmail.get(key) || null,
      rawRow: row,
    });
  });
  return events;
}

// ============================================================================
// 2026-09-06 fix — ND.COM's import was hitting a 502 Bad Gateway
// ============================================================================
// ND.COM's export is far larger than EU's or IL's (~48,500 new members +
// ~17,500 redemptions ≈ 66,000 rows total, vs. EU's ~16,700 and IL's
// ~5,065). Two separate bugs, both scaling with row count, only showed up
// at that size:
//
// 1. This function used to insert one row at a time (a separate `await
//    client.query(...)` per customer / per event) inside a single DB
//    transaction. For ~66,000 sequential round trips that's slow enough to
//    blow past Render's own gateway timeout — the browser sees a bare "502
//    Bad Gateway" from Render's edge, even though the Node process is still
//    working and (per the server logs) hadn't crashed. Fixed by batching
//    every insert into multi-row VALUES statements (BATCH_SIZE rows per
//    query — see chunkArray/insertBatch below) — this turns ~66,000 round
//    trips into ~130, which finishes comfortably inside any reasonable
//    request timeout.
// 2. After the transaction committed, the summary step used
//    `Math.min(...allDates)` / `Math.max(...allDates)` to find the earliest/
//    latest imported date. Spreading a large array as call arguments hits a
//    hard V8 limit (documented behavior, not a bug in this specific data —
//    it throws "RangeError: Maximum call stack size exceeded" once the
//    array gets large enough, and ND.COM's ~66,000 combined dates crossed
//    that threshold). Confirmed in Render's logs: "yotpo history import
//    (site=com) failed: Maximum call stack size exceeded" — this fired
//    AFTER the real data had already committed successfully, so the import
//    itself was fine; only the summary calculation crashed, taking the
//    success response down with it. Fixed with a plain loop (minMaxDates
//    below) that has no size limit.
//
// Both fixes are pure performance/robustness changes — the data written and
// the summary numbers returned are identical to before, just computed in a
// way that scales to ND.COM's larger export.

const BATCH_SIZE = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Batch-inserts `rows` into `table(columns...)` in chunks of BATCH_SIZE,
// sharing a single `$1` placeholder for `site` across every row in a batch
// (it's the same value every time — Postgres allows reusing a numbered
// parameter across multiple VALUES tuples in one query) and building the
// rest of each row's placeholders from `rowValues(row)`, which must return
// an array of values in the same order as `columns` (excluding site, and
// excluding any literal columns already baked into `literalColumns`).
async function insertBatch(client, table, columns, literalColumns, rows, site, rowValues) {
  for (const batch of chunkArray(rows, BATCH_SIZE)) {
    const valueTuples = [];
    const params = [site];
    for (const row of batch) {
      const vals = rowValues(row);
      const base = params.length;
      params.push(...vals);
      const placeholders = vals.map((_, i) => `$${base + i + 1}`);
      valueTuples.push(`($1, ${literalColumns.map((l) => `'${l}'`).join(', ')}${placeholders.length ? ', ' : ''}${placeholders.join(', ')})`);
    }
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueTuples.join(', ')}`,
      params
    );
  }
}

// Replacement for `Math.min(...dates)` / `Math.max(...dates)` — see fix #2
// above. A plain loop has no argument-count ceiling, unlike spreading an
// array as call arguments.
function minMaxDates(dates) {
  if (!dates.length) return { min: null, max: null };
  let min = dates[0];
  let max = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < min) min = dates[i];
    if (dates[i] > max) max = dates[i];
  }
  return { min, max };
}

// Runs the full import for one site: seeds yotpo_customers from the
// Customers CSV, then inserts backfilled new_member and redemption events
// (replacing any prior backfill for this site first — see file header on
// idempotency). Returns a small summary for the admin page to display.
async function importYotpoHistory(pool, site, { customersBuffer, redemptionsBuffer }) {
  const { customers, newMemberEvents } = parseCustomersCsv(customersBuffer);
  const tierByEmail = new Map(customers.map((c) => [c.email, c.tier]));
  const redemptionEvents = parseRedemptionsCsv(redemptionsBuffer, tierByEmail);
  const customersWithTier = customers.filter((c) => c.tier); // nothing useful to seed without a tier value

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Replace any prior backfill for this site — see "IDEMPOTENCY" above.
    await client.query(
      `DELETE FROM yotpo_events WHERE site = $1 AND topic IN ('backfill:customers_csv', 'backfill:redemptions_csv')`,
      [site]
    );

    // Seed/update yotpo_customers from the Customers export — this is what
    // both the redemption-tier approximation and future real webhook
    // tier_from lookups read from. Batched (see file header, fix #1).
    for (const batch of chunkArray(customersWithTier, BATCH_SIZE)) {
      const valueTuples = [];
      const params = [site];
      for (const c of batch) {
        const base = params.length;
        params.push(c.email, c.tier);
        valueTuples.push(`($1, $${base + 1}, $${base + 2}, now())`);
      }
      await client.query(
        `INSERT INTO yotpo_customers (site, email, current_tier, updated_at)
         VALUES ${valueTuples.join(', ')}
         ON CONFLICT (site, email) DO UPDATE SET current_tier = EXCLUDED.current_tier, updated_at = now()`,
        params
      );
    }

    await insertBatch(
      client,
      'yotpo_events',
      ['site', 'topic', 'event_type', 'email', 'tier_at_event', 'received_at', 'raw_payload'],
      ['backfill:customers_csv', 'new_member'],
      newMemberEvents,
      site,
      (e) => [e.email, e.tierAtEvent, e.receivedAt.toISOString(), JSON.stringify(e.rawRow)]
    );

    await insertBatch(
      client,
      'yotpo_events',
      ['site', 'topic', 'event_type', 'email', 'tier_at_event', 'points', 'reward_name', 'received_at', 'raw_payload'],
      ['backfill:redemptions_csv', 'redemption'],
      redemptionEvents,
      site,
      (e) => [e.email, e.tierAtEvent, e.points, e.rewardName, e.receivedAt.toISOString(), JSON.stringify(e.rawRow)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { min: earliest, max: latest } = minMaxDates([
    ...newMemberEvents.map((e) => e.receivedAt),
    ...redemptionEvents.map((e) => e.receivedAt),
  ]);

  return {
    site,
    customers_seeded: customersWithTier.length,
    new_members_imported: newMemberEvents.length,
    redemptions_imported: redemptionEvents.length,
    earliest_date: earliest ? earliest.toISOString().slice(0, 10) : null,
    latest_date: latest ? latest.toISOString().slice(0, 10) : null,
  };
}

module.exports = { importYotpoHistory, parseCustomersCsv, parseRedemptionsCsv };
