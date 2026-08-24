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
};

// Tags that get merged into one combined "Free Shipping" row (OR logic, not
// summed separately) — matches the ShopifyQL pattern used earlier this
// project to avoid double-counting orders carrying both tags.
const FREE_SHIPPING_TAGS = ['DISCOUNT-8B2DX', 'DISCOUNT-ZWKHZ'];

function amt(moneySet) {
  return Number(moneySet?.shopMoney?.amount || 0);
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

  // Net Sales = Gross Sales − Discounts − Returns. Matches Shopify's own
  // "Net sales" definition and the P&L sheet's own "Discounts & Returns"
  // combined-deduction formula (Row 9 "Total D&R %"). Previously this only
  // subtracted discounts, which overstated live-synced Net Sales by
  // whatever the period's returns came to (confirmed 2026-08-24: Tomer
  // spotted a live sync showing $395.4K vs. $372,010.60 in Shopify's own
  // report — a ~$23.4K gap that matches a normal return rate for this
  // store almost exactly).
  const netSales = grossSales - discountsTotal - returnsTotal;
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
  };
}

module.exports = { aggregate, DEFAULT_TAG_LABELS, FREE_SHIPPING_TAGS };
