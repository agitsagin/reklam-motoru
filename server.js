const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

// ─── SHOPIFY ────────────────────────────────────────────────────────────────
app.get("/api/shopify", async (req, res) => {
  const { store, token } = req.query;
  try {
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
      ? orders.reduce((s, o) => s + parseFloat(o.total_price), 0) / orders.length
      : 0;

    res.json({
      today_orders: todayOrders.length,
      today_revenue: todayRevenue.toFixed(2),
      month_orders: monthOrders.length,
      month_revenue: monthRevenue.toFixed(2),
      avg_order_value: avgOrderValue.toFixed(2),
      total_products: (productsData.products || []).length,
      top_products: (productsData.products || []).slice(0, 5).map(p => ({
        id: p.id,
        title: p.title,
        price: p.variants?.[0]?.price || "0"
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GOOGLE ADS ─────────────────────────────────────────────────────────────
app.post("/api/google", async (req, res) => {
  const { client_email, private_key, customer_id } = req.body;
  try {
    // Get access token via JWT
    const jwt = require("jsonwebtoken");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: client_email,
      sub: client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/adwords"
    };

    const token = jwt.sign(payload, private_key.replace(/\\n/g, "\n"), { algorithm: "RS256" });

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(401).json({ error: "Token alınamadı", detail: tokenData });
    }

    const cleanCustomerId = customer_id.replace(/-/g, "");

    // Fetch campaign performance
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
      ORDER BY metrics.cost_micros DESC
      LIMIT 20
    `;

    const adsRes = await fetch(
      `https://googleads.googleapis.com/v17/customers/${cleanCustomerId}/googleAds:search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "developer-token": process.env.GOOGLE_DEVELOPER_TOKEN || "",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query })
      }
    );

    const adsData = await adsRes.json();

    if (adsData.error) {
      return res.status(400).json({ error: adsData.error.message });
    }

    const results = (adsData.results || []).map(r => {
      const cost = (r.metrics?.costMicros || 0) / 1_000_000;
      const value = r.metrics?.conversionsValue || 0;
      const roas = cost > 0 ? (value / cost).toFixed(2) : "0";
      return {
        id: r.campaign?.id,
        name: r.campaign?.name,
        status: r.campaign?.status,
        impressions: r.metrics?.impressions || 0,
        clicks: r.metrics?.clicks || 0,
        cost: cost.toFixed(2),
        conversions: r.metrics?.conversions || 0,
        revenue: value.toFixed(2),
        roas
      };
    });

    const totalCost = results.reduce((s, r) => s + parseFloat(r.cost), 0);
    const totalRevenue = results.reduce((s, r) => s + parseFloat(r.revenue), 0);

    res.json({
      campaigns: results,
      summary: {
        total_cost: totalCost.toFixed(2),
        total_revenue: totalRevenue.toFixed(2),
        overall_roas: totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : "0",
        active_campaigns: results.filter(r => r.status === "ENABLED").length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── META ADS ───────────────────────────────────────────────────────────────
app.get("/api/meta", async (req, res) => {
  const { token, account_id } = req.query;
  try {
    const fields = "name,status,daily_budget,lifetime_budget,insights{spend,impressions,clicks,actions,action_values,cpc,ctr}";
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${account_id}/campaigns?fields=${fields}&date_preset=last_30d&access_token=${token}`
    );
    const metaData = await metaRes.json();

    if (metaData.error) {
      return res.status(400).json({ error: metaData.error.message });
    }

    const campaigns = (metaData.data || []).map(c => {
      const ins = c.insights?.data?.[0] || {};
      const spend = parseFloat(ins.spend || 0);
      const purchaseAction = (ins.action_values || []).find(a => a.action_type === "purchase");
      const revenue = parseFloat(purchaseAction?.value || 0);
      const roas = spend > 0 ? (revenue / spend).toFixed(2) : "0";
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        spend: spend.toFixed(2),
        impressions: ins.impressions || 0,
        clicks: ins.clicks || 0,
        cpc: ins.cpc || "0",
        ctr: ins.ctr || "0",
        revenue: revenue.toFixed(2),
        roas
      };
    });

    const totalSpend = campaigns.reduce((s, c) => s + parseFloat(c.spend), 0);
    const totalRevenue = campaigns.reduce((s, c) => s + parseFloat(c.revenue), 0);

    res.json({
      campaigns,
      summary: {
        total_spend: totalSpend.toFixed(2),
        total_revenue: totalRevenue.toFixed(2),
        overall_roas: totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : "0",
        active_campaigns: campaigns.filter(c => c.status === "ACTIVE").length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── COMBINED DASHBOARD ──────────────────────────────────────────────────────
app.post("/api/dashboard", async (req, res) => {
  const { shopify_store, shopify_token, meta_token, meta_account } = req.body;
  try {
    const results = {};

    // Shopify
    if (shopify_store && shopify_token) {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/shopify?store=${shopify_store}&token=${shopify_token}`);
        results.shopify = await r.json();
      } catch (e) { results.shopify = { error: e.message }; }
    }

    // Meta
    if (meta_token && meta_account) {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/meta?token=${meta_token}&account_id=${meta_account}`);
        results.meta = await r.json();
      } catch (e) { results.meta = { error: e.message }; }
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ Reklam Motoru Backend Çalışıyor", version: "1.0.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
