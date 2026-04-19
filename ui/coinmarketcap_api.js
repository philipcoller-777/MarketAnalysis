/**
 * Purpose: Fetch and format CoinMarketCap free-tier market data for crypto analysis.
 */

const https = require("https");

function currentApiKey() {
  return process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";
}

function makeRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = currentApiKey();
    if (!apiKey) {
      reject(new Error("CMC_API_KEY environment variable not set."));
      return;
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      query.set(key, String(value));
    }

    const path = `/v1${endpoint}${query.toString() ? `?${query.toString()}` : ""}`;
    const req = https.request(
      {
        hostname: "pro-api.coinmarketcap.com",
        path,
        method: "GET",
        headers: {
          "X-CMC_PRO_API_KEY": apiKey,
          "User-Agent": "MarketAnalysis/1.0",
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.status?.error_code === 0) {
              resolve(parsed.data);
              return;
            }
            reject(new Error(parsed?.status?.error_message || `CMC request failed with status ${res.statusCode}`));
          } catch (error) {
            reject(new Error(`Failed to parse CMC response: ${error.message}`));
          }
        });
      }
    );

    req.on("error", (error) => {
      reject(new Error(`CMC request failed: ${error.message}`));
    });

    req.end();
  });
}

async function getTopCryptocurrencies(limit = 100, convert = "USD") {
  return makeRequest("/cryptocurrency/listings/latest", {
    limit,
    convert,
    sort: "market_cap",
    sort_dir: "desc",
  });
}

async function getCryptocurrencyData(ids, convert = "USD") {
  return makeRequest("/cryptocurrency/quotes/latest", {
    id: Array.isArray(ids) ? ids.join(",") : ids,
    convert,
  });
}

async function getGlobalMarketData(convert = "USD") {
  return makeRequest("/global-metrics/quotes/latest", { convert });
}

async function getCryptocurrencyMetadata(ids) {
  return makeRequest("/cryptocurrency/info", {
    id: Array.isArray(ids) ? ids.join(",") : ids,
  });
}

function formatForFundamentalAnalysis(cryptoData) {
  const out = {};
  for (const crypto of Object.values(cryptoData || {})) {
    out[crypto.symbol] = {
      name: crypto.name,
      symbol: crypto.symbol,
      marketCap: crypto.quote?.USD?.market_cap || null,
      marketCapRank: crypto.cmc_rank || null,
      price: crypto.quote?.USD?.price || null,
      volume24h: crypto.quote?.USD?.volume_24h || null,
      percentChange1h: crypto.quote?.USD?.percent_change_1h || null,
      percentChange24h: crypto.quote?.USD?.percent_change_24h || null,
      percentChange7d: crypto.quote?.USD?.percent_change_7d || null,
      percentChange30d: crypto.quote?.USD?.percent_change_30d || null,
      percentChange90d: crypto.quote?.USD?.percent_change_90d || null,
      percentChange1y: crypto.quote?.USD?.percent_change_1y || null,
      circulatingSupply: crypto.circulating_supply || null,
      totalSupply: crypto.total_supply || null,
      maxSupply: crypto.max_supply || null,
      fullyDilutedMarketCap: crypto.quote?.USD?.fully_diluted_market_cap || null,
      dominance: crypto.quote?.USD?.market_cap_dominance || null,
      tvl: crypto.quote?.USD?.tvl || null,
    };
  }
  return out;
}

function formatGlobalMarketData(globalData) {
  const usd = globalData?.quote?.USD || {};
  return {
    totalMarketCap: usd.total_market_cap || null,
    totalVolume24h: usd.total_volume_24h || null,
    bitcoinDominance: usd.btc_dominance || usd.bitcoin_dominance || null,
    ethereumDominance: usd.eth_dominance || usd.ethereum_dominance || null,
    altcoinMarketCap: usd.altcoin_market_cap || null,
    altcoinVolume24h: usd.altcoin_volume_24h || null,
    stablecoinMarketCap: usd.stablecoin_market_cap || null,
    stablecoinVolume24h: usd.stablecoin_volume_24h || null,
    defiMarketCap: usd.defi_market_cap || null,
    defiVolume24h: usd.defi_volume_24h || null,
    nftMarketCap: usd.nft_market_cap || null,
  };
}

async function getTop10Cryptocurrencies() {
  const rows = await getTopCryptocurrencies(10, "USD");
  return rows.map((crypto) => ({
    rank: crypto.cmc_rank,
    name: crypto.name,
    symbol: crypto.symbol,
    price: crypto.quote?.USD?.price || null,
    marketCap: crypto.quote?.USD?.market_cap || null,
    volume24h: crypto.quote?.USD?.volume_24h || null,
    percentChange24h: crypto.quote?.USD?.percent_change_24h || null,
    percentChange7d: crypto.quote?.USD?.percent_change_7d || null,
    percentChange30d: crypto.quote?.USD?.percent_change_30d || null,
    circulatingSupply: crypto.circulating_supply || null,
    totalSupply: crypto.total_supply || null,
    maxSupply: crypto.max_supply || null,
    dominance: crypto.quote?.USD?.market_cap_dominance || null,
  }));
}

module.exports = {
  makeRequest,
  getTopCryptocurrencies,
  getCryptocurrencyData,
  getGlobalMarketData,
  getCryptocurrencyMetadata,
  formatForFundamentalAnalysis,
  formatGlobalMarketData,
  getTop10Cryptocurrencies,
};
