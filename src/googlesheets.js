// Pulls live channel-level revenue (and, where the sheet tracks it, cost)
// from the "Marketing P&L 2026" Google Sheet's "COM P&L 2026" tab, for the
// specific Section 4 channels Triple Whale genuinely cannot cover. Added
// 2026-09-03 after Tomer reported that Attentive's 4 channels, Microsoft
// Ads, Organic, and TikTok Affiliates + Organic were still showing no data
// in Section 4 even after the Shop App fix — investigation confirmed none
// of these are fixable via Triple Whale (see the header comment in
// src/triplewhale.js and the 2026-09-03 STATUS section in the build notes
// for the full per-channel writeup): Attentive has no usable data in Triple
// Whale's warehouse at all, Microsoft/Bing Ads has no connected paid
// platform there, "Organic" is a self-balancing plug figure, and "TikTok
// Affiliates + Organic" is a custom metric with no confirmed SQL
// reconstruction. All of these ARE already tracked in the P&L sheet by the
// existing monthly-update skill (com-pnl-monthly-update-fast) — this module
// reads that same sheet directly so the dashboard doesn't have to wait for
// a human to run that skill and doesn't just show "no data" in the
// meantime... though it's still only as fresh as the last time someone (or
// that skill) updated the sheet's Actual column for the current month. This
// is fundamentally different from the Shopify/Triple Whale legs, which are
// live for any date range — see the freshness caveat below.
//
// AUTH: none — no service account, no API key, no Render env vars. This
// reads the sheet's public CSV export URL, which only works once the sheet
// is shared as "Anyone with the link" (Viewer). Tomer chose this over a
// Google Cloud service account 2026-09-03 specifically to avoid that setup
// — the deliberate trade-off is that the WHOLE spreadsheet (every tab —
// COM/EU/IL P&L, not just the COM revenue breakdown this module reads)
// becomes viewable by anyone who has the link, with no login required. Not
// indexed or discoverable, but not authenticated either. One-time setup for
// Tomer: open the sheet -> Share -> General access -> "Anyone with the
// link" -> Viewer. That's the entire setup; nothing else to configure.
//
// Until that sharing setting is turned on, fetchPnlSheetChannels() below
// gets a Google sign-in page back instead of CSV, detects that (see
// looksLikeCsv below), logs it, and resolves to null — so this is safe to
// deploy before Tomer changes the sharing setting; the rest of the sync is
// completely unaffected.
//
// FRESHNESS: unlike Shopify/Triple Whale, this is NOT a live query — it
// reads whatever number is currently sitting in the sheet's "Actual" column
// for the requested month, which is only as current as the last time a
// human (or the com-pnl-monthly-update-fast skill) updated it. It could be
// today's number or several days stale. The frontend's channels_note has
// been updated to say this explicitly for the channels sourced this way,
// so Tomer doesn't mistake "sheet-sourced" for "live-live" the way
// Shopify/Triple Whale channels are.
//
// SCOPE: ND.COM only for now — the "COM P&L 2026" tab's row layout is what
// was inspected and verified live on 2026-09-03 (see below). ND.EU/ND.IL
// have their own "EU P&L 2026"/"IL P&L 2026" tabs with row layouts that
// have NOT been inspected yet — fetchPnlSheetChannels() below returns null
// immediately for any site other than 'com' rather than guess at an
// unverified layout.
//
// SHEET STRUCTURE (verified live 2026-09-03 by reading actual cell values
// in the browser, not just labels — row numbers had already drifted once
// since an earlier skill run added a Pinterest row and a Microsoft Ads row
// to the sheet that didn't exist before):
//   - Row 2 holds the month/quarter header labels ("Jan-26", "Feb-26", ...,
//     "Q1 2026", ..., "Sep-26", "Q3 2026", ...). Each month is 4 columns:
//     Goal, Sales %, Actual, G vs A, in that order — so once the column
//     holding e.g. "Sep-26" is found, the Actual column is 2 columns to its
//     right. NEVER hardcode a column position (they shift every month, and
//     shifted an extra time this run because of the two new rows above).
//   - The "Revenue Breakdown" section (row label "Revenue Breakdown" in
//     column D, ending at the row labeled "Total Gross Sales") lists each
//     channel's revenue for the month, one label per row.
//   - A second, separate "Cost" section further down (headed by a row
//     labeled "Cost" in column D) lists ad spend for some of those same
//     channels, again one label per row — Attentive's 4 channels, Pinterest
//     and Microsoft Ads all have a real cost row; "TikTok Organic +
//     Affiliates" and the "Organic Revenue (P.N)" plug do not (matches how
//     Shop App/impact.com already render on the dashboard: real revenue,
//     "—" ROAS, because there's genuinely no ad spend to report).
//   - Both sections are located dynamically by scanning column D for those
//     exact anchor labels, then reading channel labels between/after them —
//     NOT by hardcoded row numbers — specifically so this keeps working the
//     next time someone inserts or reorders a row in the sheet (as already
//     happened once between when this was scoped and when it was built).
//   - "Organic Revenue (P.N)" is a self-balancing plug FORMULA
//     (`=GrossSales - SUM(every other revenue row)`), not a typed-in value.
//     The CSV export carries its computed result, not the formula text, so
//     no special-casing is needed to read it — just don't ever try to write
//     to this cell.
//
// LABEL MAPPING: the sheet's own row labels don't always match the
// dashboard's existing Section 4 labels (confirmed 2026-09-03 against
// DATA.sites.com.months.Aug.channels in dashboard_v2.html) — CHANNEL_ROWS
// below maps each sheet label to the exact dashboard label so the
// frontend's existing by-label merge (mergeLiveIntoMonthData) matches
// these up correctly:
//   Sheet "SMS Jurney"                    -> "Attentive - SMS Journey"
//   Sheet "SMS Campaign"                  -> "Attentive - SMS Campaign"
//   Sheet "Email Jurney"                  -> "Attentive - Email Journey"
//   Sheet "Email Campaign - Newsletter"   -> "Attentive - Email Campaign (Newsletter)"
//   Sheet "Microsoft Ads"                 -> "Microsoft Ads" (unchanged)
//   Sheet "Pinterest"                     -> "Pinterest" (unchanged — see note below)
//   Sheet "TikTok Organic + Affiliates"   -> "TikTok Affiliates + Organic" (word order differs!)
//   Sheet "Organic Revenue (P.N)"         -> "Organic"
// Deliberately NOT pulled from the sheet: "Shop" (row labeled "Shop" in the
// sheet) and "Impact" (row labeled "Impact ") are already live-synced from
// Triple Whale as "Shop App" and "impact.com" respectively — pulling them
// again from the sheet too would let a stale sheet number silently
// overwrite a fresher Triple Whale one. The merge logic below only ever
// fills in a channel the OTHER source left as no_data, never overwrites one
// that already has real data, but keeping Shop/Impact out of CHANNEL_ROWS
// entirely avoids the ambiguity of two live sources for the same channel.
//
// BONUS FIX INCLUDED (2026-09-03, same day as the original build): Tomer's
// report didn't mention Pinterest, but it has the exact same symptom as
// Microsoft Ads — it's in Triple Whale's CHANNEL_MAP already, comes back
// `no_data: true` there (Pinterest isn't run as a connected ad platform on
// ND.COM), and — just confirmed live — the P&L sheet already tracks a real
// Pinterest revenue+cost figure the same way it now tracks Microsoft Ads.
// Since the code path is identical, it's included here rather than shipping
// a fix that would need a repeat of this exact investigation the next time
// Tomer notices Pinterest is blank too.
//
// COLLABS ADDED 2026-09-03 (later same day) — Tomer reported "it doesn't
// pull Collabs". Unlike Shop/Impact above, Collabs Affiliate has NO live
// source at all: it's Shopify's Collabs app, which has no MCP/Shopify
// Analytics equivalent (ShopifyQL's documented sources don't expose
// Collabs-app data — same limitation the com-pnl-monthly-update-fast skill
// documents for why it still reads the Collabs app's own dashboard via
// browser rather than a connector) and Triple Whale's CHANNEL_MAP has no
// entry for it either. So this was a real gap, not an intentional
// exclusion like Shop/Impact — Section 4 was silently showing the
// dashboard's stale embedded snapshot (0 for the current month) with no
// "no data" indicator to flag it. Confirmed live via the Google Drive
// connector (reading this exact spreadsheet directly, bypassing the CSV
// export URL) that the sheet has a real "Collabs" row in both the Revenue
// Breakdown and Cost sections — Sep-26 Actual showing $10,160 revenue /
// $928 cost, non-zero and current. Row numbers for both have drifted AGAIN
// since the original 2026-09-03 build (Revenue Breakdown's Collabs row
// moved, and Cost's Collabs row is now ~66 instead of the ~62 last
// recorded in the skill notes) — another live confirmation that the
// dynamic anchor-scan approach below (not hardcoded row numbers) was the
// right call. Dashboard label confirmed as "Collabs Affiliate" by grepping
// dashboard_v2.html's embedded Section 4 data.

const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '11D_QS9rFe8CdG88fNba-onG3arMrDfIxNq3Ta_QUQsQ';
// gid of the "COM P&L 2026" tab specifically (confirmed live 2026-09-03 —
// each tab in a Google Sheet has its own stable gid, visible in the tab's
// URL as `#gid=...`). Overridable in case the tab is ever recreated (which
// changes its gid) without needing a code change.
const COM_TAB_GID = process.env.GOOGLE_SHEETS_COM_GID || '1318706996';

const CSV_EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${COM_TAB_GID}`;

// Sheet label -> dashboard label, plus whether a matching Cost-section row
// exists for it. See the LABEL MAPPING note above.
const CHANNEL_ROWS = [
  { sheetLabel: 'SMS Jurney', dashboardLabel: 'Attentive - SMS Journey', hasCost: true },
  { sheetLabel: 'SMS Campaign', dashboardLabel: 'Attentive - SMS Campaign', hasCost: true },
  { sheetLabel: 'Email Jurney', dashboardLabel: 'Attentive - Email Journey', hasCost: true },
  {
    sheetLabel: 'Email Campaign - Newsletter',
    dashboardLabel: 'Attentive - Email Campaign (Newsletter)',
    hasCost: true,
  },
  { sheetLabel: 'Microsoft Ads', dashboardLabel: 'Microsoft Ads', hasCost: true },
  { sheetLabel: 'Pinterest', dashboardLabel: 'Pinterest', hasCost: true },
  { sheetLabel: 'TikTok Organic + Affiliates', dashboardLabel: 'TikTok Affiliates + Organic', hasCost: false },
  { sheetLabel: 'Organic Revenue (P.N)', dashboardLabel: 'Organic', hasCost: false },
  // Added 2026-09-03 — see the COLLABS ADDED note in the file header above.
  { sheetLabel: 'Collabs', dashboardLabel: 'Collabs Affiliate', hasCost: true },
];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Matches the sheet's own header format, e.g. "Sep-26" for September 2026.
function monthLabelFor(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const mon = MONTH_ABBR[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${mon}-${yy}`;
}

// Minimal RFC4180-ish CSV parser — handles quoted fields (including
// embedded commas, embedded newlines, and "" as an escaped quote), \r\n or
// \n line endings. No npm dependency, matches the plain-fetch/no-dependency
// style already used throughout this backend. Returns a 2D array of
// strings, one row per line, ragged rows left as-is (a short row just has
// fewer columns — the lookups below index safely past the end).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow; \n (or end of text) below closes the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // last field/row if the text didn't end with a newline
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// A not-yet-public (or no-longer-public) sheet's export URL redirects to a
// Google sign-in/HTML page instead of returning CSV — this is fetch()'s
// normal behavior (it follows the redirect), not an error status, so it
// can't be caught with `res.ok` alone. Detect it by checking the response
// actually looks like CSV rather than an HTML document.
function looksLikeCsv(text) {
  const head = text.slice(0, 200).trimStart().toLowerCase();
  return !head.startsWith('<!doctype') && !head.startsWith('<html');
}

// Locates the "Revenue Breakdown" and "Cost" sections in column D (index 3)
// and returns { revenueRows, costRows } — each a Map of trimmed row label
// -> 0-based row index within `rows`. Scanning for these anchor labels
// (rather than hardcoding row numbers) is deliberate: two new rows
// (Pinterest, Microsoft Ads) were inserted into this exact section between
// when this integration was scoped and when it was built, which is exactly
// the kind of drift a hardcoded row number silently breaks on.
function findRevenueAndCostRows(rows) {
  const colD = (i) => (rows[i] && rows[i][3] != null ? rows[i][3].trim() : '');
  let revStart = -1;
  let revEnd = -1;
  let costStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const v = colD(i);
    if (revStart === -1 && v === 'Revenue Breakdown') revStart = i;
    if (revStart !== -1 && revEnd === -1 && v === 'Total Gross Sales') revEnd = i;
    if (costStart === -1 && v === 'Cost' && i > Math.max(revEnd, 0)) costStart = i;
  }

  const revenueRows = new Map();
  if (revStart !== -1 && revEnd !== -1) {
    for (let i = revStart + 1; i < revEnd; i++) {
      const v = colD(i);
      if (v) revenueRows.set(v, i);
    }
  }

  const costRows = new Map();
  if (costStart !== -1) {
    const costEnd = Math.min(rows.length, costStart + 60);
    for (let i = costStart + 1; i < costEnd; i++) {
      const v = colD(i);
      if (v) costRows.set(v, i);
    }
  }

  return { revenueRows, costRows };
}

function parseNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Fetches this month's revenue (and cost, where the sheet tracks it) for
// the channels listed in CHANNEL_ROWS. `start` is the sync's start date
// (YYYY-MM-DD) — the calendar month it falls in is the month read from the
// sheet, matching how the P&L sheet itself only has one Actual-column
// bucket per month regardless of the exact day range requested. Returns an
// array shaped like fetchChannelPerformance's (triplewhale.js) output —
// [{ label, no_data }] or [{ label, no_data: false, spend_actual,
// revenue_actual, source: 'pnl_sheet' }] — or null if this site isn't
// covered yet, the sheet isn't shared as "Anyone with the link" yet, the
// month/rows couldn't be located, or the request failed (logged, never
// thrown).
async function fetchPnlSheetChannels(site, start) {
  if (site !== 'com') return null; // EU/IL tabs not verified yet -- see file header
  if (!start) return null;

  try {
    const res = await fetch(CSV_EXPORT_URL);
    if (!res.ok) {
      console.error(`googlesheets: CSV export request failed (${res.status}) — is the sheet shared as "Anyone with the link"?`);
      return null;
    }
    const text = await res.text();
    if (!looksLikeCsv(text)) {
      console.error('googlesheets: got an HTML page instead of CSV — the sheet is probably not shared as "Anyone with the link" (viewer) yet');
      return null;
    }

    const rows = parseCsv(text);
    if (rows.length < 3) return null;

    const targetLabel = monthLabelFor(start);
    const headerRow = rows[1] || []; // row 2 (0-indexed row 1)
    const colIdx = headerRow.findIndex((v) => (v || '').trim() === targetLabel);
    if (colIdx === -1) {
      console.error(`googlesheets: could not find column for month "${targetLabel}" in the CSV's row 2`);
      return null;
    }
    // Each month block is Goal, Sales %, Actual, G vs A in that order.
    const actualColIdx = colIdx + 2;

    const { revenueRows, costRows } = findRevenueAndCostRows(rows);
    if (revenueRows.size === 0) {
      console.error('googlesheets: could not locate the "Revenue Breakdown" section in the CSV');
      return null;
    }

    const cellAt = (rowIdx) => (rows[rowIdx] ? rows[rowIdx][actualColIdx] : undefined);

    return CHANNEL_ROWS.map((entry) => {
      const rIdx = revenueRows.get(entry.sheetLabel);
      if (rIdx === undefined) return { label: entry.dashboardLabel, no_data: true };
      const revenue = parseNum(cellAt(rIdx));
      if (revenue === null) return { label: entry.dashboardLabel, no_data: true };

      let spend = 0;
      if (entry.hasCost) {
        const cIdx = costRows.get(entry.sheetLabel);
        const parsedSpend = cIdx !== undefined ? parseNum(cellAt(cIdx)) : null;
        spend = parsedSpend === null ? 0 : parsedSpend;
      }

      return {
        label: entry.dashboardLabel,
        no_data: false,
        spend_actual: spend,
        revenue_actual: revenue,
        source: 'pnl_sheet',
      };
    });
  } catch (err) {
    console.error(`fetchPnlSheetChannels threw for site=${site}:`, err.message);
    return null;
  }
}

module.exports = { fetchPnlSheetChannels, CHANNEL_ROWS, parseCsv };
