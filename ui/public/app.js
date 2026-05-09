// Dashboard client for one-click trade runs, live progress, and PDF review.
const $ = (id) => document.getElementById(id);

const TICKER_RE = /^[A-Z0-9]{1,10}$/;

const IDLE_PIPELINE = [
  {
    key: "request_ticket",
    badge: "RQ",
    name: "Request Ticket",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for a new run",
    detail: "Click Request Analysis once to launch a brand new run.",
  },
  {
    key: "discovery",
    badge: "DS",
    name: "Discovery",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for the run ticket",
    detail: "The orchestrator will gather shared market context here.",
  },
  {
    key: "trade-technical",
    badge: "TA",
    name: "Technical",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for discovery",
    detail: "The chart specialist will wake up automatically.",
  },
  {
    key: "trade-fundamental",
    badge: "FA",
    name: "Fundamental",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for discovery",
    detail: "The financial quality specialist will wake up automatically.",
  },
  {
    key: "trade-sentiment",
    badge: "SA",
    name: "Sentiment",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for discovery",
    detail: "The sentiment specialist will wake up automatically.",
  },
  {
    key: "trade-risk",
    badge: "RA",
    name: "Risk",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for discovery",
    detail: "The risk specialist will wake up automatically.",
  },
  {
    key: "trade-thesis",
    badge: "TH",
    name: "Thesis",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for discovery",
    detail: "The thesis specialist will wake up automatically.",
  },
  {
    key: "research_debate",
    badge: "BD",
    name: "Bull/Bear Debate",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for agent output",
    detail: "Bull, bear, and research manager will challenge the initial thesis.",
  },
  {
    key: "execution_agent",
    badge: "EX",
    name: "Execution Agent",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for debate verdict",
    detail: "The execution agent will create a paper-only ticket with no broker submission.",
  },
  {
    key: "synthesis",
    badge: "SX",
    name: "Synthesis",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for agent output",
    detail: "Fresh markdown and JSON will be assembled here.",
  },
  {
    key: "pdf_forge",
    badge: "PF",
    name: "PDF Forge",
    state: "waiting",
    chip: "IDLE",
    summary: "Waiting for fresh JSON",
    detail: "The dashboard will render the PDF automatically when the analysis is ready.",
  },
];

const state = {
  ticker: (localStorage.getItem("ticker") || "SOL").toUpperCase(),
  jobSource: null,
  jobPollTimer: null,
  statusPollTimer: null,
  currentJob: null,
  lastStatus: null,
  brokerStatus: null,
  previewTicker: null,
  requestRunning: false,
};

function fmtBytes(n) {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function badgeForScore(score) {
  if (typeof score !== "number") return { text: "--", cls: "mid" };
  if (score >= 70) return { text: `${score}/100 BUY`, cls: "good" };
  if (score >= 55) return { text: `${score}/100 HOLD`, cls: "mid" };
  return { text: `${score}/100 AVOID`, cls: "bad" };
}

function fmtScore(score) {
  return typeof score === "number" ? `${Math.round(score)}` : "--";
}

function fmtScoreDelta(delta) {
  if (typeof delta !== "number") return "--";
  if (delta > 0) return `+${Math.round(delta)}`;
  return `${Math.round(delta)}`;
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  });
}

function normalizeTickerInput(value) {
  const cleaned = String(value || "").trim().toUpperCase();
  return cleaned || "";
}

function tickerLooksValid(value) {
  return TICKER_RE.test(normalizeTickerInput(value));
}

function isActiveJob(job) {
  return !!job && (job.status === "queued" || job.status === "running");
}

function activeJobForTicker(statusData = state.lastStatus) {
  if (state.currentJob?.ticker === state.ticker && isActiveJob(state.currentJob)) {
    return state.currentJob;
  }
  if (statusData?.activeJob?.ticker === state.ticker && isActiveJob(statusData.activeJob)) {
    return statusData.activeJob;
  }
  return null;
}

function latestSavedForTicker(statusData = state.lastStatus) {
  return statusData?.latestSaved?.ticker === state.ticker ? statusData.latestSaved : null;
}

function isLegacyStatusPayload(statusData = state.lastStatus) {
  return !!statusData && Array.isArray(statusData.steps) && !("savedPipeline" in statusData);
}

function isStaleBackendPayload(statusData = state.lastStatus) {
  if (!statusData || isLegacyStatusPayload(statusData)) return false;
  const pipelines = [statusData.savedPipeline, statusData.activeJob?.pipeline].filter(Array.isArray);
  return pipelines.some(
    (pipeline) =>
      pipeline.length > 0 &&
      (!pipeline.some((card) => card.key === "research_debate") ||
        !pipeline.some((card) => card.key === "execution_agent"))
  );
}

function savedFileUrl(file) {
  if (!file?.path) return null;
  return file.previewPath || `${file.path}?v=${Math.floor(file.mtimeMs || Date.now())}`;
}

function pipelineForDisplay(statusData = state.lastStatus) {
  const activeJob = activeJobForTicker(statusData);
  if (activeJob?.pipeline?.length) return activeJob.pipeline;
  if (statusData?.savedPipeline?.length) return statusData.savedPipeline;
  return IDLE_PIPELINE;
}

function renderMission(statusData = state.lastStatus) {
  const mission = $("mission");
  if (!mission) return;

  const pipeline = pipelineForDisplay(statusData);
  const liveJob = activeJobForTicker(statusData);
  const latestSaved = latestSavedForTicker(statusData);

  const doneCount = pipeline.filter((card) => card.state === "done").length;
  const pct = Math.round((doneCount / Math.max(pipeline.length, 1)) * 100);

  let title = `One-click analysis machine for ${state.ticker}`;
  let subtitle = "A fresh run will launch all analysis steps automatically and reveal the new PDF when it finishes.";
  let pill = "Idle";

  if (isLegacyStatusPayload(statusData)) {
    title = `Backend restart required for ${state.ticker}`;
    subtitle = "This page is talking to an older dashboard server process. Restart start-dashboard.bat so live pipeline stages can stream correctly.";
    pill = "Restart";
  } else if (isStaleBackendPayload(statusData)) {
    title = `Backend restart required for ${state.ticker}`;
    subtitle = "The frontend is current, but the running server is older and cannot start all Phase 2/Execution stages. Close and rerun start-dashboard.bat.";
    pill = "Stale";
  } else if (liveJob) {
    const runLabel = liveJob.runId ? `Run ${String(liveJob.runId).slice(0, 8)}` : "Live run";
    title = `Fresh analysis running for ${state.ticker}`;
    subtitle = "Every stage after the initial request is automatic. The dashboard is hiding older saved files while the fresh run is in flight.";
    pill = runLabel;
  } else if (latestSaved?.files?.pdf) {
    title = `Latest saved report ready for ${state.ticker}`;
    subtitle = "Review Last Analysis opens the latest completed saved run. Request Analysis starts a brand new one.";
    pill = "Ready";
  }

  mission.innerHTML = `
    <div class="mission-head">
      <div>
        <div class="mission-title">${title}</div>
        <div class="mission-sub">${subtitle}</div>
      </div>
      <div class="mission-pill">${pill}</div>
    </div>
    <div class="mission-rail">
      <div class="mission-rail-fill" style="width:${pct}%"></div>
    </div>
    <div class="mission-workers">
      ${pipeline.map((card) => `
        <div class="mission-card is-${card.state}">
          <div class="mission-card-top">
            <div class="mission-agent">
              <div class="mission-badge">${card.badge}</div>
              <div class="mission-copy">
                <div class="mission-name">${card.name}</div>
                <div class="mission-state">${card.summary}</div>
              </div>
            </div>
            <div class="mission-signal">
              <div class="mission-chip">${card.chip}</div>
              <div class="mission-dot"></div>
            </div>
          </div>
          <div class="mission-detail">${card.detail}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function executionStatusClass(status) {
  if (status === "PAPER_READY") return "is-ready";
  if (status === "NO_TRADE" || status === "NOT_BROKER_ELIGIBLE") return "is-blocked";
  return "is-watch";
}

function renderDebateSummary(statusData = state.lastStatus) {
  const host = $("debate-summary");
  if (!host) return;

  const liveJob = activeJobForTicker(statusData);
  const latestSaved = latestSavedForTicker(statusData);
  const insight = latestSaved?.insight || null;

  if (liveJob) {
    host.hidden = false;
    host.className = "debate-summary is-pending";
    host.innerHTML = `
      <div class="debate-title-row">
        <div>
          <div class="debate-title">Research Debate</div>
          <div class="debate-sub">Bull, bear, and manager verdict will appear after the fresh run completes.</div>
        </div>
        <div class="debate-status">Pending</div>
      </div>
    `;
    return;
  }

  if (!latestSaved) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }

  if (!insight?.hasResearchDebate) {
    host.hidden = false;
    host.className = "debate-summary is-empty";
    host.innerHTML = `
      <div class="debate-title-row">
        <div>
          <div class="debate-title">Research Debate</div>
          <div class="debate-sub">This saved report was generated before the Phase 2 debate pass.</div>
        </div>
        <div class="debate-status is-muted">No Debate</div>
      </div>
    `;
    return;
  }

  const delta = insight.scoreDelta;
  const deltaClass = typeof delta === "number" && delta > 0 ? "is-up" : typeof delta === "number" && delta < 0 ? "is-down" : "";
  const watchItems = (insight.watchItems || []).slice(0, 3);
  host.hidden = false;
  host.className = "debate-summary";
  host.innerHTML = `
    <div class="debate-title-row">
      <div>
        <div class="debate-title">Research Debate</div>
        <div class="debate-sub">${escapeHtml(latestSaved.ticker)} debated by bull, bear, and research manager</div>
      </div>
      <div class="debate-status">Debated</div>
    </div>

    <div class="debate-score-row">
      <div class="debate-score">
        <span>Initial</span>
        <strong>${fmtScore(insight.initialScore)}</strong>
      </div>
      <div class="debate-arrow">&rarr;</div>
      <div class="debate-score">
        <span>Manager</span>
        <strong>${fmtScore(insight.finalScore)}</strong>
      </div>
      <div class="debate-delta ${deltaClass}">${fmtScoreDelta(delta)}</div>
      <div class="debate-signal">${escapeHtml(insight.finalSignal || "--")}</div>
      <div class="debate-confidence">${escapeHtml(insight.confidence || "--")} confidence</div>
    </div>

    <div class="debate-grid">
      <div class="debate-column is-bull">
        <div class="debate-label">Bull Analyst</div>
        <div class="debate-copy">${escapeHtml(insight.bullArgument || "--")}</div>
      </div>
      <div class="debate-column is-bear">
        <div class="debate-label">Bear Analyst</div>
        <div class="debate-copy">${escapeHtml(insight.bearArgument || "--")}</div>
      </div>
      <div class="debate-column is-manager">
        <div class="debate-label">Research Manager</div>
        <div class="debate-copy">${escapeHtml(insight.verdict || "--")}</div>
      </div>
    </div>

    ${watchItems.length ? `
      <div class="debate-watch">
        <div class="debate-label">Watch Items</div>
        <div class="debate-watch-list">
          ${watchItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderExecutionSummary(statusData = state.lastStatus) {
  const host = $("execution-summary");
  if (!host) return;

  const liveJob = activeJobForTicker(statusData);
  const latestSaved = latestSavedForTicker(statusData);
  const plan = latestSaved?.insight?.executionPlan || null;

  if (liveJob) {
    host.hidden = false;
    host.className = "execution-summary is-pending";
    host.innerHTML = `
      <div class="execution-title-row">
        <div>
          <div class="execution-title">Execution Agent</div>
          <div class="execution-sub">Paper-only ticket appears after the fresh run completes. No broker order is submitted.</div>
        </div>
        <div class="execution-status">Pending</div>
      </div>
    `;
    return;
  }

  if (!latestSaved) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }

  if (!plan) {
    host.hidden = false;
    host.className = "execution-summary is-empty";
    host.innerHTML = `
      <div class="execution-title-row">
        <div>
          <div class="execution-title">Execution Agent</div>
          <div class="execution-sub">This saved report was generated before the execution-planning stage.</div>
        </div>
        <div class="execution-status is-muted">No Plan</div>
      </div>
    `;
    return;
  }

  const statusClass = executionStatusClass(plan.status);
  const safeguards = (plan.safeguards || []).slice(0, 3);
  const notes = (plan.brokerNotes || []).slice(0, 3);
  host.hidden = false;
  host.className = `execution-summary ${statusClass}`;
  host.innerHTML = `
    <div class="execution-title-row">
      <div>
        <div class="execution-title">Execution Agent</div>
        <div class="execution-sub">Paper-only execution plan for ${escapeHtml(latestSaved.ticker)}. Broker submission is disabled.</div>
      </div>
      <div class="execution-status ${statusClass}">${escapeHtml(plan.status || "--")}</div>
    </div>

    <div class="execution-ticket-grid">
      <div class="execution-ticket-cell">
        <span>Action</span>
        <strong>${escapeHtml(plan.action || "--")}</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Order</span>
        <strong>${escapeHtml(plan.orderType || "--")}</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Entry</span>
        <strong>${escapeHtml(plan.entry || "--")}</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Stop</span>
        <strong>${escapeHtml(plan.stopLoss || "--")}</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Target</span>
        <strong>${escapeHtml(plan.takeProfit || "--")}</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Size</span>
        <strong>${plan.positionSizePct ?? "--"}%</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Risk</span>
        <strong>${plan.riskPct ?? "--"}%</strong>
      </div>
      <div class="execution-ticket-cell">
        <span>Confidence</span>
        <strong>${escapeHtml(plan.confidence || "--")}</strong>
      </div>
    </div>

    <div class="execution-rationale">${escapeHtml(plan.rationale || "--")}</div>

    ${safeguards.length ? `
      <div class="execution-list">
        <div class="execution-label">Safeguards</div>
        <div>${safeguards.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </div>
    ` : ""}
    ${notes.length ? `
      <div class="execution-list">
        <div class="execution-label">Broker Notes</div>
        <div>${notes.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </div>
    ` : ""}
  `;
}

function renderBrokerStatus(broker = state.brokerStatus) {
  const host = $("broker");
  if (!host) return;

  if (!broker) {
    host.innerHTML = `
      <div class="broker-card is-muted">
        <div class="broker-row">
          <span>Alpaca</span>
          <strong>Checking</strong>
        </div>
      </div>
    `;
    return;
  }

  if (!broker.configured) {
    host.innerHTML = `
      <div class="broker-card is-muted">
        <div class="broker-row">
          <span>Alpaca</span>
          <strong>Not Configured</strong>
        </div>
        <div class="broker-note">${escapeHtml(broker.error || "Missing local credentials")}</div>
      </div>
    `;
    return;
  }

  const account = broker.account || {};
  const clock = broker.clock || {};
  const positions = Array.isArray(broker.positions) ? broker.positions.length : 0;
  const orders = Array.isArray(broker.orders) ? broker.orders.length : 0;
  const marketLabel = clock.is_open ? "Market Open" : "Market Closed";
  const mode = broker.paper ? "Paper" : "Live URL";
  const warning = broker.paper ? "" : `<div class="broker-note is-warn">Live Alpaca URL detected. Order submission remains disabled.</div>`;

  host.innerHTML = `
    <div class="broker-card ${broker.connected ? "is-on" : "is-error"}">
      <div class="broker-row">
        <span>Alpaca</span>
        <strong>${broker.connected ? "Connected" : "Offline"}</strong>
      </div>
      <div class="broker-pills">
        <span>${escapeHtml(mode)}</span>
        <span>${escapeHtml(marketLabel)}</span>
      </div>
      <div class="broker-grid">
        <div>
          <span>Equity</span>
          <strong>${fmtMoney(account.equity || account.portfolio_value)}</strong>
        </div>
        <div>
          <span>Buying Power</span>
          <strong>${fmtMoney(account.buying_power)}</strong>
        </div>
        <div>
          <span>Positions</span>
          <strong>${positions}</strong>
        </div>
        <div>
          <span>Open Orders</span>
          <strong>${orders}</strong>
        </div>
      </div>
      ${broker.error ? `<div class="broker-note">${escapeHtml(broker.error)}</div>` : ""}
      ${warning}
    </div>
  `;
}

async function apiGet(pathname) {
  const response = await fetch(pathname, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function apiPost(pathname, body) {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function refreshBrokerStatus() {
  try {
    const data = await apiGet("/api/broker/status");
    state.brokerStatus = data.broker || null;
    renderBrokerStatus(state.brokerStatus);
    return state.brokerStatus;
  } catch (error) {
    state.brokerStatus = {
      configured: false,
      connected: false,
      paper: true,
      error: String(error),
    };
    renderBrokerStatus(state.brokerStatus);
    return state.brokerStatus;
  }
}

function clearJobStream() {
  if (!state.jobSource) return;
  try {
    state.jobSource.close();
  } catch {}
  state.jobSource = null;
}

function clearJobPolling() {
  if (!state.jobPollTimer) return;
  clearInterval(state.jobPollTimer);
  state.jobPollTimer = null;
}

function syncStatusPolling() {
  const shouldPoll = state.requestRunning;
  if (shouldPoll && !state.statusPollTimer) {
    state.statusPollTimer = setInterval(() => {
      refreshStatus({ loadPreview: false }).catch(() => {});
    }, 2000);
  }
  if (!shouldPoll && state.statusPollTimer) {
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
}

function setBusyState() {
  $("btn-request").disabled = state.requestRunning;
  $("btn-review").disabled = state.requestRunning;
  syncStatusPolling();
}

function setEmptyPreview(title, subtitle) {
  state.previewTicker = null;
  $("pdf").src = "about:blank";
  $("empty-title").textContent = title;
  $("empty-sub").textContent = subtitle;
  $("empty").style.display = "grid";
}

function withPdfViewerParams(pdfUrl) {
  if (!pdfUrl) return pdfUrl;
  return `${pdfUrl}#zoom=page-fit&pagemode=none`;
}

function showPdfPreview(pdfUrl, ticker) {
  if (!pdfUrl) return;
  state.previewTicker = ticker;
  $("pdf").src = withPdfViewerParams(pdfUrl);
  $("empty").style.display = "none";
}

function setJobLog(text) {
  const el = $("joblog");
  el.textContent = text || "";
  el.scrollTop = el.scrollHeight;
}

function appendJobLog(line) {
  const el = $("joblog");
  el.textContent = (el.textContent ? `${el.textContent}\n` : "") + line;
  el.scrollTop = el.scrollHeight;
}

function updateArtifactLinks(statusData = state.lastStatus) {
  const latestSaved = latestSavedForTicker(statusData);
  const links = latestSaved?.files || {};
  $("link-md").href = savedFileUrl(links.md) || `/trade/TRADE-ANALYSIS-${state.ticker}.md`;
  $("link-json").href = savedFileUrl(links.json) || `/trade/TRADE-ANALYSIS-${state.ticker}.json`;
  $("link-pdf").href = savedFileUrl(links.pdf) || `/trade/TRADE-ANALYSIS-${state.ticker}.pdf`;
}

async function refreshReports() {
  const data = await apiGet("/api/reports");
  const host = $("reports");
  host.innerHTML = "";

  for (const report of data.reports || []) {
    const score = report?.meta?.overall_score;
    const badge = badgeForScore(score);
    const hasDebate = !!(report?.insight?.hasResearchDebate || report?.meta?.research_debate);
    const executionStatus = report?.insight?.executionPlan?.status || null;
    const note = report?.meta?.date || (report.source === "run" ? "Saved run snapshot" : "Legacy saved files");
    const div = document.createElement("div");
    div.className = "report";
    div.onclick = async () => {
      setTicker(report.ticker, { loadPreview: false });
      await reviewLastAnalysis();
    };
    div.innerHTML = `
      <div>
        <div class="t">${escapeHtml(report.ticker)}</div>
        <div class="hint">${escapeHtml(note)}</div>
      </div>
      <div class="report-markers">
        <div class="debate-mini ${hasDebate ? "is-on" : "is-off"}">${hasDebate ? "Debated" : "No Debate"}</div>
        <div class="execution-mini ${executionStatus ? executionStatusClass(executionStatus) : "is-off"}">${escapeHtml(executionStatus || "No Plan")}</div>
        <div class="badge ${badge.cls}">${escapeHtml(badge.text)}</div>
      </div>
    `;
    host.appendChild(div);
  }
}

function renderStatusRows(statusData) {
  const host = $("status");
  host.innerHTML = "";

  for (const step of statusData.steps || []) {
    const hasFile = !!step.exists;
    const dotCls = hasFile ? (step.fresh ? "dot ok" : "dot warn") : "dot";
    const freshness = !hasFile ? "missing" : step.fresh ? "fresh for current request" : "older saved file";
    const meta = hasFile
      ? `${fmtBytes(step.bytes)} | ${new Date(step.mtimeMs).toLocaleString()} | ${freshness}`
      : freshness;
    const row = document.createElement("div");
    row.className = "step";
    row.innerHTML = `
      <div class="left">
        <div class="${dotCls}"></div>
        <div class="label">${step.label}</div>
      </div>
      <div class="meta">${meta}</div>
    `;
    host.appendChild(row);
  }

  const latestSaved = latestSavedForTicker(statusData);
  if (latestSaved) {
    const row = document.createElement("div");
    row.className = "step";
    row.innerHTML = `
      <div class="left">
        <div class="dot ok"></div>
        <div class="label">Latest Saved Run</div>
      </div>
      <div class="meta">${latestSaved.runId ? `snapshot ${String(latestSaved.runId).slice(0, 8)}` : "legacy saved files"}</div>
    `;
    host.appendChild(row);
  }
}

async function refreshStatus(options = {}) {
  const { loadPreview = false } = options;
  if (!tickerLooksValid(state.ticker)) return null;
  const data = await apiGet(`/api/status?ticker=${encodeURIComponent(state.ticker)}`);
  state.lastStatus = data;

  if (!state.currentJob && data.activeJob?.ticker === state.ticker && isActiveJob(data.activeJob)) {
    state.currentJob = data.activeJob;
    state.requestRunning = true;
  }

  renderStatusRows(data);
  updateArtifactLinks(data);
  renderMission(data);
  renderDebateSummary(data);
  renderExecutionSummary(data);

  if (loadPreview) {
    const latestSaved = latestSavedForTicker(data);
    if (latestSaved?.files?.pdf) {
      showPdfPreview(savedFileUrl(latestSaved.files.pdf), state.ticker);
    } else {
      setEmptyPreview(
        `No saved PDF for ${state.ticker}`,
        "Request a fresh analysis to generate and reveal the next report automatically."
      );
    }
  }

  setBusyState();
  return data;
}

function setTicker(value, options = {}) {
  const cleaned = normalizeTickerInput(value);
  state.ticker = cleaned || "SOL";
  localStorage.setItem("ticker", state.ticker);
  $("ticker").value = state.ticker;

  if (!tickerLooksValid(state.ticker)) {
    renderMission({ savedPipeline: IDLE_PIPELINE });
    renderDebateSummary(null);
    renderExecutionSummary(null);
    return;
  }

  refreshStatus({ loadPreview: options.loadPreview === true }).catch(() => {});
  if (!options.loadPreview) {
    setEmptyPreview(
      `Ready to analyze ${state.ticker}`,
      "Request Analysis starts a fresh run. Review Last Analysis opens the latest saved report snapshot."
    );
  }
}

function finishActiveRun({ loadPreview }) {
  state.requestRunning = false;
  clearJobStream();
  clearJobPolling();
  setBusyState();
  refreshReports().catch(() => {});
  refreshStatus({ loadPreview }).catch(() => {});
  refreshBrokerStatus().catch(() => {});
}

function handleJobUpdate(job, options = {}) {
  if (!job) return;
  state.currentJob = job;
  state.requestRunning = isActiveJob(job);
  renderMission();
  renderDebateSummary();
  renderExecutionSummary();
  setBusyState();

  if (job.status === "done") {
    appendJobLog("DONE: one-click analysis pipeline complete");
    finishActiveRun({ loadPreview: true });
    return;
  }

  if (job.status === "error") {
    appendJobLog(`ERROR: ${job.error || "unknown"}`);
    finishActiveRun({ loadPreview: false });
    return;
  }

  if (options.fromPoll) {
    renderMission();
  }
}

function startJobPolling(jobId) {
  clearJobPolling();
  state.jobPollTimer = setInterval(async () => {
    try {
      const data = await apiGet(`/api/jobs/${encodeURIComponent(jobId)}`);
      handleJobUpdate(data.job, { fromPoll: true });
      if (data.job?.status === "done" || data.job?.status === "error") {
        clearJobPolling();
      }
    } catch {}
  }, 2000);
}

function trackJob(jobId) {
  clearJobStream();
  clearJobPolling();

  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  state.jobSource = source;

  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "log" && message.line) appendJobLog(message.line);
      if (message.type === "job" && message.job) handleJobUpdate(message.job);
    } catch {}
  };

  source.onerror = () => {
    clearJobStream();
    appendJobLog("Live stream interrupted. Switching to polling until the run finishes.");
    startJobPolling(jobId);
  };
}

async function requestAnalysis() {
  if (state.requestRunning) return;
  if (!tickerLooksValid(state.ticker)) {
    appendJobLog("Enter a valid ticker first.");
    return;
  }

  const ticker = state.ticker;
  state.requestRunning = true;
  state.currentJob = null;
  setBusyState();
  setJobLog("");
  clearJobStream();
  clearJobPolling();
  setEmptyPreview(
    `Running fresh analysis for ${ticker}`,
    "Older saved reports are hidden while the new end-to-end run is working."
  );

  try {
    const response = await apiPost("/api/run-analysis", { ticker });
    appendJobLog(`Started /trade analyze ${ticker}...`);
    if (response.job) handleJobUpdate(response.job);
    if (response.status) {
      state.lastStatus = response.status;
      updateArtifactLinks(response.status);
      renderStatusRows(response.status);
      renderMission(response.status);
    }
    trackJob(response.jobId);
  } catch (error) {
    state.requestRunning = false;
    setBusyState();
    throw error;
  }
}

async function reviewLastAnalysis() {
  if (!tickerLooksValid(state.ticker)) {
    appendJobLog("Enter a valid ticker first.");
    return;
  }
  appendJobLog(`Reviewing the latest saved analysis for ${state.ticker}...`);
  const statusData = await refreshStatus({ loadPreview: true });
  if (!latestSavedForTicker(statusData)?.files?.pdf) {
    appendJobLog(`No saved PDF snapshot exists yet for ${state.ticker}.`);
  }
}

function wire() {
  $("ticker").value = state.ticker;
  $("ticker").addEventListener("input", (event) => {
    state.ticker = normalizeTickerInput(event.target.value);
    localStorage.setItem("ticker", state.ticker);
  });
  $("ticker").addEventListener("change", (event) => setTicker(event.target.value));
  $("ticker").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      setTicker(event.target.value);
      requestAnalysis().catch((error) => appendJobLog(String(error)));
    }
  });

  $("btn-refresh").onclick = async () => {
    await refreshReports();
    await refreshBrokerStatus();
    await refreshStatus({ loadPreview: false });
  };
  $("btn-request").onclick = () => requestAnalysis().catch((error) => appendJobLog(String(error)));
  $("btn-review").onclick = () => reviewLastAnalysis().catch((error) => appendJobLog(String(error)));

  setBusyState();
  renderMission({ savedPipeline: IDLE_PIPELINE });
  renderDebateSummary(null);
  renderExecutionSummary(null);
  renderBrokerStatus(null);
}

async function boot() {
  wire();
  setEmptyPreview(
    `Ready to analyze ${state.ticker}`,
    "Request Analysis launches a fresh end-to-end run. Review Last Analysis opens the latest saved snapshot."
  );
  await refreshReports();
  await refreshBrokerStatus();
  await refreshStatus({ loadPreview: false });
}

boot().catch((error) => {
  setJobLog(String(error));
});
