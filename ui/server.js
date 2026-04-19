// Local Trade Dashboard server (no external deps)
// Serves a small web UI that runs trade analysis end-to-end, snapshots each run,
// and previews the newly generated PDF in-browser.

const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const fearGreedModule = require("./fear_greed_index");
const cmcModule = require("./coinmarketcap_api");
const xModule = require("./x_api");

const ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(__dirname, "public");
const TRADE_DIR = path.join(ROOT, "trade");
const REQUESTS_DIR = path.join(ROOT, "requests");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const RUNS_DIR = path.join(TRADE_DIR, ".runs");
const TICKER_RE = /^[A-Z0-9]{1,10}$/;

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
  } catch {
    return;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function applyLocalEnvAliases() {
  if (!process.env.XAI_API_KEY && process.env.LOCAL_XAI_API_KEY) {
    process.env.XAI_API_KEY = process.env.LOCAL_XAI_API_KEY;
  }
  if (!process.env.XAI_MODEL && process.env.LOCAL_GROK_MODEL) {
    process.env.XAI_MODEL = process.env.LOCAL_GROK_MODEL;
  }
}

loadEnvFile(path.join(ROOT, ".env"));
applyLocalEnvAliases();

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";

// Prefer an explicit interpreter path to avoid Windows Store python/py aliases.
const DEFAULT_PYTHON =
  process.env.MARKET_PYTHON ||
  "C:\\APPS_NEW\\DeepTutor\\.venv\\Scripts\\python.exe";

const DEFAULT_ANALYSIS_ENGINE = (process.env.ANALYSIS_ENGINE || "auto").trim().toLowerCase();
const DEFAULT_XAI_BASE_URL = (process.env.XAI_BASE_URL || process.env.XAI_API_BASE || "https://api.x.ai/v1").trim().replace(/\/+$/, "");
const DEFAULT_XAI_MODEL = (process.env.XAI_MODEL || "grok-3-mini").trim();
const DEFAULT_BINANCE_BASE_URL = (process.env.BINANCE_API_BASE || "https://api.binance.com").trim().replace(/\/+$/, "");
const DEFAULT_COINGECKO_BASE_URL = (process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3").trim().replace(/\/+$/, "");
const DEFAULT_COINGECKO_API_KEY = (
  process.env.COINGECKO_API_KEY ||
  process.env.COINGECKO_DEMO_API_KEY ||
  process.env.X_CG_DEMO_API_KEY ||
  ""
).trim();
const DEFAULT_XRPSCAN_BASE_URL = (process.env.XRPSCAN_API_BASE || "https://api.xrpscan.com/api/v1").trim().replace(/\/+$/, "");
const COINGECKO_COIN_MAP = {
  BTC: "bitcoin",
  ETH: "ethereum",
  XRP: "ripple",
  SOL: "solana",
  XLM: "stellar",
  XDC: "xdc-network",
};
const SCORE_WEIGHTS = {
  technical: 0.3,
  fundamental: 0.3,
  sentiment: 0.2,
  risk: 0.1,
  thesis: 0.1,
};
const SCORE_WEIGHT_LABELS = {
  technical: "30%",
  fundamental: "30%",
  sentiment: "20%",
  risk: "10%",
  thesis: "10%",
};
const DATA_CACHE = new Map();
const FEAR_GREED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CMC_CACHE_TTL_MS = 5 * 60 * 1000;
const X_CACHE_TTL_MS = 15 * 60 * 1000;

const ANALYSIS_PIPELINE = [
  {
    key: "request_ticket",
    badge: "RQ",
    name: "Request Ticket",
    waiting: "Waiting for a new run",
    active: "Locking a brand new request",
    done: "Fresh run ticket created",
    error: "Run request failed",
  },
  {
    key: "discovery",
    badge: "DS",
    name: "Discovery",
    waiting: "Waiting for the request ticket",
    active: "Gathering shared market context",
    done: "Shared brief collected",
    error: "Discovery failed",
  },
  {
    key: "trade-technical",
    badge: "TA",
    name: "Technical",
    waiting: "Waiting for discovery",
    active: "Chart and trend analysis live",
    done: "Technical analysis returned",
    error: "Technical analysis interrupted",
  },
  {
    key: "trade-fundamental",
    badge: "FA",
    name: "Fundamental",
    waiting: "Waiting for discovery",
    active: "Financial quality analysis live",
    done: "Fundamental analysis returned",
    error: "Fundamental analysis interrupted",
  },
  {
    key: "trade-sentiment",
    badge: "SA",
    name: "Sentiment",
    waiting: "Waiting for discovery",
    active: "News and crowd analysis live",
    done: "Sentiment analysis returned",
    error: "Sentiment analysis interrupted",
  },
  {
    key: "trade-risk",
    badge: "RA",
    name: "Risk",
    waiting: "Waiting for discovery",
    active: "Risk and sizing analysis live",
    done: "Risk analysis returned",
    error: "Risk analysis interrupted",
  },
  {
    key: "trade-thesis",
    badge: "TH",
    name: "Thesis",
    waiting: "Waiting for discovery",
    active: "Bull/bear thesis analysis live",
    done: "Thesis analysis returned",
    error: "Thesis analysis interrupted",
  },
  {
    key: "synthesis",
    badge: "SX",
    name: "Synthesis",
    waiting: "Waiting for agent output",
    active: "Combining agent output into the brief",
    done: "Fresh markdown and JSON locked",
    error: "Fresh analysis files were not produced",
  },
  {
    key: "pdf_forge",
    badge: "PF",
    name: "PDF Forge",
    waiting: "Waiting for fresh JSON",
    active: "Rendering the polished PDF",
    done: "Fresh PDF ready to review",
    error: "PDF generation failed",
  },
];

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

async function loadCached(key, ttlMs, loader) {
  const cached = DATA_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await loader();
  DATA_CACHE.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function sendJson(res, code, obj) {
  const payload = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, code, text, contentType = "text/plain; charset=utf-8") {
  const payload = Buffer.from(text);
  res.writeHead(code, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function normalizeTicker(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return TICKER_RE.test(normalized) ? normalized : null;
}

function safeJoin(base, requestedPath) {
  const normalized = path.normalize(requestedPath).replace(/^([/\\])+/, "");
  const resolvedBase = path.resolve(base);
  const resolvedJoined = path.resolve(base, normalized);
  const relative = path.relative(resolvedBase, resolvedJoined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolvedJoined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function formatDisplayDate(ts = Date.now()) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function extractFirstJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {}

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = input.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function safeText(value, fallback = "") {
  const out = String(value || "").trim();
  return out || fallback;
}

function isPlaceholderText(value) {
  const out = String(value || "").trim().toLowerCase();
  if (!out) return true;
  return (
    out === "--" ||
    out === "n/a" ||
    out.includes("pending") ||
    out.includes("baseline unavailable") ||
    out.includes("no dominant moat signal")
  );
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const nums = values.map(toNumber).filter((value) => value !== null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function median(values) {
  const nums = values
    .map(toNumber)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 0) return (nums[mid - 1] + nums[mid]) / 2;
  return nums[mid];
}

function compactNumber(value, fractionDigits = 2) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

function formatUsd(value) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(n);
  }
  let digits = 2;
  if (abs > 0 && abs < 1) digits = 4;
  if (abs > 0 && abs < 0.1) digits = 5;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function formatPlainNumber(value, fractionDigits = 2) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

function formatPercent(value, fractionDigits = 1) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(fractionDigits)}%`;
}

function formatPercentRatio(value, fractionDigits = 1) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return `${(n * 100).toFixed(fractionDigits)}%`;
}

function formatSupply(value) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return compactNumber(n, 2);
}

function formatRatio(value, fractionDigits = 2) {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return `${n.toFixed(fractionDigits)}x`;
}

function slugifyCategory(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJson(urlString, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const headers = {
      Accept: "application/json",
      "User-Agent": "trade-dashboard/1.0",
      ...(options.headers || {}),
    };
    const response = await fetch(urlString, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(urlString, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const headers = {
      Accept: options.accept || "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "trade-dashboard/1.0",
      ...(options.headers || {}),
    };
    const response = await fetch(urlString, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function coingeckoHeaders() {
  if (!DEFAULT_COINGECKO_API_KEY) return {};
  return { "x-cg-demo-api-key": DEFAULT_COINGECKO_API_KEY };
}

function coingeckoUrl(pathname, params = {}) {
  const query = new url.URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${DEFAULT_COINGECKO_BASE_URL}${pathname}${suffix ? `?${suffix}` : ""}`;
}

function binanceUrl(pathname, params = {}) {
  const query = new url.URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${DEFAULT_BINANCE_BASE_URL}${pathname}${suffix ? `?${suffix}` : ""}`;
}

function xrpscanUrl(pathname) {
  return `${DEFAULT_XRPSCAN_BASE_URL}${pathname}`;
}

function normalizeCoinGeckoCandle(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  return {
    openTime: Number(row[0]) || 0,
    open: Number(row[1]) || 0,
    high: Number(row[2]) || 0,
    low: Number(row[3]) || 0,
    close: Number(row[4]) || 0,
    volume: null,
  };
}

function normalizeBinanceCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  return {
    openTime: Number(row[0]) || 0,
    open: Number(row[1]) || 0,
    high: Number(row[2]) || 0,
    low: Number(row[3]) || 0,
    close: Number(row[4]) || 0,
    volume: Number(row[5]) || 0,
  };
}

async function fetchBinanceCandles(symbol, job) {
  if (!symbol) return null;
  appendJobLog(job, `Fetching Binance daily candles for ${symbol}.`);
  const [candlesRaw, ticker24h] = await Promise.all([
    fetchJson(binanceUrl("/api/v3/klines", { symbol, interval: "1d", limit: 120 }), { timeoutMs: 20000 }),
    fetchJson(binanceUrl("/api/v3/ticker/24hr", { symbol }), { timeoutMs: 15000 }),
  ]);
  const candles = Array.isArray(candlesRaw) ? candlesRaw.map(normalizeBinanceCandle).filter(Boolean) : [];
  if (candles.length === 0) return null;
  return {
    source: "binance",
    symbol,
    candles,
    ticker24h: ticker24h || null,
  };
}

async function fetchCoinGeckoMarketSnapshot(ticker, job) {
  appendJobLog(job, `Fetching CoinGecko market data for ${ticker}.`);
  const marketParamsBase = {
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: 25,
    page: 1,
    sparkline: false,
    price_change_percentage: "24h,7d,30d",
  };

  let market = null;
  try {
    const markets = await fetchJson(
      coingeckoUrl("/coins/markets", {
        ...marketParamsBase,
        symbols: ticker.toLowerCase(),
        include_tokens: "all",
      }),
      { headers: coingeckoHeaders(), timeoutMs: 20000 }
    );
    const matches = Array.isArray(markets)
      ? markets
          .filter((item) => String(item?.symbol || "").toUpperCase() === ticker)
          .sort((a, b) => (a?.market_cap_rank || Number.MAX_SAFE_INTEGER) - (b?.market_cap_rank || Number.MAX_SAFE_INTEGER))
      : [];
    market = matches[0] || null;
  } catch (error) {
    appendJobLog(job, `CoinGecko symbol lookup failed for ${ticker}: ${error.message}`);
  }

  if (!market?.id && COINGECKO_COIN_MAP[ticker]) {
    const mappedId = COINGECKO_COIN_MAP[ticker];
    appendJobLog(job, `CoinGecko symbol lookup missed ${ticker}. Retrying with mapped id ${mappedId}.`);
    try {
      const byId = await fetchJson(
        coingeckoUrl("/coins/markets", {
          ...marketParamsBase,
          ids: mappedId,
        }),
        { headers: coingeckoHeaders(), timeoutMs: 20000 }
      );
      market = Array.isArray(byId) ? byId[0] || null : null;
    } catch (error) {
      appendJobLog(job, `CoinGecko id lookup failed for ${ticker}: ${error.message}`);
    }
  }

  if (!market?.id) {
    appendJobLog(job, `CoinGecko could not resolve a market id for ${ticker}.`);
    return null;
  }

  const details = await fetchJson(
    coingeckoUrl(`/coins/${encodeURIComponent(market.id)}`, {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: true,
      developer_data: true,
      sparkline: false,
      include_categories_details: true,
    }),
    { headers: coingeckoHeaders(), timeoutMs: 20000 }
  );

  let peers = [];
  const categoryId =
    details?.categories_details?.[0]?.id ||
    slugifyCategory(details?.categories?.[0]);

  if (categoryId) {
    try {
      peers = await fetchJson(
        coingeckoUrl("/coins/markets", {
          vs_currency: "usd",
          category: categoryId,
          order: "market_cap_desc",
          per_page: 25,
          page: 1,
          sparkline: false,
          price_change_percentage: "24h,7d,30d",
        }),
        { headers: coingeckoHeaders(), timeoutMs: 20000 }
      );
    } catch {}
  }

  if (!Array.isArray(peers) || peers.length < 3) {
    const rank = Number(market.market_cap_rank) || 1;
    const page = Math.max(1, Math.ceil(rank / 50));
    try {
      peers = await fetchJson(
        coingeckoUrl("/coins/markets", {
          vs_currency: "usd",
          order: "market_cap_desc",
          per_page: 50,
          page,
          sparkline: false,
          price_change_percentage: "24h,7d,30d",
        }),
        { headers: coingeckoHeaders(), timeoutMs: 20000 }
      );
    } catch {
      peers = [];
    }
  }

  appendJobLog(job, `CoinGecko market snapshot resolved for ${ticker} via ${market.id}.`);

  return {
    market,
    details: details || null,
    peers: Array.isArray(peers) ? peers.filter((item) => item?.id && item.id !== market.id) : [],
  };
}

async function fetchCoinGeckoOhlc(coinId, job) {
  if (!coinId) return null;
  appendJobLog(job, `Falling back to CoinGecko OHLC data for ${coinId}.`);
  const rows = await fetchJson(
    coingeckoUrl(`/coins/${encodeURIComponent(coinId)}/ohlc`, {
      vs_currency: "usd",
      days: 30,
    }),
    { headers: coingeckoHeaders(), timeoutMs: 20000 }
  );
  const candles = Array.isArray(rows) ? rows.map(normalizeCoinGeckoCandle).filter(Boolean) : [];
  if (candles.length === 0) return null;
  return { source: "coingecko", symbol: coinId, candles, ticker24h: null };
}

async function fetchXrpscanMetrics(job) {
  appendJobLog(job, "Fetching XRPSCAN ledger metrics for XRP.");
  const rows = await fetchJson(xrpscanUrl("/metrics/metric"), { timeoutMs: 20000 });
  const entries = Array.isArray(rows) ? rows.filter((row) => row?.metric) : [];
  if (entries.length === 0) return null;
  const latest = entries[entries.length - 1];
  const trailing = entries.slice(-30);
  return {
    latest,
    trailing,
  };
}

function formatCmcAssetRow(asset) {
  if (!asset?.symbol) return null;
  return {
    name: asset.name || asset.symbol,
    symbol: asset.symbol,
    marketCap: asset.quote?.USD?.market_cap || null,
    marketCapRank: asset.cmc_rank || null,
    price: asset.quote?.USD?.price || null,
    volume24h: asset.quote?.USD?.volume_24h || null,
    percentChange1h: asset.quote?.USD?.percent_change_1h || null,
    percentChange24h: asset.quote?.USD?.percent_change_24h || null,
    percentChange7d: asset.quote?.USD?.percent_change_7d || null,
    percentChange30d: asset.quote?.USD?.percent_change_30d || null,
    circulatingSupply: asset.circulating_supply || null,
    totalSupply: asset.total_supply || null,
    maxSupply: asset.max_supply || null,
    dominance: asset.quote?.USD?.market_cap_dominance || null,
  };
}

async function fetchFearGreedSentiment(job) {
  appendJobLog(job, "Fetching crypto Fear & Greed context.");
  return loadCached("fear-greed:report", FEAR_GREED_CACHE_TTL_MS, async () => {
    const current = await fearGreedModule.getFearGreedIndex();
    const history = await fearGreedModule.getFearGreedHistory(30);
    return fearGreedModule.formatForSentimentReport(current, history);
  });
}

async function fetchCoinMarketCapContext(ticker, job) {
  const cmcApiKey = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";
  if (!cmcApiKey) return null;

  appendJobLog(job, `Fetching CoinMarketCap market context for ${ticker}.`);
  const [topAssets, globalMetrics] = await Promise.all([
    loadCached("cmc:listings:top100", CMC_CACHE_TTL_MS, async () => cmcModule.getTopCryptocurrencies(100, "USD")),
    loadCached("cmc:global", CMC_CACHE_TTL_MS, async () => cmcModule.getGlobalMarketData("USD")),
  ]);

  const asset =
    (Array.isArray(topAssets) ? topAssets : []).find((row) => safeText(row?.symbol).toUpperCase() === ticker) || null;

  return {
    asset: formatCmcAssetRow(asset),
    global: cmcModule.formatGlobalMarketData(globalMetrics),
  };
}

async function fetchXSentimentContext(ticker, job) {
  if (!xModule.isConfigured()) return null;
  appendJobLog(job, `Fetching X social sentiment context for ${ticker}.`);
  return loadCached(`x:social:${ticker}`, X_CACHE_TTL_MS, async () => xModule.buildCryptoSentimentSnapshot(ticker));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = average(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * multiplier + prev;
    out[i] = prev;
  }
  return out;
}

function computeRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeMacd(values) {
  if (!Array.isArray(values) || values.length < 35) {
    return { macd: null, signal: null, histogram: null };
  }
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const macdSeries = values.map((_, index) => {
    if (ema12[index] === null || ema26[index] === null) return null;
    return ema12[index] - ema26[index];
  });
  const filtered = macdSeries.filter((value) => value !== null);
  const signalSeries = ema(filtered, 9);
  const macd = filtered[filtered.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  if (macd === undefined || signal === undefined || signal === null) {
    return { macd: null, signal: null, histogram: null };
  }
  return {
    macd,
    signal,
    histogram: macd - signal,
  };
}

function collectSwingLevels(candles) {
  const supports = [];
  const resistances = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const prev = candles[i - 1];
    const current = candles[i];
    const next = candles[i + 1];
    if (current.low <= prev.low && current.low <= next.low) supports.push(current.low);
    if (current.high >= prev.high && current.high >= next.high) resistances.push(current.high);
  }
  return { supports, resistances };
}

function pickNearestLevel(levels, current, direction, fallback) {
  const filtered = Array.from(new Set(levels.map((value) => Number(value).toFixed(10))))
    .map(Number)
    .filter((value) => Number.isFinite(value) && (direction === "below" ? value < current : value > current))
    .sort((a, b) => (direction === "below" ? b - a : a - b));
  return filtered[0] ?? fallback;
}

function buildTechnicalRead(candles, market) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const closes = candles.map((row) => row.close).filter((value) => Number.isFinite(value));
  const highs = candles.map((row) => row.high).filter((value) => Number.isFinite(value));
  const lows = candles.map((row) => row.low).filter((value) => Number.isFinite(value));
  const volumes = candles.map((row) => row.volume).filter((value) => Number.isFinite(value));
  if (closes.length < 20 || highs.length < 20 || lows.length < 20) return null;

  const currentPrice = closes[closes.length - 1];
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const ema20 = ema20Series[ema20Series.length - 1];
  const ema20Prev = ema20Series[ema20Series.length - 2];
  const ema50 = ema50Series[ema50Series.length - 1];
  const rsi = computeRsi(closes, 14);
  const macd = computeMacd(closes);
  const { supports, resistances } = collectSwingLevels(candles.slice(-90));
  const support1 = pickNearestLevel(supports, currentPrice, "below", Math.min(...lows.slice(-20)));
  const support2 = pickNearestLevel(
    supports.filter((value) => value < support1),
    support1,
    "below",
    Math.min(...lows.slice(-60))
  );
  const resistance1 = pickNearestLevel(resistances, currentPrice, "above", Math.max(...highs.slice(-20)));
  const resistance2 = pickNearestLevel(
    resistances.filter((value) => value > resistance1),
    resistance1,
    "above",
    Math.max(...highs.slice(-60))
  );

  let trendValue = "Neutral";
  let trendInterpretation = "Price is range-bound versus the medium-term trend.";
  if (ema20 && ema50) {
    const ema20Rising = ema20Prev !== null && ema20Prev !== undefined ? ema20 > ema20Prev : false;
    if (currentPrice > ema20 && ema20 > ema50 && ema20Rising) {
      trendValue = "Bullish";
      trendInterpretation = "Price is above the 20-day and 50-day trend anchors with a rising short-term slope.";
    } else if (currentPrice < ema20 && ema20 < ema50 && !ema20Rising) {
      trendValue = "Bearish";
      trendInterpretation = "Price is below both medium-term trend anchors and momentum is still slipping.";
    } else {
      trendValue = "Neutral-Balanced";
      trendInterpretation = "Trend anchors are close together, pointing to consolidation rather than a decisive breakout.";
    }
  }

  let macdValue = "Flat";
  let macdInterpretation = "Momentum is still seeking direction.";
  if (macd.macd !== null && macd.signal !== null && macd.histogram !== null) {
    if (macd.macd > macd.signal && macd.histogram > 0) {
      macdValue = "Bullish";
      macdInterpretation = "MACD is above the signal line with a positive histogram, supporting upside momentum.";
    } else if (macd.macd < macd.signal && macd.histogram < 0) {
      macdValue = "Bearish";
      macdInterpretation = "MACD is below the signal line with a negative histogram, showing fading momentum.";
    } else {
      macdValue = "Neutral";
      macdInterpretation = "MACD and signal are compressed, so momentum is mixed.";
    }
  }

  const avg20Volume = average(volumes.slice(-20));
  const lastVolume = volumes.length ? volumes[volumes.length - 1] : null;
  const volumeRatio = avg20Volume && lastVolume ? lastVolume / avg20Volume : null;
  let volumeValue = "n/a";
  let volumeInterpretation = "Volume context was unavailable from the selected market feed.";
  if (volumeRatio !== null) {
    volumeValue = `${volumeRatio.toFixed(2)}x avg`;
    if (volumeRatio >= 1.25) {
      volumeInterpretation = "Participation is running above the 20-day average, so the latest move has confirmation.";
    } else if (volumeRatio <= 0.85) {
      volumeInterpretation = "Participation is light versus the 20-day average, which makes the move less convincing.";
    } else {
      volumeInterpretation = "Participation is close to the 20-day average and does not contradict the current trend.";
    }
  }

  const rangeWidth = resistance1 > support1 ? (resistance1 - support1) / currentPrice : null;
  let patternValue = "Range consolidation";
  let patternInterpretation = "Price is rotating inside a defined swing range.";
  if (trendValue === "Bullish" && rangeWidth !== null && rangeWidth < 0.12) {
    patternValue = "Bullish continuation range";
    patternInterpretation = "A tight range above the medium-term trend often acts like a continuation setup if resistance breaks.";
  } else if (trendValue === "Bearish" && rangeWidth !== null && rangeWidth < 0.12) {
    patternValue = "Bearish continuation range";
    patternInterpretation = "A tight range beneath the moving trend anchors keeps downside pressure in place until demand reclaims resistance.";
  } else if (rangeWidth !== null && rangeWidth < 0.08) {
    patternValue = "Compression";
    patternInterpretation = "The recent trading range is tight, which raises the odds of an expansion move once a boundary breaks.";
  }

  const marketChange24h = toNumber(market?.priceChangePercentage24h ?? market?.price_change_percentage_24h);
  const marketChange7d = toNumber(market?.priceChangePercentage7dInCurrency ?? market?.price_change_percentage_7d_in_currency);
  const marketContextValue =
    marketChange24h !== null || marketChange7d !== null
      ? `${formatPercent(marketChange24h, 1)} 24h | ${formatPercent(marketChange7d, 1)} 7d`
      : "Local chart feed";
  const marketContextInterpretation =
    market?.marketCapRank || market?.market_cap_rank || (Array.isArray(market?.categories) && market.categories[0])
      ? `Market-cap rank #${market?.marketCapRank || market?.market_cap_rank || "n/a"}${
          Array.isArray(market?.categories) && market.categories[0] ? ` in ${market.categories[0]}` : ""
        }.`
      : "Derived directly from the current exchange candle feed.";

  const scoreParts = [
    trendValue === "Bullish" ? 24 : trendValue === "Neutral-Balanced" ? 17 : 10,
    rsi !== null ? (rsi >= 48 && rsi <= 68 ? 18 : rsi > 68 ? 12 : 10) : 12,
    macdValue === "Bullish" ? 18 : macdValue === "Neutral" ? 12 : 8,
    volumeRatio !== null ? (volumeRatio >= 1.1 ? 14 : volumeRatio >= 0.9 ? 11 : 8) : 10,
    currentPrice > support1 ? 12 : 8,
  ];
  const score = clampScore(scoreParts.reduce((sum, value) => sum + value, 0), 65);

  return {
    score,
    currentPrice,
    support1,
    support2,
    resistance1,
    resistance2,
    indicators: [
      { indicator: "Trend Direction", value: trendValue, interpretation: trendInterpretation },
      {
        indicator: "RSI (14)",
        value: rsi !== null ? formatPlainNumber(rsi, 1) : "n/a",
        interpretation:
          rsi === null
            ? "RSI could not be derived from the available candles."
            : rsi >= 70
            ? "Momentum is stretched and approaching overbought conditions."
            : rsi <= 35
            ? "Momentum is weak and closer to oversold territory."
            : "Momentum is balanced with room for continuation.",
      },
      { indicator: "MACD", value: macdValue, interpretation: macdInterpretation },
      { indicator: "Volume", value: volumeValue, interpretation: volumeInterpretation },
      { indicator: "Pattern", value: patternValue, interpretation: patternInterpretation },
      { indicator: "Market Context", value: marketContextValue, interpretation: marketContextInterpretation },
    ],
    keyLevels: [
      { level: "Resistance 2", price: formatUsd(resistance2), notes: "Higher swing resistance from the recent 2-3 month range" },
      { level: "Resistance 1", price: formatUsd(resistance1), notes: "Nearest swing resistance traders need to reclaim" },
      { level: "Current Price", price: formatUsd(currentPrice), notes: "Latest close from the selected market feed" },
      { level: "Support 1", price: formatUsd(support1), notes: "Nearest swing support inside the active range" },
      { level: "Support 2", price: formatUsd(support2), notes: "Lower range support and deeper invalidation zone" },
    ],
  };
}

function buildPeerAverages(peers) {
  const cleanPeers = Array.isArray(peers) ? peers.filter(Boolean).slice(0, 20) : [];
  return {
    marketCap: average(cleanPeers.map((item) => item?.market_cap)),
    fdvToMarketCap: average(
      cleanPeers.map((item) => {
        const fdv = toNumber(item?.fully_diluted_valuation);
        const marketCap = toNumber(item?.market_cap);
        if (!fdv || !marketCap) return null;
        return fdv / marketCap;
      })
    ),
    volumeToMarketCap: average(
      cleanPeers.map((item) => {
        const volume = toNumber(item?.total_volume);
        const marketCap = toNumber(item?.market_cap);
        if (!volume || !marketCap) return null;
        return volume / marketCap;
      })
    ),
    circulatingRatio: average(
      cleanPeers.map((item) => {
        const circulating = toNumber(item?.circulating_supply);
        const maxSupply = toNumber(item?.max_supply || item?.total_supply);
        if (!circulating || !maxSupply) return null;
        return circulating / maxSupply;
      })
    ),
    change7d: average(cleanPeers.map((item) => item?.price_change_percentage_7d_in_currency)),
    rank: median(cleanPeers.map((item) => item?.market_cap_rank)),
  };
}

function buildFundamentalRead(context) {
  const market = context?.coingecko?.market;
  if (!market) return null;
  const details = context?.coingecko?.details || {};
  const peerAverages = buildPeerAverages(context?.coingecko?.peers || []);
  const marketCap = toNumber(market.market_cap);
  const fdv = toNumber(market.fully_diluted_valuation);
  const volume24h = toNumber(market.total_volume);
  const circulatingSupply = toNumber(market.circulating_supply);
  const totalSupply = toNumber(market.total_supply);
  const maxSupply = toNumber(market.max_supply);
  const supplyBase = maxSupply || totalSupply;
  const fdvRatio = fdv && marketCap ? fdv / marketCap : null;
  const turnoverRatio = volume24h && marketCap ? volume24h / marketCap : null;
  const circulatingRatio = circulatingSupply && supplyBase ? circulatingSupply / supplyBase : null;
  const athChange = toNumber(market.ath_change_percentage);
  const communityFollowers = toNumber(details?.community_data?.twitter_followers) || toNumber(details?.community_data?.reddit_subscribers);
  const developerStars = toNumber(details?.developer_data?.stars);

  const metrics = [
    {
      metric: "Market Cap",
      value: formatUsd(marketCap),
      sector_avg: formatUsd(peerAverages.marketCap),
      assessment:
        market.market_cap_rank <= 10
          ? `Large-cap crypto asset with rank #${market.market_cap_rank}.`
          : `Mid-cap crypto asset with rank #${market.market_cap_rank}.`,
    },
    {
      metric: "FDV / Market Cap",
      value: formatRatio(fdvRatio, 2),
      sector_avg: formatRatio(peerAverages.fdvToMarketCap, 2),
      assessment:
        fdvRatio === null
          ? "Dilution baseline unavailable."
          : fdvRatio <= 1.15
          ? "Limited future dilution versus current market cap."
          : fdvRatio <= 1.5
          ? "Moderate dilution overhang remains in the supply curve."
          : "High fully diluted overhang versus current market cap.",
    },
    {
      metric: "Circulating Supply",
      value:
        circulatingRatio !== null
          ? `${formatSupply(circulatingSupply)} / ${formatSupply(supplyBase)}`
          : formatSupply(circulatingSupply || supplyBase),
      sector_avg: peerAverages.circulatingRatio !== null ? formatPercentRatio(peerAverages.circulatingRatio, 1) : "n/a",
      assessment:
        circulatingRatio === null
          ? "Supply schedule detail is incomplete."
          : `${formatPercentRatio(circulatingRatio, 1)} of headline supply is already circulating.`,
    },
    {
      metric: "24h Turnover",
      value: turnoverRatio !== null ? formatPercentRatio(turnoverRatio, 1) : "n/a",
      sector_avg: peerAverages.volumeToMarketCap !== null ? formatPercentRatio(peerAverages.volumeToMarketCap, 1) : "n/a",
      assessment:
        turnoverRatio === null
          ? "Liquidity context is unavailable."
          : turnoverRatio >= (peerAverages.volumeToMarketCap || 0)
          ? "Trading liquidity is running at or above peer pace."
          : "Trading liquidity is below the recent peer basket average.",
    },
    {
      metric: "7d Performance",
      value: formatPercent(market.price_change_percentage_7d_in_currency, 1),
      sector_avg: formatPercent(peerAverages.change7d, 1),
      assessment:
        toNumber(market.price_change_percentage_7d_in_currency) >= (peerAverages.change7d || 0)
          ? "Recent momentum is ahead of the peer basket."
          : "Recent momentum is lagging the peer basket.",
    },
    {
      metric: context?.xrpscan ? "Network Activity" : "Market Cap Rank",
      value: context?.xrpscan
        ? compactNumber(context.xrpscan.latest?.metric?.transaction_count || 0, 1)
        : `#${market.market_cap_rank || "n/a"}`,
      sector_avg: context?.xrpscan
        ? compactNumber(average((context.xrpscan.trailing || []).map((row) => row?.metric?.transaction_count)) || 0, 1)
        : peerAverages.rank !== null
        ? `#${Math.round(peerAverages.rank)}`
        : "n/a",
      assessment: context?.xrpscan
        ? (() => {
            const latestTx = toNumber(context.xrpscan.latest?.metric?.transaction_count);
            const avgTx = average((context.xrpscan.trailing || []).map((row) => row?.metric?.transaction_count));
            if (latestTx === null || avgTx === null) return "XRPL activity baseline is incomplete.";
            return latestTx >= avgTx
              ? "XRPL transaction activity is holding at or above its recent 30-day pace."
              : "XRPL transaction activity is below its recent 30-day pace.";
          })()
        : `Relative size sits ${market.market_cap_rank <= (peerAverages.rank || market.market_cap_rank) ? "above" : "below"} the nearby peer basket.`,
    },
  ];

  const projectName = details?.name || market.name || context?.ticker;
  const primaryCategory = details?.categories?.[0] || "large-cap crypto";
  const valuationAssessment = [
    `${projectName} trades as a crypto network asset rather than a cash-flow business, so the cleanest valuation anchors here are market cap, dilution, liquidity, and usage.`,
    `${formatUsd(marketCap)} of market cap and a ${fdvRatio !== null ? formatRatio(fdvRatio, 2) : "n/a"} FDV-to-market-cap ratio point to ${
      fdvRatio !== null && fdvRatio <= 1.15 ? "a relatively contained future supply overhang" : "some remaining dilution overhang"
    }.`,
    `${turnoverRatio !== null ? formatPercentRatio(turnoverRatio, 1) : "n/a"} of 24h turnover versus market cap suggests ${
      turnoverRatio !== null && turnoverRatio >= (peerAverages.volumeToMarketCap || 0) ? "healthy liquidity for position entry and exit" : "liquidity that is softer than the current peer basket"
    }, while the asset still sits ${athChange !== null ? `${Math.abs(athChange).toFixed(1)}% below its all-time high` : "away from its prior cycle high"}.`,
    `Treat the token as a ${primaryCategory} adoption and liquidity trade, not as a stock with earnings multiples.`,
  ].join(" ");

  const moatSignals = [];
  if (market.market_cap_rank && market.market_cap_rank <= 10) {
    moatSignals.push(`Large-cap network effect with market-cap rank #${market.market_cap_rank}.`);
  }
  if (turnoverRatio !== null && turnoverRatio >= 0.04) {
    moatSignals.push("Deep spot liquidity keeps access broad across exchanges and venues.");
  }
  if (context?.xrpscan) {
    moatSignals.push("XRPL settlement activity provides observable network usage beyond pure price action.");
  }
  if (communityFollowers && communityFollowers >= 100000) {
    moatSignals.push("Large community footprint supports distribution and staying power.");
  }
  if (developerStars && developerStars >= 500) {
    moatSignals.push("Visible open-source developer traction reinforces ecosystem durability.");
  }
  if (Array.isArray(details?.categories) && details.categories[0]) {
    moatSignals.push(`Positioned in ${details.categories[0]}, which gives it a clear role in the crypto market map.`);
  }
  if (moatSignals.length === 0) {
    moatSignals.push("Market position is currently driven more by liquidity and adoption than by a clearly dominant structural moat.");
  }

  let moatRating = "Moderate";
  if ((market.market_cap_rank || 99) <= 5 && moatSignals.length >= 4) moatRating = "Wide";
  else if ((market.market_cap_rank || 99) > 20 || moatSignals.length <= 2) moatRating = "Narrow";

  const scoreParts = [
    market.market_cap_rank <= 10 ? 24 : market.market_cap_rank <= 30 ? 18 : 12,
    turnoverRatio !== null ? (turnoverRatio >= 0.05 ? 18 : turnoverRatio >= 0.025 ? 14 : 10) : 12,
    fdvRatio !== null ? (fdvRatio <= 1.15 ? 18 : fdvRatio <= 1.5 ? 14 : 10) : 12,
    circulatingRatio !== null ? (circulatingRatio >= 0.7 ? 14 : circulatingRatio >= 0.45 ? 11 : 8) : 10,
    context?.xrpscan ? 14 : communityFollowers || developerStars ? 12 : 10,
  ];

  return {
    score: clampScore(scoreParts.reduce((sum, value) => sum + value, 0), 65),
    metrics,
    valuationAssessment,
    moat: {
      rating: moatRating,
      sources: moatSignals.slice(0, 5),
    },
  };
}

function mergeSourcedAnalysis(baseAnalysis, context) {
  const next = JSON.parse(JSON.stringify(baseAnalysis));
  const market = context?.coingecko?.market || null;
  const technical = buildTechnicalRead(context?.priceFeed?.candles, {
    ...(market || {}),
    categories: context?.coingecko?.details?.categories || [],
  });
  const fundamental = market ? buildFundamentalRead(context) : null;

  if (market || context?.coingecko?.details?.name) {
    next.company_name = safeText(context?.coingecko?.details?.name || market?.name, next.company_name);
  }
  next.date = formatDisplayDate();

  if (technical) {
    next.technical = {
      key_levels: technical.keyLevels,
      indicators: technical.indicators,
    };
    next.categories["Technical Strength"] = {
      ...(next.categories["Technical Strength"] || {}),
      score: technical.score,
      weight: SCORE_WEIGHT_LABELS.technical,
    };
  }

  if (fundamental) {
    next.fundamental = {
      metrics: fundamental.metrics,
      valuation_assessment:
        isPlaceholderText(next?.fundamental?.valuation_assessment) ? fundamental.valuationAssessment : next.fundamental.valuation_assessment,
      moat:
        !next?.fundamental?.moat ||
        isPlaceholderText(next?.fundamental?.moat?.sources?.[0]) ||
        isPlaceholderText(next?.fundamental?.moat?.rating)
          ? fundamental.moat
          : next.fundamental.moat,
    };
    next.categories["Fundamental Quality"] = {
      ...(next.categories["Fundamental Quality"] || {}),
      score: fundamental.score,
      weight: SCORE_WEIGHT_LABELS.fundamental,
    };
  }

  if (context?.fearGreed || context?.xSocial) {
    next.market_sentiment = {
      ...(next.market_sentiment || {}),
      fear_greed: context?.fearGreed || null,
      social_x: context?.xSocial || null,
    };
  }

  if (context?.coinmarketcap?.global || context?.coinmarketcap?.asset) {
    next.crypto_market_context = {
      ...(next.crypto_market_context || {}),
      global: context?.coinmarketcap?.global || null,
      asset: context?.coinmarketcap?.asset || null,
    };
  }

  if (COINGECKO_COIN_MAP[next.ticker]) {
    next.thesis = {
      ...(next.thesis || {}),
      catalysts: normalizeCatalysts(next?.thesis?.catalysts, { crypto: true, context, ticker: next.ticker }),
    };
  }

  const technicalScore = clampScore(next.categories?.["Technical Strength"]?.score, 65);
  const fundamentalScore = clampScore(next.categories?.["Fundamental Quality"]?.score, 65);
  const sentimentScore = clampScore(next.categories?.["Sentiment & Momentum"]?.score, 65);
  const riskScore = clampScore(next.categories?.["Risk Profile"]?.score, 65);
  const thesisScore = clampScore(next.categories?.["Thesis Conviction"]?.score, 65);
  const weighted =
    technicalScore * SCORE_WEIGHTS.technical +
    fundamentalScore * SCORE_WEIGHTS.fundamental +
    sentimentScore * SCORE_WEIGHTS.sentiment +
    riskScore * SCORE_WEIGHTS.risk +
    thesisScore * SCORE_WEIGHTS.thesis;
  next.overall_score = clampScore(weighted, next.overall_score || 0);
  return next;
}

async function buildMarketContext(ticker, job) {
  let priceFeed = null;
  try {
    priceFeed = await fetchBinanceCandles(`${ticker}USDT`, job);
  } catch (error) {
    appendJobLog(job, `Binance candles unavailable for ${ticker}: ${error.message}`);
  }

  let coingecko = null;
  try {
    coingecko = await fetchCoinGeckoMarketSnapshot(ticker, job);
  } catch (error) {
    appendJobLog(job, `CoinGecko market snapshot unavailable for ${ticker}: ${error.message}`);
  }

  if (!priceFeed) {
    try {
      priceFeed = await fetchCoinGeckoOhlc(coingecko?.market?.id || COINGECKO_COIN_MAP[ticker], job);
    } catch (error) {
      appendJobLog(job, `CoinGecko OHLC fallback unavailable for ${ticker}: ${error.message}`);
    }
  }

  let xrpscan = null;
  if (ticker === "XRP") {
    try {
      xrpscan = await fetchXrpscanMetrics(job);
    } catch (error) {
      appendJobLog(job, `XRPSCAN metrics unavailable: ${error.message}`);
    }
  }

  let fearGreed = null;
  try {
    fearGreed = await fetchFearGreedSentiment(job);
  } catch (error) {
    appendJobLog(job, `Fear & Greed context unavailable: ${error.message}`);
  }

  let coinmarketcap = null;
  try {
    coinmarketcap = await fetchCoinMarketCapContext(ticker, job);
  } catch (error) {
    appendJobLog(job, `CoinMarketCap context unavailable: ${error.message}`);
  }

  let xSocial = null;
  if (COINGECKO_COIN_MAP[ticker]) {
    try {
      xSocial = await fetchXSentimentContext(ticker, job);
    } catch (error) {
      appendJobLog(job, `X social context unavailable: ${error.message}`);
    }
  }

  appendJobLog(
    job,
    `Market sources ready for ${ticker}: price=${priceFeed?.source || "missing"}, fundamentals=${
      coingecko?.market?.id || "missing"
    }, xrpl=${xrpscan ? "ready" : "n/a"}, fear_greed=${fearGreed ? "ready" : "missing"}, cmc=${
      coinmarketcap?.global ? "ready" : "missing"
    }, x_social=${
      xSocial ? "ready" : "missing"
    }`
  );

  return {
    ticker,
    coingecko,
    priceFeed,
    xrpscan,
    fearGreed,
    coinmarketcap,
    xSocial,
  };
}

function buildPromptSnapshot(context) {
  const market = context?.coingecko?.market || null;
  if (!market && !context?.priceFeed?.candles?.length) return null;
  const technical = buildTechnicalRead(context?.priceFeed?.candles, {
    ...(market || {}),
    categories: context?.coingecko?.details?.categories || [],
  });
  const fundamental = market ? buildFundamentalRead(context) : null;
  return {
    asset: {
      ticker: context.ticker,
      name: context?.coingecko?.details?.name || market?.name || context.ticker,
      market_cap_rank: market?.market_cap_rank,
      price_usd: market?.current_price,
      market_cap_usd: market?.market_cap,
      fdv_usd: market?.fully_diluted_valuation,
      volume_24h_usd: market?.total_volume,
      change_24h_pct: market?.price_change_percentage_24h,
      change_7d_pct: market?.price_change_percentage_7d_in_currency,
      categories: context?.coingecko?.details?.categories || [],
      source_price_feed: context?.priceFeed?.source || "coingecko",
    },
    technical: technical
      ? {
          trend: technical.indicators[0]?.value,
          rsi14: technical.indicators[1]?.value,
          macd: technical.indicators[2]?.value,
          volume: technical.indicators[3]?.value,
          pattern: technical.indicators[4]?.value,
          support_1: technical.keyLevels[3]?.price,
          support_2: technical.keyLevels[4]?.price,
          resistance_1: technical.keyLevels[1]?.price,
          resistance_2: technical.keyLevels[0]?.price,
        }
      : null,
    fundamental: fundamental
      ? {
          metrics: fundamental.metrics,
          valuation_assessment: fundamental.valuationAssessment,
          moat: fundamental.moat,
        }
      : null,
    sentiment: context?.fearGreed || context?.xSocial
      ? {
          fear_greed: context.fearGreed || null,
          social_x: context.xSocial
            ? {
                post_count_24h: context.xSocial.postCount24h,
                post_count_prev_24h: context.xSocial.postCountPrev24h,
                post_count_7d: context.xSocial.postCount7d,
                intensity: context.xSocial.intensity,
                net_sentiment: context.xSocial.netSentiment,
                sentiment_breakdown: context.xSocial.sentimentBreakdown,
                volume_shift_pct_24h: context.xSocial.volumeShiftPct24h,
                top_narratives: context.xSocial.topNarratives.slice(0, 6),
                top_hashtags: context.xSocial.topHashtags.slice(0, 8),
                influencers: context.xSocial.influencers.slice(0, 5),
                example_posts: context.xSocial.samplePosts,
              }
            : null,
        }
      : null,
    market_context: context?.coinmarketcap?.global
      ? {
          total_market_cap_usd: context.coinmarketcap.global.totalMarketCap,
          total_volume_24h_usd: context.coinmarketcap.global.totalVolume24h,
          bitcoin_dominance_pct: context.coinmarketcap.global.bitcoinDominance,
          ethereum_dominance_pct: context.coinmarketcap.global.ethereumDominance,
          stablecoin_market_cap_usd: context.coinmarketcap.global.stablecoinMarketCap,
          defi_market_cap_usd: context.coinmarketcap.global.defiMarketCap,
        }
      : null,
    market_listing: context?.coinmarketcap?.asset
      ? {
          cmc_rank: context.coinmarketcap.asset.marketCapRank,
          price_usd: context.coinmarketcap.asset.price,
          market_cap_usd: context.coinmarketcap.asset.marketCap,
          volume_24h_usd: context.coinmarketcap.asset.volume24h,
          change_24h_pct: context.coinmarketcap.asset.percentChange24h,
          change_7d_pct: context.coinmarketcap.asset.percentChange7d,
          supply_circulating: context.coinmarketcap.asset.circulatingSupply,
          supply_total: context.coinmarketcap.asset.totalSupply,
          supply_max: context.coinmarketcap.asset.maxSupply,
          dominance_pct: context.coinmarketcap.asset.dominance,
        }
      : null,
    xrpl: context?.xrpscan
      ? {
          latest_transaction_count: context.xrpscan.latest?.metric?.transaction_count,
          trailing_30d_avg_transaction_count: average(
            (context.xrpscan.trailing || []).map((row) => row?.metric?.transaction_count)
          ),
        }
      : null,
  };
}

function hasSourcedTechnical(data) {
  const levels = data?.technical?.key_levels || [];
  const indicators = data?.technical?.indicators || [];
  const hasLevel = levels.some((item) => !isPlaceholderText(item?.price));
  const hasIndicator = indicators.some((item) => !isPlaceholderText(item?.value));
  return hasLevel && hasIndicator;
}

function hasSourcedFundamentals(data) {
  const metrics = data?.fundamental?.metrics || [];
  return metrics.some(
    (item) =>
      !isPlaceholderText(item?.value) &&
      !isPlaceholderText(item?.assessment)
  );
}

function normalizeKeyLevels(levels = []) {
  const defaults = [
    { level: "Resistance 2", price: "--", notes: "Major upside zone" },
    { level: "Resistance 1", price: "--", notes: "Near-term upside zone" },
    { level: "Current Price", price: "--", notes: "At analysis timestamp" },
    { level: "Support 1", price: "--", notes: "Near-term support zone" },
    { level: "Support 2", price: "--", notes: "Major support zone" },
  ];
  const out = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const src = levels[i] || {};
    const base = defaults[i];
    out.push({
      level: safeText(src.level, base.level),
      price: safeText(src.price, base.price),
      notes: safeText(src.notes, base.notes),
    });
  }
  return out;
}

function normalizeIndicators(indicators = []) {
  const defaults = [
    { indicator: "Trend Direction", value: "--", interpretation: "Trend read pending" },
    { indicator: "RSI (14)", value: "--", interpretation: "Momentum read pending" },
    { indicator: "MACD", value: "--", interpretation: "Signal read pending" },
    { indicator: "Volume", value: "--", interpretation: "Participation read pending" },
    { indicator: "Pattern", value: "--", interpretation: "Pattern read pending" },
    { indicator: "Market Context", value: "--", interpretation: "Macro read pending" },
  ];
  const out = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const src = indicators[i] || {};
    const base = defaults[i];
    out.push({
      indicator: safeText(src.indicator, base.indicator),
      value: safeText(src.value, base.value),
      interpretation: safeText(src.interpretation, base.interpretation),
    });
  }
  return out;
}

function normalizeMetrics(metrics = []) {
  const defaults = [
    { metric: "Market Profile", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
    { metric: "Valuation", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
    { metric: "Growth", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
    { metric: "Profitability", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
    { metric: "Balance Sheet", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
    { metric: "Liquidity", value: "--", sector_avg: "--", assessment: "Baseline unavailable" },
  ];
  const out = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const src = metrics[i] || {};
    const base = defaults[i];
    out.push({
      metric: safeText(src.metric, base.metric),
      value: safeText(src.value, base.value),
      sector_avg: safeText(src.sector_avg, base.sector_avg),
      assessment: safeText(src.assessment, base.assessment),
    });
  }
  return out;
}

function normalizeBulletList(items, fallback) {
  const arr = Array.isArray(items) ? items : [];
  const out = arr
    .map((item) => safeText(item, ""))
    .filter(Boolean)
    .slice(0, 5);
  if (out.length > 0) return out;
  return [fallback];
}

function isEquityStyleCatalyst(event) {
  const text = safeText(event, "").toLowerCase();
  if (!text) return true;
  return [
    "earnings",
    "analyst day",
    "guidance",
    "product launch",
    "dividend",
    "buyback",
    "shareholder",
    "quarter",
    "ceo",
  ].some((token) => text.includes(token));
}

function deriveCryptoCatalystDefaults(context = {}, ticker = "") {
  const upperTicker = safeText(ticker, "").toUpperCase();
  const xSocial = context?.xSocial || null;
  const fearGreed = context?.fearGreed || null;
  const narratives = Array.isArray(xSocial?.topNarratives) ? xSocial.topNarratives : [];
  const clarity = narratives.find((row) => /clarity act|market structure/i.test(safeText(row?.name)));
  const primary = narratives[0] || null;

  return [
    {
      event: clarity?.name || primary?.name || (
        upperTicker === "XRP"
          ? "Regulatory / Ripple ecosystem headlines"
          : upperTicker === "BTC"
            ? "ETF / treasury / institutional flow headlines"
            : upperTicker === "SOL"
              ? "Solana ecosystem / network headlines"
              : "Regulatory / ecosystem headlines"
      ),
      date: clarity ? "Live on X / next 7 days" : "Next 24-72 hours",
      impact: clarity ? "High" : "Medium to High",
    },
    {
      event: "Macro Data / Fed / liquidity signal",
      date: "Next 24-72 hours",
      impact: "High",
    },
    {
      event: fearGreed || xSocial ? "Sentiment and positioning shift" : "Liquidity / technical re-test",
      date: "Near term",
      impact: "Medium",
    },
  ];
}

function normalizeCatalysts(items = [], options = {}) {
  const defaults = options.crypto
    ? deriveCryptoCatalystDefaults(options.context, options.ticker)
    : [
        { event: "Earnings Window", date: "Next quarter", impact: "Medium" },
        { event: "Macro Update", date: "This month", impact: "Medium" },
        { event: "Technical Re-test", date: "Near term", impact: "Low" },
      ];
  const out = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const src = items[i] || {};
    const base = defaults[i];
    const useBase = options.crypto && (isEquityStyleCatalyst(src.event) || isPlaceholderText(src.event));
    out.push({
      event: useBase ? base.event : safeText(src.event, base.event),
      date: useBase ? base.date : safeText(src.date, base.date),
      impact: useBase ? base.impact : safeText(src.impact, base.impact),
    });
  }
  return out;
}

function normalizeScenarios(items = []) {
  const defaults = [
    { scenario: "Bull Case", probability: "30%", return: "+15% to +30%", trigger: "Execution beats expectations" },
    { scenario: "Base Case", probability: "45%", return: "+5% to +15%", trigger: "Company performs near consensus" },
    { scenario: "Bear Case", probability: "25%", return: "-10% to -20%", trigger: "Macro and execution headwinds" },
  ];
  const out = [];
  for (let i = 0; i < defaults.length; i += 1) {
    const src = items[i] || {};
    const base = defaults[i];
    out.push({
      scenario: safeText(src.scenario, base.scenario),
      probability: safeText(src.probability, base.probability),
      return: safeText(src.return, base.return),
      trigger: safeText(src.trigger, base.trigger),
    });
  }
  return out;
}

function pickCategoryScore(rawCategories, names, fallback) {
  for (const name of names) {
    const value = rawCategories?.[name]?.score ?? rawCategories?.[name];
    const n = Number(value);
    if (Number.isFinite(n)) return clampScore(n, fallback);
  }
  return fallback;
}

function normalizeAnalysisData(raw, ticker) {
  const T = normalizeTicker(ticker) || "TICKER";
  const isCrypto = Boolean(COINGECKO_COIN_MAP[T]);
  const categories = raw?.categories || {};

  const technicalScore = pickCategoryScore(categories, ["Technical Strength", "Technical"], 65);
  const fundamentalScore = pickCategoryScore(categories, ["Fundamental Quality", "Fundamental"], 65);
  const sentimentScore = pickCategoryScore(categories, ["Sentiment & Momentum", "Sentiment"], 65);
  const riskScore = pickCategoryScore(categories, ["Risk Profile", "Risk"], 65);
  const thesisScore = pickCategoryScore(categories, ["Thesis Conviction", "Thesis"], 65);

  const overallFromRaw = Number(raw?.overall_score);
  const weighted =
    technicalScore * SCORE_WEIGHTS.technical +
    fundamentalScore * SCORE_WEIGHTS.fundamental +
    sentimentScore * SCORE_WEIGHTS.sentiment +
    riskScore * SCORE_WEIGHTS.risk +
    thesisScore * SCORE_WEIGHTS.thesis;
  const overallScore = Number.isFinite(overallFromRaw) ? clampScore(overallFromRaw, 0) : clampScore(weighted, 0);

  return {
    ticker: T,
    company_name: safeText(raw?.company_name, T),
    date: safeText(raw?.date, formatDisplayDate()),
    overall_score: overallScore,
    categories: {
      "Technical Strength": { score: technicalScore, weight: SCORE_WEIGHT_LABELS.technical },
      "Fundamental Quality": { score: fundamentalScore, weight: SCORE_WEIGHT_LABELS.fundamental },
      "Sentiment & Momentum": { score: sentimentScore, weight: SCORE_WEIGHT_LABELS.sentiment },
      "Risk Profile": { score: riskScore, weight: SCORE_WEIGHT_LABELS.risk },
      "Thesis Conviction": { score: thesisScore, weight: SCORE_WEIGHT_LABELS.thesis },
    },
    technical: {
      key_levels: normalizeKeyLevels(raw?.technical?.key_levels),
      indicators: normalizeIndicators(raw?.technical?.indicators),
    },
    fundamental: {
      metrics: normalizeMetrics(raw?.fundamental?.metrics),
      valuation_assessment: safeText(
        raw?.fundamental?.valuation_assessment,
        "Valuation appears mixed versus peers. Treat this as an educational baseline pending deeper due diligence."
      ),
      moat: {
        rating: safeText(raw?.fundamental?.moat?.rating, "Moderate"),
        sources: normalizeBulletList(
          raw?.fundamental?.moat?.sources,
          "No dominant moat signal was confidently identified."
        ),
      },
    },
    thesis: {
      bull_case: normalizeBulletList(raw?.thesis?.bull_case, "Base upside case requires execution and favorable macro."),
      bear_case: normalizeBulletList(raw?.thesis?.bear_case, "Downside case centers on weak execution and macro stress."),
      catalysts: normalizeCatalysts(raw?.thesis?.catalysts, { crypto: isCrypto, ticker: T }),
      entry_exit: {
        entry_price: safeText(raw?.thesis?.entry_exit?.entry_price, "Set a staged entry near support"),
        target_price: safeText(raw?.thesis?.entry_exit?.target_price, "Target prior resistance levels"),
        stop_loss: safeText(raw?.thesis?.entry_exit?.stop_loss, "Use a defined invalidation level"),
        timeframe: safeText(raw?.thesis?.entry_exit?.timeframe, "3-6 months"),
      },
    },
    risk: {
      risk_reward_ratio: safeText(raw?.risk?.risk_reward_ratio, "2.0:1"),
      recommended_position_size: safeText(raw?.risk?.recommended_position_size, "2-5% of portfolio"),
      max_drawdown_scenario: safeText(raw?.risk?.max_drawdown_scenario, "Drawdown risk depends on market regime"),
      volatility: safeText(raw?.risk?.volatility, "Moderate"),
      correlation: safeText(raw?.risk?.correlation, "Correlated to broader market beta"),
      sizing_methodology: safeText(
        raw?.risk?.sizing_methodology,
        "Use fixed risk-per-trade and reduce size as volatility expands."
      ),
      scenarios: normalizeScenarios(raw?.risk?.scenarios),
    },
  };
}

function gradeForScore(score) {
  if (score >= 85) return "A+";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 40) return "C";
  return "D";
}

function signalForScore(score) {
  if (score >= 85) return "STRONG BUY";
  if (score >= 70) return "BUY";
  if (score >= 55) return "HOLD";
  if (score >= 40) return "CAUTION";
  return "AVOID";
}

function renderMarkdownFromAnalysis(data) {
  const c = data.categories || {};
  const grade = gradeForScore(Number(data.overall_score) || 0);
  const signal = signalForScore(Number(data.overall_score) || 0);
  const technical = data.technical || {};
  const fundamental = data.fundamental || {};
  const thesis = data.thesis || {};
  const risk = data.risk || {};
  const marketSentiment = data.market_sentiment || {};
  const fearGreed = marketSentiment.fear_greed || null;
  const xSocial = marketSentiment.social_x || null;
  const cryptoContext = data.crypto_market_context || {};
  const cryptoGlobal = cryptoContext.global || null;

  const lines = [
    `# Trade Analysis: ${data.ticker} - ${data.company_name}`,
    `> Generated by AI Trading Analyst | ${data.date}`,
    "",
    "---",
    "",
    "## Executive Summary",
    "",
    `${data.company_name} (${data.ticker}) is a model-generated educational trade brief.`,
    "Use this report as a research starting point, not as financial advice.",
    "",
    "---",
    "",
    "## Trade Score Dashboard",
    "",
    "| Dimension | Score | Weight | Weighted |",
    "|-----------|-------|--------|----------|",
    `| Technical Strength | ${c["Technical Strength"]?.score || 0}/100 | ${SCORE_WEIGHT_LABELS.technical} | ${((c["Technical Strength"]?.score || 0) * SCORE_WEIGHTS.technical).toFixed(2)} |`,
    `| Fundamental Quality | ${c["Fundamental Quality"]?.score || 0}/100 | ${SCORE_WEIGHT_LABELS.fundamental} | ${((c["Fundamental Quality"]?.score || 0) * SCORE_WEIGHTS.fundamental).toFixed(2)} |`,
    `| Sentiment & Momentum | ${c["Sentiment & Momentum"]?.score || 0}/100 | ${SCORE_WEIGHT_LABELS.sentiment} | ${((c["Sentiment & Momentum"]?.score || 0) * SCORE_WEIGHTS.sentiment).toFixed(2)} |`,
    `| Risk Profile | ${c["Risk Profile"]?.score || 0}/100 | ${SCORE_WEIGHT_LABELS.risk} | ${((c["Risk Profile"]?.score || 0) * SCORE_WEIGHTS.risk).toFixed(2)} |`,
    `| Thesis Conviction | ${c["Thesis Conviction"]?.score || 0}/100 | ${SCORE_WEIGHT_LABELS.thesis} | ${((c["Thesis Conviction"]?.score || 0) * SCORE_WEIGHTS.thesis).toFixed(2)} |`,
    `| **Composite Trade Score** | | | **${data.overall_score}/100** |`,
    "",
    `**Grade: ${grade}** | **Signal: ${signal}**`,
    "",
    "---",
    "",
    "## Technical Overview",
  ];

  for (const indicator of technical.indicators || []) {
    lines.push(`- **${indicator.indicator}**: ${indicator.value} - ${indicator.interpretation}`);
  }

  lines.push("", "## Fundamental Overview", "");
  lines.push(fundamental.valuation_assessment || "No valuation narrative was returned.");
  lines.push("", "### Moat");
  for (const source of fundamental.moat?.sources || []) lines.push(`- ${source}`);

  if (fearGreed || xSocial || cryptoGlobal) {
    lines.push("", "## Crypto Social Intelligence", "");
  }

  if (fearGreed) {
    lines.push("### Fear & Greed");
    lines.push(`- **Current Reading**: ${fearGreed.currentValue}/100 (${fearGreed.classification})`);
    lines.push(`- **Signal**: ${fearGreed.signal} | **Interpretation**: ${fearGreed.interpretation}`);
    lines.push(`- **Trend**: 7d ${fearGreed.trend7d}, 30d ${fearGreed.trend30d}, historical average ${fearGreed.historicalAverage ?? "--"}/100`);
    lines.push("");
  }

  if (xSocial) {
    lines.push("### X / Twitter Sentiment Snapshot");
    lines.push(`- **Net Sentiment**: ${xSocial.netSentiment}`);
    lines.push(`- **Intensity**: ${xSocial.intensity}`);
    lines.push(`- **24h Post Volume**: ${xSocial.postCount24h ?? "--"}`);
    lines.push(`- **24h Volume Shift**: ${xSocial.volumeShiftPct24h != null ? `${xSocial.volumeShiftPct24h.toFixed(2)}%` : "--"}`);
    lines.push("");
    lines.push("#### Top Narratives");
    for (const narrative of xSocial.topNarratives || []) {
      lines.push(`- **${narrative.name}**: ${narrative.matches} matches | stance ${narrative.stance} | engagement ${narrative.engagement}`);
    }
    lines.push("", "#### Common Hashtags");
    for (const tag of xSocial.topHashtags || []) {
      lines.push(`- ${tag.tag} (${tag.count})`);
    }
    lines.push("", "#### Influencer Watch");
    for (const row of xSocial.influencers || []) {
      lines.push(`- **${row.handle}**: ${row.stance} | mentions ${row.mentions} | engagement ${row.engagement}`);
    }
    lines.push("");
    if (xSocial.samplePosts?.bullish) {
      const sample = xSocial.samplePosts.bullish;
      lines.push(`> **Greed-leaning example:** ${sample.text}${sample.author?.handle ? ` — ${sample.author.handle}` : ""}`);
      lines.push("");
    }
    if (xSocial.samplePosts?.bearish) {
      const sample = xSocial.samplePosts.bearish;
      lines.push(`> **Fear-leaning example:** ${sample.text}${sample.author?.handle ? ` — ${sample.author.handle}` : ""}`);
      lines.push("");
    }
  }

  if (cryptoGlobal) {
    lines.push("### Broad Crypto Market Context");
    lines.push(`- **Total Market Cap**: ${cryptoGlobal.totalMarketCap ? `$${Number(cryptoGlobal.totalMarketCap).toLocaleString()}` : "--"}`);
    lines.push(`- **24h Volume**: ${cryptoGlobal.totalVolume24h ? `$${Number(cryptoGlobal.totalVolume24h).toLocaleString()}` : "--"}`);
    lines.push(`- **Bitcoin Dominance**: ${cryptoGlobal.bitcoinDominance != null ? `${Number(cryptoGlobal.bitcoinDominance).toFixed(2)}%` : "--"}`);
    lines.push(`- **Ethereum Dominance**: ${cryptoGlobal.ethereumDominance != null ? `${Number(cryptoGlobal.ethereumDominance).toFixed(2)}%` : "--"}`);
    lines.push("");
  }

  lines.push("", "## Investment Thesis", "", "### Bull Case");
  for (const item of thesis.bull_case || []) lines.push(`- ${item}`);
  lines.push("", "### Bear Case");
  for (const item of thesis.bear_case || []) lines.push(`- ${item}`);

  lines.push("", "### Catalysts");
  for (const cat of thesis.catalysts || []) lines.push(`- ${cat.event} (${cat.date}): ${cat.impact}`);

  lines.push(
    "",
    "## Entry / Exit Strategy",
    "",
    "| Parameter | Level |",
    "|-----------|-------|",
    `| Entry Zone | ${thesis.entry_exit?.entry_price || "--"} |`,
    `| Price Target | ${thesis.entry_exit?.target_price || "--"} |`,
    `| Stop Loss | ${thesis.entry_exit?.stop_loss || "--"} |`,
    `| Timeframe | ${thesis.entry_exit?.timeframe || "--"} |`,
    "",
    "## Risk Assessment",
    "",
    `- **Risk/Reward**: ${risk.risk_reward_ratio || "--"}`,
    `- **Position Size**: ${risk.recommended_position_size || "--"}`,
    `- **Drawdown Scenario**: ${risk.max_drawdown_scenario || "--"}`,
    `- **Volatility**: ${risk.volatility || "--"}`,
    `- **Correlation**: ${risk.correlation || "--"}`,
    "",
    "### Scenario Matrix"
  );

  for (const sc of risk.scenarios || []) {
    lines.push(`- **${sc.scenario}** (${sc.probability}): ${sc.return} | Trigger: ${sc.trigger}`);
  }

  lines.push(
    "",
    `> **DISCLAIMER:** This analysis is generated by an AI system for educational purposes only. It is NOT financial advice.`,
    ""
  );
  return lines.join("\n");
}

function writeAnalysisArtifacts(ticker, analysisData) {
  const canonical = buildCanonicalArtifactMap(ticker);
  const markdown = renderMarkdownFromAnalysis(analysisData);
  fs.writeFileSync(canonical.json.absPath, `${JSON.stringify(analysisData, null, 2)}\n`, "utf8");
  fs.writeFileSync(canonical.md.absPath, `${markdown}\n`, "utf8");
}

function resolveAnalysisEngine() {
  const requested = DEFAULT_ANALYSIS_ENGINE;
  if (requested === "xai") return "xai";
  if (requested === "claude") return "claude";
  if (process.env.XAI_API_KEY) return "xai";
  return "claude";
}

function xaiClientConfig() {
  return {
    apiKey: process.env.XAI_API_KEY || "",
    model: DEFAULT_XAI_MODEL,
    baseUrl: DEFAULT_XAI_BASE_URL,
  };
}

async function requestAnalysisFromXai(ticker, job) {
  const cfg = xaiClientConfig();
  if (!cfg.apiKey) {
    throw new Error("Missing XAI_API_KEY (or LOCAL_XAI_API_KEY) in environment.");
  }

  const marketContext = await buildMarketContext(ticker, job);
  const promptSnapshot = buildPromptSnapshot(marketContext);

  const systemPrompt = [
    "You are an institutional trade analysis engine.",
    "Return exactly one JSON object and no markdown fences.",
    "The JSON schema must include:",
    "ticker, company_name, date, overall_score, categories, technical, fundamental, thesis, risk.",
    "Use numeric scores 0-100 and concise factual fields.",
    "If the asset is crypto, use crypto-native language and do not invent stock metrics like P/E or EPS.",
    "If verified source data is provided, treat it as ground truth.",
    "Include educational disclaimer tone only; no financial advice language as recommendations.",
  ].join(" ");

  const userPrompt = [
    `Build a full analysis JSON for ticker ${ticker}.`,
    "Use this categories object shape exactly:",
    '{"Technical Strength":{"score":0,"weight":"30%"},"Fundamental Quality":{"score":0,"weight":"30%"},"Sentiment & Momentum":{"score":0,"weight":"20%"},"Risk Profile":{"score":0,"weight":"10%"},"Thesis Conviction":{"score":0,"weight":"10%"}}',
    "Use arrays with at least: technical.key_levels (5), technical.indicators (6), fundamental.metrics (6), thesis.bull_case (3), thesis.bear_case (3), thesis.catalysts (3), risk.scenarios (3).",
    `Set date to ${formatDisplayDate()}.`,
    promptSnapshot ? "Use this verified market snapshot as factual context:\n" + JSON.stringify(promptSnapshot, null, 2) : "",
    "Return JSON only.",
  ].join("\n");

  const endpoint = `${cfg.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  appendJobLog(job, `External engine: xAI model ${cfg.model}`);
  appendJobLog(job, `Calling ${endpoint}`);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 2600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.text();
  if (!response.ok) {
    const snippet = payload.slice(0, 400);
    throw new Error(`xAI API error ${response.status}: ${snippet}`);
  }

  let parsed = null;
  try {
    const json = JSON.parse(payload);
    const rawContent = json?.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("\n")
      : rawContent;
    parsed = extractFirstJsonObject(content);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    throw new Error("xAI response did not include parseable JSON analysis.");
  }
  const normalized = normalizeAnalysisData(parsed, ticker);
  const merged = mergeSourcedAnalysis(normalized, marketContext);

  if (!hasSourcedTechnical(merged)) {
    throw new Error(`Technical market data did not populate for ${ticker}. No PDF was generated to avoid placeholder analysis.`);
  }
  if (!hasSourcedFundamentals(merged)) {
    throw new Error(`Fundamental market data did not populate for ${ticker}. No PDF was generated to avoid placeholder analysis.`);
  }

  return merged;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildCanonicalArtifactMap(ticker) {
  return {
    md: {
      kind: "md",
      name: `TRADE-ANALYSIS-${ticker}.md`,
      absPath: path.join(TRADE_DIR, `TRADE-ANALYSIS-${ticker}.md`),
      publicPath: `/trade/TRADE-ANALYSIS-${ticker}.md`,
    },
    json: {
      kind: "json",
      name: `TRADE-ANALYSIS-${ticker}.json`,
      absPath: path.join(TRADE_DIR, `TRADE-ANALYSIS-${ticker}.json`),
      publicPath: `/trade/TRADE-ANALYSIS-${ticker}.json`,
    },
    pdf: {
      kind: "pdf",
      name: `TRADE-ANALYSIS-${ticker}.pdf`,
      absPath: path.join(TRADE_DIR, `TRADE-ANALYSIS-${ticker}.pdf`),
      publicPath: `/trade/TRADE-ANALYSIS-${ticker}.pdf`,
    },
  };
}

function withCacheBust(publicPath, mtimeMs) {
  if (!publicPath) return null;
  const stamp = Number.isFinite(mtimeMs) ? Math.floor(mtimeMs) : Date.now();
  const joiner = publicPath.includes("?") ? "&" : "?";
  return `${publicPath}${joiner}v=${stamp}`;
}

function publicRunFilePath(ticker, runId, fileName) {
  return `/runs/${ticker}/${runId}/${fileName}`;
}

function runDirFor(ticker, runId) {
  return path.join(RUNS_DIR, ticker, runId);
}

function runMetaPath(run) {
  return path.join(runDirFor(run.ticker, run.id), "run.json");
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    ticker: run.ticker,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt || null,
    error: run.error || null,
    files: run.files || {},
    meta: run.meta || null,
  };
}

function persistRun(run) {
  run.updatedAt = Date.now();
  ensureDir(runDirFor(run.ticker, run.id));
  writeJsonFile(runMetaPath(run), summarizeRun(run));
  return run;
}

function updateRun(run, patch) {
  Object.assign(run, patch);
  return persistRun(run);
}

function createRunRecord({ ticker, requestPath, requestMtimeMs }) {
  const run = {
    id: makeId(),
    ticker,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    error: null,
    request: {
      path: requestPath,
      mtimeMs: requestMtimeMs,
    },
    files: {},
    meta: null,
  };
  return persistRun(run);
}

function snapshotRunArtifacts(run, kinds) {
  const canonical = buildCanonicalArtifactMap(run.ticker);
  const nextFiles = { ...(run.files || {}) };
  const kindsToCopy = Array.isArray(kinds) && kinds.length ? kinds : ["md", "json", "pdf"];

  for (const kind of kindsToCopy) {
    const source = canonical[kind];
    if (!source) continue;
    const st = statSafe(source.absPath);
    if (!st) continue;
    if (run.request?.mtimeMs && st.mtimeMs < run.request.mtimeMs) continue;

    const targetDir = runDirFor(run.ticker, run.id);
    ensureDir(targetDir);
    const targetPath = path.join(targetDir, source.name);
    fs.copyFileSync(source.absPath, targetPath);
    const targetStat = fs.statSync(targetPath);
    nextFiles[kind] = {
      path: publicRunFilePath(run.ticker, run.id, source.name),
      previewPath: withCacheBust(publicRunFilePath(run.ticker, run.id, source.name), targetStat.mtimeMs),
      bytes: targetStat.size,
      mtimeMs: targetStat.mtimeMs,
      name: source.name,
    };
  }

  const nextRun = updateRun(run, { files: nextFiles });
  const jsonFile = nextRun.files?.json?.name
    ? path.join(runDirFor(nextRun.ticker, nextRun.id), nextRun.files.json.name)
    : null;
  const meta = jsonFile ? readJsonFile(jsonFile) : null;
  if (meta) return updateRun(nextRun, { meta });
  return nextRun;
}

function reportUpdatedAt(report) {
  const fileTimes = Object.values(report?.files || {}).map((file) => file?.mtimeMs || 0);
  return Math.max(report?.completedAt || 0, report?.createdAt || 0, 0, ...fileTimes);
}

function pickLatestReport(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return null;
  return [...reports].sort((a, b) => reportUpdatedAt(b) - reportUpdatedAt(a))[0] || null;
}

function reportFromRun(run) {
  if (!run) return null;
  const files = run.files || {};
  if (!files.md && !files.json && !files.pdf) return null;
  return {
    ticker: run.ticker,
    runId: run.id,
    source: "run",
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt || run.updatedAt,
    files,
    meta: run.meta || null,
  };
}

function listPersistedRuns(ticker = null) {
  ensureDir(RUNS_DIR);
  const tickerDirs = ticker ? [ticker] : (() => {
    try {
      return fs.readdirSync(RUNS_DIR);
    } catch {
      return [];
    }
  })();

  const runs = [];
  for (const tickerDir of tickerDirs) {
    const baseDir = path.join(RUNS_DIR, tickerDir);
    let runDirs = [];
    try {
      runDirs = fs.readdirSync(baseDir);
    } catch {
      continue;
    }

    for (const runId of runDirs) {
      const raw = readJsonFile(path.join(baseDir, runId, "run.json"));
      if (!raw) continue;
      runs.push(raw);
    }
  }

  runs.sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0));
  return runs;
}

function listRunAnalyses() {
  return listPersistedRuns()
    .filter((run) => run.status === "done")
    .map(reportFromRun)
    .filter(Boolean);
}

function listLegacyAnalyses() {
  let names = [];
  try {
    names = fs.readdirSync(TRADE_DIR);
  } catch {
    return [];
  }

  const tickers = new Set();
  for (const name of names) {
    const match = name.match(/^TRADE-ANALYSIS-([A-Z0-9]+)\.(md|json|pdf)$/i);
    if (match) tickers.add(match[1].toUpperCase());
  }

  const out = [];
  for (const ticker of Array.from(tickers).sort()) {
    const canonical = buildCanonicalArtifactMap(ticker);
    const item = {
      ticker,
      runId: null,
      source: "legacy",
      status: "done",
      files: {},
      meta: null,
    };

    for (const kind of ["md", "json", "pdf"]) {
      const file = canonical[kind];
      const st = statSafe(file.absPath);
      if (!st) continue;
      item.files[kind] = {
        path: file.publicPath,
        previewPath: withCacheBust(file.publicPath, st.mtimeMs),
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        name: file.name,
      };
    }

    if (item.files.json) {
      item.meta = readJsonFile(canonical.json.absPath);
    }

    if (Object.keys(item.files).length > 0) out.push(item);
  }

  return out;
}

function listTradeAnalyses() {
  const merged = new Map();
  const candidates = [...listLegacyAnalyses(), ...listRunAnalyses()];

  for (const report of candidates) {
    const current = merged.get(report.ticker);
    if (!current) {
      merged.set(report.ticker, report);
      continue;
    }
    merged.set(report.ticker, pickLatestReport([current, report]));
  }

  return Array.from(merged.values()).sort((a, b) => {
    const byTime = reportUpdatedAt(b) - reportUpdatedAt(a);
    if (byTime !== 0) return byTime;
    return a.ticker.localeCompare(b.ticker);
  });
}

function getLatestSavedAnalysis(ticker) {
  return pickLatestReport(listTradeAnalyses().filter((report) => report.ticker === ticker)) || null;
}

function makeCard(def, state, detail) {
  const chipByState = {
    waiting: "IDLE",
    queued: "AUTO",
    active: "LIVE",
    done: "DONE",
    error: "ERROR",
  };
  return {
    key: def.key,
    badge: def.badge,
    name: def.name,
    state,
    chip: chipByState[state] || "IDLE",
    summary: def[state] || def.waiting,
    detail: detail || def[state] || def.waiting,
  };
}

function buildAnalysisPipeline(jobLike) {
  const stage = jobLike?.stage || "request_ticket";
  const status = jobLike?.status || "queued";
  const cards = ANALYSIS_PIPELINE.map((def) => makeCard(def, "waiting", def.waiting));
  const byKey = new Map(cards.map((card) => [card.key, card]));

  const mark = (key, state, detail) => {
    const def = ANALYSIS_PIPELINE.find((item) => item.key === key);
    if (!def) return;
    byKey.set(key, makeCard(def, state, detail));
  };

  const markDone = (keys) => keys.forEach((key) => mark(key, "done"));
  const agentKeys = ANALYSIS_PIPELINE
    .filter((def) => def.key.startsWith("trade-"))
    .map((def) => def.key);

  if (status === "done") {
    ANALYSIS_PIPELINE.forEach((def) => mark(def.key, "done"));
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (status === "error") {
    if (stage === "control_tower" || stage === "request_ticket") {
      mark("request_ticket", "error");
    } else if (stage === "discovery") {
      markDone(["request_ticket"]);
      mark("discovery", "error");
    } else if (stage === "agent_swarm") {
      markDone(["request_ticket", "discovery"]);
      agentKeys.forEach((key) => mark(key, "error"));
    } else if (stage === "synthesis") {
      markDone(["request_ticket", "discovery", ...agentKeys]);
      mark("synthesis", "error");
    } else if (stage === "pdf_forge") {
      markDone(["request_ticket", "discovery", ...agentKeys, "synthesis"]);
      mark("pdf_forge", "error");
    } else {
      mark("request_ticket", "error");
    }
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (stage === "control_tower" || stage === "request_ticket") {
    mark("request_ticket", "active");
    mark("discovery", "queued");
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (stage === "discovery") {
    markDone(["request_ticket"]);
    mark("discovery", "active");
    agentKeys.forEach((key) => mark(key, "queued"));
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (stage === "agent_swarm") {
    markDone(["request_ticket", "discovery"]);
    agentKeys.forEach((key) => mark(key, "active"));
    mark("synthesis", "queued");
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (stage === "synthesis") {
    markDone(["request_ticket", "discovery", ...agentKeys]);
    mark("synthesis", "active");
    mark("pdf_forge", "queued");
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  if (stage === "pdf_forge") {
    markDone(["request_ticket", "discovery", ...agentKeys, "synthesis"]);
    mark("pdf_forge", "active");
    return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
  }

  return ANALYSIS_PIPELINE.map((def) => byKey.get(def.key));
}

function buildSavedPipeline(report) {
  if (!report) return buildAnalysisPipeline({ status: "queued", stage: "request_ticket" });
  if (report.files?.pdf) return buildAnalysisPipeline({ status: "done", stage: "done" });
  if (report.files?.json) return buildAnalysisPipeline({ status: "running", stage: "synthesis" });
  if (report.files?.md) return buildAnalysisPipeline({ status: "running", stage: "agent_swarm" });
  return buildAnalysisPipeline({ status: "queued", stage: "request_ticket" });
}

// ---- Job tracking (in-memory) ---------------------------------------------
const jobs = new Map();
const jobStreams = new Map();

function summarizeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    ticker: job.ticker,
    runId: job.runId || null,
    status: job.status,
    stage: job.stage || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    pipeline: job.pipeline || null,
    result: job.result || null,
    run: job.run || null,
  };
}

function newJob({ type, ticker, runId = null }) {
  const id = makeId();
  const now = Date.now();
  const job = {
    id,
    type,
    ticker: ticker.toUpperCase(),
    runId,
    status: "queued",
    stage: null,
    pipeline: type === "analysis-pipeline" ? buildAnalysisPipeline({ status: "queued" }) : null,
    log: [],
    createdAt: now,
    updatedAt: now,
    error: null,
    result: null,
    run: null,
  };
  jobs.set(id, job);
  return job;
}

function jobEvent(jobId, evt) {
  const subs = jobStreams.get(jobId);
  if (!subs || subs.size === 0) return;
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of subs) {
    try {
      res.write(data);
    } catch {}
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  if (job.type === "analysis-pipeline") {
    job.pipeline = buildAnalysisPipeline(job);
  }
  job.updatedAt = Date.now();
  jobs.set(job.id, job);
  jobEvent(job.id, { type: "job", job: summarizeJob(job) });
}

function appendJobLog(job, line) {
  job.log.push({ t: Date.now(), line: String(line) });
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  jobs.set(job.id, job);
  jobEvent(job.id, { type: "log", line: String(line) });
}

function getLatestJobForTicker(ticker) {
  const matches = Array.from(jobs.values())
    .filter((job) => job.ticker === ticker)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] || null;
}

function buildStep(filePath, label, requestStep) {
  const st = statSafe(filePath);
  const base = st
    ? { exists: true, bytes: st.size, mtimeMs: st.mtimeMs }
    : { exists: false };
  const fresh = !!(
    st &&
    requestStep?.exists &&
    Number.isFinite(requestStep.mtimeMs) &&
    st.mtimeMs >= requestStep.mtimeMs
  );
  return {
    label,
    ...base,
    fresh,
  };
}

function computeStatus(ticker) {
  const T = normalizeTicker(ticker);
  if (!T) throw new Error("invalid ticker");
  const reqFile = path.join(REQUESTS_DIR, `ANALYZE-${T}.txt`);
  const canonical = buildCanonicalArtifactMap(T);

  const requestStep = buildStep(reqFile, "Requested", null);
  const markdownStep = buildStep(canonical.md.absPath, "Markdown", requestStep);
  const jsonStep = buildStep(canonical.json.absPath, "JSON", requestStep);
  const pdfStep = buildStep(canonical.pdf.absPath, "PDF", requestStep);
  const latestSaved = getLatestSavedAnalysis(T);
  const activeJob = getLatestJobForTicker(T);

  return {
    ticker: T,
    steps: [
      { key: "requested", ...requestStep },
      { key: "markdown", ...markdownStep },
      { key: "json", ...jsonStep },
      { key: "pdf", ...pdfStep },
    ],
    files: {
      request: `/requests/ANALYZE-${T}.txt`,
      md: canonical.md.publicPath,
      json: canonical.json.publicPath,
      pdf: canonical.pdf.publicPath,
    },
    latestSaved,
    savedPipeline: buildSavedPipeline(latestSaved),
    activeJob: activeJob ? summarizeJob(activeJob) : null,
  };
}

function runPdfForJob(job, ticker, run = null) {
  const T = normalizeTicker(ticker);
  if (!T) {
    if (run) updateRun(run, { status: "error", error: "Invalid ticker" });
    updateJob(job, { status: "error", stage: "pdf_forge", error: "Invalid ticker" });
    return job;
  }

  const canonical = buildCanonicalArtifactMap(T);
  const inputJson = canonical.json.absPath;
  const outPdf = canonical.pdf.absPath;
  const script = path.join(SCRIPTS_DIR, "generate_trade_pdf.py");

  if (!statSafe(inputJson)) {
    const message = `Missing JSON: ${inputJson}`;
    if (run) updateRun(run, { status: "error", error: message });
    updateJob(job, { status: "error", stage: "pdf_forge", error: message, run: summarizeRun(run) });
    return job;
  }

  const python = DEFAULT_PYTHON;
  const args = [script, inputJson, outPdf];

  updateJob(job, { status: "running", stage: "pdf_forge", run: summarizeRun(run) });
  appendJobLog(job, `Running: ${python} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  const child = spawn(python, args, { cwd: ROOT, windowsHide: true });

  child.stdout.on("data", (data) => appendJobLog(job, data.toString("utf8").trimEnd()));
  child.stderr.on("data", (data) => appendJobLog(job, data.toString("utf8").trimEnd()));
  child.on("error", (err) => {
    if (run) run = updateRun(run, { status: "error", error: String(err) });
    updateJob(job, { status: "error", stage: "pdf_forge", error: String(err), run: summarizeRun(run) });
  });

  child.on("close", (code) => {
    if (code !== 0) {
      const message = `PDF generator exited with code ${code}`;
      if (run) run = updateRun(run, { status: "error", error: message });
      updateJob(job, { status: "error", stage: "pdf_forge", error: message, run: summarizeRun(run) });
      return;
    }

    let resultPath = canonical.pdf.publicPath;
    let resultPreviewPath = withCacheBust(canonical.pdf.publicPath, Date.now());
    let resultBytes = 0;
    let latestSaved = null;

    if (run) {
      run = snapshotRunArtifacts(run, ["md", "json", "pdf"]);
      run = updateRun(run, { status: "done", completedAt: Date.now(), error: null });
      latestSaved = reportFromRun(run);
    }

    if (latestSaved?.files?.pdf) {
      resultPath = latestSaved.files.pdf.path;
      resultPreviewPath = latestSaved.files.pdf.previewPath || withCacheBust(latestSaved.files.pdf.path, latestSaved.files.pdf.mtimeMs);
      resultBytes = latestSaved.files.pdf.bytes || 0;
    } else {
      const st = statSafe(outPdf);
      if (!st) {
        const message = "Generator succeeded but PDF not found.";
        if (run) run = updateRun(run, { status: "error", error: message });
        updateJob(job, { status: "error", stage: "pdf_forge", error: message, run: summarizeRun(run) });
        return;
      }
      resultBytes = st.size;
      resultPreviewPath = withCacheBust(resultPath, st.mtimeMs);
    }

    updateJob(job, {
      status: "done",
      stage: "done",
      result: {
        pdfBytes: resultBytes,
        pdfPath: resultPath,
        previewPath: resultPreviewPath,
      },
      latestSaved,
      run: summarizeRun(run),
    });
  });

  return job;
}

function runGeneratePdf({ ticker }) {
  const T = normalizeTicker(ticker);
  if (!T) {
    const job = newJob({ type: "generate-pdf", ticker: "INVALID" });
    updateJob(job, { status: "error", stage: "pdf_forge", error: "Invalid ticker" });
    return job;
  }

  const job = newJob({ type: "generate-pdf", ticker: T });
  updateJob(job, { status: "running", stage: "pdf_forge" });
  return runPdfForJob(job, T);
}

function writeAnalysisRequest({ ticker }) {
  const T = normalizeTicker(ticker);
  if (!T) throw new Error("invalid ticker");
  ensureDir(REQUESTS_DIR);
  const requestPath = path.join(REQUESTS_DIR, `ANALYZE-${T}.txt`);
  const stamp = new Date().toISOString();
  const body = [
    "# Analysis Request",
    `# Created: ${stamp}`,
    "",
    `/trade analyze ${T}`,
    "",
    "Notes:",
    '- This file is a local "intent" marker for the dashboard.',
    "- The actual analysis is produced by the agent workflow and saved into /trade.",
    "",
  ].join("\n");
  fs.writeFileSync(requestPath, body, "utf8");
  return { requestPath: `/requests/${path.basename(requestPath)}`, absolutePath: requestPath };
}

function runAnalysisWithClaude(job, run, ticker) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    `/trade analyze ${ticker}`,
  ];

  appendJobLog(job, `Running: claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  const child = spawn("claude", args, { cwd: ROOT, windowsHide: true });

  let swarmActivated = false;
  const activateSwarm = () => {
    if (swarmActivated || job.status !== "running") return;
    swarmActivated = true;
    updateJob(job, { status: "running", stage: "agent_swarm", run: summarizeRun(run) });
    appendJobLog(job, "Agent swarm live: technical, fundamental, sentiment, risk, and thesis are running automatically.");
  };

  const swarmTimer = setTimeout(activateSwarm, 1200);
  const onData = (data) => {
    const line = data.toString("utf8").trimEnd();
    if (!line) return;
    appendJobLog(job, line);
    activateSwarm();
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (err) => {
    clearTimeout(swarmTimer);
    const stage = swarmActivated ? "agent_swarm" : "discovery";
    run = updateRun(run, { status: "error", error: String(err) });
    updateJob(job, { status: "error", stage, error: String(err), run: summarizeRun(run) });
  });

  child.on("close", (code) => {
    clearTimeout(swarmTimer);
    if (code !== 0) {
      const stage = swarmActivated ? "agent_swarm" : "discovery";
      const message = `Analysis exited with code ${code}`;
      run = updateRun(run, { status: "error", error: message });
      updateJob(job, { status: "error", stage, error: message, run: summarizeRun(run) });
      return;
    }

    run = snapshotRunArtifacts(run, ["md", "json"]);
    if (!run.files?.json) {
      const message = `Analysis finished but no fresh JSON was produced for ${ticker}.`;
      run = updateRun(run, { status: "error", error: message });
      updateJob(job, { status: "error", stage: "synthesis", error: message, run: summarizeRun(run) });
      return;
    }

    updateJob(job, { status: "running", stage: "synthesis", run: summarizeRun(run) });
    appendJobLog(
      job,
      run.files?.md
        ? "Fresh markdown and JSON detected. Handing off to PDF Forge automatically."
        : "Fresh JSON detected. Handing off to PDF Forge automatically."
    );
    run = updateRun(run, { status: "analysis_complete", error: null });
    runPdfForJob(job, ticker, run);
  });
}

function runAnalysisWithXai(job, run, ticker) {
  (async () => {
    try {
      await sleep(350);
      updateJob(job, { status: "running", stage: "agent_swarm", run: summarizeRun(run) });
      appendJobLog(job, "Agent swarm live via external model orchestration.");

      const analysisData = await requestAnalysisFromXai(ticker, job);
      updateJob(job, { status: "running", stage: "synthesis", run: summarizeRun(run) });
      appendJobLog(job, "External analysis returned. Writing fresh markdown and JSON artifacts.");
      writeAnalysisArtifacts(ticker, analysisData);

      run = snapshotRunArtifacts(run, ["md", "json"]);
      if (!run.files?.json) {
        const message = `External engine finished but no fresh JSON was produced for ${ticker}.`;
        run = updateRun(run, { status: "error", error: message });
        updateJob(job, { status: "error", stage: "synthesis", error: message, run: summarizeRun(run) });
        return;
      }

      run = updateRun(run, { status: "analysis_complete", error: null });
      appendJobLog(job, "Fresh analysis artifacts ready. Handing off to PDF Forge automatically.");
      runPdfForJob(job, ticker, run);
    } catch (err) {
      const message = String(err);
      run = updateRun(run, { status: "error", error: message });
      updateJob(job, { status: "error", stage: job.stage || "agent_swarm", error: message, run: summarizeRun(run) });
    }
  })();
}

function runAnalysis({ ticker }) {
  const T = normalizeTicker(ticker);
  if (!T) {
    const job = newJob({ type: "analysis-pipeline", ticker: "INVALID" });
    updateJob(job, { status: "error", stage: "request_ticket", error: "Invalid ticker" });
    return job;
  }

  const requestInfo = writeAnalysisRequest({ ticker: T });
  const requestStat = fs.statSync(requestInfo.absolutePath);
  let run = createRunRecord({
    ticker: T,
    requestPath: requestInfo.requestPath,
    requestMtimeMs: requestStat.mtimeMs,
  });

  const job = newJob({ type: "analysis-pipeline", ticker: T, runId: run.id });
  updateJob(job, { status: "running", stage: "control_tower", run: summarizeRun(run) });
  appendJobLog(job, `Queued analysis request: ${requestInfo.requestPath}`);
  updateJob(job, { status: "running", stage: "discovery", run: summarizeRun(run) });
  appendJobLog(job, "Discovery phase live: gathering the shared market brief for all five analysis agents.");

  const engine = resolveAnalysisEngine();
  appendJobLog(job, `Analysis engine selected: ${engine}`);

  if (engine === "xai") {
    runAnalysisWithXai(job, run, T);
  } else {
    runAnalysisWithClaude(job, run, T);
  }

  return job;
}

// ---- Routing ---------------------------------------------------------------
function handleApi(req, res, parsed) {
  const pathname = parsed.pathname || "/";

  if (pathname === "/api/reports" && req.method === "GET") {
    return sendJson(res, 200, { reports: listTradeAnalyses() });
  }

  if (pathname === "/api/status" && req.method === "GET") {
    const ticker = normalizeTicker(parsed.query.ticker);
    if (!ticker) return sendJson(res, 400, { error: "invalid ticker" });
    return sendJson(res, 200, computeStatus(ticker));
  }

  if (pathname === "/api/request-analysis" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const ticker = normalizeTicker(body.ticker);
        if (!ticker) return sendJson(res, 400, { error: "invalid ticker" });
        const out = writeAnalysisRequest({ ticker });
        return sendJson(res, 200, { ok: true, requestPath: out.requestPath });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (pathname === "/api/run-analysis" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const ticker = normalizeTicker(body.ticker);
        if (!ticker) return sendJson(res, 400, { error: "invalid ticker" });
        const job = runAnalysis({ ticker });
        return sendJson(res, 200, {
          ok: true,
          jobId: job.id,
          job: summarizeJob(job),
          status: computeStatus(ticker),
        });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (pathname === "/api/generate-pdf" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        const ticker = normalizeTicker(body.ticker);
        if (!ticker) return sendJson(res, 400, { error: "invalid ticker" });
        const job = runGeneratePdf({ ticker });
        return sendJson(res, 200, { ok: true, jobId: job.id, job: summarizeJob(job) });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  if (pathname.startsWith("/api/jobs/") && pathname.endsWith("/events") && req.method === "GET") {
    const match = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (!match) return sendJson(res, 404, { error: "not found" });
    const jobId = match[1];
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: "unknown job" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "job", job: summarizeJob(job) })}\n\n`);
    for (const row of job.log) {
      res.write(`data: ${JSON.stringify({ type: "log", line: row.line })}\n\n`);
    }

    const set = jobStreams.get(jobId) || new Set();
    set.add(res);
    jobStreams.set(jobId, set);

    req.on("close", () => {
      const streamSet = jobStreams.get(jobId);
      if (streamSet) streamSet.delete(res);
    });
    return;
  }

  if (pathname.startsWith("/api/jobs/") && req.method === "GET") {
    const match = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (!match) return sendJson(res, 404, { error: "not found" });
    const jobId = match[1];
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: "unknown job" });
    return sendJson(res, 200, { job: summarizeJob(job) });
  }

  return sendJson(res, 404, { error: "not found" });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (pathname.startsWith("/api/")) return handleApi(req, res, parsed);

  if (pathname.startsWith("/trade/")) {
    const filePath = safeJoin(TRADE_DIR, pathname.slice("/trade/".length));
    if (!filePath) return sendText(res, 400, "Bad path");
    return serveStatic(res, filePath);
  }

  if (pathname.startsWith("/requests/")) {
    const filePath = safeJoin(REQUESTS_DIR, pathname.slice("/requests/".length));
    if (!filePath) return sendText(res, 400, "Bad path");
    return serveStatic(res, filePath);
  }

  if (pathname.startsWith("/runs/")) {
    const filePath = safeJoin(RUNS_DIR, pathname.slice("/runs/".length));
    if (!filePath) return sendText(res, 400, "Bad path");
    return serveStatic(res, filePath);
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic(res, path.join(UI_DIR, "index.html"));
  }

  const uiPath = safeJoin(UI_DIR, pathname);
  if (uiPath) {
    try {
      if (fs.statSync(uiPath).isFile()) return serveStatic(res, uiPath);
    } catch {}
  }

  return sendText(res, 404, "Not found");
}

function main() {
  ensureDir(TRADE_DIR);
  ensureDir(REQUESTS_DIR);
  ensureDir(RUNS_DIR);

  if (process.argv.includes("--check")) {
    const script = path.join(SCRIPTS_DIR, "generate_trade_pdf.py");
    const ok = fs.existsSync(script);
    const uiOk = fs.existsSync(path.join(UI_DIR, "index.html"));
    const tradeOk = fs.existsSync(TRADE_DIR);
    const runsOk = fs.existsSync(RUNS_DIR);
    const engineResolved = resolveAnalysisEngine();
    const status = {
      ok: ok && uiOk && tradeOk && runsOk,
      script: ok,
      ui: uiOk,
      tradeDir: tradeOk,
      runsDir: runsOk,
      python: DEFAULT_PYTHON,
      analysisEngine: engineResolved,
      xaiConfigured: !!process.env.XAI_API_KEY,
      xaiBaseUrl: DEFAULT_XAI_BASE_URL,
      xaiModel: DEFAULT_XAI_MODEL,
    };
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.ok ? 0 : 1);
  }

  const server = http.createServer(handler);
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    const engineResolved = resolveAnalysisEngine();
    console.log(`Trade dashboard: http://${DEFAULT_HOST}:${DEFAULT_PORT}/`);
    console.log(`Using MARKET_PYTHON=${DEFAULT_PYTHON}`);
    console.log(`Using analysis engine=${engineResolved}`);
    if (engineResolved === "xai") {
      console.log(`Using XAI_BASE_URL=${DEFAULT_XAI_BASE_URL}`);
      console.log(`Using XAI_MODEL=${DEFAULT_XAI_MODEL}`);
      console.log(`Using XAI_API_KEY=${process.env.XAI_API_KEY ? "configured" : "missing"}`);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildFundamentalRead,
  buildAnalysisPipeline,
  buildTechnicalRead,
  formatPercentRatio,
  formatRatio,
  hasSourcedFundamentals,
  hasSourcedTechnical,
  mergeSourcedAnalysis,
  normalizeTicker,
  pickLatestReport,
  safeJoin,
};
