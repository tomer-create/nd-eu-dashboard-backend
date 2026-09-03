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
//
// SECTION 7 (OTHER COSTS) + LIVE PROFIT/PROFIT MARGIN ADDED 2026-09-03
// (later still) — Tomer: "fix the Profit and the profit margin" ->
// clarified "for all 3 sites... should be formula: net sales - Other
// Costs. also the other costs section doesn't pull from the spreadsheet."
// Section 7 (Other Costs) was, until now, exactly like Profit/Profit
// Margin/Blended ROAS: 100% embedded-snapshot, never touched by a Sync
// (confirmed by grepping server.js — no `other_costs` field anywhere in
// its response). Since Profit needs a live Other Costs total to be a live
// number itself, this fetches Section 7's own line items from the sheet
// the same way CHANNEL_ROWS does for Section 4 — dynamic anchor-scan of
// each site's own "Cost" section, no hardcoded rows.
//
// THIS PART COVERS ALL 3 SITES, unlike CHANNEL_ROWS above (still COM-only)
// — Tomer explicitly asked for all 3, and Section 7 already has its own
// curated, DIFFERENT list of line items per site (EU/IL P&L tab row
// layouts inspected live 2026-09-03 via WebFetch against the sheet's own
// CSV export, following its redirect to
// doc-*.googleusercontent.com/export — docs.google.com/.../export
// sometimes 401s through WebFetch directly even once public; the redirect
// URL it hands back always works). EU tab gid confirmed 464121371, IL tab
// gid confirmed 1903859495 (both from the eu-pnl-monthly-update-fast /
// il-pnl-monthly-update-fast skill files, cross-checked live).
//
// PER-SITE OTHER-COSTS SCOPE DIFFERS ON PURPOSE: each site's Section 7
// list (OTHER_COST_ROWS below) was already curated in an earlier session to
// exclude exactly the cost rows that ARE tracked in that site's Section 4
// (to avoid double-counting) — and Section 4's live coverage differs by
// site (COM now covers Attentive/Microsoft Ads/Collabs/Pinterest via the
// sheet as of earlier today; EU/IL's Section 4 does not, so EU/IL's
// Section 7 still legitimately includes Impact Affiliate fees, Collabs,
// SMS/Email costs that COM's Section 7 excludes). This fetch respects
// whatever list each site's embedded other_costs already has — it does not
// change which line items appear, only makes their values live.
//
// PRODUCT COST / COGS: deliberately NOT read from the sheet for any site.
// Section 1's "COGS" KPI tile already pulls live from Shopify's own
// ShopifyQL cost_of_goods_sold metric (added 2026-08-24, specifically
// because Tomer said the sheet's own COGS number "isn't correct"). Section
// 7's "Product Cost" line item is the same concept — sourcing it from the
// sheet here would silently reintroduce the exact inaccuracy that fix
// already solved, AND could disagree with Section 1's own tile on the same
// dashboard. So OTHER_COST_ROWS never maps a "Product Cost" entry — the
// frontend merge (dashboard_v2.html) fills the "Product Cost" line, and
// COM's combined "PR Box Cost + Product Cost" line, directly from
// live.kpis.cogs instead. COM and IL's sheets both have their own separate
// "PR Box cost" row (returned here as a generic 'PR Box Cost' line item);
// COM's dashboard combines it with COGS into one tile ("per dashboard
// spec"), IL's keeps it as its own standalone tile — that combining
// decision lives in the frontend merge, not here.

const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '11D_QS9rFe8CdG88fNba-onG3arMrDfIxNq3Ta_QUQsQ';
// gid per site's own P&L tab (confirmed live 2026-09-03 — each tab in a
// Google Sheet has its own stable gid, visible in the tab's URL as
// `#gid=...`). Overridable in case a tab is ever recreated (which changes
// its gid) without needing a code change.
const TAB_GID = {
  com: process.env.GOOGLE_SHEETS_COM_GID || '1318706996',
  eu: process.env.GOOGLE_SHEETS_EU_GID || '464121371',
  il: process.env.GOOGLE_SHEETS_IL_GID || '1903859495',
};

function csvExportUrl(site) {
  const gid = TAB_GID[site];
  if (!gid) return null;
  return `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${gid}`;
}

// Sheet label -> dashboard label, plus whether a matching Cost-section row
// exists for it. See the LABEL MAPPING note above. COM only (see SCOPE note
// above) — Section 4's live P&L-sheet channel pull hasn't been extended to
// EU/IL yet.
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

// Section 7 (Other Costs) sheet label -> dashboard label, one list per site
// (each verified live against that site's own "COM/EU/IL P&L 2026" tab
// 2026-09-03 — see the SECTION 7 note above). 'PR Box Cost' is returned as
// a plain generic line item here for both COM and IL; the frontend decides
// whether to combine it with live COGS (COM) or show it standalone (IL).
const OTHER_COST_ROWS = {
  com: [
    { sheetLabel: 'Boxes', dashboardLabel: 'Boxes' },
    { sheetLabel: 'US - Shipping cost', dashboardLabel: 'US - Shipping Cost' },
    { sheetLabel: 'LATAM / Canada - Shipping cost', dashboardLabel: 'Swap (Global) Shipping Cost' },
    { sheetLabel: 'Pick & Pack', dashboardLabel: 'Pick & Pack Fee' },
    { sheetLabel: 'PPC Agency Fee', dashboardLabel: 'PPC Agency Fee' },
    { sheetLabel: 'Triple Whale - BI Tool', dashboardLabel: 'Triple Whale - BI Tool' },
    { sheetLabel: 'Talent Pop - Cstomer Service', dashboardLabel: 'Talent Pop - Customer Service' }, // sheet has this typo
    { sheetLabel: 'Reach Panel', dashboardLabel: 'Reach Panel' },
    { sheetLabel: 'SEO', dashboardLabel: 'SEO' },
    { sheetLabel: 'Shopify + Apps', dashboardLabel: 'Shopify + Apps' },
    { sheetLabel: 'Impact TBU', dashboardLabel: 'Impact TBU' },
    { sheetLabel: 'Quiz Fees', dashboardLabel: 'Quiz Fees' },
    { sheetLabel: 'Tolstoy Fee', dashboardLabel: 'Tolstoy Fee' },
    { sheetLabel: 'Development', dashboardLabel: 'Development' },
    { sheetLabel: 'Yotpo Loyalty Program', dashboardLabel: 'Yotpo Loyalty Program' },
    { sheetLabel: 'Yotpo Reviews', dashboardLabel: 'Yotpo Reviews' },
    { sheetLabel: 'Gratis', dashboardLabel: 'Gratis' },
    { sheetLabel: 'Commision', dashboardLabel: 'Commission (TikTok Affiliate)' }, // sheet has this typo
    { sheetLabel: 'TikTok Gifting', dashboardLabel: 'TikTok Gifting' },
    { sheetLabel: 'PR Box cost', dashboardLabel: 'PR Box Cost' }, // combined with live COGS client-side, see note above
  ],
  eu: [
    { sheetLabel: 'Boxes', dashboardLabel: 'Boxes' },
    { sheetLabel: 'Europe & ROW - Shipping cost', dashboardLabel: 'Europe & ROW - Shipping Cost' },
    { sheetLabel: 'Netherlands - Shipping cost', dashboardLabel: 'Netherlands - Shipping Cost' },
    { sheetLabel: 'Pick & Pack', dashboardLabel: 'Pick & Pack Fee' },
    { sheetLabel: 'PPC Agency Fee', dashboardLabel: 'PPC Agency Fee' },
    { sheetLabel: 'Triple Whale - BI Tool', dashboardLabel: 'Triple Whale - BI Tool' },
    { sheetLabel: 'Talent Pop - Customer Service', dashboardLabel: 'Talent Pop - Customer Service' },
    { sheetLabel: 'Reach Panel', dashboardLabel: 'Reach Panel' },
    { sheetLabel: 'SEO', dashboardLabel: 'SEO' },
    { sheetLabel: 'Shopify + Apps', dashboardLabel: 'Shopify + Apps' },
    { sheetLabel: 'Impact TBU', dashboardLabel: 'Impact TBU' },
    { sheetLabel: 'Impact Affiliate fees', dashboardLabel: 'Impact Affiliate fees' },
    { sheetLabel: 'Collabs', dashboardLabel: 'Collabs' },
    { sheetLabel: 'Quiz Fees', dashboardLabel: 'Quiz Fees' },
    { sheetLabel: 'Tolstoy Fee', dashboardLabel: 'Tolstoy Fee' },
    { sheetLabel: 'Development', dashboardLabel: 'Development' },
    { sheetLabel: 'SMS Jurney', dashboardLabel: 'SMS Jurney' },
    { sheetLabel: 'SMS Campaign', dashboardLabel: 'SMS Campaign' },
    { sheetLabel: 'Email Jurney', dashboardLabel: 'Email Jurney' },
    { sheetLabel: 'Email Campaign - Newsletter', dashboardLabel: 'Email Campaign - Newsletter' },
    { sheetLabel: 'Yotpo Loyalty Program', dashboardLabel: 'Yotpo Loyalty Program' },
    { sheetLabel: 'Yotpo Reviews', dashboardLabel: 'Yotpo Reviews' },
  ],
  il: [
    { sheetLabel: 'Boxes', dashboardLabel: 'Boxes' },
    { sheetLabel: 'IL - Shipping cost', dashboardLabel: 'IL - Shipping Cost' },
    { sheetLabel: 'Pick & Pack', dashboardLabel: 'Pick & Pack' },
    { sheetLabel: 'PPC Agency Fee', dashboardLabel: 'PPC Agency Fee' },
    { sheetLabel: 'Triple Whale - BI Tool', dashboardLabel: 'Triple Whale - BI Tool' },
    { sheetLabel: 'Reach Panel', dashboardLabel: 'Reach Panel' },
    { sheetLabel: 'Shopify + Apps', dashboardLabel: 'Shopify + Apps' },
    { sheetLabel: 'Collabs', dashboardLabel: 'Collabs' },
    { sheetLabel: 'Quiz Fees', dashboardLabel: 'Quiz Fees' },
    { sheetLabel: 'Tolstoy Fee', dashboardLabel: 'Tolstoy Fee' },
    { sheetLabel: 'Development', dashboardLabel: 'Development' },
    { sheetLabel: 'SMS Campaign', dashboardLabel: 'SMS Campaign' },
    { sheetLabel: 'Email Jurney', dashboardLabel: 'Email Jurney' },
    { sheetLabel: 'Email Campaign - Newsletter', dashboardLabel: 'Email Campaign - Newsletter' },
    { sheetLabel: 'Yotpo Loyalty Program', dashboardLabel: 'Yotpo Loyalty Program' },
    { sheetLabel: 'Yotpo Reviews', dashboardLabel: 'Yotpo Reviews' },
    { sheetLabel: 'PR Box cost', dashboardLabel: 'PR Box Cost' }, // standalone on IL, not combined with COGS
  ],
};

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

// Fetches + parses one site's P&L tab as a 2D array of strings, or null on
// any failure (not shared publicly, HTML instead of CSV, network error,
// too-short response) — always logged, never thrown. Shared by both
// fetchPnlSheetChannels and fetchPnlSheetOtherCosts below so the
// fetch/parse/error-handling logic exists exactly once.
async function fetchSheetRows(site) {
  const url = csvExportUrl(site);
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`googlesheets: CSV export request failed for site=${site} (${res.status}) — is the sheet shared as "Anyone with the link"?`);
      return null;
    }
    const text = await res.text();
    if (!looksLikeCsv(text)) {
      console.error(`googlesheets: got an HTML page instead of CSV for site=${site} — the sheet is probably not shared as "Anyone with the link" (viewer) yet`);
      return null;
    }

    const rows = parseCsv(text);
    if (rows.length < 3) return null;
    return rows;
  } catch (err) {
    console.error(`googlesheets: CSV fetch/parse threw for site=${site}:`, err.message);
    return null;
  }
}

// Locates the Actual column for `start`'s calendar month in an already-
// fetched sheet (`rows`), per the "Goal, Sales %, Actual, G vs A" 4-column
// block convention documented above. Returns the 0-based column index, or
// -1 if that month's column couldn't be found (logged by the caller).
function findActualColIdx(rows, start, site) {
  const targetLabel = monthLabelFor(start);
  const headerRow = rows[1] || []; // row 2 (0-indexed row 1)
  const colIdx = headerRow.findIndex((v) => (v || '').trim() === targetLabel);
  if (colIdx === -1) {
    console.error(`googlesheets: could not find column for month "${targetLabel}" in the ${site} CSV's row 2`);
    return -1;
  }
  // Each month block is Goal, Sales %, Actual, G vs A in that order.
  return colIdx + 2;
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
  if (site !== 'com') return null; // EU/IL tabs not extended to Section 4 yet -- see SCOPE note above
  if (!start) return null;

  const rows = await fetchSheetRows(site);
  if (!rows) return null;

  const actualColIdx = findActualColIdx(rows, start, site);
  if (actualColIdx === -1) return null;

  const { revenueRows, costRows } = findRevenueAndCostRows(rows);
  if (revenueRows.size === 0) {
    console.error(`googlesheets: could not locate the "Revenue Breakdown" section in the ${site} CSV`);
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
}

// Fetches this month's Section 7 (Other Costs) line items for `site` — see
// the SECTION 7 note above for full rationale. All 3 sites supported.
// Returns an array of { label, no_data } / { label, no_data: false,
// actual, source: 'pnl_sheet' } — one entry per OTHER_COST_ROWS[site] item
// — or null if this site has no mapping, the sheet isn't shared yet, the
// month/rows couldn't be located, or the request failed (logged, never
// thrown). Deliberately does NOT include a "Product Cost" entry for any
// site — see the PRODUCT COST / COGS note above; the frontend sources that
// line item from live Shopify COGS instead.
async function fetchPnlSheetOtherCosts(site, start) {
  const mapping = OTHER_COST_ROWS[site];
  if (!mapping || !start) return null;

  const rows = await fetchSheetRows(site);
  if (!rows) return null;

  const actualColIdx = findActualColIdx(rows, start, site);
  if (actualColIdx === -1) return null;

  const { costRows } = findRevenueAndCostRows(rows);
  if (costRows.size === 0) {
    console.error(`googlesheets: could not locate the "Cost" section in the ${site} CSV`);
    return null;
  }

  const cellAt = (rowIdx) => (rows[rowIdx] ? rows[rowIdx][actualColIdx] : undefined);

  return mapping.map((entry) => {
    const rIdx = costRows.get(entry.sheetLabel);
    if (rIdx === undefined) return { label: entry.dashboardLabel, no_data: true };
    const actual = parseNum(cellAt(rIdx));
    if (actual === null) return { label: entry.dashboardLabel, no_data: true };
    return { label: entry.dashboardLabel, no_data: false, actual, source: 'pnl_sheet' };
  });
}

module.exports = {
  fetchPnlSheetChannels,
  fetchPnlSheetOtherCosts,
  CHANNEL_ROWS,
  OTHER_COST_ROWS,
  parseCsv,
};
