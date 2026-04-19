/**
 * Purpose: Validate the repo's crypto sentiment modules against live APIs when configured.
 */

const fs = require("fs");
const path = require("path");
const fearGreedModule = require("./ui/fear_greed_index");
const cmcModule = require("./ui/coinmarketcap_api");
const xModule = require("./ui/x_api");

function loadEnvFile(filePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const TOP_10_CRYPTOS = [
  { id: 1, symbol: "BTC", name: "Bitcoin" },
  { id: 1027, symbol: "ETH", name: "Ethereum" },
  { id: 52, symbol: "XRP", name: "XRP" },
  { id: 5426, symbol: "SOL", name: "Solana" },
  { id: 5805, symbol: "AVAX", name: "Avalanche" },
  { id: 1975, symbol: "LINK", name: "Chainlink" },
  { id: 512, symbol: "XLM", name: "Stellar" },
  { id: 3408, symbol: "USDC", name: "USD Coin" },
  { id: 2010, symbol: "ADA", name: "Cardano" },
  { id: 8916, symbol: "ICP", name: "Internet Computer" },
];

const hasCmcKey = Boolean(process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY);
const hasXBearer = Boolean(process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN);

async function runTest(name, fn, { optional = false } = {}) {
  console.log(`\n=== ${name} ===`);
  try {
    if (optional && !hasCmcKey) {
      console.log("- Skipped: CoinMarketCap API key is not configured in this shell.");
      return "skipped";
    }
    await fn();
    console.log("OK");
    return "passed";
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return "failed";
  }
}

async function testFearGreedIndex() {
  const result = await fearGreedModule.getFearGreedIndex();
  console.log(`Value: ${result.value}/100`);
  console.log(`Classification: ${result.classification}`);
  console.log(`Timestamp: ${new Date(result.timestamp * 1000).toISOString()}`);
  const interpretation = fearGreedModule.interpretFearGreedValue(result.value);
  console.log(`Signal: ${interpretation.signal} (${interpretation.sentiment})`);
}

async function testFearGreedHistory() {
  const history = await fearGreedModule.getFearGreedHistory(30);
  const average = Math.round(history.reduce((sum, row) => sum + row.value, 0) / history.length);
  console.log(`Rows: ${history.length}`);
  console.log(`Newest: ${history[0].value}/100`);
  console.log(`Oldest: ${history[history.length - 1].value}/100`);
  console.log(`30d average: ${average}/100`);
}

async function testFearGreedFormatting() {
  const current = await fearGreedModule.getFearGreedIndex();
  const history = await fearGreedModule.getFearGreedHistory(30);
  const formatted = fearGreedModule.formatForSentimentReport(current, history);
  console.log(JSON.stringify(formatted, null, 2));
}

async function testTop10Cryptocurrencies() {
  const top10 = await cmcModule.getTop10Cryptocurrencies();
  console.log(`Rows: ${top10.length}`);
  for (const row of top10.slice(0, 5)) {
    console.log(`${row.rank}. ${row.symbol} ${row.name} $${row.price?.toFixed(2)}`);
  }
}

async function testSpecificCryptocurrencyData() {
  const ids = TOP_10_CRYPTOS.slice(0, 3).map((coin) => coin.id).join(",");
  const data = await cmcModule.getCryptocurrencyData(ids);
  for (const crypto of Object.values(data)) {
    console.log(`${crypto.symbol}: $${crypto.quote?.USD?.price?.toFixed(2)} market cap rank #${crypto.cmc_rank}`);
  }
}

async function testGlobalMarketData() {
  const globalData = await cmcModule.getGlobalMarketData();
  const formatted = cmcModule.formatGlobalMarketData(globalData);
  console.log(`Total market cap: ${formatted.totalMarketCap}`);
  console.log(`BTC dominance: ${formatted.bitcoinDominance}`);
  console.log(`ETH dominance: ${formatted.ethereumDominance}`);
}

async function testFundamentalFormatting() {
  const ids = TOP_10_CRYPTOS.slice(0, 2).map((coin) => coin.id).join(",");
  const data = await cmcModule.getCryptocurrencyData(ids);
  const formatted = cmcModule.formatForFundamentalAnalysis(data);
  console.log(JSON.stringify(formatted, null, 2));
}

async function testComprehensiveSentimentAnalysis() {
  const fearGreed = await fearGreedModule.getFearGreedIndex();
  const history = await fearGreedModule.getFearGreedHistory(30);
  const sentiment = fearGreedModule.formatForSentimentReport(fearGreed, history);
  const btcData = await cmcModule.getCryptocurrencyData(String(TOP_10_CRYPTOS[0].id));
  const btc = btcData[TOP_10_CRYPTOS[0].id];
  console.log(`Fear & Greed: ${sentiment.currentValue}/100 (${sentiment.classification})`);
  console.log(`BTC price: $${btc.quote?.USD?.price?.toFixed(2)}`);
  console.log(`BTC 24h: ${btc.quote?.USD?.percent_change_24h?.toFixed(2)}%`);
}

async function testXSocialSentiment() {
  const snapshot = await xModule.buildCryptoSentimentSnapshot("BTC");
  console.log(`Net sentiment: ${snapshot.netSentiment}`);
  console.log(`24h posts: ${snapshot.postCount24h}`);
  console.log(`Volume shift 24h: ${snapshot.volumeShiftPct24h}`);
  console.log(`Top narrative: ${snapshot.topNarratives[0]?.name || "n/a"}`);
}

async function main() {
  console.log("Crypto Sentiment Integration Test Suite");
  console.log(`CoinMarketCap configured: ${hasCmcKey ? "yes" : "no"}`);

  const results = [];
  results.push(await runTest("TEST 1: Fear & Greed Index", testFearGreedIndex));
  results.push(await runTest("TEST 2: Fear & Greed History", testFearGreedHistory));
  results.push(await runTest("TEST 3: Fear & Greed Report Formatting", testFearGreedFormatting));
  results.push(await runTest("TEST 4: Top 10 Cryptocurrencies", testTop10Cryptocurrencies, { optional: true }));
  results.push(await runTest("TEST 5: Specific Cryptocurrency Data", testSpecificCryptocurrencyData, { optional: true }));
  results.push(await runTest("TEST 6: Global Market Data", testGlobalMarketData, { optional: true }));
  results.push(await runTest("TEST 7: Fundamental Formatting", testFundamentalFormatting, { optional: true }));
  results.push(await runTest("TEST 8: Comprehensive Sentiment Analysis", testComprehensiveSentimentAnalysis, { optional: true }));
  results.push(
    await runTest(
      "TEST 9: X Social Sentiment Snapshot",
      testXSocialSentiment,
      { optional: !hasXBearer }
    )
  );

  const passed = results.filter((value) => value === "passed").length;
  const skipped = results.filter((value) => value === "skipped").length;
  const failed = results.filter((value) => value === "failed").length;

  console.log("\n=== TEST SUMMARY ===");
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
