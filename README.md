# MarketAnalysis

Local market analysis dashboard for stocks and crypto with markdown, JSON, and PDF report output.

## What It Does

- Runs a local dashboard for one-click analysis requests
- Generates fresh report snapshots in markdown, JSON, and PDF
- Combines technical, fundamental, sentiment, risk, and thesis analysis
- Runs a Phase 2 bull/bear research debate pass after the first analysis
- Shows a Debate Summary panel with bull case, bear case, manager verdict, score delta, signal, confidence, and watch items
- Marks saved reports as `Debated` or `No Debate` in the dashboard report list
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
- `XAI_MODEL` or `LOCAL_GROK_MODEL` defaults to `grok-4.3`

Optional enrichments:

- `X_BEARER_TOKEN` for X / Twitter social sentiment
- `CMC_API_KEY` for CoinMarketCap market context
- `COINGECKO_API_KEY` for CoinGecko enrichment
- `MARKET_PYTHON` for a specific Python interpreter path

The xAI analysis path uses the Responses API with a strict JSON schema before
normalizing the report. It then runs a second structured bull/bear research
debate pass and includes the Research Manager verdict in markdown/PDF output.

The debate pass stores a `research_debate` object in the JSON report. New reports
use that object to show the dashboard Debate Summary panel and the report-list
`Debated` badge. Older saved reports remain usable and are marked `No Debate`.

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

The Windows launcher uses:

```text
http://127.0.0.1:8799/
```

The batch launcher now stops any older dashboard server already bound to port
`8799` before starting a new one. This prevents a stale backend process from
silently running old pipeline code while the browser shows newer frontend files.
The dashboard also detects this mismatch and shows a backend restart warning if
the running API does not expose the Phase 2 debate stage.

Dashboard screenshot: [images/Market Analysis.png](https://github.com/philipcoller-777/MarketAnalysis/blob/bd82bfaf286db966abbebd8487f04f748312e291/images/Market%20Analysis.png)

## Analysis Pipeline

Fresh analysis runs move through these dashboard stages:

1. Request Ticket
2. Discovery
3. Technical
4. Fundamental
5. Sentiment
6. Risk
7. Thesis
8. Bull/Bear Debate
9. Synthesis
10. PDF Forge

The Bull/Bear Debate stage is the Phase 2 pass. It challenges the initial
analysis from both sides, then records a Research Manager verdict. When present,
the dashboard renders the debate directly above the PDF preview and the PDF
includes a Research Debate section.

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
node --test ui\server.test.js
```

Run the crypto integration checks:

```powershell
node test_crypto_integration.js
```

Run the PDF generator tests:

```powershell
python scripts\test_generate_trade_pdf.py
```

If the default `python` does not have `reportlab`, run the PDF tests with the
same interpreter configured in `MARKET_PYTHON`.

## Notes

- This repo is set up for local use first, not cloud deployment
- The Node server intentionally uses built-in modules only
- Real API keys should stay in `.env`, which is ignored by Git
- Do not commit live API keys or local `.env` files to the public repo
