import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const WALLET = process.env.WALLET_ADDRESS;
const NETWORK = "eip155:8453"; // Base mainnet

// ─── x402 Payment Setup ──────────────────────────────
let resourceServer = null;
let applyPayments = null;

const hasKeys = process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET;
if (hasKeys) {
  try {
    const x402Express = await import("@x402/express");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const { createFacilitatorConfig } = await import("@coinbase/x402");
    const facilitatorConfig = createFacilitatorConfig(
      process.env.CDP_API_KEY_ID,
      process.env.CDP_API_KEY_SECRET
    );
    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    resourceServer = new x402Express.x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());
    applyPayments = x402Express.paymentMiddleware;
    console.log("x402 payment middleware initialized");
  } catch (e) {
    console.warn("x402 setup failed:", e.message);
  }
} else {
  console.log("Running in FREE mode — add CDP_API_KEY_ID and CDP_API_KEY_SECRET to enable payments");
}

// ─── Payment pricing config ──────────────────────────
const pricing = {
  "GET /api/v1/crypto/price/": {
    accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: WALLET }],
    description: "Real-time crypto price with 24h change and market cap",
  },
  "GET /api/v1/crypto/signal/": {
    accepts: [{ scheme: "exact", price: "$0.03", network: NETWORK, payTo: WALLET }],
    description: "Trading signal (BUY/HOLD/SELL) with confidence score",
  },
  "POST /api/v1/web/extract": {
    accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: WALLET }],
    description: "Extract clean text from any URL",
  },
  "POST /api/v1/web/metadata": {
    accepts: [{ scheme: "exact", price: "$0.02", network: NETWORK, payTo: WALLET }],
    description: "Extract title, links, images, headings from URL",
  },
  "POST /api/v1/web/contacts": {
    accepts: [{ scheme: "exact", price: "$0.03", network: NETWORK, payTo: WALLET }],
    description: "Extract emails, phones, social links from URL",
  },
  "POST /api/v1/transform/json-to-csv": {
    accepts: [{ scheme: "exact", price: "$0.005", network: NETWORK, payTo: WALLET }],
    description: "Convert JSON array to CSV",
  },
  "POST /api/v1/transform/csv-to-json": {
    accepts: [{ scheme: "exact", price: "$0.005", network: NETWORK, payTo: WALLET }],
    description: "Convert CSV to JSON array",
  },
  "POST /api/v1/transform/xml-to-json": {
    accepts: [{ scheme: "exact", price: "$0.005", network: NETWORK, payTo: WALLET }],
    description: "Convert XML to JSON",
  },
  "GET /api/v1/forex/rate/": {
    accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: WALLET }],
    description: "Exchange rate for currency pair",
  },
};

// Apply payment middleware if configured
if (resourceServer && applyPayments) {
  app.use(applyPayments(pricing, resourceServer));
  console.log("Payment gating ACTIVE — agents must pay USDC on Base");
}

// ─── Helper: fetch with timeout ──────────────────────
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── CRYPTO ENDPOINTS ────────────────────────────────

// GET /api/v1/crypto/price/:symbol
app.get("/api/v1/crypto/price/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toLowerCase();
    const cgMap = {
      btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin",
      xrp: "ripple", ada: "cardano", dot: "polkadot", matic: "matic-network",
      avax: "avalanche-2", link: "chainlink", uni: "uniswap", atom: "cosmos",
      near: "near", apt: "aptos", sui: "sui", arb: "arbitrum",
      op: "optimism", pepe: "pepe", shib: "shiba-inu", hbar: "hedera-hashgraph",
      ton: "the-open-network", fil: "filecoin", bnb: "binancecoin",
    };
    const id = cgMap[symbol] || symbol;
    const r = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`
    );
    if (!r.ok) return res.status(404).json({ error: `Unknown symbol: ${symbol}` });
    const data = await r.json();
    res.json({
      symbol: data.symbol?.toUpperCase(),
      name: data.name,
      price: data.market_data?.current_price?.usd,
      change_24h: data.market_data?.price_change_percentage_24h,
      market_cap: data.market_data?.market_cap?.usd,
      volume_24h: data.market_data?.total_volume?.usd,
      high_24h: data.market_data?.high_24h?.usd,
      low_24h: data.market_data?.low_24h?.usd,
      last_updated: data.market_data?.last_updated,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/crypto/signal/:symbol
app.get("/api/v1/crypto/signal/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toLowerCase();
    const cgMap = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin", xrp: "ripple", hbar: "hedera-hashgraph" };
    const id = cgMap[symbol] || symbol;
    const r = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`
    );
    if (!r.ok) return res.status(404).json({ error: `Unknown symbol: ${symbol}` });
    const data = await r.json();
    const md = data.market_data;
    const change24h = md?.price_change_percentage_24h || 0;
    const change7d = md?.price_change_percentage_7d || 0;
    const change30d = md?.price_change_percentage_30d || 0;

    // Simple signal logic based on momentum
    let signal = "HOLD";
    let confidence = 50;
    if (change24h > 5 && change7d > 10) { signal = "BUY"; confidence = 75; }
    else if (change24h > 3 && change7d > 5) { signal = "BUY"; confidence = 60; }
    else if (change24h < -5 && change7d < -10) { signal = "SELL"; confidence = 75; }
    else if (change24h < -3 && change7d < -5) { signal = "SELL"; confidence = 60; }

    // Boost confidence if 30d trend aligns
    if ((signal === "BUY" && change30d > 15) || (signal === "SELL" && change30d < -15)) {
      confidence = Math.min(confidence + 15, 95);
    }

    res.json({
      symbol: data.symbol?.toUpperCase(),
      signal,
      confidence,
      price: md?.current_price?.usd,
      change_24h: change24h,
      change_7d: change7d,
      change_30d: change30d,
      analysis: `${data.symbol?.toUpperCase()} is ${signal === "BUY" ? "showing bullish momentum" : signal === "SELL" ? "showing bearish momentum" : "moving sideways"}. 24h: ${change24h > 0 ? "+" : ""}${change24h?.toFixed(1)}%, 7d: ${change7d > 0 ? "+" : ""}${change7d?.toFixed(1)}%.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WEB EXTRACTION ENDPOINTS ────────────────────────

// POST /api/v1/web/extract — clean text from URL
app.post("/api/v1/web/extract", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentPayAPI/1.0)" },
    });
    const html = await r.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    res.json({ url, text: text.substring(0, 50000), length: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/web/metadata — structured metadata from URL
app.post("/api/v1/web/metadata", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentPayAPI/1.0)" },
    });
    const html = await r.text();
    const $ = cheerio.load(html);
    res.json({
      url,
      title: $("title").text().trim(),
      description: $('meta[name="description"]').attr("content") || "",
      ogTitle: $('meta[property="og:title"]').attr("content") || "",
      ogImage: $('meta[property="og:image"]').attr("content") || "",
      headings: $("h1, h2, h3").map((_, el) => $(el).text().trim()).get().slice(0, 20),
      links: $("a[href]").map((_, el) => ({ text: $(el).text().trim(), href: $(el).attr("href") })).get().slice(0, 50),
      images: $("img[src]").map((_, el) => $(el).attr("src")).get().slice(0, 30),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/web/contacts — extract emails, phones, social links
app.post("/api/v1/web/contacts", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentPayAPI/1.0)" },
    });
    const html = await r.text();
    const text = html;
    const emails = [...new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
    const phones = [...new Set(text.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/g) || [])];
    const $ = cheerio.load(html);
    const socialLinks = $("a[href]").map((_, el) => $(el).attr("href")).get()
      .filter(href => /twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|github\.com|youtube\.com/i.test(href));
    res.json({ url, emails, phones, social: [...new Set(socialLinks)] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DATA TRANSFORMATION ENDPOINTS ───────────────────

// POST /api/v1/transform/json-to-csv
app.post("/api/v1/transform/json-to-csv", (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ error: "data must be a non-empty array of objects" });
    }
    const headers = [...new Set(data.flatMap(Object.keys))];
    const csv = [
      headers.join(","),
      ...data.map(row => headers.map(h => {
        const v = row[h] ?? "";
        return typeof v === "string" && (v.includes(",") || v.includes('"'))
          ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(","))
    ].join("\n");
    res.json({ csv, rows: data.length, columns: headers.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/transform/csv-to-json
app.post("/api/v1/transform/csv-to-json", (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv) return res.status(400).json({ error: "csv string required" });
    const lines = csv.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const data = lines.slice(1).map(line => {
      const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] || ""]));
    });
    res.json({ data, rows: data.length, columns: headers.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/transform/xml-to-json
app.post("/api/v1/transform/xml-to-json", (req, res) => {
  try {
    const { xml } = req.body;
    if (!xml) return res.status(400).json({ error: "xml string required" });
    const $ = cheerio.load(xml, { xmlMode: true });
    function parseNode(el) {
      const obj = {};
      const $el = $(el);
      // Attributes
      const attrs = el.attribs;
      if (attrs && Object.keys(attrs).length) obj["@attributes"] = attrs;
      // Children
      const children = $el.children();
      if (children.length === 0) {
        return $el.text().trim();
      }
      children.each((_, child) => {
        const name = child.name || child.tagName;
        const parsed = parseNode(child);
        if (obj[name]) {
          if (!Array.isArray(obj[name])) obj[name] = [obj[name]];
          obj[name].push(parsed);
        } else {
          obj[name] = parsed;
        }
      });
      return obj;
    }
    const root = $.root().children().first();
    const result = { [root[0]?.name || "root"]: parseNode(root[0]) };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FOREX ENDPOINT ──────────────────────────────────

// GET /api/v1/forex/rate/:pair (e.g., USD-EUR)
app.get("/api/v1/forex/rate/:pair", async (req, res) => {
  try {
    const [from, to] = req.params.pair.toUpperCase().split("-");
    if (!from || !to) return res.status(400).json({ error: "Format: FROM-TO (e.g., USD-EUR)" });
    // Use exchangerate.host free API
    const r = await fetchWithTimeout(
      `https://api.exchangerate.host/latest?base=${from}&symbols=${to}`
    );
    const data = await r.json();
    if (!data.success && !data.rates) {
      return res.status(404).json({ error: `Rate not found for ${from}-${to}` });
    }
    res.json({
      from, to,
      rate: data.rates?.[to],
      date: data.date,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DISCOVERY ENDPOINTS ─────────────────────────────

// MCP config
app.get("/.well-known/mcp.json", (req, res) => {
  res.json({
    name: "NoGrave Agent Services",
    description: "Crypto prices, web scraping, data transformation, forex — pay-per-use with USDC on Base",
    version: "1.0.0",
    tools: Object.entries(pricing).map(([route, config]) => ({
      name: route.replace(/[^a-zA-Z]/g, "_").replace(/_+/g, "_"),
      description: config.description,
      price: config.accepts[0].price,
      endpoint: route,
    })),
  });
});

// A2A Agent Card
app.get("/.well-known/agent.json", (req, res) => {
  res.json({
    name: "NoGrave Agent Services",
    description: "Pay-per-use API for AI agents. Crypto data, web extraction, data transformation, forex rates. Payments in USDC on Base via x402.",
    url: process.env.SERVICE_URL || `http://localhost:${PORT}`,
    capabilities: ["crypto-data", "web-extraction", "data-transformation", "forex"],
    payment: { protocol: "x402", network: NETWORK, token: "USDC", wallet: WALLET },
    endpoints: Object.entries(pricing).map(([route, config]) => ({
      method: route.split(" ")[0],
      path: route.split(" ")[1],
      price: config.accepts[0].price,
      description: config.description,
    })),
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", endpoints: Object.keys(pricing).length, wallet: WALLET });
});

// Root — landing page for humans, JSON for agents
app.get("/", (req, res) => {
  const accept = req.headers.accept || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return res.json({
      name: "NoGrave Agent Services",
      description: "Pay-per-use APIs for AI agents. USDC micropayments on Base via x402.",
      wallet: WALLET,
      docs: "Send requests to any endpoint. If x402 is active, pay USDC on Base. Discovery at /.well-known/mcp.json and /.well-known/agent.json",
      endpoints: Object.entries(pricing).map(([route, config]) => ({
        route,
        price: config.accepts[0].price,
        description: config.description,
      })),
    });
  }

  const endpoints = Object.entries(pricing).map(([route, config]) => {
    const [method, path] = route.split(" ");
    return `
      <div class="endpoint">
        <div class="endpoint-header">
          <span class="method ${method.toLowerCase()}">${method}</span>
          <code class="path">${path}</code>
          <span class="price">${config.accepts[0].price}</span>
        </div>
        <p class="desc">${config.description}</p>
      </div>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NoGrave Agent Services</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #0a0a0f;
      color: #e0e0e8;
      min-height: 100vh;
      overflow-x: hidden;
    }
    .bg-grid {
      position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(rgba(99, 102, 241, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(99, 102, 241, 0.03) 1px, transparent 1px);
      background-size: 60px 60px;
    }
    .glow-orb {
      position: fixed; border-radius: 50%; filter: blur(120px); opacity: 0.15; z-index: 0;
    }
    .glow-1 { width: 500px; height: 500px; background: #6366f1; top: -100px; right: -100px; }
    .glow-2 { width: 400px; height: 400px; background: #06b6d4; bottom: -100px; left: -100px; }

    .container { max-width: 900px; margin: 0 auto; padding: 60px 24px; position: relative; z-index: 1; }

    .hero { text-align: center; margin-bottom: 64px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 100px; padding: 6px 16px; font-size: 13px; color: #818cf8;
      margin-bottom: 24px; font-weight: 500;
    }
    .badge .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    h1 {
      font-size: clamp(2.2rem, 5vw, 3.5rem); font-weight: 800;
      background: linear-gradient(135deg, #fff 0%, #818cf8 50%, #06b6d4 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      line-height: 1.1; margin-bottom: 16px;
    }
    .subtitle { font-size: 18px; color: #9ca3af; max-width: 600px; margin: 0 auto 32px; line-height: 1.6; }

    .stats {
      display: flex; justify-content: center; gap: 40px; margin-bottom: 32px;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
    .stat-label { font-size: 13px; color: #6b7280; margin-top: 4px; }

    .wallet-box {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px; padding: 12px 20px; font-family: 'JetBrains Mono', monospace;
      font-size: 13px; color: #9ca3af;
    }
    .wallet-box .label { color: #6366f1; font-weight: 600; }

    .section-title {
      font-size: 14px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 2px; color: #6366f1; margin-bottom: 24px;
    }

    .endpoints { display: flex; flex-direction: column; gap: 12px; margin-bottom: 64px; }
    .endpoint {
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px; padding: 20px 24px;
      transition: border-color 0.2s, background 0.2s;
    }
    .endpoint:hover { border-color: rgba(99, 102, 241, 0.3); background: rgba(99, 102, 241, 0.04); }
    .endpoint-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
    .method {
      font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 600;
      padding: 4px 10px; border-radius: 6px; text-transform: uppercase;
    }
    .method.get { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
    .method.post { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
    .path { font-family: 'JetBrains Mono', monospace; font-size: 14px; color: #e0e0e8; flex: 1; }
    .price {
      font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 600;
      color: #06b6d4; background: rgba(6, 182, 212, 0.1); padding: 4px 12px; border-radius: 6px;
    }
    .desc { font-size: 14px; color: #9ca3af; line-height: 1.5; }

    .discovery { margin-bottom: 64px; }
    .discovery-links { display: flex; gap: 12px; flex-wrap: wrap; }
    .discovery-link {
      display: flex; align-items: center; gap: 8px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 14px 20px; text-decoration: none;
      color: #e0e0e8; font-size: 14px; font-weight: 500;
      transition: border-color 0.2s;
    }
    .discovery-link:hover { border-color: rgba(99, 102, 241, 0.4); }
    .discovery-link code { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #818cf8; }

    .footer {
      text-align: center; padding-top: 40px; border-top: 1px solid rgba(255,255,255,0.06);
      color: #6b7280; font-size: 13px;
    }
    .footer a { color: #818cf8; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="glow-orb glow-1"></div>
  <div class="glow-orb glow-2"></div>

  <div class="container">
    <div class="hero">
      <div class="badge"><span class="dot"></span> x402 Payments Active</div>
      <h1>NoGrave Agent Services</h1>
      <p class="subtitle">Pay-per-use APIs built for AI agents. Crypto data, web extraction, data transformation, and forex rates — all paid with USDC micropayments on Base.</p>

      <div class="stats">
        <div class="stat"><div class="stat-value">9</div><div class="stat-label">Endpoints</div></div>
        <div class="stat"><div class="stat-value">$0.005</div><div class="stat-label">Starting Price</div></div>
        <div class="stat"><div class="stat-value">USDC</div><div class="stat-label">on Base</div></div>
      </div>

      <div class="wallet-box">
        <span class="label">Wallet</span>
        ${WALLET}
      </div>
    </div>

    <div class="section-title">Endpoints</div>
    <div class="endpoints">${endpoints}</div>

    <div class="discovery">
      <div class="section-title">Agent Discovery</div>
      <div class="discovery-links">
        <a href="/.well-known/mcp.json" class="discovery-link">
          🔌 <span>MCP Config</span> <code>/.well-known/mcp.json</code>
        </a>
        <a href="/.well-known/agent.json" class="discovery-link">
          🤖 <span>A2A Agent Card</span> <code>/.well-known/agent.json</code>
        </a>
        <a href="/health" class="discovery-link">
          💚 <span>Health Check</span> <code>/health</code>
        </a>
      </div>
    </div>

    <div class="footer">
      <p>Built by <a href="https://github.com/NoGraveDev" target="_blank">No Grave LLC</a> · Powered by <a href="https://www.x402.org/" target="_blank">x402 Protocol</a></p>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`NoGrave Agent Services running on port ${PORT}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Endpoints: ${Object.keys(pricing).length}`);
  console.log(`x402: ${resourceServer ? "ACTIVE" : "FREE MODE (no CDP keys)"}`);
});
