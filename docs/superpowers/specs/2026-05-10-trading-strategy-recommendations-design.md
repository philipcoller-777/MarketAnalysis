# Trading Strategy Recommendations Design

## Context

MarketAnalysis already has a local Node dashboard with an Analysis page, a Trading page, saved report history, a TradingView chart, setup quality, trader/risk committee output, paper-only execution plans, and Alpaca paper-order guardrails. The next phase adds strategy recommendations inside this existing flow, using ideas adapted from the referenced Vibe-Trading repository without porting its full Python backtesting system.

This feature remains educational and paper-only. It recommends directional setups and order levels for review; it does not automate live trading.

## Goals

- Add a strategy mode selector to the Trading dashboard: Swing, Intraday, and Scalping.
- Show a timeframe-by-timeframe trend bias summary for the selected mode.
- List available strategy families adapted from Vibe-Trading concepts.
- Produce one recommended entry setup on the lowest timeframe for the selected mode.
- Keep the recommendation tied to saved agent analysis, current risk committee context, and paper-order guardrails.
- Support bidirectional trading logic so the dashboard can identify long-only, short-only, mixed, or no-trade conditions.

## Non-Goals

- Do not port the full Vibe-Trading FastAPI/Python app.
- Do not add a historical backtest engine in this phase.
- Do not submit broker orders automatically.
- Do not add live equity minute bars unless an existing configured data source can provide them safely.
- Do not treat missing lower-timeframe data as a valid signal.

## Strategy Modes

| Mode | Bias Timeframes | Entry Timeframe | Intended Holding Window |
| --- | --- | --- | --- |
| Swing | 1W, 1D, 4H, 2H | 2H | 3-5 days |
| Intraday | 1D, 4H, 15m, 5m | 15m or 5m | Asia open to NY close |
| Scalping | 30m, 15m, 5m, 2m | 5m or 2m | Short-term scalp |

The mode selector is rendered at the top of `/trading`, near the ticker controls. The selected mode persists in `localStorage`.

## Vibe-Trading Concepts To Adapt

- `technical-basic`: trend, mean-reversion, and volume voting using moving averages, RSI, MACD/ADX-style momentum, Bollinger context, and OBV/volume confirmation.
- `candlestick`: pattern recognition for engulfing, hammer, shooting star, morning star, evening star, and other classic entry triggers.
- `ichimoku`: optional trend confirmation from Tenkan/Kijun and cloud position where enough candles are available.
- `minute-analysis`: explicit intraday timeframe support and practical limits for minute-level data.
- `execution-model`: slippage awareness, limit-order preference, conservative cost assumptions, and risk caps.

SMC-style structure, fair value gaps, and order-block detection are useful later, but they are intentionally excluded from the first implementation because they require more careful data and validation.

## Data Model

Server-side recommendations are returned by a new endpoint:

`GET /api/strategy-recommendations?ticker=<TICKER>&mode=<swing|intraday|scalping>`

Response shape:

```json
{
  "ticker": "BTC",
  "mode": "intraday",
  "config": {
    "label": "Intraday",
    "biasTimeframes": ["1D", "4H", "15m", "5m"],
    "entryTimeframes": ["15m", "5m"],
    "holdingWindow": "Asia open to NY close"
  },
  "dataStatus": {
    "source": "binance",
    "complete": true,
    "warnings": []
  },
  "timeframes": [
    {
      "timeframe": "4H",
      "bias": "bullish",
      "score": 72,
      "price": "$67,500",
      "indicators": {
        "ma200": "above",
        "ma50": "above",
        "emaStack": "bullish",
        "rsi": "58.4",
        "macd": "bullish",
        "volume": "1.25x avg",
        "candlePattern": "Bullish engulfing"
      },
      "notes": "Trend and momentum align with volume confirmation."
    }
  ],
  "consensus": {
    "direction": "LONG_ONLY",
    "score": 68,
    "summary": "Higher timeframes lean bullish; use long setups only until bias changes."
  },
  "availableStrategies": [
    {
      "key": "trend_pullback",
      "name": "Trend Pullback",
      "direction": "long",
      "fit": "preferred"
    }
  ],
  "entryRecommendation": {
    "strategy": "Trend Pullback",
    "direction": "BUY",
    "entryType": "LIMIT",
    "entry": "$67,200",
    "stopLoss": "$66,300",
    "takeProfit": "$69,000",
    "riskReward": "1:2",
    "riskPct": 1,
    "maxConcurrentTrades": 2,
    "rationale": "Bias is bullish and lower timeframe pulled back near support.",
    "guardrails": ["Manual confirmation required", "Paper-only", "Refresh stale data before submission"]
  }
}
```

## Strategy Families

The first implementation exposes these strategy families:

- Trend Pullback: trade with multi-timeframe bias after a controlled pullback into moving-average or support context.
- Breakout Continuation: trade with bias when price closes through nearby resistance/support with volume confirmation.
- Candle Reversal: trade only when higher timeframe bias allows it and the entry timeframe prints a reversal candle near a level.
- Mean Reversion: allowed only when consensus is mixed or range-bound; entry must be near Bollinger/RSI extremes with clear invalidation.
- Ichimoku Confirmation: optional strategy when enough candles exist for cloud and Tenkan/Kijun confirmation.

Each strategy can produce long or short recommendations. If the timeframe stack is contradictory, the server returns `NO_TRADE` or `BIDIRECTIONAL` with a wait condition rather than forcing a direction.

## Bias Scoring

Each timeframe produces a 0-100 score and one of `bullish`, `bearish`, or `mixed`.

Signals considered:

- Close above/below 200MA.
- Close above/below 50MA.
- EMA fast/slow stack.
- RSI zone.
- MACD direction.
- Volume confirmation versus recent average.
- Latest candlestick pattern.
- Swing support/resistance position.

The consensus direction is derived from the weighted timeframe stack:

- `LONG_ONLY`: most higher-timeframe scores are bullish and the entry timeframe is not bearish.
- `SHORT_ONLY`: most higher-timeframe scores are bearish and the entry timeframe is not bullish.
- `BIDIRECTIONAL`: higher timeframes are mixed, so only quick tactical setups are allowed.
- `NO_TRADE`: data is missing, risk blocks the setup, or signals conflict too strongly.

## Integration With Existing Analysis

Saved agent analysis remains the source of broad context. Strategy recommendations use:

- Latest saved report metadata for ticker, research debate, trader decision, risk committee, and execution plan.
- Existing setup quality and execution quality as guardrails.
- Current candle-derived indicators for the selected strategy mode.

If the risk committee rejected or blocked a report, the strategy panel can still show bias, but the entry recommendation must be `WAIT` or `NO_TRADE`.

## Data Sources

First implementation:

- Crypto symbols with Binance pairs use Binance klines for `1w`, `1d`, `4h`, `2h`, `1h`, `30m`, `15m`, `5m`, and `2m` where Binance supports the interval.
- For `2m`, the server aggregates pairs of `1m` candles when the upstream exchange does not provide a native `2m` interval.
- CoinGecko OHLC remains a fallback for daily-style crypto context only.
- Stocks without a configured intraday bar source show strategy mode and saved-analysis context, but timeframe rows are marked unavailable.

Future implementation can add Alpaca market-data bars for equities if credentials and subscription support are available.

## UI Changes

`ui/public/trading.html`:

- Add a mode selector near the existing Trading nav/ticker controls.
- Add a `strategy-recommendations` panel below the TradingView chart and above Setup Quality.

`ui/public/app.js`:

- Store selected strategy mode in state and `localStorage`.
- Fetch `/api/strategy-recommendations` when ticker, saved report, or mode changes.
- Render loading, unavailable, no-trade, and recommendation states.
- Re-render after report selection and refresh.

`ui/public/styles.css`:

- Add compact dashboard styles for mode selector, timeframe rows, bias arrows, strategy chips, and entry ticket.
- Keep styling consistent with existing Trading page panels.

## Server Changes

`ui/server.js`:

- Add strategy mode configuration.
- Add multi-interval Binance candle fetcher with caching.
- Add indicator helpers for SMA, EMA, RSI, MACD, volume ratio, swing levels, and candlestick patterns.
- Add recommendation builders:
  - `buildTimeframeBias`
  - `buildStrategyConsensus`
  - `buildAvailableStrategies`
  - `buildEntryRecommendation`
  - `buildStrategyRecommendations`
- Add API route `/api/strategy-recommendations`.
- Export helpers for tests.

## Error Handling

- Invalid ticker returns 400.
- Unknown mode returns 400.
- Missing data returns a 200 response with `dataStatus.complete=false` and no forced entry.
- Unsupported symbols return an unavailable state, not a crash.
- Partial timeframe data renders available rows and marks missing rows explicitly.
- Strategy entries are not generated when the latest report is stale or risk committee blocks trading.

## Testing

Add focused Node tests for:

- Strategy mode configuration.
- Multi-timeframe consensus direction.
- Candle pattern detection.
- RRR level calculation for long and short setups.
- Recommendation blocking when risk committee rejects a setup.
- API response shape for successful and unavailable data.

Existing server, PDF, and dashboard tests should continue to pass.

## Implementation Order

1. Add server-side strategy configuration and pure calculation helpers.
2. Add strategy recommendation builder and unit tests using synthetic candles.
3. Add the API route and response tests.
4. Add Trading dashboard selector and strategy panel rendering.
5. Add CSS and responsive layout.
6. Run Node tests and server check.

## Decisions

- Default selected mode is `Intraday`, because the current Trading page already centers intraday review and paper execution.
- Default risk settings are 1% risk per trade, 1:2 RRR, and 2 max concurrent trades.
- Equity intraday bars are deferred until a verified data path is available.
