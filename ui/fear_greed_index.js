/**
 * Purpose: Fetch and format the Alternative.me crypto Fear & Greed index.
 */

const https = require("https");

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.alternative.me",
        path: pathname,
        method: "GET",
        headers: {
          "User-Agent": "MarketAnalysis/1.0",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`Failed to parse Fear & Greed response: ${error.message}`));
          }
        });
      }
    );

    req.on("error", (error) => {
      reject(new Error(`Fear & Greed request failed: ${error.message}`));
    });

    req.end();
  });
}

async function getFearGreedIndex() {
  const payload = await requestJson("/fng/?limit=1&format=json");
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!row) {
    throw new Error("No Fear & Greed data returned.");
  }
  return {
    value: Number.parseInt(row.value, 10),
    classification: row.value_classification || "Unknown",
    timestamp: Number.parseInt(row.timestamp, 10),
    timeUntilUpdate: Number.parseInt(row.time_until_update || "0", 10),
  };
}

async function getFearGreedHistory(limit = 30) {
  const payload = await requestJson(`/fng/?limit=${encodeURIComponent(String(limit))}&format=json`);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (rows.length === 0) {
    throw new Error("No Fear & Greed history returned.");
  }
  return rows.map((row) => ({
    value: Number.parseInt(row.value, 10),
    classification: row.value_classification || "Unknown",
    timestamp: Number.parseInt(row.timestamp, 10),
  }));
}

function interpretFearGreedValue(value) {
  const score = Number.isFinite(Number(value)) ? Number(value) : 50;
  if (score <= 20) {
    return {
      sentiment: "extreme_fear",
      signal: "BUY",
      strength: 0.9,
      value: score,
      interpretation: `Market is in extreme fear (${score}/100)`,
    };
  }
  if (score <= 40) {
    return {
      sentiment: "fear",
      signal: "BUY",
      strength: 0.6,
      value: score,
      interpretation: `Market is in fear (${score}/100)`,
    };
  }
  if (score <= 50) {
    return {
      sentiment: "neutral_lean_fear",
      signal: "HOLD",
      strength: 0.3,
      value: score,
      interpretation: `Market is slightly cautious (${score}/100)`,
    };
  }
  if (score <= 60) {
    return {
      sentiment: "neutral_lean_greed",
      signal: "HOLD",
      strength: 0.3,
      value: score,
      interpretation: `Market is slightly optimistic (${score}/100)`,
    };
  }
  if (score <= 80) {
    return {
      sentiment: "greed",
      signal: "SELL",
      strength: 0.6,
      value: score,
      interpretation: `Market is in greed (${score}/100)`,
    };
  }
  return {
    sentiment: "extreme_greed",
    signal: "SELL",
    strength: 0.9,
    value: score,
    interpretation: `Market is in extreme greed (${score}/100)`,
  };
}

function formatForSentimentReport(currentData, historyData = []) {
  const current = currentData || {};
  const history = Array.isArray(historyData) ? historyData : [];
  const interpretation = interpretFearGreedValue(current.value);

  let trend7d = "stable";
  let trend30d = "stable";

  if (history.length >= 7) {
    const newest = history[0]?.value;
    const oldest = history[6]?.value;
    if (newest >= oldest + 5) trend7d = "increasing";
    else if (newest <= oldest - 5) trend7d = "decreasing";
  }

  if (history.length >= 30) {
    const newest = history[0]?.value;
    const oldest = history[29]?.value;
    if (newest >= oldest + 10) trend30d = "increasing";
    else if (newest <= oldest - 10) trend30d = "decreasing";
  }

  const historicalAverage =
    history.length > 0
      ? Math.round(history.reduce((sum, row) => sum + (Number(row.value) || 0), 0) / history.length)
      : null;

  return {
    source: "Alternative.me Crypto Fear & Greed Index",
    currentValue: Number(current.value) || 0,
    classification: current.classification || "Unknown",
    timestamp: current.timestamp ? new Date(current.timestamp * 1000).toISOString() : null,
    sentiment: interpretation.sentiment,
    signal: interpretation.signal,
    signalStrength: interpretation.strength,
    interpretation: interpretation.interpretation,
    trend7d,
    trend30d,
    historicalAverage,
    extremeReading: (Number(current.value) || 0) <= 25 || (Number(current.value) || 0) >= 75,
  };
}

module.exports = {
  getFearGreedIndex,
  getFearGreedHistory,
  interpretFearGreedValue,
  formatForSentimentReport,
};
