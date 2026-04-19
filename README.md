# MarketAnalysis

Local market analysis dashboard for stocks and crypto with markdown, JSON, and PDF report output.

## What It Does

- Runs a local dashboard for one-click analysis requests
- Generates fresh report snapshots in markdown, JSON, and PDF
- Combines technical, fundamental, sentiment, risk, and thesis analysis
- Supports stock ticker analysis and crypto analysis in the same workflow
- Adds crypto-native enrichment from:
  - X / Twitter recent-search sentiment
  - CoinMarketCap market context
  - Crypto Fear & Greed data
- Keeps a local run history under `trade/`

## Repo Layout

- `ui/` - local HTTP server, dashboard UI, API integrations, and tests
- `scripts/` - PDF generator and PDF tests
- `agents/` - analysis agent briefs
- `skills/` - reusable trade-analysis skills
- `trade/` - generated report outputs and run snapshots
- `requests/` - request ticket files created by the local workflow

## Requirements

- Node.js 18+ recommended
- Python 3 for PDF generation
- `reportlab` installed in the Python environment used for PDF output

Install the PDF dependency with:

```powershell
python -m pip install reportlab
```

If Windows resolves `python` to a Store alias, set `MARKET_PYTHON` in `.env` to a real interpreter path.

## Environment Setup

Copy `.env_example` to `.env` and fill in the values you want to enable.

Core requirement:

- `XAI_API_KEY` for xAI / Grok analysis

Optional enrichments:

- `X_BEARER_TOKEN` for X / Twitter social sentiment
- `CMC_API_KEY` for CoinMarketCap market context
- `COINGECKO_API_KEY` for CoinGecko enrichment
- `MARKET_PYTHON` for a specific Python interpreter path

## Running The App

Start the local dashboard:

```powershell
node ui\server.js
```

Or use the Windows launcher:

```powershell
.\start-dashboard.bat
```

Default local URL:

```text
http://127.0.0.1:8787/
```

The batch launcher uses port `8799` by default to avoid conflicts with stale local sessions.

## Output Files

Fresh analysis outputs are written under `trade/`:

- `TRADE-ANALYSIS-<TICKER>.md`
- `TRADE-ANALYSIS-<TICKER>.json`
- `TRADE-ANALYSIS-<TICKER>.pdf`

Run metadata and snapshots are stored under `trade/.runs/`.

## Crypto Notes

Crypto reports support a different enrichment path from stock reports:

- X narrative and social-volume context can be added to crypto analysis
- CoinMarketCap market metrics can be merged into the prompt snapshot
- Fear & Greed data can be surfaced in the crypto sentiment section
- Crypto catalyst handling is separated from stock-style catalyst defaults

Crypto-native enrichment is strongest for mapped assets currently present in the server, including `BTC`, `ETH`, `XRP`, `SOL`, `XLM`, and `XDC`.

## Tests

Run the Node server tests:

```powershell
node ui\server.test.js
```

Run the crypto integration checks:

```powershell
node test_crypto_integration.js
```

Run the PDF generator tests:

```powershell
python scripts\test_generate_trade_pdf.py
```

## Notes

- This repo is set up for local use first, not cloud deployment
- The Node server intentionally uses built-in modules only
- Real API keys should stay in `.env`, which is ignored by Git
