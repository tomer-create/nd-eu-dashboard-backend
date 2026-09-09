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
// SCOPE: ND.COM and ND.IL as of 2026-09-08 — the "COM P&L 2026" tab's row
// layout was inspected and verified live 2026-09-03 (see below); ND.IL's
// "IL P&L 2026" tab was verified live 2026-09-08 (see the "IL ADDED" note
// further below) and turned out to have the IDENTICAL Revenue Breakdown/Cost
// row labels, so CHANNEL_ROWS is shared across both sites rather than
// needing a per-site label map. ND.EU's "EU P&L 2026" tab was ALSO checked
// live the same day and also matches this layout exactly, but is
// deliberately not enabled yet — see fetchPnlSheetChannels()'s own comment
// for why (OTHER_COST_ROWS double-counting risk that needs the same audit
// IL just got, plus new-row implications for channels EU doesn't actually
// run). fetchPnlSheetChannels() below returns null immediately for any site
// other than 'com'/'il' rather than guess at an unaudited site.
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
// IL ADDED 2026-09-08 — Tomer: "on Marketing & Sales Channel Performance in
// ND.IL Doesn't pull data from spreadsheet and for collabs Affiliate as
// well." Root cause: fetchPnlSheetChannels() below had a hard `site !== 'com'`
// gate from when this was first built (see the original SCOPE note above) —
// ND.IL's Section 4 was ENTIRELY frozen on the embedded snapshot, Collabs
// Affiliate included, exactly as reported. Verified live via WebFetch against
// the IL P&L tab's own CSV export (gid 1903859495, same redirect-following
// technique as the Section 7 fetch below) that its Revenue Breakdown and Cost
// sections have the EXACT SAME row labels as ND.COM's tab (SMS Jurney, SMS
// Campaign, Email Jurney, Email Campaign - Newsletter, Microsoft Ads,
// Pinterest, Collabs, TikTok Organic + Affiliates, Organic Revenue (P.N.) —
// all present, same spelling) — and cross-checked the dashboard's own
// embedded Section 4 data for ND.IL to confirm every CHANNEL_ROWS
// dashboardLabel already exists as a row there too. So CHANNEL_ROWS needed NO
// per-site variant for IL — just widening fetchPnlSheetChannels()'s site
// gate to also allow 'il'. ND.EU's tab was checked the same way the same day
// and ALSO matches this layout exactly, but is deliberately not turned on
// yet (see fetchPnlSheetChannels()'s own comment for why — the same
// double-counting audit this IL fix required, not yet done for EU).
//
// DOUBLE-COUNTING FIX REQUIRED ALONGSIDE THIS: IL's OTHER_COST_ROWS (Section
// 7) previously included 'Collabs', 'SMS Campaign', 'Email Jurney', and
// 'Email Campaign - Newsletter' as line items — legitimate at the time,
// since Section 4 wasn't sourcing them for IL yet (see the PER-SITE
// OTHER-COSTS SCOPE note below, written back when this was still true).
// Now that Section 4 pulls these same sheet rows for IL, leaving them in
// OTHER_COST_ROWS.il would count each one TWICE: once in Section 4's
// per-channel spend and again in Section 7's "Other Costs" total (which
// Profit falls back to when the sheet's own "Total Cost" row can't be read
// this sync). Removed all 4 from OTHER_COST_ROWS.il below, matching exactly
// how OTHER_COST_ROWS.com already excludes these same categories for the
// identical reason. ('SMS Jurney' was never in IL's Section 7 list to begin
// with — IL doesn't run that channel; matches it being one of the channels
// HIDDEN_CHANNELS_BY_SITE.il hides from Section 4's IL view in
// dashboard_v2.html — so nothing to remove there.)
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
// THIS PART COVERS ALL 3 SITES, unlike CHANNEL_ROWS above (COM+IL as of
// 2026-09-08, EU still pending — see the SCOPE note above) — Tomer
// explicitly asked for all 3 here, and Section 7 already has its own
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
// list (OTHER_COST_ROWS below) is curated to exclude exactly the cost rows
// that ARE tracked in that site's Section 4 (to avoid double-counting) — and
// Section 4's live sheet-coverage differs by site. As of 2026-09-08 (see the
// "IL ADDED" note above): COM and IL both cover Attentive/Microsoft
// Ads/Collabs/Pinterest via Section 4's sheet pull, so both sites' Section 7
// lists exclude Collabs/SMS/Email accordingly. EU's Section 4 does NOT yet
// pull these from the sheet (see fetchPnlSheetChannels()'s own comment for
// why it's not enabled there yet), so EU's Section 7 still legitimately
// includes Impact Affiliate fees, Collabs, SMS/Email costs that COM/IL's
// Section 7 now exclude — that's intentional, not drift, until EU gets the
// same audit. This fetch respects whatever list each site's embedded
// other_costs already has — it does not change which line items appear,
// only makes their values live.
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
// exists for it. See the LABEL MAPPING note above. Used for ND.COM and
// ND.IL as of 2026-09-08 (see the SCOPE and "IL ADDED" notes above) — shared
// as-is across both sites since their sheet tabs were verified live to have
// identical Revenue Breakdown/Cost row labels for every channel here. Not
// yet used for ND.EU (verified to match too, but not enabled — see
// fetchPnlSheetChannels()'s own comment).
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
    // NOTE: the IL P&L tab also has a second, generic "Shipping cost" row
    // (no site prefix) directly below "IL - Shipping cost" -- confirmed
    // live 2026-09-09 to be a blank/unused template leftover (every month
    // and the YTD column show "-", no formula) carried over from the
    // COM/EU tabs' two-row shipping split, which doesn't apply to IL
    // (single country, no split). Deliberately NOT mapped here -- do not
    // add it without confirming live that it has actually started holding
    // real numbers.
    { sheetLabel: 'Pick & Pack', dashboardLabel: 'Pick & Pack' },
    { sheetLabel: 'PPC Agency Fee', dashboardLabel: 'PPC Agency Fee' },
    { sheetLabel: 'Triple Whale - BI Tool', dashboardLabel: 'Triple Whale - BI Tool' },
    { sheetLabel: 'Talent Pop - Cstomer Service', dashboardLabel: 'Talent Pop - Customer Service' }, // sheet has this typo (same as COM)
    { sheetLabel: 'Reach Panel', dashboardLabel: 'Reach Panel' },
    { sheetLabel: 'SEO', dashboardLabel: 'SEO' },
    { sheetLabel: 'Shopify + Apps', dashboardLabel: 'Shopify + Apps' },
    { sheetLabel: 'Impact TBU', dashboardLabel: 'Impact TBU' },
    // 'Collabs', 'SMS Campaign', 'Email Jurney', and 'Email Campaign -
    // Newsletter' REMOVED 2026-09-08 — see the "IL ADDED"/"DOUBLE-COUNTING
    // FIX" note near the top of this file. These now live in Section 4
    // (CHANNEL_ROWS above, as 'Collabs Affiliate'/'Attentive - SMS
    // Campaign'/'Attentive - Email Journey'/'Attentive - Email Campaign
    // (Newsletter)') now that Section 4's sheet pull covers ND.IL — leaving
    // them here too would double-count them in Section 7's Other Costs
    // total. ('SMS Jurney' was never in this list — IL doesn't run that
    // channel, see HIDDEN_CHANNELS_BY_SITE.il in dashboard_v2.html.)
    { sheetLabel: 'Quiz Fees', dashboardLabel: 'Quiz Fees' },
    { sheetLabel: 'Tolstoy Fee', dashboardLabel: 'Tolstoy Fee' },
    { sheetLabel: 'Development', dashboardLabel: 'Development' },
    { sheetLabel: 'Yotpo Loyalty Program', dashboardLabel: 'Yotpo Loyalty Program' },
    { sheetLabel: 'Yotpo Reviews', dashboardLabel: 'Yotpo Reviews' },
    { sheetLabel: 'Gratis', dashboardLabel: 'Gratis' },
    // ADDED 2026-09-09: 'Talent Pop - Cstomer Service', 'SEO', 'Impact TBU',
    // 'Gratis', 'Commision', and 'TikTok Gifting' were all present as real
    // Cost-section rows on the live IL P&L tab (confirmed 2026-09-09,
    // with genuine historical Actual values -- e.g. Gratis=791 Aug-26,
    // Impact TBU=3,000 YTD, Commision=10 YTD) but were missing from this
    // array, so Section 7 (Other Costs) never pulled them -- this was the
    // cause of Tomer's "ND.IL Other Costs doesn't pull all the data"
    // report. None of these overlap Section 4's channel coverage (they
    // have no paired revenue channel), so adding them here doesn't
    // reintroduce the double-counting the 2026-09-08 fix removed.
    { sheetLabel: 'Commision', dashboardLabel: 'Commission (TikTok Affiliate)' }, // sheet has this typo (same as COM)
    { sheetLabel: 'TikTok Gifting', dashboardLabel: 'TikTok Gifting' },
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

// Parses a P&L sheet cell's displayed text into a number, or null if it's
// genuinely empty/non-numeric (a bare "-" placeholder the sheet shows for
// zero/blank cells, an error string, etc). Strips thousands-separator
// commas AND whitespace -- not just commas -- because Google Sheets renders
// negative numbers under this sheet's number format as "- 144,493" (a SPACE
// between the minus sign and the digits, i.e. accounting-style spacing),
// and `Number()` refuses to parse that (Number("- 144493") is NaN; only
// Number("-144493") works). Before 2026-09-09 this function only stripped
// commas, so any negative cell silently came back as null/no_data instead
// of its real (negative) value. Caught when ND.IL's "Organic Revenue (P.N)"
// -- a self-balancing plug row that can legitimately go negative -- showed
// no_data:true for Sep-26 despite the sheet clearly showing "- 144,493" in
// that cell (confirmed live via the cell's own formula bar: Sep-26 Actual
// literally computed to -144,493 that day). Stripping all whitespace (not
// just the sign-adjacent gap) is safe here: every value this function ever
// sees is a plain formatted number/currency string, never free text with
// meaningful internal spaces, and a bare "-" placeholder still correctly
// parses to NaN -> null after stripping (nothing left for Number() to read
// but the dash itself). Affects every P&L-sheet reader in this file
// (fetchPnlSheetChannels, fetchPnlSheetOtherCosts, fetchPnlSheetTotalCost,
// fetchPnlSheetMarketingSpend) since they all funnel through this one
// function -- not just the row that surfaced it.
function parseNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
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
  // ND.IL added 2026-09-08 -- see the "IL ADDED" note above. ND.EU's tab
  // verified to have the identical row layout too (same live check, same
  // day) but NOT enabled here yet -- Tomer only reported ND.IL, and turning
  // EU on would need the same OTHER_COST_ROWS double-count audit this IL fix
  // got (EU's OTHER_COST_ROWS.eu currently still includes Collabs/SMS/Email,
  // same as IL's did before this fix) plus a check of what NEW rows would
  // appear for channels EU doesn't actually run (e.g. Microsoft Ads/Pinterest
  // showing a $0 row instead of staying absent). Flip this to include 'eu'
  // once that's done, following the exact same pattern as IL below.
  if (site !== 'com' && site !== 'il') return null;
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

// Fetches this month's "Total Cost" row directly from the sheet — added
// 2026-09-07 after Tomer noticed the dashboard's Profit/Profit Margin
// disagreed with the sheet's own Profit row for "the same formula". Root
// cause: the 2026-09-03 fix computed Profit as Net Sales − Section 7's
// "Other Costs" total, but "Other Costs" (OTHER_COST_ROWS above) is only a
// SUBSET of the sheet's true Total Cost row — it deliberately excludes
// whatever cost categories Section 4 already shows per-channel (ad-platform
// spend for every site; for EU/IL that's ALSO SMS/Email/Collabs/Impact fees,
// since those sit in OTHER_COST_ROWS.eu/.il but not .com — see the site
// lists above). Reconstructing "true total cost" client-side by adding
// Section 4's channel spend back on top of Section 7's total would have
// double-counted those categories for EU/IL (present in both sections
// there) while under-counting nothing for COM — an asymmetric, error-prone
// fix. Reading the sheet's own "Total Cost" row directly (it's already a
// single SUM formula covering every cost line, see the sheet's row for the
// exact range) sidesteps that entirely: one number, straight from the same
// authoritative formula Tomer already reviews, for all 3 sites uniformly,
// with no reconstruction logic to get subtly wrong per site.
//
// Uses the SAME live sheet-row-scanning approach as fetchPnlSheetOtherCosts
// (label-scan via findRevenueAndCostRows's costRows map, not a hardcoded
// row number) so this doesn't silently break the next time a row is
// inserted above it. Returns { no_data: false, actual, source: 'pnl_sheet' }
// or { no_data: true } (label not found, month column not found, sheet not
// shared, or the request failed — logged, never thrown), or null if the
// sheet fetch itself failed before any label-scanning could happen.
async function fetchPnlSheetTotalCost(site, start) {
  if (!start) return null;

  const rows = await fetchSheetRows(site);
  if (!rows) return null;

  const actualColIdx = findActualColIdx(rows, start, site);
  if (actualColIdx === -1) return null;

  const { costRows } = findRevenueAndCostRows(rows);
  if (costRows.size === 0) {
    console.error(`googlesheets: could not locate the "Cost" section in the ${site} CSV (fetchPnlSheetTotalCost)`);
    return null;
  }

  const rIdx = costRows.get('Total Cost');
  if (rIdx === undefined) {
    console.error(`googlesheets: could not find a "Total Cost" row in the ${site} CSV's Cost section`);
    return { no_data: true };
  }
  const actual = parseNum(rows[rIdx] ? rows[rIdx][actualColIdx] : undefined);
  if (actual === null) return { no_data: true };
  return { no_data: false, actual, source: 'pnl_sheet' };
}

// Marketing-only cost rows — added 2026-09-07 to make Section 1's "Blended
// ROAS" tile live (previously 100% frozen at the embedded snapshot, even for
// the CURRENT month — unlike every other KPI tile, it had no live-sync path
// at all). There's no single "Blended ROAS" or "Marketing Spend" row
// anywhere in the sheet to just read directly (confirmed live 2026-09-07 by
// grepping all 3 sites' full CSV export for "blended" — zero matches) — this
// dashboard's Blended ROAS was always a COMPUTED metric
// (Gross Sales ÷ sum of these specific cost lines), first hand-built in
// build_dashboard_data.py when the dashboard's embedded snapshot was
// generated. This list is exactly that script's MARKETING_COST_KEYS,
// translated to the sheet's own row labels instead of that script's
// internal key names, so the live figure is the same formula, not a new
// one — same principle as the 2026-09-07 Total Cost fix (Tomer: "check who
// is wrong and why" when the dashboard and sheet disagreed on Profit).
//
// Confirmed live 2026-09-07 that ALL 3 sites (COM/EU/IL) use these exact 15
// labels in their Cost sections, unlike OTHER_COST_ROWS above (which is a
// genuinely asymmetric per-site list) — so this is intentionally ONE shared
// list, not a per-site map. Only the ROW NUMBERS differ site to site (and
// month to month, as rows are inserted/removed) — findRevenueAndCostRows's
// label-scan handles that the same way it does for every other lookup in
// this file.
const MARKETING_COST_ROWS = [
  'Google Ads',
  'Meta ads',
  'TikTok Shop Ads',
  'Commision', // sheet's own spelling (not a typo in this file) — exact-match lookup
  'TikTok Gifting',
  'Criteo Ads',
  'PPC Agency Fee',
  'Shop PPC',
  'Impact TBU',
  'Impact Affiliate fees',
  'Collabs',
  'SMS Jurney', // sheet's own spelling
  'SMS Campaign',
  'Email Jurney', // sheet's own spelling
  'Email Campaign - Newsletter',
];

// Fetches this month's total marketing spend (sum of MARKETING_COST_ROWS)
// for `site`, for whichever month `start` falls in — see the MARKETING_COST_ROWS
// comment above for the full rationale. Same live label-scan approach as
// fetchPnlSheetOtherCosts/fetchPnlSheetTotalCost above (via
// findRevenueAndCostRows's costRows map — never a hardcoded row number).
// Tolerant of individual missing rows: sums whatever it finds and reports
// how many of the 15 expected rows it actually located, rather than failing
// the whole total over one missing/renamed label. Returns
// { no_data: false, actual, source: 'pnl_sheet', rows_found, rows_expected }
// or { no_data: true } (nothing found at all, month column not found, sheet
// not shared) or null (the sheet fetch itself failed before any
// label-scanning could happen) — same failure shape as this file's other
// fetchers, logged, never thrown.
//
// Reused as-is for the MoM comparison period too (server.js calls this a
// second time with the previous month's start date) — findActualColIdx
// looks up whichever month label `start` falls in, so no separate function
// is needed. NOT reused for YoY: the sheet only has 2026 columns (confirmed
// live 2026-09-07 — no prior-year tab exists anywhere in this spreadsheet),
// so a YoY call would just always return { no_data: true } — server.js
// doesn't bother making that call at all rather than spending an extra CSV
// fetch on a comparison that can never succeed with this data source.
async function fetchPnlSheetMarketingSpend(site, start) {
  if (!start) return null;

  const rows = await fetchSheetRows(site);
  if (!rows) return null;

  const actualColIdx = findActualColIdx(rows, start, site);
  if (actualColIdx === -1) return null;

  const { costRows } = findRevenueAndCostRows(rows);
  if (costRows.size === 0) {
    console.error(`googlesheets: could not locate the "Cost" section in the ${site} CSV (fetchPnlSheetMarketingSpend)`);
    return null;
  }

  let total = 0;
  let foundCount = 0;
  for (const label of MARKETING_COST_ROWS) {
    const rIdx = costRows.get(label);
    if (rIdx === undefined) continue;
    const val = parseNum(rows[rIdx] ? rows[rIdx][actualColIdx] : undefined);
    if (val === null) continue;
    total += val;
    foundCount += 1;
  }
  if (foundCount === 0) {
    console.error(`googlesheets: found none of the expected marketing-cost rows in the ${site} CSV's Cost section — layout may have changed`);
    return { no_data: true };
  }
  return {
    no_data: false,
    actual: total,
    source: 'pnl_sheet',
    rows_found: foundCount,
    rows_expected: MARKETING_COST_ROWS.length,
  };
}

module.exports = {
  fetchPnlSheetChannels,
  fetchPnlSheetOtherCosts,
  fetchPnlSheetTotalCost,
  fetchPnlSheetMarketingSpend,
  CHANNEL_ROWS,
  OTHER_COST_ROWS,
  MARKETING_COST_ROWS,
  parseCsv,
};
