const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());
app.use(express.json());

// ─── SHOPIFY ────────────────────────────────────────────────────────────────
async function fetchShopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;
  if (!store || !token) return { error: "Shopify env eksik" };

  const [ordersRes, productsRes] = await Promise.all([
    fetch(`https://${store}/admin/api/2024-01/orders.json?status=any&limit=250&financial_status=paid`, {
      headers: { "X-Shopify-Access-Token": token }
    }),
    fetch(`https://${store}/admin/api/2024-01/products.json?limit=50`, {
      headers: { "X-Shopify-Access-Token": token }
    })
  ]);

  const ordersData = await ordersRes.json();
  const productsData = await productsRes.json();
  const orders = ordersData.orders || [];
  const today = new Date().toISOString().split("T")[0];
  const thisMonth = new Date().toISOString().slice(0, 7);

  const todayOrders = orders.filter(o => o.created_at.startsWith(today));
  const monthOrders = orders.filter(o => o.created_at.startsWith(thisMonth));
  const todayRevenue = todayOrders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const monthRevenue = monthOrders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const avgOrderValue = orders.length > 0
    ? orders.reduce((s, o) => s + parseFloat(o.total_price), 0) / orders.length : 0;

  return {
    today_orders: todayOrders.length,
    today_revenue: todayRevenue.toFixed(2),
    month_orders: monthOrders.length,
    month_revenue: monthRevenue.toFixed(2),
    avg_order_value: avgOrderValue.toFixed(2),
    total_products: (productsData.products || []).length,
    top_products: (productsData.products || []).slice(0, 5).map(p => ({
      id: p.id, title: p.title, price: p.variants?.[0]?.price || "0"
    }))
  };
}

// ─── META ────────────────────────────────────────────────────────────────────
async function fetchMeta() {
  const token = process.env.META_TOKEN;
  const account_id = process.env.META_ACCOUNT;
  if (!token || !account_id) return { error: "Meta env eksik" };

  const fields = "name,status,daily_budget,insights{spend,impressions,clicks,actions,action_values,cpc,ctr}";
  const metaRes = await fetch(
    `https://graph.facebook.com/v19.0/${account_id}/campaigns?fields=${fields}&date_preset=last_30d&access_token=${token}`
  );
  const metaData = await metaRes.json();
  if (metaData.error) return { error: metaData.error.message };

  const campaigns = (metaData.data || []).map(c => {
    const ins = c.insights?.data?.[0] || {};
    const spend = parseFloat(ins.spend || 0);
    const purchaseAction = (ins.action_values || []).find(a => a.action_type === "purchase");
    const revenue = parseFloat(purchaseAction?.value || 0);
    return {
      id: c.id, name: c.name, status: c.status,
      spend: spend.toFixed(2), impressions: ins.impressions || 0,
      clicks: ins.clicks || 0, cpc: ins.cpc || "0", ctr: ins.ctr || "0",
      revenue: revenue.toFixed(2),
      roas: spend > 0 ? (revenue / spend).toFixed(2) : "0"
    };
  });

  const totalSpend = campaigns.reduce((s, c) => s + parseFloat(c.spend), 0);
  const totalRevenue = campaigns.reduce((s, c) => s + parseFloat(c.revenue), 0);
  return {
    campaigns,
    summary: {
      total_spend: totalSpend.toFixed(2),
      total_revenue: totalRevenue.toFixed(2),
      overall_roas: totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : "0",
      active_campaigns: campaigns.filter(c => c.status === "ACTIVE").length
    }
  };
}

// ─── GOOGLE ADS ──────────────────────────────────────────────────────────────
async function fetchGoogle() {
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const customer_id = process.env.GOOGLE_CUSTOMER_ID;
  const dev_token = process.env.GOOGLE_DEVELOPER_TOKEN;
  if (!client_email || !private_key || !customer_id) return { error: "Google env eksik" };

  const jwt = require("jsonwebtoken");
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({
    iss: client_email, sub: client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/adwords"
  }, private_key, { algorithm: "RS256" });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return { error: "Google token alınamadı" };

  const cleanId = customer_id.replace(/-/g, "");
  const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 20`;

  const adsRes = await fetch(
    `https://googleads.googleapis.com/v17/customers/${cleanId}/googleAds:search`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "developer-token": dev_token || "",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    }
  );
  const adsData = await adsRes.json();
  if (adsData.error) return { error: adsData.error.message };

  const results = (adsData.results || []).map(r => {
    const cost = (r.metrics?.costMicros || 0) / 1_000_000;
    const value = r.metrics?.conversionsValue || 0;
    return {
      id: r.campaign?.id, name: r.campaign?.name, status: r.campaign?.status,
      impressions: r.metrics?.impressions || 0, clicks: r.metrics?.clicks || 0,
      cost: cost.toFixed(2), conversions: r.metrics?.conversions || 0,
      revenue: value.toFixed(2),
      roas: cost > 0 ? (value / cost).toFixed(2) : "0"
    };
  });

  const totalCost = results.reduce((s, r) => s + parseFloat(r.cost), 0);
  const totalRevenue = results.reduce((s, r) => s + parseFloat(r.revenue), 0);
  return {
    campaigns: results,
    summary: {
      total_cost: totalCost.toFixed(2),
      total_revenue: totalRevenue.toFixed(2),
      overall_roas: totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : "0",
      active_campaigns: results.filter(r => r.status === "ENABLED").length
    }
  };
}

// ─── DASHBOARD (tek endpoint, env'den okur) ──────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const [shopify, meta, google] = await Promise.allSettled([
      fetchShopify(), fetchMeta(), fetchGoogle()
    ]);
    res.json({
      shopify: shopify.status === "fulfilled" ? shopify.value : { error: shopify.reason?.message },
      meta: meta.status === "fulfilled" ? meta.value : { error: meta.reason?.message },
      google: google.status === "fulfilled" ? google.value : { error: google.reason?.message },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ Reklam Motoru Backend Çalışıyor", version: "2.0.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
