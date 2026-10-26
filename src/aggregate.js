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
    return k;
  }
  return null;
}
// Returns Map(kindKey -> amount) for one order.
function yotpoCodes(order) {
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
    const k = yotpoKindOf(a);
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
  const groupAcc = new Map(DISCOUNT_GROUPS.map((g) => [g.key, { value: 0, grossSales: 0, orders: 0 }]));
  let sawDiscountApps = false;

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
    {
      const orderTags = order.tags || [];
      const inGroups = new Set(orderTags.map((t) => TAG_GROUP[t]).filter(Boolean));
      inGroups.forEach((key) => {
        const g = groupAcc.get(key);
        g.value += orderDiscount; g.grossSales += orderGross; g.orders += 1;
      });
    }

    const tags = order.tags || [];
    for (const tag of Object.keys(tagLabels)) {
      if (tags.includes(tag)) {
        const t = tagMap.get(tag) || { grossSales: 0, discountValue: 0, orders: 0 };
        t.grossSales += orderGross;
        t.discountValue += orderDiscount;
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
      };
      t.grossSales += orderGross;
      t.discountValue += orderDiscount;
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
      discount_pct: v.grossSales ? v.discountValue / v.grossSales : null,
      orders: v.orders,
      pct_of_total_discounts: discountsTotal ? v.discountValue / discountsTotal : null,
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
      });
    });
    discountGroups = DISCOUNT_GROUPS.map((g) => {
      const v = groupAcc.get(g.key);
      return {
        key: g.key,
        label: g.label,
        gross_sales: v.grossSales,
        discount_value: v.value,
        discount_pct: v.grossSales ? v.value / v.grossSales : null,
        orders: v.orders,
        pct_of_total_discounts: discountsTotal ? v.value / discountsTotal : null,
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
    // 3: Yotpo Loyalty Points / Bday / Ref rows + discount_groups
    // (2026-10-26). The month cache re-pulls a stored closed month below 3.
    discounts_version: sawDiscountApps ? 3 : 1,
  };
}

module.exports = { aggregate, DEFAULT_TAG_LABELS, FREE_SHIPPING_TAGS, DISCOUNT_GROUPS, YOTPO_KINDS };
