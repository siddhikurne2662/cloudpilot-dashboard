// public/views/runhistory.js - Global run history page (all executions)
import { api, escapeHtml, formatDateTime, formatDuration } from '../api.js';
import { setPageHeader, setTopActions } from '../ui.js';

export async function runHistoryView(params) {
  // params[0] is optional workflowId for filtered view
  const workflowId = params && params[0];

  setPageHeader(
    workflowId ? 'Workflow History' : 'Run History',
    workflowId ? `Execution history for workflow ${workflowId}` : 'All recent workflow executions'
  );
  setTopActions(
    workflowId
      ? `<button class="btn-create" onclick="window.location.hash='/workflows'">
           <i class="fas fa-arrow-left"></i> Back to Workflows
         </button>`
      : ''
  );

  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading history…</span></div>`;

  try {
    let executions = [];
    if (workflowId) {
      const data = await api.getWorkflowHistory(workflowId);
      executions = data?.data || data?.executions || [];
    } else {
      const data = await api.getExecutions();
      executions = data?.executions || [];
    }

    renderHistory(executions, workflowId);
  } catch (err) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>Failed to load history</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>`;
  }
}

function renderHistory(executions, workflowId) {
  const grid = document.getElementById('workflowsGrid');

  if (!executions.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <i class="fas fa-history"></i>
        <h3>No executions yet</h3>
        <p>${workflowId ? 'This workflow has not been run yet.' : 'Run a workflow to see its history here.'}</p>
        <button class="btn-create" onclick="window.location.hash='/workflows'">
          <i class="fas fa-project-diagram"></i> Go to Workflows
        </button>
      </div>`;
    return;
  }

  grid.innerHTML = `
    <div class="wf-table-wrap" style="grid-column:1/-1">
      <table class="wf-table">
        <thead>
          <tr>
            <th>#</th>
            ${!workflowId ? '<th>Workflow</th>' : ''}
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${executions.map((exec, i) => buildExecRow(exec, executions.length - i, !workflowId)).join('')}
        </tbody>
      </table>
    </div>`;
}

function buildExecRow(exec, num, showWorkflow) {
  // Resolve the numeric n8n execution ID.
  // engine_execution_ref is always the numeric n8n ID when stored by CloudPilot.
  // exec.id from Supabase is a UUID — skip it if not numeric.
  // exec.id from n8n API responses is numeric.
  const execId = resolveNumericExecId(exec);
  const status = getStatus(exec);
  const started = exec.startedAt || exec.started_at;
  const duration = getDuration(exec);
  const wfId = exec.workflowId || exec.workflow_id || exec.engine_workflow_ref || '';

  // Only route to /execution/:id when we have a valid numeric execution ID.
  // Otherwise route to workflow history as fallback.
  const timelineHash = execId
    ? `/execution/${execId}`
    : (wfId ? `/run-history/${wfId}` : '/run-history');

  const statusColors = {
    success: 'active',
    error: 'error',
    running: 'running',
    unknown: 'inactive',
  };

  return `
    <tr>
      <td><strong>#${num}</strong></td>
      ${showWorkflow ? `<td><span class="wf-id">${escapeHtml(String(wfId))}</span></td>` : ''}
      <td>
        <span class="status-badge ${statusColors[status] || 'inactive'}">
          <span class="status-dot ${status === 'running' ? 'pulse' : ''}"></span>
          ${status}
        </span>
      </td>
      <td>${started ? formatDateTime(started) : '—'}</td>
      <td>${duration || '—'}</td>
      <td>
        <button class="wf-btn secondary" onclick="window.location.hash='${escapeHtml(timelineHash)}'">
          <i class="fas fa-code-branch"></i> Timeline
        </button>
      </td>
    </tr>`;
}

function getStatus(exec) {
  if (exec.status === 'success' || exec.finished === true) return 'success';
  if (exec.status === 'error' || exec.status === 'failed') return 'error';
  if (exec.status === 'running' || exec.finished === false) return 'running';
  return exec.status || 'unknown';
}

function getDuration(exec) {
  if (exec.duration_ms) return formatDuration(exec.duration_ms);
  const start = exec.startedAt || exec.started_at;
  const end = exec.stoppedAt || exec.finished_at;
  if (start && end) {
    const ms = new Date(end) - new Date(start);
    return formatDuration(ms);
  }
  return null;
}

// Returns the numeric n8n execution ID from an execution row.
// engine_execution_ref is the numeric n8n ID stored by CloudPilot.
// exec.id from Supabase is a UUID — not valid for /execution/:id route.
// exec.id from n8n API responses IS numeric and valid.
function resolveNumericExecId(exec) {
  if (!exec) return '';
  const isNum = (v) => v !== null && v !== undefined && v !== '' && /^\d+$/.test(String(v));
  if (isNum(exec.engine_execution_ref)) return String(exec.engine_execution_ref);
  if (isNum(exec.id)) return String(exec.id);
  if (isNum(exec.n8n_execution_id)) return String(exec.n8n_execution_id);
  return '';
}