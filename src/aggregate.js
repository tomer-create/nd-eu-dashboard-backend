// Turns a raw list of Shopify orders (from shopify.fetchOrders) into the
// same shapes the dashboard's Sections 1/2/3/5/6 expect.
//
// KNOWN LIMITATION: "returns" here are refunds attached to orders that were
// CREATED in the requested window. A refund issued in this window against an
// order created earlier won't be counted (Shopify's Admin API has no
// top-level "refunds in date range X" query). This is an approximation —
// good enough for MTD trend tracking, not a substitute for accounting.

const DEFAULT_TAG_LABELS = {
  'DISCOUNT-36SLV': 'HY-GLAM Collection Bundle',
  'DISCOUNT-KB24C': "Natasha's Recommended Sets",
  'DISCOUNT-COLLECTIONBUNDLES': 'Collection Bundles',
  'DISCOUNT-FREE_SAMPLE': 'Free Sample',
  'DISCOUNT-FT9ZL': 'Glam Tier Free Gift',
  'DISCOUNT-8B2DX': 'Free Shipping Glam Tier',
  'DISCOUNT-ZWKHZ': 'Discount Shipping For Glow Tier',
  'DISCOUNT-PRO-ARTIST': 'Pro-Artist',
  'DISCOUNT-BA_DISCOUNT': 'BA Discount',
  'DISCOUNT-OA5WN': 'Glow Tier Free Gift',
  Collabs_Affiliate: 'Collabs Affiliate',
  // ND.IL-specific discount codes, added 2026-08-25 per Tomer's request for
  // Section 6 (Discounts Breakdown) on ND.IL. Shopify auto-generates a
  // distinct code suffix per discount even when the merchant reuses the same
  // program name across stores — DISCOUNT-QAQAN and DISCOUNT-VPXK0 are
  // ND.IL's own codes for the SAME two programs COM/EU already track above
  // under different codes (DISCOUNT-FT9ZL / DISCOUNT-36SLV respectively).
  // This is intentional, not a duplicate: aggregate() keys tagMap by the raw
  // tag string, and a given site's orders only ever carry that site's own
  // discount codes, so COM/EU orders will never match these two new keys and
  // ND.IL orders will never match the older ones — each site's Section 6
  // still shows exactly one row per program, just via a different tag.
  'DISCOUNT-QAQAN': 'Glam Tier Free Gift',
  'DISCOUNT-VPXK0': 'HY-GLAM Collection Bundle',
  'DISCOUNT-UHGUH': 'Bundles - סטים',
  // ND.IL-specific "Annual Reward Sale" codes, added 2026-08-26 per Tomer's
  // request for Section 6 on ND.IL.
  'DISCOUNT-I1KYC': 'Annual Reward Sale Bronze',
  'DISCOUNT-Y40T0': 'Annual Reward Sale Glam',
  // ND.IL-specific "Rosh HaShana Sale" code, added 2026-09-07 per Tomer's
  // request for Section 6 on ND.IL.
  'DISCOUNT-MM7ME': 'Rosh HaShana Sale',
  // ND.EU-specific "Bi-Annual Reward Sale" codes, added 2026-08-26 per
  // Tomer's request for Section 6 on ND.EU. Same program names as the
  // ND.COM/ND.US codes just below, but each store mints its own distinct
  // code — same non-collision logic as the ND.IL codes documented above:
  // a given site's orders only ever carry that site's own codes, so this is
  // three extra rows for EU and three different extra rows for COM, never
  // double-counted or cross-matched.
  'DISCOUNT-TQZF5': 'Bi-Annual Reward Sale Bronze',
  'DISCOUNT-UG8ID': 'Bi-Annual Reward Sale Glow',
  'DISCOUNT-DS71A': 'Bi-Annual Reward Sale Glam',
  // ND.COM/ND.US-specific "Bi-Annual Reward Sale" codes, added 2026-08-26 per
  // Tomer's request for Section 6 on ND.COM.
  'DISCOUNT-1TL82': 'Bi-Annual Reward Sale Bronze',
  'DISCOUNT-EJ75N': 'Bi-Annual Reward Sale Glow',
  'DISCOUNT-JBD6Q': 'Bi-Annual Reward Sale Glam',
  // ND.IL-specific "Free shipping" affiliate program, added 2026-09-10 per
  // Tomer's request for Section 6 on ND.IL: "add also all the orders tagged
  // with 'Free shipping' as a new discount line". Unlike every other entry
  // above, this isn't a single fixed discount code — it's a Shopify price
  // rule ("משלוח חינם אפיליאייט" / "Free shipping affiliate", price_rule_id
  // 1360799367346, confirmed live via shopify_discount_codes on the IL
  // store) that mints many individual single-use codes (24D2KT, 2F3SKS,
  // 2W2C2C, ...), so matching by exact code like the rows above isn't
  // workable here. Per Tomer, orders using any of these codes carry the
  // literal order tag "Free shipping" (not the per-order code) — same
  // matching mechanism as every other row here (aggregate() checks
  // order.tags for an exact string match against this map's keys), just
  // keyed on that shared descriptive tag instead of a discount code.
  'Free shipping': 'Free Shipping',
  // ND.COM and ND.EU "Natasha's Birthday" sale codes, added 2026-09-15 per
  // Tomer's request for Section 6 on both stores. Each store mints its own
  // distinct code for the same program — same non-collision logic as every
  // other per-site pair above (Bi-Annual Reward Sale, etc.): a given site's
  // orders only ever carry that site's own discount code, so COM orders
  // will never match XU5AJ and EU orders will never match YAMQU — each
  // site's Section 6 shows exactly one "Natasha's Birthday" row, via its
  // own code.
  'DISCOUNT-YAMQU': "Natasha's Birthday", // ND.COM
  'DISCOUNT-XU5AJ': "Natasha's Birthday", // ND.EU
  // Added 2026-10-26 per Tomer: Fall Sale 2026 (ND.COM DISCOUNT-LZ5AG, ND.EU
  // DISCOUNT-1Y9YV), Free Makeup Bag (ND.COM + ND.EU, same tag) and ND.IL's
  // Election Sale 15% (DISCOUNT-OBWY5).
  'DISCOUNT-LZ5AG': 'Fall Sale 2026', // ND.COM
  'DISCOUNT-1Y9YV': 'Fall Sale 2026', // ND.EU
  'DISCOUNT-FREE_MAKEUP_BAG': 'Free Makeup Bag', // ND.COM + ND.EU
  'DISCOUNT-OBWY5': 'Election Sale 15%', // ND.IL
};

// Discount groups (2026-10-26, Tomer): the Discounts Breakdown is shown as
// groups that open into their programs. Each row carries its group; each
// group also gets its own total over the UNION of its orders (an order with
// two programs of the same group counts once), so group totals never
// double-count. Yotpo's group is built from the Yotpo codes (below).
const DISCOUNT_GROUPS = [
  { key: 'yotpo', label: 'YOTPO' },
  { key: 'sales', label: 'SALES', tags: ['DISCOUNT-LZ5AG', 'DISCOUNT-1Y9YV', 'DISCOUNT-YAMQU', 'DISCOUNT-XU5AJ',
    'DISCOUNT-TQZF5', 'DISCOUNT-UG8ID', 'DISCOUNT-DS71A', 'DISCOUNT-1TL82', 'DISCOUNT-EJ75N', 'DISCOUNT-JBD6Q',
    'DISCOUNT-I1KYC', 'DISCOUNT-Y40T0', 'DISCOUNT-MM7ME', 'DISCOUNT-OBWY5'] },
  { key: 'gifts', label: 'GIFTS & SAMPLES', tags: ['DISCOUNT-FT9ZL', 'DISCOUNT-OA5WN', 'DISCOUNT-QAQAN', 'DISCOUNT-FREE_SAMPLE', 'DISCOUNT-FREE_MAKEUP_BAG'] },
  { key: 'segments', label: 'SEGMENTS', tags: ['DISCOUNT-PRO-ARTIST', 'DISCOUNT-BA_DISCOUNT'] },
];
const TAG_GROUP = {};
DISCOUNT_GROUPS.forEach((g) => (g.tags || []).forEach((t) => { TAG_GROUP[t] = g.key; }));

// Tags that get merged into one combined "Free Shipping" row (OR logic, not
// summed separately) — matches the ShopifyQL pattern used earlier this
// project to avoid double-counting orders carrying both tags.
const FREE_SHIPPING_TAGS = ['DISCOUNT-8B2DX', 'DISCOUNT-ZWKHZ'];

function amt(moneySet) {
  return Number(moneySet?.shopMoney?.amount || 0);
}

// Yotpo codes (2026-10-26). Yotpo Loyalty & Rewards creates single-use
// Shopify codes; checked against Shopify's discount events (created by the
// "Yotpo Loyalty & Rewards" app, and Yotpo sets the code as the title):
//   Loyalty Points — 8 upper-case letters / digits, fixed amount (spent
//                    points: 16.4 = 164 points), e.g. 5NYLEBNR
//   Bday           — BDAY + 8 upper-case letters / digits, e.g. BDAY6GK2QNIW
//   Ref            — REF + 8 upper-case letters / digits, e.g. REF2K6N8OCN
// Not Yotpo, and not matched: Attentive's codes (ND… mixed case, 6-character
// mixed case, BDAYcJPFk5), affiliate codes (REFERMATE, P6X56X), and an
// 8-character PERCENTAGE code like F50TL2NY ("15% welcome discount").
// The amount is what that code actually took off the order (its line-item
// discount allocations), so other discounts on the same order aren't counted.
const YOTPO_KINDS = [
  { key: 'loyalty', tag: 'Yotpo points codes', label: 'Loyalty Points', re: /^[A-Z0-9]{8}$/, fixedOnly: true },
  { key: 'bday', tag: 'Yotpo BDAY codes', label: 'Bday', re: /^BDAY[A-Z0-9]{8}$/ },
  { key: 'ref', tag: 'Yotpo REF codes', label: 'Ref', re: /^REF[A-Z0-9]{8}$/ },
];
function yotpoKindOf(app) {
  const code = String(app.code || '');
  for (const k of YOTPO_KINDS) {
    if (!k.re.test(code)) continue;
    if (k.fixedOnly && !(app.value && app.value.__typename === 'MoneyV2')) continue;
    // Rules sheet (2026-11-04, Tomer's "Discounts split / Yotpo Loyalty
    // rules"): a points redemption is always a multiple of $0.10 (10 points =
    // $1) — an 8-character fixed-amount code of $8.55 isn't points.
    if (k.fixedOnly && app.value.amount != null && Math.abs(Math.round(Number(app.value.amount) * 100)) % 10 !== 0) continue;
    return k;
  }
  return null;
}
// Returns Map(kindKey -> amount) for one order.
function yotpoCodes(order) { return codeKindAmounts(order, yotpoKindOf); }
// Returns Map(kindKey -> amount) of one order's discount codes of the kinds
// kindOf recognises (what those codes took off the line items).
function codeKindAmounts(order, kindOf) {
  const out = new Map();
  const apps = order.discountApplications && order.discountApplications.nodes;
  if (!Array.isArray(apps) || !apps.length) return out;
  const byIndex = new Map(); // allocation totals per discount application index
  let sawAlloc = false;
  for (const e of (order.lineItems && order.lineItems.edges) || []) {
    for (const al of e.node.discountAllocations || []) {
      sawAlloc = true;
      const idx = al.discountApplication && al.discountApplication.index;
      byIndex.set(idx, (byIndex.get(idx) || 0) + amt(al.allocatedAmountSet));
    }
  }
  const tds = order.totalDiscountsSet || {};
  const shopCur = tds.shopMoney && tds.shopMoney.currencyCode;
  const shopDisc = Number(tds.shopMoney && tds.shopMoney.amount || 0);
  const presDisc = Number(tds.presentmentMoney && tds.presentmentMoney.amount || 0);
  apps.forEach((a, pos) => {
    if (!a || a.__typename !== 'DiscountCodeApplication') return;
    const k = kindOf(a);
    if (!k) return;
    const idx = a.index !== undefined ? a.index : pos;
    let x;
    if (sawAlloc && a.index !== undefined) {
      x = byIndex.get(idx) || 0;
    } else if (a.value && a.value.__typename === 'MoneyV2') {
      // Older payload shape (no allocations): the code's own amount.
      x = Number(a.value.amount || 0);
      if (shopCur && a.value.currencyCode && a.value.currencyCode !== shopCur && a.value.currencyCode === order.presentmentCurrencyCode && presDisc > 0) x *= shopDisc / presDisc;
    } else {
      x = 0;
    }
    out.set(k.key, (out.get(k.key) || 0) + Math.max(0, Math.min(x, shopDisc)));
  });
  return out;
}

// ---- Program discounts by discount application (2026-10-28) --------------
// Tomer: "Pro-Artist actually gets 40.4% discount but it should be 30%". A
// program row used to take the WHOLE discount of every order carrying its
// tag — so a Pro-Artist order that also had a Free Sample (100% off a
// sample), the Free Makeup Bag, a Yotpo points code or an Attentive code had
// all of those counted as Pro-Artist. Order tags also don't prove the
// discount applied (an order tagged DISCOUNT-FREE_SAMPLE sometimes has only a
// code). Now each program counts only the Shopify discount applications that
// belong to it, read from the line items' (and shipping lines') discount
// allocations:
//   - a discount (automatic / manual title) BELONGS to a tag when nearly all
//     the orders that used it carry that tag (≥ 90% of ≥ 3 orders in the
//     period), or when it matches a known title (KNOWN_PROGRAM_TITLES);
//     discount codes are never assigned this way (an affiliate code used on
//     3 orders that all happened to get a free sample isn't Free Sample);
//     generic titles like "-15%" are shared by several programs (Fall Sale
//     tiers, Recommended Sets) and never belong to one tag;
//   - a tag that owns discounts counts only those;
//   - a tag that owns none (e.g. Fall Sale, whose discounts are titled
//     "-15%" / "-20%" / "-25%") counts the order's discounts that no other
//     program owns, leaving out discount codes (Attentive, affiliate, Yotpo —
//     their own programs) and shipping discounts; free-shipping tags count only
//     discounts on the shipping lines.
// Discount % = the program's discount ÷ the gross sales of the items it
// discounted (Pro-Artist → 30%). Gross Sales and Orders stay the orders that
// carry the tag.
const KNOWN_PROGRAM_TITLES = [
  { tag: 'DISCOUNT-PRO-ARTIST', re: /^pro(\b|\s|$)|pro[\s-]*artist/i },
  { tag: 'DISCOUNT-FREE_SAMPLE', re: /free\s*sample/i },
  { tag: 'DISCOUNT-FREE_MAKEUP_BAG', re: /makeup\s*bag/i },
];
const SHIPPING_PROGRAM_TAGS = new Set(['DISCOUNT-8B2DX', 'DISCOUNT-ZWKHZ', 'Free shipping']);
const GENERIC_TITLE_RE = /^\s*-?\s*\d+(\.\d+)?\s*%\s*(off)?\s*$/i;
// A manual discount titled like a code (GLAMJUNKIESCOM, DIDJABEAUTY — an
// affiliate code re-applied on an edited / draft order) counts as that code.
const CODE_LIKE_RE = /^[A-Z0-9][A-Z0-9_-]{3,}$/;
const isCodeApp = (a) => a.__typename === 'DiscountCodeApplication' || (a.__typename !== 'AutomaticDiscountApplication' && CODE_LIKE_RE.test(String(a.title || '').trim()));
function appKey(a) {
  if (!a) return null;
  if (a.__typename === 'DiscountCodeApplication') return a.code ? 'code:' + String(a.code).toUpperCase() : null;
  if (isCodeApp(a)) return 'code:' + String(a.title).trim().toUpperCase();
  return a.title ? 'title:' + String(a.title).trim().toLowerCase() : null;
}
// Per order: the discount applications with what each took off and which
// line items it touched. null when the payload has no titles / allocations
// (orders stored before 2026-10-28) — the caller then keeps the old method.
function orderApps(order) {
  const nodes = order.discountApplications && order.discountApplications.nodes;
  if (!Array.isArray(nodes)) return null;
  const hasTitles = nodes.some((a) => a && ('title' in a || 'targetType' in a));
  if (nodes.length && !hasTitles) return null;
  const apps = new Map(); // index -> app
  nodes.forEach((a, pos) => {
    if (!a) return;
    const idx = a.index !== undefined ? a.index : pos;
    apps.set(idx, { idx, key: appKey(a), code: isCodeApp(a), yotpo: !!yotpoKindOf(a), amount: 0, lines: new Set(), shipping: a.targetType === 'SHIPPING_LINE' });
  });
  const lineGross = [];
  ((order.lineItems && order.lineItems.edges) || []).forEach((e, li) => {
    lineGross[li] = amt(e.node.originalTotalSet);
    (e.node.discountAllocations || []).forEach((al) => {
      const ap = apps.get(al.discountApplication && al.discountApplication.index);
      const v = amt(al.allocatedAmountSet);
      if (ap && v) { ap.amount += v; ap.lines.add(li); }
    });
  });
  const ship = (order.shippingLines && order.shippingLines.nodes) || [];
  ship.forEach((sl) => (sl.discountAllocations || []).forEach((al) => {
    const ap = apps.get(al.discountApplication && al.discountApplication.index);
    if (ap) ap.amount += amt(al.allocatedAmountSet);
  }));
  return { apps: [...apps.values()].filter((a) => a.key && a.amount > 0.0001), lineGross };
}
// Which tag owns each discount key, learned from this order list.
function learnOwners(orders, tags, appsOf) {
  const nK = new Map(), co = new Map(); // key -> n ; key -> Map(tag -> n)
  for (const o of orders) {
    const oa = appsOf.get(o);
    if (!oa) continue;
    const ot = (o.tags || []).filter((t) => tags.has(t));
    new Set(oa.apps.map((a) => a.key)).forEach((k) => {
      nK.set(k, (nK.get(k) || 0) + 1);
      const m = co.get(k) || new Map();
      ot.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
      co.set(k, m);
    });
  }
  const owner = new Map();
  nK.forEach((n, k) => {
    if (k.startsWith('title:') && GENERIC_TITLE_RE.test(k.slice(6))) return;
    const known = KNOWN_PROGRAM_TITLES.find((p) => k.startsWith('title:') && p.re.test(k.slice(6)) && tags.has(p.tag));
    if (known) { owner.set(k, known.tag); return; }
    // Codes are never learned: popular codes (affiliates, Attentive) can sit
    // on orders that all happen to carry a common tag such as FREE_SAMPLE.
    if (n < 3 || k.startsWith('code:')) return;
    let best = null, bestP = 0;
    (co.get(k) || new Map()).forEach((c, t) => { const pr = c / n; if (pr > bestP) { bestP = pr; best = t; } });
    if (best && bestP >= 0.9) owner.set(k, best);
  });
  return owner;
}

// ---- Discounts split (2026-11-04, Tomer's file "Discounts split / Yotpo
// Loyalty rules") ----------------------------------------------------------
// EVERY product discount of the period (Shopify's Discounts — shipping-line
// discounts aren't in it), each discount application in exactly one item, in
// five buckets. Classified per discount application by its title / code, with
// the program tags learned above (owners) for automatic discounts whose title
// is reused (e.g. "Free gift" is the Glow tier gift in some months, a GWP in
// others):
//   SAMPLES             Free Sample (site orders)
//   GIFTS: GWP          Free gift, Free makeup bag
//   GIFTS: TIKTOK       TikTok creator samples ("Free sample" on TikTok orders)
//   YOTPO LOYALTY       Points redemptions, Glow tier gift, Glam tier gift,
//                       Birthday (BDAY), Referral (REF)
//   REGULAR             TikTok seller discounts, Sales (−15% … −40%),
//                       Attentive, Influencer & campaign codes, Pro Artist,
//                       Free shipping, Other manual discounts, Other order offers
const SPLIT_BUCKETS = [
  { key: 'samples', label: 'Samples', items: [['free_sample', 'Free Sample']] },
  { key: 'gwp', label: 'Gifts: GWP to customers', items: [['free_gift', 'Free gift'], ['makeup_bag', 'Free makeup bag']] },
  { key: 'tiktok_creators', label: 'Gifts: TikTok creators', items: [['tiktok_samples', 'TikTok creator samples']] },
  { key: 'yotpo', label: 'Yotpo Loyalty', items: [['points', 'Points redemptions'], ['glow_gift', 'Glow tier gift'], ['glam_gift', 'Glam tier gift'], ['bday', 'Birthday (BDAY)'], ['ref', 'Refer a friend (REF)']] },
  { key: 'regular', label: 'Regular', items: [['tiktok_seller', 'TikTok seller discounts'], ['sales', 'Sales (−15% … −40%)'], ['attentive', 'Attentive'], ['codes', 'Influencer & campaign codes'], ['pro_artist', 'Pro Artist'], ['free_shipping', 'Free shipping'], ['manual', 'Other manual discounts'], ['offers', 'Other order offers']] },
];
const SPLIT_TAG_ITEM = {
  'DISCOUNT-FREE_SAMPLE': 'free_sample',
  'DISCOUNT-FREE_MAKEUP_BAG': 'makeup_bag',
  'DISCOUNT-OA5WN': 'glow_gift',
  'DISCOUNT-FT9ZL': 'glam_gift', 'DISCOUNT-QAQAN': 'glam_gift',
  'DISCOUNT-PRO-ARTIST': 'pro_artist',
  'DISCOUNT-8B2DX': 'free_shipping', 'DISCOUNT-ZWKHZ': 'free_shipping', 'Free shipping': 'free_shipping',
};
// Attentive's single-use codes: 6 random letters/digits ("mETyTq", Shopify
// title "attentive") or ND + 6 ("NDYns1cg", "ATTENTIVE15OFF"), always with a
// lowercase letter (uppercase-only codes are Yotpo / affiliate codes).
const isAttentiveCode = (code) => /^(ND)?[A-Za-z0-9]{6}$/.test(code) && /[a-z]/.test(code);
function splitItemOf(a, isTikTok, owners) {
  const title = String(a.title || '').trim();
  if (isTikTok) return /free\s*sample/i.test(title) ? 'tiktok_samples' : 'tiktok_seller';
  if (a.__typename === 'DiscountCodeApplication') {
    // Birthday codes in any case (EU has mixed-case ones like BDAYcJPFk5 —
    // Tomer's file counts them as Birthday, 2026-11-04).
    if (/^BDAY[A-Za-z0-9]{4,}$/i.test(String(a.code || ''))) return 'bday';
    const k = yotpoKindOf(a);
    if (k) return k.key === 'loyalty' ? 'points' : k.key;
    if (isAttentiveCode(String(a.code || ''))) return 'attentive';
    return 'codes';
  }
  const owner = owners.get(appKey(a));
  if (owner && SPLIT_TAG_ITEM[owner]) return SPLIT_TAG_ITEM[owner];
  if (owner && TAG_GROUP[owner] === 'sales') return 'sales';
  if (/free\s*sample/i.test(title)) return 'free_sample';
  if (/makeup\s*bag/i.test(title)) return 'makeup_bag';
  if (/glow/i.test(title) && /gift/i.test(title)) return 'glow_gift';
  if (/glam/i.test(title) && /gift/i.test(title)) return 'glam_gift';
  if (/free\s*gift|gift\s*with\s*purchase|gwp/i.test(title)) return 'free_gift';
  if (KNOWN_PROGRAM_TITLES[0].re.test(title)) return 'pro_artist';
  if (/free\s*ship/i.test(title)) return 'free_shipping';
  if (GENERIC_TITLE_RE.test(title) || /sale|bundle|\bsets?\b/i.test(title)) return 'sales';
  if (isCodeApp(a)) return 'codes'; // a manual discount titled like a code
  if (a.__typename === 'ManualDiscountApplication') return 'manual';
  return 'offers';
}
function discountSplit(orders, owners, grossSales) {
  // discGross (2026-11-04, Tomer: "add another column with discount ratio"):
  // the gross of the line items each item / bucket / the total discounted —
  // Discount Ratio = discount ÷ that (Pro Artist → 30%, samples → 100%).
  const itemAcc = new Map(); // item -> { value, orders, discGross }
  const bucketAcc = new Map(SPLIT_BUCKETS.map((b) => [b.key, { value: 0, orders: 0, discGross: 0 }]));
  const bucketOf = new Map();
  SPLIT_BUCKETS.forEach((b) => b.items.forEach(([k]) => { bucketOf.set(k, b.key); itemAcc.set(k, { value: 0, orders: 0, discGross: 0 }); }));
  let total = 0, totalOrders = 0, totalDiscGross = 0;
  for (const order of orders) {
    const nodes = (order.discountApplications && order.discountApplications.nodes) || [];
    const byIdx = new Map();
    nodes.forEach((a, pos) => { if (a) byIdx.set(a.index !== undefined ? a.index : pos, a); });
    const isTikTok = order.sourceName === 'tiktok';
    const perItem = new Map(); // item -> { v, lines:Set }
    const lineGross = [];
    order.lineItems.edges.forEach((e, li) => {
      lineGross[li] = amt(e.node.originalTotalSet);
      for (const al of e.node.discountAllocations || []) {
        const v = amt(al.allocatedAmountSet);
        if (!v) continue;
        const a = byIdx.get(al.discountApplication && al.discountApplication.index);
        const item = a ? splitItemOf(a, isTikTok, owners) : (isTikTok ? 'tiktok_seller' : 'offers');
        const p = perItem.get(item) || { v: 0, lines: new Set() };
        p.v += v; p.lines.add(li);
        perItem.set(item, p);
      }
    });
    if (!perItem.size) continue;
    totalOrders += 1;
    const bucketLines = new Map(), allLines = new Set();
    const sumLines = (set) => { let g = 0; set.forEach((li) => { g += lineGross[li] || 0; }); return g; };
    perItem.forEach((p, item) => {
      const ia = itemAcc.get(item); ia.value += p.v; ia.orders += 1; ia.discGross += sumLines(p.lines);
      const b = bucketOf.get(item); bucketAcc.get(b).value += p.v;
      const bl = bucketLines.get(b) || new Set(); p.lines.forEach((li) => { bl.add(li); allLines.add(li); }); bucketLines.set(b, bl);
      total += p.v;
    });
    bucketLines.forEach((set, b) => { const ba = bucketAcc.get(b); ba.orders += 1; ba.discGross += sumLines(set); });
    totalDiscGross += sumLines(allLines);
  }
  return {
    total: { discount_value: total, orders: totalOrders, gross_sales: grossSales, discounted_gross: totalDiscGross },
    buckets: SPLIT_BUCKETS.map((b) => ({
      key: b.key, label: b.label,
      discount_value: bucketAcc.get(b.key).value, orders: bucketAcc.get(b.key).orders, discounted_gross: bucketAcc.get(b.key).discGross,
      items: b.items.map(([k, label]) => ({ key: k, label, discount_value: itemAcc.get(k).value, orders: itemAcc.get(k).orders, discounted_gross: itemAcc.get(k).discGross })),
    })),
  };
}

function aggregate(orders, { tagLabels = DEFAULT_TAG_LABELS } = {}) {
  let grossSales = 0;
  let discountsTotal = 0;
  let unitsSold = 0;
  let unitsReturned = 0;
  let returnsTotal = 0;

  const productMap = new Map(); // title -> { units, revenue }
  const countryMap = new Map(); // countryCode -> { grossSales, orders }
  const tagMap = new Map(); // tag -> { grossSales, discountValue, orders }
  const yotpoAcc = new Map(YOTPO_KINDS.map((k) => [k.key, { value: 0, grossSales: 0, orders: 0 }]));
  const groupAcc = new Map(DISCOUNT_GROUPS.map((g) => [g.key, { value: 0, grossSales: 0, orders: 0, discGross: 0 }]));
  // Total row of the Discounts Breakdown (2026-11-02, Tomer: "add for the
  // total line the real numbers of the total"): every order with a program
  // shown in the table (a Yotpo code or a grouped program tag), counted once,
  // and only those programs' own discounts — not the store-wide figure, which
  // also holds TikTok Shop orders, free shipping and codes not in the table.
  const tableAcc = { value: 0, grossSales: 0, orders: 0, discGross: 0 };
  // TikTok Shop orders synced into Shopify (sourceName 'tiktok'): their
  // product discounts (TikTok vouchers, samples, seller discounts) are part of
  // Shopify's store-wide Discounts but not a website program.
  const tiktokAcc = { value: 0, grossSales: 0, orders: 0 };
  let sawSourceName = false;
  let sawDiscountApps = false;
  // Program discounts by discount application (see the note above).
  const programTags = new Set([...Object.keys(tagLabels), ...FREE_SHIPPING_TAGS]);
  let byApp = orders.length > 0;
  const appsOf = new Map();
  for (const o of orders) { const oa = orderApps(o); appsOf.set(o, oa); if (!oa) byApp = false; }
  const owners = byApp ? learnOwners(orders, programTags, appsOf) : new Map();
  const ownedBy = new Map(); // tag -> Set(keys)
  owners.forEach((t, k) => { if (!ownedBy.has(t)) ownedBy.set(t, new Set()); ownedBy.get(t).add(k); });
  // One program's share of one order: { value, discGross, appIdx:Set }.
  const programPart = (o, tag) => {
    const oa = appsOf.get(o);
    const mine = ownedBy.get(tag);
    const picked = oa.apps.filter((a) => (mine && mine.size) ? mine.has(a.key)
      // Free-shipping tags: only discounts on the shipping lines.
      : SHIPPING_PROGRAM_TAGS.has(tag) ? (a.shipping && !owners.has(a.key) && !a.yotpo)
      : (!owners.has(a.key) && !a.code && !a.yotpo && !a.shipping));
    const lines = new Set();
    picked.forEach((a) => a.lines.forEach((l) => lines.add(l)));
    let discGross = 0;
    lines.forEach((l) => { discGross += oa.lineGross[l] || 0; });
    return { value: picked.reduce((x, a) => x + a.amount, 0), discGross, apps: new Set(picked.map((a) => a.idx)), lines };
  };

  for (const order of orders) {
    const orderGross = order.lineItems.edges.reduce(
      (sum, e) => sum + amt(e.node.originalTotalSet),
      0
    );
    const orderDiscount = amt(order.totalDiscountsSet);
    grossSales += orderGross;
    discountsTotal += orderDiscount;

    for (const e of order.lineItems.edges) {
      unitsSold += e.node.quantity;
      const p = productMap.get(e.node.title) || { units: 0, revenue: 0 };
      p.units += e.node.quantity;
      p.revenue += amt(e.node.originalTotalSet);
      productMap.set(e.node.title, p);
    }

    for (const refund of order.refunds || []) {
      for (const e of refund.refundLineItems.edges) {
        unitsReturned += e.node.quantity;
        returnsTotal += amt(e.node.subtotalSet);
      }
    }

    const country = order.shippingAddress?.countryCode || 'Unknown';
    const c = countryMap.get(country) || { grossSales: 0, orders: 0 };
    c.grossSales += orderGross;
    c.orders += 1;
    countryMap.set(country, c);

    if (order.discountApplications) sawDiscountApps = true;
    const yc = yotpoCodes(order);
    let yTotal = 0;
    yc.forEach((v, key) => {
      const acc = yotpoAcc.get(key);
      acc.value += v; acc.grossSales += orderGross; acc.orders += 1;
      yTotal += v;
    });
    if (yc.size) {
      const g = groupAcc.get('yotpo');
      g.value += yTotal; g.grossSales += orderGross; g.orders += 1;
    }
    if (order.sourceName !== undefined) sawSourceName = true;
    if (order.sourceName === 'tiktok') {
      let ld = 0;
      for (const e of order.lineItems.edges) for (const al of e.node.discountAllocations || []) ld += amt(al.allocatedAmountSet);
      tiktokAcc.orders += 1; tiktokAcc.grossSales += orderGross; tiktokAcc.value += ld;
    }
    {
      const orderTags = order.tags || [];
      const inGroups = new Set(orderTags.map((t) => TAG_GROUP[t]).filter(Boolean));
      inGroups.forEach((key) => {
        const g = groupAcc.get(key);
        g.grossSales += orderGross; g.orders += 1;
        if (byApp) {
          // Each discount counted once even when two programs of the group share it.
          const apps = new Set(), lines = new Set();
          orderTags.filter((t) => TAG_GROUP[t] === key).forEach((t) => { const p = programPart(order, t); p.apps.forEach((i) => apps.add(i)); p.lines.forEach((l) => lines.add(l)); });
          appsOf.get(order).apps.forEach((a) => { if (apps.has(a.idx)) g.value += a.amount; });
          let dg = 0; lines.forEach((l) => { dg += appsOf.get(order).lineGross[l] || 0; });
          g.discGross += dg || 0;
        } else {
          g.value += orderDiscount;
        }
      });
      if (yc.size || inGroups.size) {
        tableAcc.orders += 1; tableAcc.grossSales += orderGross;
        if (byApp) {
          // Group programs never take Yotpo / code discounts (programPart), so
          // the Yotpo codes' own amount is added on top without overlap.
          const apps = new Set(), lines = new Set();
          orderTags.filter((t) => TAG_GROUP[t]).forEach((t) => { const p = programPart(order, t); p.apps.forEach((i) => apps.add(i)); p.lines.forEach((l) => lines.add(l)); });
          appsOf.get(order).apps.forEach((a) => { if (apps.has(a.idx)) tableAcc.value += a.amount; });
          tableAcc.value += yTotal;
          // Discount % base: the discounted items, or the whole order when a
          // Yotpo code (spread over the order) was used.
          let dg = 0;
          if (yc.size) dg = orderGross;
          else lines.forEach((l) => { dg += appsOf.get(order).lineGross[l] || 0; });
          tableAcc.discGross += dg;
        } else {
          tableAcc.value += orderDiscount; tableAcc.discGross += orderGross;
        }
      }
    }

    const tags = order.tags || [];
    for (const tag of Object.keys(tagLabels)) {
      if (tags.includes(tag)) {
        const t = tagMap.get(tag) || { grossSales: 0, discountValue: 0, orders: 0, discGross: 0 };
        t.grossSales += orderGross;
        if (byApp) { const p = programPart(order, tag); t.discountValue += p.value; t.discGross += p.value ? (p.discGross || orderGross) : 0; }
        else t.discountValue += orderDiscount;
        t.orders += 1;
        tagMap.set(tag, t);
      }
    }
    // Combined free-shipping row: OR logic across FREE_SHIPPING_TAGS.
    if (FREE_SHIPPING_TAGS.some((t) => tags.includes(t))) {
      const t = tagMap.get('__FREE_SHIPPING_COMBINED__') || {
        grossSales: 0,
        discountValue: 0,
        orders: 0,
        discGross: 0,
      };
      t.grossSales += orderGross;
      if (byApp) {
        const apps = new Set();
        FREE_SHIPPING_TAGS.filter((x) => tags.includes(x)).forEach((x) => programPart(order, x).apps.forEach((i) => apps.add(i)));
        const v = appsOf.get(order).apps.filter((a) => apps.has(a.idx)).reduce((x, a) => x + a.amount, 0);
        t.discountValue += v; t.discGross += v ? orderGross : 0;
      } else t.discountValue += orderDiscount;
      t.orders += 1;
      tagMap.set('__FREE_SHIPPING_COMBINED__', t);
    }
  }

  const netSales = grossSales - discountsTotal;
  const ordersCount = orders.length;
  const aov = ordersCount ? netSales / ordersCount : 0;

  const topProducts = [...productMap.entries()]
    .map(([title, v]) => ({ title, units_sold: v.units, gross_sales: v.revenue }))
    .sort((a, b) => b.gross_sales - a.gross_sales);

  const byCountry = [...countryMap.entries()]
    .map(([country, v]) => ({ country, gross_sales: v.grossSales, orders: v.orders }))
    .sort((a, b) => b.gross_sales - a.gross_sales);

  const discountsTotalGross = grossSales; // store-wide gross, for the Total row's % denominator
  const discounts = [...tagMap.entries()]
    .filter(([tag]) => tag !== '__FREE_SHIPPING_COMBINED__')
    .map(([tag, v]) => ({
      tag,
      label: tagLabels[tag] || tag,
      group: TAG_GROUP[tag] || null,
      gross_sales: v.grossSales,
      discount_value: v.discountValue,
      discount_pct: byApp ? (v.discGross ? v.discountValue / v.discGross : (v.discountValue ? null : 0)) : (v.grossSales ? v.discountValue / v.grossSales : null),
      discounted_gross: byApp ? v.discGross : undefined,
      orders: v.orders,
      pct_of_total_discounts: discountsTotal ? v.discountValue / discountsTotal : null,
      pct_of_gross: grossSales ? v.discountValue / grossSales : null,
      owned_discounts: byApp ? [...(ownedBy.get(tag) || [])].map((k) => k.replace(/^(title|code):/, '')).slice(0, 6) : undefined,
    }));

  const combined = tagMap.get('__FREE_SHIPPING_COMBINED__');
  if (combined) {
    discounts.push({
      tag: 'Free Shipping (combined)',
      label: 'Free Shipping (Glam + Glow Tier, combined)',
      gross_sales: combined.grossSales,
      discount_value: combined.discountValue,
      discount_pct: combined.grossSales ? combined.discountValue / combined.grossSales : null,
      orders: combined.orders,
      pct_of_total_discounts: discountsTotal ? combined.discountValue / discountsTotal : null,
      pct_of_gross: grossSales ? combined.discountValue / grossSales : null,
    });
  }

  // Yotpo rows (Loyalty Points / Bday / Ref): discount_value = what those
  // codes took off (not the orders' other discounts); discount_pct = that ÷
  // the gross sales of the orders they were used on. Only when this order
  // list carries discountApplications (the full current-period query), so
  // comparison periods fetched with lighter queries never show a false $0.
  let discountGroups;
  if (sawDiscountApps) {
    YOTPO_KINDS.forEach((k) => {
      const y = yotpoAcc.get(k.key);
      if (!y.orders && k.key !== 'loyalty') return;
      discounts.push({
        tag: k.tag,
        label: k.label,
        group: 'yotpo',
        gross_sales: y.grossSales,
        discount_value: y.value,
        discount_pct: y.grossSales ? y.value / y.grossSales : null,
        orders: y.orders,
        ...(k.key === 'loyalty' ? { points: Math.round(y.value * 10) } : {}),
        pct_of_total_discounts: discountsTotal ? y.value / discountsTotal : null,
        pct_of_gross: grossSales ? y.value / grossSales : null,
      });
    });
    discountGroups = DISCOUNT_GROUPS.map((g) => {
      const v = groupAcc.get(g.key);
      return {
        key: g.key,
        label: g.label,
        gross_sales: v.grossSales,
        discount_value: v.value,
        // Yotpo: codes spread over the whole order → ÷ the orders' gross. Other
        // groups (by discount application): ÷ the items their programs discounted.
        discount_pct: (byApp && g.key !== 'yotpo') ? (v.discGross ? v.value / v.discGross : (v.value ? null : 0)) : (v.grossSales ? v.value / v.grossSales : null),
        discounted_gross: (byApp && g.key !== 'yotpo') ? v.discGross : undefined,
        orders: v.orders,
        pct_of_total_discounts: discountsTotal ? v.value / discountsTotal : null,
        pct_of_gross: grossSales ? v.value / grossSales : null,
      };
    });
  }

  return {
    kpis: {
      gross_sales: grossSales,
      net_sales: netSales,
      discounts_total: discountsTotal,
      orders: ordersCount,
      average_order_value: aov,
      units_sold: unitsSold,
      units_returned: unitsReturned,
      returns_total: returnsTotal,
    },
    top_products: topProducts,
    by_country: byCountry,
    discounts,
    discounts_total_gross: discountsTotalGross,
    discounts_total_abs: discountsTotal,
    discounts_total_orders: ordersCount,
    discount_groups: discountGroups,
    discounts_tiktok: sawSourceName ? { gross_sales: tiktokAcc.grossSales, discount_value: tiktokAcc.value, orders: tiktokAcc.orders } : undefined,
    // Renamed from discounts_table_total (2026-11-02, Attentive taken out of
    // the table again — Tomer) so payloads that still counted Attentive in
    // their total are never shown; the page adds up the groups (≈) for them
    // until they're re-pulled.
    // The five-bucket split of every discount (2026-11-04). Needs discount
    // titles / allocations (byApp) and each order's channel (sourceName).
    discount_split: byApp && sawSourceName ? discountSplit(orders, owners, grossSales) : undefined,
    discounts_programs_total: sawDiscountApps ? {
      gross_sales: tableAcc.grossSales,
      discount_value: tableAcc.value,
      discounted_gross: tableAcc.discGross,
      orders: tableAcc.orders,
    } : undefined,
    // 3: Yotpo Loyalty Points / Bday / Ref rows + discount_groups
    // (2026-10-26). The month cache re-pulls a stored closed month below 3.
    // 4 (2026-10-28): program discounts by discount application (byApp).
    // A period with no orders has nothing to re-pull (it used to stay at 1 and
    // be re-pulled on every view — 2026-10-29 review).
    // 5 (2026-11-02): discounts_table_total (the table's own Total row).
    // 6 (2026-11-02): ATTENTIVE group + discounts_tiktok (needs sourceName).
    // 7 (2026-11-02): ATTENTIVE removed again; discounts_programs_total.
    // 8 (2026-11-04): discount_split (five buckets, every discount) and the
    //                 $0.10 rule for Yotpo points codes.
    // 9 (2026-11-04): Discount Ratio (discounted_gross) in the split; BDAY
    //                 codes in any case count as Birthday.
    discounts_version: orders.length === 0 ? 9 : (sawDiscountApps ? (byApp && sawSourceName ? 9 : byApp ? 5 : 3) : 1),
    discounts_by_app: byApp,
  };
}

module.exports = { aggregate, DEFAULT_TAG_LABELS, FREE_SHIPPING_TAGS, DISCOUNT_GROUPS, YOTPO_KINDS };
