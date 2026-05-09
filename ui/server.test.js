// Tests for dashboard server helpers and pipeline state selection.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildAnalysisPipeline,
  buildFundamentalRead,
  buildTechnicalRead,
  buildXaiDebateRequest,
  buildXaiAnalysisRequest,
  hasSourcedFundamentals,
  hasSourcedTechnical,
  mergeSourcedAnalysis,
  normalizeTicker,
  parseXaiStructuredResponse,
  pickLatestReport,
  applyResearchDebate,
  removeStaleLegacyFiles,
  renderMarkdownFromAnalysis,
  safeJoin,
  summarizeReportInsight,
  validateResearchDebate,
  validateStructuredAnalysis,
} = require("./server");

test("normalizeTicker accepts uppercase alphanumeric tickers", () => {
  assert.equal(normalizeTicker(" sol "), "SOL");
  assert.equal(normalizeTicker("BTC1"), "BTC1");
});

test("normalizeTicker rejects traversal and punctuation", () => {
  assert.equal(normalizeTicker("../sol"), null);
  assert.equal(normalizeTicker("SOL/USDT"), null);
  assert.equal(normalizeTicker("TOO-LONG-TICKER"), null);
});

test("safeJoin keeps paths inside the base directory", () => {
  const base = path.resolve("C:\\000 AGENTS\\MarketAnalysis\\trade");
  assert.equal(
    safeJoin(base, "TRADE-ANALYSIS-SOL.json"),
    path.resolve(base, "TRADE-ANALYSIS-SOL.json")
  );
});

test("safeJoin rejects parent traversal and sibling-prefix escapes", () => {
  const base = path.resolve("C:\\000 AGENTS\\MarketAnalysis\\trade");
  assert.equal(safeJoin(base, "..\\requests\\ANALYZE-SOL.txt"), null);
  assert.equal(safeJoin(base, "..\\trade2\\escape.txt"), null);
});

test("buildAnalysisPipeline marks all specialist agents live during the swarm", () => {
  const pipeline = buildAnalysisPipeline({ status: "running", stage: "agent_swarm" });
  const activeAgents = pipeline.filter((card) => card.key.startsWith("trade-") && card.state === "active");
  assert.equal(activeAgents.length, 5);
  assert.equal(pipeline.find((card) => card.key === "request_ticket")?.state, "done");
  assert.equal(pipeline.find((card) => card.key === "research_debate")?.state, "queued");
  assert.equal(pipeline.find((card) => card.key === "pdf_forge")?.state, "waiting");
});

test("buildAnalysisPipeline shows research debate as its own active stage", () => {
  const pipeline = buildAnalysisPipeline({ status: "running", stage: "research_debate" });
  assert.equal(pipeline.find((card) => card.key === "trade-thesis")?.state, "done");
  assert.equal(pipeline.find((card) => card.key === "research_debate")?.state, "active");
  assert.equal(pipeline.find((card) => card.key === "synthesis")?.state, "queued");
});

test("pickLatestReport prefers the newest saved report", () => {
  const older = {
    ticker: "SOL",
    files: {
      pdf: { mtimeMs: 100 },
    },
  };
  const newer = {
    ticker: "SOL",
    files: {
      pdf: { mtimeMs: 200 },
    },
  };
  assert.equal(pickLatestReport([older, newer]), newer);
});

test("removeStaleLegacyFiles drops an older canonical PDF from fresher analysis files", () => {
  const files = {
    md: { mtimeMs: 300, path: "/trade/TRADE-ANALYSIS-BTC.md" },
    json: { mtimeMs: 310, path: "/trade/TRADE-ANALYSIS-BTC.json" },
    pdf: { mtimeMs: 100, path: "/trade/TRADE-ANALYSIS-BTC.pdf" },
  };

  const pruned = removeStaleLegacyFiles(files);

  assert.equal(pruned.pdf, undefined);
  assert.equal(files.pdf.path, "/trade/TRADE-ANALYSIS-BTC.pdf");
});

test("removeStaleLegacyFiles keeps a PDF generated with the newest analysis files", () => {
  const files = {
    md: { mtimeMs: 300 },
    json: { mtimeMs: 310 },
    pdf: { mtimeMs: 320 },
  };

  const pruned = removeStaleLegacyFiles(files);

  assert.equal(pruned.pdf, files.pdf);
});

test("buildXaiAnalysisRequest uses Responses API with strict JSON schema", () => {
  const request = buildXaiAnalysisRequest({
    cfg: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3" },
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
  });

  assert.equal(request.endpoint, "https://api.x.ai/v1/responses");
  assert.equal(request.body.model, "grok-4.3");
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.name, "trade_analysis");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.required.includes("risk"), true);
  assert.deepEqual(request.body.input.map((msg) => msg.role), ["system", "user"]);
});

test("parseXaiStructuredResponse reads Responses API output text", () => {
  const payload = JSON.stringify({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              ticker: "BTC",
              company_name: "Bitcoin",
              date: "May 09, 2026",
              overall_score: 67,
              categories: {},
              technical: {},
              fundamental: {},
              thesis: {},
              risk: {},
            }),
          },
        ],
      },
    ],
  });

  const parsed = parseXaiStructuredResponse(payload);

  assert.equal(parsed.ticker, "BTC");
  assert.equal(parsed.company_name, "Bitcoin");
});

test("validateStructuredAnalysis rejects incomplete model output", () => {
  assert.throws(
    () => validateStructuredAnalysis({ ticker: "BTC", company_name: "Bitcoin" }),
    /missing required field: date/
  );
});

test("buildXaiDebateRequest uses a strict research debate schema", () => {
  const request = buildXaiDebateRequest({
    cfg: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3" },
    ticker: "BTC",
    analysis: { ticker: "BTC", overall_score: 67 },
    promptSnapshot: { asset: { ticker: "BTC" } },
  });

  assert.equal(request.endpoint, "https://api.x.ai/v1/responses");
  assert.equal(request.body.text.format.name, "research_debate");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.required.includes("research_manager"), true);
  assert.match(request.body.input[1].content, /Bull Analyst/i);
  assert.match(request.body.input[1].content, /Bear Analyst/i);
});

test("applyResearchDebate attaches verdict and can adjust the final score", () => {
  const analysis = {
    ticker: "BTC",
    overall_score: 67,
    categories: {
      "Thesis Conviction": { score: 60, weight: "10%" },
    },
  };
  const debate = validateResearchDebate({
    bull_argument: "Flows and technical structure support continuation.",
    bear_argument: "Macro liquidity and volatility can invalidate the setup.",
    research_manager: {
      verdict: "Bull case is stronger, but only modestly.",
      final_score: 72,
      final_signal: "BUY",
      confidence: "Medium",
      score_adjustments: [{ dimension: "Thesis Conviction", from: 60, to: 68, reason: "Debate improved conviction." }],
      key_watch_items: ["Confirm breakout volume"],
    },
  });

  const next = applyResearchDebate(analysis, debate);

  assert.equal(next.overall_score, 72);
  assert.equal(next.categories["Thesis Conviction"].score, 68);
  assert.equal(next.research_debate.research_manager.final_signal, "BUY");
});

test("renderMarkdownFromAnalysis includes the research debate section", () => {
  const markdown = renderMarkdownFromAnalysis({
    ticker: "BTC",
    company_name: "Bitcoin",
    date: "May 09, 2026",
    overall_score: 72,
    categories: {},
    technical: {},
    fundamental: {},
    thesis: {},
    risk: {},
    research_debate: {
      bull_argument: "Bull evidence.",
      bear_argument: "Bear evidence.",
      research_manager: {
        verdict: "Bull case wins narrowly.",
        final_signal: "BUY",
        confidence: "Medium",
        key_watch_items: ["Volume confirmation"],
      },
    },
  });

  assert.match(markdown, /## Research Debate/);
  assert.match(markdown, /Bull evidence/);
  assert.match(markdown, /Bull case wins narrowly/);
});

test("summarizeReportInsight exposes compact debate metadata", () => {
  const insight = summarizeReportInsight({
    overall_score: 72,
    research_debate: {
      bull_argument: "ETF flows and trend strength support continuation.",
      bear_argument: "Liquidity shocks could invalidate the setup.",
      research_manager: {
        verdict: "Bull case wins narrowly while risk remains elevated.",
        initial_score: 67,
        final_score: 72,
        final_signal: "BUY",
        confidence: "Medium",
        score_adjustments: [{ dimension: "Risk", from: 60, to: 64, reason: "Risk improved." }],
        key_watch_items: ["Confirm volume expansion", "Watch macro liquidity"],
      },
    },
  });

  assert.equal(insight.hasResearchDebate, true);
  assert.equal(insight.initialScore, 67);
  assert.equal(insight.finalScore, 72);
  assert.equal(insight.scoreDelta, 5);
  assert.equal(insight.finalSignal, "BUY");
  assert.equal(insight.confidence, "Medium");
  assert.equal(insight.watchItems.length, 2);
});

test("buildTechnicalRead derives real levels and indicators from candles", () => {
  const candles = Array.from({ length: 80 }, (_, index) => {
    const base = 0.45 + index * 0.01;
    return {
      openTime: index,
      open: base,
      high: base + 0.02 + (index % 5 === 0 ? 0.015 : 0),
      low: base - 0.018 - (index % 6 === 0 ? 0.008 : 0),
      close: base + (index % 3 === 0 ? 0.012 : 0.006),
      volume: 1_000_000 + index * 12_000,
    };
  });

  const read = buildTechnicalRead(candles, {
    market_cap_rank: 6,
    price_change_percentage_24h: 2.4,
    price_change_percentage_7d_in_currency: 8.1,
    categories: ["Payments"],
  });

  assert.ok(read);
  assert.equal(read.keyLevels.length, 5);
  assert.equal(read.indicators.length, 6);
  assert.notEqual(read.keyLevels[0].price, "--");
  assert.notEqual(read.indicators[1].value, "--");
  assert.ok(read.score >= 0 && read.score <= 100);
});

test("buildFundamentalRead creates crypto-native metrics from sourced data", () => {
  const read = buildFundamentalRead({
    coingecko: {
      market: {
        name: "XRP",
        market_cap_rank: 4,
        market_cap: 35_000_000_000,
        fully_diluted_valuation: 58_000_000_000,
        total_volume: 2_400_000_000,
        circulating_supply: 58_300_000_000,
        total_supply: 99_900_000_000,
        max_supply: 100_000_000_000,
        price_change_percentage_7d_in_currency: 6.2,
        ath_change_percentage: -72.4,
      },
      details: {
        name: "XRP",
        categories: ["Payments"],
        community_data: {
          twitter_followers: 1_200_000,
        },
        developer_data: {
          stars: 1_800,
        },
      },
      peers: [
        {
          market_cap: 28_000_000_000,
          fully_diluted_valuation: 40_000_000_000,
          total_volume: 1_400_000_000,
          circulating_supply: 40_000_000_000,
          max_supply: 60_000_000_000,
          price_change_percentage_7d_in_currency: 3.1,
          market_cap_rank: 7,
        },
        {
          market_cap: 22_000_000_000,
          fully_diluted_valuation: 31_000_000_000,
          total_volume: 900_000_000,
          circulating_supply: 32_000_000_000,
          max_supply: 50_000_000_000,
          price_change_percentage_7d_in_currency: 2.7,
          market_cap_rank: 9,
        },
      ],
    },
    xrpscan: {
      latest: { metric: { transaction_count: 1_350_000 } },
      trailing: [
        { metric: { transaction_count: 1_100_000 } },
        { metric: { transaction_count: 1_240_000 } },
      ],
    },
  });

  assert.ok(read);
  assert.equal(read.metrics.length, 6);
  assert.match(read.valuationAssessment, /crypto network asset/i);
  assert.ok(read.moat.sources.length >= 3);
  assert.ok(read.score >= 0 && read.score <= 100);
});

test("mergeSourcedAnalysis replaces placeholder crypto tables with sourced values", () => {
  const merged = mergeSourcedAnalysis(
    {
      ticker: "XRP",
      company_name: "Ripple",
      date: "April 18, 2026",
      overall_score: 65,
      categories: {
        "Technical Strength": { score: 60, weight: "25%" },
        "Fundamental Quality": { score: 60, weight: "25%" },
        "Sentiment & Momentum": { score: 70, weight: "20%" },
        "Risk Profile": { score: 55, weight: "15%" },
        "Thesis Conviction": { score: 65, weight: "15%" },
      },
      technical: {
        key_levels: [{ price: "--" }, { price: "--" }, { price: "--" }, { price: "--" }, { price: "--" }],
        indicators: [{ value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }],
      },
      fundamental: {
        metrics: [{ metric: "Market Profile", value: "--", sector_avg: "--", assessment: "Baseline unavailable" }],
        valuation_assessment: "Valuation appears mixed versus peers. Treat this as an educational baseline pending deeper due diligence.",
        moat: { rating: "Moderate", sources: ["No dominant moat signal was confidently identified."] },
      },
      thesis: {
        catalysts: [
          { event: "Earnings Window", date: "Next quarter", impact: "Medium" },
          { event: "Analyst Day", date: "This month", impact: "Medium" },
          { event: "Product Launch", date: "Near term", impact: "Low" },
        ],
      },
    },
    {
      ticker: "XRP",
      coingecko: {
        market: {
          name: "XRP",
          market_cap_rank: 4,
          market_cap: 35_000_000_000,
          fully_diluted_valuation: 58_000_000_000,
          total_volume: 2_400_000_000,
          circulating_supply: 58_300_000_000,
          total_supply: 99_900_000_000,
          max_supply: 100_000_000_000,
          price_change_percentage_24h: 2.4,
          price_change_percentage_7d_in_currency: 6.2,
          ath_change_percentage: -72.4,
        },
        details: {
          name: "XRP",
          categories: ["Payments"],
          community_data: { twitter_followers: 1_200_000 },
          developer_data: { stars: 1_800 },
        },
        peers: [
          {
            market_cap: 28_000_000_000,
            fully_diluted_valuation: 40_000_000_000,
            total_volume: 1_400_000_000,
            circulating_supply: 40_000_000_000,
            max_supply: 60_000_000_000,
            price_change_percentage_7d_in_currency: 3.1,
            market_cap_rank: 7,
          },
        ],
      },
      priceFeed: {
        candles: Array.from({ length: 80 }, (_, index) => {
          const base = 0.45 + index * 0.01;
          return {
            openTime: index,
            open: base,
            high: base + 0.02 + (index % 5 === 0 ? 0.015 : 0),
            low: base - 0.018 - (index % 6 === 0 ? 0.008 : 0),
            close: base + (index % 3 === 0 ? 0.012 : 0.006),
            volume: 1_000_000 + index * 12_000,
          };
        }),
      },
      xrpscan: {
        latest: { metric: { transaction_count: 1_350_000 } },
        trailing: [
          { metric: { transaction_count: 1_100_000 } },
          { metric: { transaction_count: 1_240_000 } },
        ],
      },
      xSocial: {
        topNarratives: [
          { name: "CLARITY Act / U.S. Market Structure", stance: "bullish", matches: 120, engagement: 5000 },
        ],
      },
    }
  );

  assert.equal(merged.company_name, "XRP");
  assert.notEqual(merged.technical.key_levels[0].price, "--");
  assert.notEqual(merged.fundamental.metrics[0].value, "--");
  assert.doesNotMatch(merged.fundamental.moat.sources[0], /no dominant moat signal/i);
  assert.equal(merged.market_sentiment.social_x.topNarratives[0].name, "CLARITY Act / U.S. Market Structure");
  assert.equal(merged.thesis.catalysts[0].event, "CLARITY Act / U.S. Market Structure");
  assert.doesNotMatch(merged.thesis.catalysts[1].event, /earnings|analyst day/i);
});

test("mergeSourcedAnalysis can still populate technicals when only price feed is available", () => {
  const merged = mergeSourcedAnalysis(
    {
      ticker: "XRP",
      company_name: "Ripple",
      date: "April 18, 2026",
      overall_score: 65,
      categories: {
        "Technical Strength": { score: 60, weight: "25%" },
        "Fundamental Quality": { score: 60, weight: "25%" },
        "Sentiment & Momentum": { score: 70, weight: "20%" },
        "Risk Profile": { score: 55, weight: "15%" },
        "Thesis Conviction": { score: 65, weight: "15%" },
      },
      technical: {
        key_levels: [{ price: "--" }, { price: "--" }, { price: "--" }, { price: "--" }, { price: "--" }],
        indicators: [{ value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }, { value: "--" }],
      },
      fundamental: {
        metrics: [{ metric: "Market Profile", value: "--", sector_avg: "--", assessment: "Baseline unavailable" }],
        valuation_assessment: "Valuation appears mixed versus peers. Treat this as an educational baseline pending deeper due diligence.",
        moat: { rating: "Moderate", sources: ["No dominant moat signal was confidently identified."] },
      },
    },
    {
      ticker: "XRP",
      priceFeed: {
        candles: Array.from({ length: 80 }, (_, index) => {
          const base = 0.45 + index * 0.01;
          return {
            openTime: index,
            open: base,
            high: base + 0.02 + (index % 5 === 0 ? 0.015 : 0),
            low: base - 0.018 - (index % 6 === 0 ? 0.008 : 0),
            close: base + (index % 3 === 0 ? 0.012 : 0.006),
            volume: 1_000_000 + index * 12_000,
          };
        }),
      },
      coingecko: null,
    }
  );

  assert.equal(hasSourcedTechnical(merged), true);
  assert.equal(hasSourcedFundamentals(merged), false);
});
