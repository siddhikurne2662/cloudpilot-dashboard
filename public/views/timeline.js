// public/views/timeline.js - Live animated execution + visual history
import { api, escapeHtml, formatDateTime, formatDuration } from '../api.js';
import { setPageHeader, setTopActions, showToast } from '../ui.js';

// Hide stats + section header to give timeline full height
function enterTimelineLayout() {
  document.body.classList.add('timeline-page');
  const stats = document.querySelector('.stats-grid');
  const secHeader = document.querySelector('.section-header');
  const grid = document.getElementById('workflowsGrid');
  if (stats) stats.style.display = 'none';
  if (secHeader) secHeader.style.display = 'none';
  if (grid) { grid.style.display = 'block'; grid.style.overflow = 'hidden'; }
}

function exitTimelineLayout() {
  document.body.classList.remove('timeline-page');
  const stats = document.querySelector('.stats-grid');
  const secHeader = document.querySelector('.section-header');
  const grid = document.getElementById('workflowsGrid');
  if (stats) stats.style.display = '';
  if (secHeader) secHeader.style.display = '';
  if (grid) { grid.style.display = ''; grid.style.overflow = ''; }
}

export async function timelineView(params) {
  // params[0] is either:
  //   - an execution ID  (when routed via /execution/:id)
  //   - a workflow ID    (when routed via /workflow/:id)
  // The /execution route opens a single execution's timeline directly.
  // The /workflow route shows the list of executions for that workflow.
  const paramId = params && params[0];

  enterTimelineLayout();
  window.addEventListener('hashchange', exitTimelineLayout, { once: true });

  setPageHeader('Execution History', 'Every run, every node — visualized');
  setTopActions(`
    <button class="btn-create" onclick="window.history.back()"
      style="background:var(--bg-secondary);color:var(--text-secondary);border:1px solid var(--border)">
      <i class="fas fa-arrow-left"></i> Back
    </button>
  `);

  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading executions…</span></div>`;

  // Determine current route to know what paramId represents
  const currentHash = window.location.hash.slice(1) || '';
  const isExecutionRoute = currentHash.startsWith('/execution/');

  // Validate: n8n execution IDs are always numeric integers.
  // Reject fake webhook IDs (wh-xxx), Supabase UUIDs, or any non-numeric string early
  // to prevent the backend from returning "Invalid execution ID" errors.
  if (isExecutionRoute && paramId && !isNumericId(paramId)) {
    exitTimelineLayout();
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>Invalid execution ID</h3>
        <p>Expected a numeric n8n execution ID. Got: <code>${escapeHtml(String(paramId))}</code></p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
          Navigate here from Run History to see a valid execution.
        </p>
        <button class="btn-create" onclick="window.location.hash='/run-history'" style="margin-top:0.5rem">
          <i class="fas fa-history"></i> View Run History
        </button>
      </div>`;
    return;
  }

  try {
    let executions = [];
    let autoOpenId = null;
    let autoOpenMeta = null;

    if (isExecutionRoute && paramId) {
      // /execution/:execId — fetch execution timeline to get workflowId,
      // then load sibling executions for the sidebar list.
      let workflowId = null;
      try {
        const execData = await api.getTimeline(paramId);
        workflowId = execData?.workflow_id ? String(execData.workflow_id) : null;
      } catch (_) { }

      if (workflowId) {
        const histData = await api.getWorkflowHistory(workflowId);
        executions = histData?.data || histData?.executions || [];
      } else {
        executions = [{ id: paramId, engine_execution_ref: paramId }];
      }

      autoOpenId = paramId;
      autoOpenMeta = executions.find(e =>
        String(e.engine_execution_ref) === String(paramId) ||
        String(e.id) === String(paramId)
      ) || { id: paramId, engine_execution_ref: paramId };
    } else if (paramId) {
      // /workflow/:workflowId — load history list for this workflow
      const data = await api.getWorkflowHistory(paramId);
      executions = data?.data || data?.executions || [];
      if (executions.length > 0) {
        autoOpenId = resolveExecId(executions[0]);
        autoOpenMeta = executions[0];
      }
    }

    if (!executions.length) {
      exitTimelineLayout();
      grid.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-satellite-dish"></i>
          <h3>No runs yet</h3>
          <p>Click <strong>Run</strong> on a workflow to see executions here</p>
        </div>`;
      return;
    }

    grid.innerHTML = `
      <div class="exec-history-wrap">
        <div class="exec-history-list" id="execHistoryList">
          ${executions.map((exec, i) => buildHistoryRow(exec, executions.length - i)).join('')}
        </div>
        <div class="exec-detail-panel" id="execDetailPanel">
          <div class="exec-detail-empty">
            <i class="fas fa-mouse-pointer"></i>
            <p>Select an execution to inspect it</p>
          </div>
        </div>
      </div>`;

    if (autoOpenId) openExecDetail(autoOpenId, autoOpenMeta || {});

  } catch (err) {
    exitTimelineLayout();
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>Failed to load history</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>`;
  }
}

function buildHistoryRow(exec, num) {
  const status = execStatus(exec);
  // engine_execution_ref is the numeric n8n execution ID (stored by CloudPilot in Supabase).
  // exec.id from n8n API responses is also the numeric execution ID.
  // When rows come from Supabase, exec.id is the Supabase UUID — DO NOT use it as n8n ID.
  // Always prefer engine_execution_ref, then fall back to exec.id only if it looks numeric.
  const id = resolveExecId(exec);
  const start = exec.startedAt || exec.started_at;
  const duration = getDuration(exec);
  return `
    <div class="exec-row exec-row--${status}" id="row-${escapeHtml(String(id))}"
         onclick="window._openExec('${escapeHtml(String(id))}', ${JSON.stringify(exec).replace(/\"/g, '&quot;')})">
      <div class="exec-row-bullet exec-bullet--${status}">
        <i class="fas fa-${statusIcon(status)}${status === 'running' ? ' fa-spin' : ''}"></i>
      </div>
      <div class="exec-row-body">
        <div class="exec-row-title">Run #${num}</div>
        <div class="exec-row-meta">
          ${start ? `<span><i class="fas fa-clock"></i> ${formatDateTime(start)}</span>` : ''}
          ${duration ? `<span><i class="fas fa-stopwatch"></i> ${duration}</span>` : ''}
        </div>
      </div>
      <span class="exec-status-chip exec-chip--${status}">${status}</span>
    </div>`;
  return `
    <div class="exec-row exec-row--${status}" id="row-${escapeHtml(String(id))}"
         onclick="window._openExec('${escapeHtml(String(id))}', ${JSON.stringify(exec).replace(/"/g, '&quot;')})">
      <div class="exec-row-bullet exec-bullet--${status}">
        <i class="fas fa-${statusIcon(status)}${status === 'running' ? ' fa-spin' : ''}"></i>
      </div>
      <div class="exec-row-body">
        <div class="exec-row-title">Run #${num}</div>
        <div class="exec-row-meta">
          ${start ? `<span><i class="fas fa-clock"></i> ${formatDateTime(start)}</span>` : ''}
          ${duration ? `<span><i class="fas fa-stopwatch"></i> ${duration}</span>` : ''}
        </div>
      </div>
      <span class="exec-status-chip exec-chip--${status}">${status}</span>
    </div>`;
}

function openExecDetail(id, execMeta) {
  document.querySelectorAll('.exec-row').forEach(r => r.classList.remove('exec-row--selected'));
  const row = document.getElementById(`row-${id}`);
  if (row) row.classList.add('exec-row--selected');

  const panel = document.getElementById('execDetailPanel');
  if (!panel) return;

  // Guard: only call the API with a numeric execution ID
  if (!isNumericId(id)) {
    panel.innerHTML = `
      <div class="exec-detail-error">
        <i class="fas fa-exclamation-circle"></i>
        <p>Cannot load timeline: execution ID <code>${escapeHtml(String(id))}</code> is not a valid numeric n8n ID.</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
          Run the workflow again from the dashboard to generate a trackable execution.
        </p>
      </div>`;
    return;
  }

  panel.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading node data…</span></div>`;

  api.getTimeline(id).then(data => {
    renderDetailPanel(panel, data, execMeta);
  }).catch(err => {
    panel.innerHTML = `
      <div class="exec-detail-error">
        <i class="fas fa-exclamation-circle"></i>
        <p>${escapeHtml(err.message)}</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:4px">
          Detailed node data is available for executions triggered through CloudPilot.
        </p>
      </div>`;
  });
}

window._openExec = openExecDetail;

function renderDetailPanel(panel, data, execMeta) {
  const { timeline = [], status, started_at, finished_at } = data;
  const overallStatus = status || execStatus(execMeta);
  const totalMs = started_at && finished_at ? new Date(finished_at) - new Date(started_at) : null;

  const nodeCards = timeline.length
    ? timeline.map((node, i) => buildNodeCard(node, i, timeline.length)).join('')
    : `<div class="no-nodes-msg"><i class="fas fa-info-circle"></i> No node-level data for this execution.</div>`;

  panel.innerHTML = `
    <div class="exec-detail-header">
      <div class="exec-detail-status exec-detail-status--${overallStatus}">
        <i class="fas fa-${statusIcon(overallStatus)}${overallStatus === 'running' ? ' fa-spin' : ''}"></i>
        ${overallStatus.charAt(0).toUpperCase() + overallStatus.slice(1)}
      </div>
      <div class="exec-detail-times">
        ${started_at ? `<div class="exec-time-item"><span class="exec-time-label">Started</span><span class="exec-time-val">${formatDateTime(started_at)}</span></div>` : ''}
        ${finished_at ? `<div class="exec-time-item"><span class="exec-time-label">Finished</span><span class="exec-time-val">${formatDateTime(finished_at)}</span></div>` : ''}
        ${totalMs ? `<div class="exec-time-item"><span class="exec-time-label">Duration</span><span class="exec-time-val exec-time-dur">${formatDuration(totalMs)}</span></div>` : ''}
      </div>
    </div>
    ${timeline.length > 1 ? buildProgressBar(timeline) : ''}
    <div class="exec-nodes-label">
      <i class="fas fa-sitemap"></i> Node Execution Path
      <span class="exec-nodes-count">${timeline.length} nodes</span>
    </div>
    <div class="exec-node-cards">${nodeCards}</div>`;
}

function buildProgressBar(timeline) {
  const total = timeline.reduce((sum, n) => sum + (n.duration_ms || 0), 0);
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#f43f5e'];
  const segments = timeline.map((node, i) => {
    const pct = total > 0 ? Math.max(((node.duration_ms || 0) / total) * 100, 2) : (100 / timeline.length);
    const color = node.status === 'failed' ? '#f43f5e' : colors[i % colors.length];
    return `<div class="prog-seg" style="width:${pct.toFixed(1)}%;background:${color}" title="${escapeHtml(node.node_name)}: ${formatDuration(node.duration_ms)}"></div>`;
  }).join('');
  return `
    <div class="exec-progress-bar-wrap">
      <div class="exec-progress-label">Time Distribution</div>
      <div class="exec-progress-bar">${segments}</div>
      <div class="exec-progress-legend">
        ${timeline.map((n, i) => `
          <div class="prog-legend-item">
            <span class="prog-legend-dot" style="background:${n.status === 'failed' ? '#f43f5e' : colors[i % colors.length]}"></span>
            <span class="prog-legend-name">${escapeHtml(n.node_name)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function buildNodeCard(node, index, total) {
  const isLast = index === total - 1;
  const status = node.status || 'success';
  const outputSummary = buildOutputSummary(node.output_preview);
  return `
    <div class="node-card node-card--${status}">
      <div class="node-card-left">
        <div class="node-card-index">${index + 1}</div>
        ${!isLast ? `<div class="node-card-line"></div>` : ''}
      </div>
      <div class="node-card-body">
        <div class="node-card-header">
          <div class="node-card-title-row">
            <div class="node-card-icon node-icon--${status}">
              <i class="fas fa-${getNodeIcon(node)}"></i>
            </div>
            <div>
              <div class="node-card-name">${escapeHtml(node.node_name)}</div>
              <div class="node-card-type">${escapeHtml(node.node_type || 'action')}</div>
            </div>
          </div>
          <div class="node-card-meta">
            ${node.duration_ms ? `<span class="node-dur-badge"><i class="fas fa-bolt"></i> ${formatDuration(node.duration_ms)}</span>` : ''}
            <span class="node-status-badge node-status--${status}">
              <i class="fas fa-${status === 'success' ? 'check' : 'times'}"></i> ${status}
            </span>
          </div>
        </div>
        ${node.error ? `
          <div class="node-card-error">
            <div class="node-error-title"><i class="fas fa-exclamation-triangle"></i> Error</div>
            <div class="node-error-msg">${escapeHtml(node.error)}</div>
          </div>` : ''}
        ${outputSummary ? `
          <div class="node-card-output">
            <div class="node-output-title"><i class="fas fa-arrow-right"></i> Output</div>
            ${outputSummary}
          </div>` : ''}
      </div>
    </div>`;
}

function buildOutputSummary(rawPreview) {
  if (!rawPreview) return null;
  let obj;
  try { obj = typeof rawPreview === 'string' ? JSON.parse(rawPreview) : rawPreview; }
  catch { return `<div class="node-output-text">${escapeHtml(String(rawPreview).slice(0, 200))}</div>`; }
  if (typeof obj !== 'object' || obj === null) return `<div class="node-output-text">${escapeHtml(String(obj))}</div>`;
  const entries = Object.entries(obj).slice(0, 8);
  if (!entries.length) return null;
  return `<div class="node-output-kvgrid">${entries.map(([k, v]) => `
    <div class="node-output-kv">
      <span class="node-output-key">${escapeHtml(k)}</span>
      <span class="node-output-val">${escapeHtml(formatOutputValue(v))}</span>
    </div>`).join('')}</div>`;
}

function formatOutputValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? '✓ true' : '✗ false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (Array.isArray(v)) return `[ ${v.length} items ]`;
  if (typeof v === 'object') return `{ ${Object.keys(v).length} keys }`;
  return String(v);
}

function getNodeIcon(node) {
  const name = (node.node_name || '').toLowerCase();
  const type = (node.node_type || '').toLowerCase();
  if (name.includes('email') || name.includes('mail')) return 'envelope';
  if (name.includes('slack')) return 'hashtag';
  if (name.includes('http') || name.includes('webhook')) return 'globe';
  if (name.includes('database') || name.includes('sql')) return 'database';
  if (name.includes('s3') || name.includes('storage')) return 'cloud-upload-alt';
  if (name.includes('schedule') || name.includes('cron')) return 'clock';
  if (name.includes('filter') || name.includes('if')) return 'filter';
  if (name.includes('code') || name.includes('function')) return 'code';
  if (name.includes('start') || name.includes('trigger') || name.includes('manual') || type === 'trigger') return 'play-circle';
  if (name.includes('set') || name.includes('assign')) return 'pen';
  if (name.includes('merge') || name.includes('join')) return 'code-branch';
  if (name.includes('split') || name.includes('loop')) return 'random';
  return 'circle-notch';
}

// ─────────────────────────────────────────────
// LIVE RUN PANEL
// ─────────────────────────────────────────────
export function showLiveRunPanel(workflowId, workflowName, cardEl) {
  const existing = document.getElementById(`live-panel-${workflowId}`);
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = `live-panel-${workflowId}`;
  panel.className = 'live-run-panel';
  panel.innerHTML = `
    <div class="live-run-header">
      <div class="live-run-title">
        <div class="live-pulse"></div>
        <span>Run: <strong>${escapeHtml(workflowName)}</strong></span>
      </div>
      <button class="live-close-btn" onclick="document.getElementById('live-panel-${workflowId}').remove()">
        <i class="fas fa-times"></i>
      </button>
    </div>

    <div class="live-run-form" id="live-form-${workflowId}" style="padding:12px 16px;border-bottom:1px solid var(--border)">
      <button class="wf-btn intent-btn" id="live-run-btn-${workflowId}"
        style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;padding:9px 16px;width:100%;background:var(--primary);border:none;border-radius:6px;color:#fff;cursor:pointer;">
        <i class="fas fa-play"></i> Run Workflow
      </button>
    </div>

    <div class="live-run-steps" id="live-steps-${workflowId}" style="display:none"></div>
    <div class="live-run-footer" id="live-footer-${workflowId}"></div>`;

  cardEl.insertAdjacentElement('afterend', panel);
  requestAnimationFrame(() => panel.classList.add('live-run-panel--visible'));
  return panel;
}


// ─────────────────────────────────────────────
// Main run entry point
// ─────────────────────────────────────────────
export async function runWithLivePanel(workflowId, workflowName, cardEl, wf = null, optionalCommand = null, extraPayload = {}) {
  const panel = showLiveRunPanel(workflowId, workflowName, cardEl);
  if (!panel) return;

  const btn = panel.querySelector(`#live-run-btn-${workflowId}`);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;

    btn.disabled = true;

    const email = typeof (window.__currentUser || {}).email === 'string'
      ? window.__currentUser.email : '';

    console.log("EXTRA PAYLOAD:", extraPayload);
    // 🔥 NO INPUT, PURE AUTO MODE
    const payload = {
      email,
      ...extraPayload
    };

    const formEl = document.getElementById(`live-form-${workflowId}`);
    const stepsEl = document.getElementById(`live-steps-${workflowId}`);
    if (formEl) formEl.style.display = 'none';
    if (stepsEl) stepsEl.style.display = '';

    stepsEl.innerHTML = `
      <div class="live-step live-step--pending">
        <div class="live-step-dot live-dot--spin"><i class="fas fa-circle-notch fa-spin"></i></div>
        <div class="live-step-info"><div class="live-step-name">Sending request to n8n…</div></div>
      </div>`;

    await _executeRun(workflowId, payload);
  }, { once: true });
}

async function _executeRun(workflowId, payload) {
  const stepsEl = document.getElementById(`live-steps-${workflowId}`);
  const footerEl = document.getElementById(`live-footer-${workflowId}`);

  // ── Local helpers ──
  function addStep(label, status = 'running', detail = '') {
    const el = document.createElement('div');
    el.className = `live-step live-step--${status}`;
    el.innerHTML = `
    <div class="live-step-dot live-dot--${status}">
      <i class="fas fa-${status === 'running' ? 'circle-notch fa-spin' : status === 'success' ? 'check' : 'times'}"></i>
    </div>
    <div class="live-step-info">
      <div class="live-step-name">${escapeHtml(label)}</div>
      ${detail ? `<div class="live-step-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`;
    stepsEl.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return el;
  }

  function updateLastStep(status, detail = '') {
    const steps = stepsEl.querySelectorAll('.live-step');
    const last = steps[steps.length - 1];
    if (!last) return;
    last.className = `live-step live-step--${status}`;
    const dot = last.querySelector('.live-step-dot');
    dot.className = `live-step-dot live-dot--${status}`;
    dot.innerHTML = `<i class="fas fa-${status === 'success' ? 'check' : 'times'}"></i>`;
    if (detail) {
      let d = last.querySelector('.live-step-detail');
      if (!d) { d = document.createElement('div'); d.className = 'live-step-detail'; last.querySelector('.live-step-info').appendChild(d); }
      d.textContent = detail;
    }
  }

  function successFooter() {
    return `
    <div class="live-result-bar live-result--ok">
      <span style="color:var(--success)">
        <i class="fas fa-check-circle"></i> Workflow triggered successfully
      </span>
      <button class="wf-btn secondary" style="font-size:11px;padding:5px 10px"
        onclick="window.location.hash='/run-history/${workflowId}'">
        <i class="fas fa-history"></i> History
      </button>
    </div>`;
  }

  function showRunError(message, hint = '') {
    footerEl.innerHTML = `
    <div class="live-result-bar live-result--err">
      <div style="flex:1">
        <div style="color:var(--accent);font-weight:700;margin-bottom:4px">
          <i class="fas fa-exclamation-triangle"></i> Execution failed
        </div>
        <div style="font-size:11px;color:#8a9bc0">${escapeHtml(message)}</div>
        ${hint ? `<div style="font-size:11px;color:#5a6f8a;margin-top:4px"><i class="fas fa-info-circle"></i> ${escapeHtml(hint)}</div>` : ''}
      </div>
      <a href="http://localhost:5678/workflow/${workflowId}" target="_blank"
         class="wf-btn secondary" style="font-size:11px;padding:5px 10px;text-decoration:none;white-space:nowrap">
        <i class="fas fa-external-link-alt"></i> Open in n8n
      </a>
    </div>`;
  }

  // ── Main flow ──
  try {
    updateLastStep('success', 'Connected to n8n');
    await delay(300);

    addStep('Triggering workflow execution…', 'running');
    await delay(200);

    // Pass the payload (action, email, etc.) to the backend which forwards to n8n webhook
    const result = await api.runWorkflow(workflowId, payload);
    const execId = result?.execution?.id || result?.execution?.executionId;

    // If execId starts with "wh-" it's a fallback fake ID — don't try to poll it
    const canPoll = execId && !String(execId).startsWith('wh-');

    if (canPoll) {
      updateLastStep('success', `Execution ID: ${execId}`);
      await delay(300);

      addStep('Waiting for completion…', 'running');
      const finalData = await pollExecution(execId);

      if (finalData) {
        const nodes = finalData.timeline || [];
        updateLastStep('success', `${nodes.length} nodes executed`);
        await delay(200);

        if (nodes.length) {
          addStep('Building execution report…', 'running');
          await delay(400);
          updateLastStep('success');
          renderInlineResults(footerEl, finalData);
          // Notify dashboard to refresh stats
          window.dispatchEvent(new CustomEvent('cloudpilot:execution-complete'));
        }

        const allOk = nodes.every(n => n.status !== 'failed');
        const histTarget = execId ? `/execution/${execId}` : `/run-history/${workflowId}`;
        footerEl.insertAdjacentHTML('beforeend', `
        <div class="live-result-bar ${allOk ? 'live-result--ok' : 'live-result--err'}">
          <span style="color:${allOk ? 'var(--success)' : 'var(--accent)'}">
            <i class="fas fa-${allOk ? 'check-circle' : 'exclamation-triangle'}"></i>
            ${allOk ? 'All nodes succeeded' : 'Some nodes failed — check details'}
          </span>
          <button class="wf-btn secondary" style="font-size:11px;padding:5px 10px"
            onclick="window.location.hash='${histTarget}'">
            <i class="fas fa-history"></i> Full History
          </button>
        </div>`);
      } else {
        // Poll timed out — workflow still running or very slow
        addStep('Workflow running in background', 'success');
        footerEl.innerHTML = successFooter();
      }
    } else {
      // Webhook fire-and-forget — no real execution ID returned
      updateLastStep('success', 'Workflow dispatched');
      await delay(200);
      addStep('Workflow dispatched', 'success', 'n8n is processing in the background');
      footerEl.innerHTML = successFooter();
    }

  } catch (err) {
    updateLastStep('error', err.message);
    showRunError(err.message);
  }
}

// ─────────────────────────────────────────────
// POLLING
// ─────────────────────────────────────────────
async function pollExecution(execId) {
  for (let i = 0; i < 24; i++) {
    await delay(2500);
    try {
      const data = await api.getTimeline(execId);
      if (data?.status && data.status !== 'running') return data;
    } catch (_) { }
  }
  return null;
}

// ─────────────────────────────────────────────
// INLINE RESULTS
// ─────────────────────────────────────────────
function renderInlineResults(container, data) {
  const rows = (data.timeline || []).map(node => {
    const ok = node.status !== 'failed';
    return `
      <div class="inline-node-row">
        <div class="inline-node-icon ${ok ? 'inline-ok' : 'inline-err'}"><i class="fas fa-${ok ? 'check' : 'times'}"></i></div>
        <div class="inline-node-name">${escapeHtml(node.node_name)}</div>
        <div class="inline-node-dur">${formatDuration(node.duration_ms)}</div>
        ${node.error ? `<div class="inline-node-err">${escapeHtml(node.error)}</div>` : ''}
      </div>`;
  }).join('');
  if (rows) container.insertAdjacentHTML('afterbegin', `<div class="inline-nodes-list">${rows}</div>`);
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns true if id is a valid numeric n8n execution/workflow ID.
// n8n IDs are always positive integers. Rejects UUIDs, wh-xxx fake IDs, etc.
function isNumericId(id) {
  return id !== null && id !== undefined && id !== '' && /^\d+$/.test(String(id));
}

// Resolve the numeric n8n execution ID from an execution object.
// engine_execution_ref is set by CloudPilot when storing in Supabase and is always numeric.
// exec.id from n8n API responses is also numeric.
// exec.id from Supabase SELECT is a UUID — skip it if not numeric.
function resolveExecId(exec) {
  if (!exec) return '';
  const ref = exec.engine_execution_ref;
  if (ref && isNumericId(ref)) return String(ref);
  const id = exec.id;
  if (id && isNumericId(id)) return String(id);
  // last resort — n8n_execution_id field
  const ni = exec.n8n_execution_id;
  if (ni && isNumericId(ni)) return String(ni);
  return '';
}

function execStatus(exec) {
  if (exec.status === 'success' || exec.finished === true) return 'success';
  if (exec.status === 'error' || exec.status === 'failed') return 'error';
  if (exec.status === 'running' || exec.finished === false) return 'running';
  return 'unknown';
}

function statusIcon(s) {
  if (s === 'success') return 'check-circle';
  if (s === 'error') return 'times-circle';
  if (s === 'running') return 'circle-notch';
  return 'question-circle';
}

function getDuration(exec) {
  const start = exec.startedAt || exec.started_at;
  const end = exec.stoppedAt || exec.finished_at;
  if (!start || !end) return null;
  return formatDuration(new Date(end) - new Date(start));
}