/**
 * Purpose: Query X recent-search endpoints and summarize crypto social sentiment.
 */

const https = require("https");

function bearerToken() {
  return process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || "";
}

function isConfigured() {
  return Boolean(bearerToken());
}

function xGet(pathname, params = {}) {
  return new Promise((resolve, reject) => {
    const token = bearerToken();
    if (!token) {
      reject(new Error("X_BEARER_TOKEN environment variable not set."));
      return;
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      query.set(key, String(value));
    }

    const path = `${pathname}${query.toString() ? `?${query.toString()}` : ""}`;
    const req = https.request(
      {
        hostname: "api.x.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
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
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
              return;
            }
            reject(
              new Error(
                parsed?.errors?.[0]?.detail ||
                  parsed?.title ||
                  `X API request failed with status ${res.statusCode}`
              )
            );
          } catch (error) {
            reject(new Error(`Failed to parse X API response: ${error.message}`));
          }
        });
      }
    );

    req.on("error", (error) => {
      reject(new Error(`X API request failed: ${error.message}`));
    });

    req.end();
  });
}

function isoTime(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildTickerQuery(ticker) {
  const t = String(ticker || "").toUpperCase();
  const config = {
    BTC: ["BTC", "#BTC", "bitcoin", "#bitcoin", "\"spot bitcoin ETF\"", "\"bitcoin dominance\""],
    XRP: ["XRP", "#XRP", "ripple", "#ripple", "RLUSD", "\"Brad Garlinghouse\"", "\"SEC\""],
  };
  const terms = config[t] || [t, `#${t}`];
  return `(${terms.join(" OR ")}) lang:en -is:retweet`;
}

function getNarrativeBuckets(ticker) {
  const base = [
    { name: "ETF / Institutional Flows", stance: "bullish", patterns: [/etf/i, /institution/i, /blackrock/i, /inflow/i] },
    { name: "Macro / Fed / Dollar Risk", stance: "mixed", patterns: [/fed/i, /cpi/i, /rates/i, /dxy/i, /macro/i] },
    { name: "Whale / Exchange Flow", stance: "mixed", patterns: [/whale/i, /exchange/i, /inflow/i, /outflow/i, /distribution/i, /accumulation/i] },
    { name: "Breakout / Momentum Setup", stance: "bullish", patterns: [/breakout/i, /squeeze/i, /rally/i, /higher high/i, /bull flag/i] },
    { name: "Breakdown / Capitulation Risk", stance: "bearish", patterns: [/breakdown/i, /capitulation/i, /rejection/i, /sell-off/i, /liquidation/i] },
    { name: "Security / Hack / Exploit Risk", stance: "bearish", patterns: [/hack/i, /exploit/i, /breach/i, /drain/i] },
  ];
  if (String(ticker || "").toUpperCase() === "XRP") {
    base.push(
      { name: "SEC / Legal Case", stance: "mixed", patterns: [/sec/i, /lawsuit/i, /appeal/i, /court/i, /judge/i] },
      { name: "Ripple / Partnership Narrative", stance: "bullish", patterns: [/ripple/i, /partnership/i, /bank/i, /payment/i, /rlusd/i] }
    );
  }
  if (String(ticker || "").toUpperCase() === "BTC") {
    base.push(
      { name: "Store of Value / Treasury Narrative", stance: "bullish", patterns: [/treasury/i, /reserve/i, /store of value/i, /digital gold/i] },
      { name: "Miner / Hashrate Stress", stance: "mixed", patterns: [/miner/i, /hashrate/i, /difficulty/i] }
    );
  }
  return base;
}

function sentimentFromText(text) {
  const bullish = [
    /bullish/i, /breakout/i, /rally/i, /accumulation/i, /buy zone/i, /approval/i, /adoption/i, /partnership/i, /squeeze/i,
    /higher high/i, /support held/i, /inflow/i, /optimis/i, /confidence/i,
  ];
  const bearish = [
    /bearish/i, /dump/i, /crash/i, /sell-off/i, /distribution/i, /breakdown/i, /hack/i, /exploit/i, /lawsuit/i,
    /rejection/i, /outflow/i, /panic/i, /fear/i, /liquidation/i, /setback/i,
  ];
  let score = 0;
  for (const pattern of bullish) if (pattern.test(text)) score += 1;
  for (const pattern of bearish) if (pattern.test(text)) score -= 1;
  if (score > 0) return { label: "bullish", score };
  if (score < 0) return { label: "bearish", score };
  return { label: "neutral", score: 0 };
}

function extractHashtags(post) {
  const tags = Array.isArray(post?.entities?.hashtags) ? post.entities.hashtags.map((row) => row.tag) : [];
  return tags.map((tag) => `#${tag}`);
}

function postEngagement(post) {
  const metrics = post?.public_metrics || {};
  return (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0) + (metrics.quote_count || 0);
}

function computeVolumeShift(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function summarizePosts(ticker, payload, counts = {}) {
  const posts = Array.isArray(payload?.data) ? payload.data : [];
  const users = new Map((payload?.includes?.users || []).map((user) => [user.id, user]));
  const narratives = new Map();
  const hashtags = new Map();
  const influencerMap = new Map();
  const sentimentBreakdown = { bullish: 0, bearish: 0, neutral: 0 };

  for (const bucket of getNarrativeBuckets(ticker)) {
    narratives.set(bucket.name, { name: bucket.name, stance: bucket.stance, matches: 0, engagement: 0 });
  }

  const enriched = posts.map((post) => {
    const text = String(post?.text || "");
    const sentiment = sentimentFromText(text);
    sentimentBreakdown[sentiment.label] += 1;
    const engagement = postEngagement(post);

    for (const tag of extractHashtags(post)) {
      hashtags.set(tag, (hashtags.get(tag) || 0) + 1);
    }

    for (const bucket of getNarrativeBuckets(ticker)) {
      if (bucket.patterns.some((pattern) => pattern.test(text))) {
        const row = narratives.get(bucket.name);
        row.matches += 1;
        row.engagement += engagement;
      }
    }

    const user = users.get(post.author_id);
    if (user) {
      const key = user.username || user.name || post.author_id;
      const row = influencerMap.get(key) || {
        handle: user.username ? `@${user.username}` : user.name || key,
        verified: Boolean(user.verified),
        followers: user.public_metrics?.followers_count || 0,
        mentions: 0,
        engagement: 0,
        sentimentScore: 0,
      };
      row.mentions += 1;
      row.engagement += engagement;
      row.sentimentScore += sentiment.score;
      influencerMap.set(key, row);
    }

    return {
      id: post.id,
      text,
      createdAt: post.created_at || null,
      engagement,
      sentiment: sentiment.label,
      author: user
        ? {
            handle: user.username ? `@${user.username}` : user.name || "unknown",
            verified: Boolean(user.verified),
            followers: user.public_metrics?.followers_count || 0,
          }
        : null,
    };
  });

  const topNarratives = [...narratives.values()]
    .filter((row) => row.matches > 0)
    .sort((a, b) => b.matches - a.matches || b.engagement - a.engagement)
    .slice(0, 10);

  const topHashtags = [...hashtags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  const influencers = [...influencerMap.values()]
    .sort((a, b) => b.engagement - a.engagement || b.followers - a.followers)
    .slice(0, 8)
    .map((row) => ({
      handle: row.handle,
      verified: row.verified,
      followers: row.followers,
      mentions: row.mentions,
      engagement: row.engagement,
      stance:
        row.sentimentScore > 0 ? "bullish" : row.sentimentScore < 0 ? "bearish" : "mixed",
    }));

  const positiveExample =
    enriched
      .filter((row) => row.sentiment === "bullish")
      .sort((a, b) => b.engagement - a.engagement)[0] || null;
  const negativeExample =
    enriched
      .filter((row) => row.sentiment === "bearish")
      .sort((a, b) => b.engagement - a.engagement)[0] || null;

  const netSentiment =
    sentimentBreakdown.bullish > sentimentBreakdown.bearish * 1.1
      ? "positive"
      : sentimentBreakdown.bearish > sentimentBreakdown.bullish * 1.1
        ? "negative"
        : "neutral";

  const volumeShiftPct = computeVolumeShift(counts.last24h, counts.previous24h);

  return {
    source: "X Recent Search",
    ticker: String(ticker || "").toUpperCase(),
    query: buildTickerQuery(ticker),
    postCount24h: counts.last24h || posts.length,
    postCountPrev24h: counts.previous24h || null,
    postCount7d: counts.last7d || null,
    volumeShiftPct24h: volumeShiftPct,
    intensity:
      (counts.last24h || posts.length) >= 1500 ? "very_high" :
      (counts.last24h || posts.length) >= 500 ? "high" :
      (counts.last24h || posts.length) >= 150 ? "medium" : "low",
    netSentiment,
    sentimentBreakdown,
    topNarratives,
    topHashtags,
    influencers,
    samplePosts: {
      bullish: positiveExample,
      bearish: negativeExample,
    },
  };
}

async function searchRecentPosts(query, options = {}) {
  return xGet("/2/tweets/search/recent", {
    query,
    max_results: options.maxResults || 50,
    start_time: options.startTime,
    end_time: options.endTime,
    next_token: options.nextToken,
    expansions: "author_id",
    "tweet.fields": "created_at,public_metrics,author_id,entities,lang",
    "user.fields": "username,name,verified,public_metrics",
  });
}

async function countRecentPosts(query, options = {}) {
  const payload = await xGet("/2/tweets/counts/recent", {
    query,
    start_time: options.startTime,
    end_time: options.endTime,
    granularity: options.granularity || "hour",
  });
  return payload?.meta?.total_tweet_count || (Array.isArray(payload?.data) ? payload.data.reduce((sum, row) => sum + (row.tweet_count || 0), 0) : 0);
}

async function buildCryptoSentimentSnapshot(ticker) {
  // X recent-search can reject end_time values that are effectively "in the future"
  // relative to its own clock, so back off slightly from local wall time.
  const now = Date.now() - 2 * 60 * 1000;
  const last24hStart = isoTime(now - 24 * 60 * 60 * 1000);
  const prev24hStart = isoTime(now - 48 * 60 * 60 * 1000);
  const last7dStart = isoTime(now - (7 * 24 - 1) * 60 * 60 * 1000);
  const end = isoTime(now);
  const query = buildTickerQuery(ticker);

  const [postsResult, last24hResult, previous24hResult, last7dResult] = await Promise.allSettled([
    searchRecentPosts(query, { maxResults: 50, startTime: last24hStart, endTime: end }),
    countRecentPosts(query, { startTime: last24hStart, endTime: end, granularity: "hour" }),
    countRecentPosts(query, { startTime: prev24hStart, endTime: last24hStart, granularity: "hour" }),
    countRecentPosts(query, { startTime: last7dStart, endTime: end, granularity: "day" }),
  ]);

  if (postsResult.status !== "fulfilled") {
    throw postsResult.reason;
  }
  if (last24hResult.status !== "fulfilled") {
    throw last24hResult.reason;
  }
  if (previous24hResult.status !== "fulfilled") {
    throw previous24hResult.reason;
  }

  const posts = postsResult.value;
  const last24h = last24hResult.value;
  const previous24h = previous24hResult.value;
  const last7d = last7dResult.status === "fulfilled" ? last7dResult.value : null;

  return summarizePosts(ticker, posts, { last24h, previous24h, last7d });
}

module.exports = {
  isConfigured,
  buildTickerQuery,
  searchRecentPosts,
  countRecentPosts,
  buildCryptoSentimentSnapshot,
};
