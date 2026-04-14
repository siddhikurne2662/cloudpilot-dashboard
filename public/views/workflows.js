// public/views/workflows.js - All Workflows page
import { api, escapeHtml, formatDate } from '../api.js';
import { showToast, setPageHeader, setTopActions } from '../ui.js';
import { runWithLivePanel } from './timeline.js';

let _workflows = [];

export async function workflowsView() {
  setPageHeader('All Workflows', 'View and manage all your automation workflows');
  setTopActions(`
    <button class="btn-create" onclick="window.location.hash='/templates'">
      <i class="fas fa-plus"></i> New Workflow
    </button>
  `);

  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading workflows…</span></div>`;

  try {
    const data = await api.getWorkflows();
    _workflows = data?.data || data?.workflows || [];
    renderWorkflowsTable(_workflows);
  } catch (err) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-plug"></i>
        <h3>Cannot reach n8n</h3>
        <p>${escapeHtml(err.message)}</p>
        <button class="btn-create" onclick="workflowsView()">
          <i class="fas fa-sync-alt"></i> Retry
        </button>
      </div>`;
  }
}

function renderWorkflowsTable(workflows) {
  const grid = document.getElementById('workflowsGrid');

  if (!workflows.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <i class="fas fa-project-diagram"></i>
        <h3>No workflows yet</h3>
        <p>Import a template to create your first automation</p>
        <button class="btn-create" onclick="window.location.hash='/templates'">
          <i class="fas fa-boxes"></i> Browse Templates
        </button>
      </div>`;
    return;
  }

  grid.innerHTML = `
    <div class="wf-table-wrap" style="grid-column:1/-1">
      <table class="wf-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Nodes</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${workflows.map(wf => buildTableRow(wf)).join('')}
        </tbody>
      </table>
    </div>`;
}

function buildTableRow(wf) {
  const nodeCount = (wf.nodes || []).length;
  const id = escapeHtml(String(wf.id));
  const name = escapeHtml(wf.name);
  const safeName = escapeHtml(wf.name).replace(/'/g, "\\'");

  return `
    <tr id="wfrow-${id}">
      <td class="wf-table-name">
        <strong>${name}</strong>
        <span class="wf-id">${id}</span>
      </td>
      <td>
        <span class="status-badge ${wf.active ? 'active' : 'inactive'}">
          <span class="status-dot"></span>${wf.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td>${nodeCount}</td>
      <td>${formatDate(wf.updatedAt)}</td>
      <td class="wf-table-actions">
        <button class="wf-btn primary" onclick="window._wfRun('${id}', '${safeName}', this)">
          <i class="fas fa-play"></i> Run
        </button>
        <button class="wf-btn secondary" onclick="window.location.hash='/run-history/${id}'">
          <i class="fas fa-history"></i> History
        </button>
        <button class="wf-btn ${wf.active ? 'warning' : 'success'}" onclick="window._wfToggle('${id}', ${!wf.active}, '${safeName}', this)">
          <i class="fas fa-${wf.active ? 'pause' : 'play-circle'}"></i>
          ${wf.active ? 'Deactivate' : 'Activate'}
        </button>
        <button class="wf-btn danger" onclick="window._wfDelete('${id}', '${safeName}')">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>`;
}

// ─────────────────────────────────────────────
// deriveTaskType — mirrors the exact same if/else order as your
// n8n "Extract Data from Email" node so they always agree.
// Called with the workflow NAME so no extra config is needed.
// ─────────────────────────────────────────────
function deriveTaskType(workflowName) {
  const t = (workflowName || '').toLowerCase();

  // bucket
  if ((t.includes('delete') || t.includes('remove')) && t.includes('bucket')) return 'delete_bucket';
  if ((t.includes('create') || t.includes('make')) && t.includes('bucket')) return 'create_bucket';
  if ((t.includes('list') || t.includes('show') || t.includes('get')) && t.includes('bucket')) return 'list_buckets';

  // object
  if (t.includes('upload')) return 'upload_object';
  if ((t.includes('delete') || t.includes('remove')) && t.includes('object')) return 'delete_object';
  if ((t.includes('get') || t.includes('fetch')) && t.includes('object')) return 'get_object';

  // instance
  if (t.includes('start') && t.includes('instance')) return 'start_instance';
  if (t.includes('stop') && t.includes('instance')) return 'stop_instance';

  // user
  if (t.includes('create') && t.includes('user')) return 'create_user';
  if (t.includes('delete') && t.includes('user')) return 'delete_user';

  return '';
}

// ─────────────────────────────────────────────
// _wfRun — single click, derives task_type from workflow name,
// passes it as extraPayload so Extract node short-circuits cleanly.
// ─────────────────────────────────────────────
window._wfRun = async (id, name, btnEl) => {
  const row = document.getElementById(`wfrow-${id}`);
  const wf = _workflows.find(w => String(w.id) === String(id)) || null;

  // Derive task_type from workflow name — same logic as n8n Extract node.
  // This is sent as { task_type } in the webhook body so the Extract node
  // can short-circuit without needing to parse any command string.
  const task_type = deriveTaskType(name);
  const extraPayload = task_type ? { task_type } : {};

  await runWithLivePanel(
    id,
    name,
    row || document.getElementById('workflowsGrid'),
    wf,
    null,        // optionalCommand — never used from dashboard
    extraPayload // { task_type: "list_buckets" } etc.
  );
};

window._wfToggle = async (id, active, name, btnEl) => {
  try {
    await api.toggleWorkflow(id, active);
    const wf = _workflows.find(w => String(w.id) === String(id));
    if (wf) wf.active = active;
    showToast(`${active ? '✅ Activated' : '⏸ Deactivated'}: ${name}`, active ? 'success' : 'info');
    renderWorkflowsTable(_workflows);
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
};

window._wfDelete = async (id, name) => {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await api.deleteWorkflow(id);
    _workflows = _workflows.filter(w => String(w.id) !== String(id));
    showToast('🗑️ Workflow deleted', 'success');
    renderWorkflowsTable(_workflows);
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
};