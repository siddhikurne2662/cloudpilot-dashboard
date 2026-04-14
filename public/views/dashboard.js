// public/views/dashboard.js
import { api, escapeHtml, formatDate } from '../api.js';
import { showToast, setPageHeader, setTopActions } from '../ui.js';
import { runWithLivePanel } from './timeline.js';
import { renderOnboardingChecklist, isOnboarded } from '../onboarding.js';

let _allWorkflows = [];
// Track last-run timestamps for sorting (in-memory, resets on page reload)
const _lastRunAt = new Map();

export async function dashboardView() {
  setPageHeader('Dashboard', 'Manage and run your automation workflows');
  setTopActions(`
    <div class="search-wrapper">
      <i class="fas fa-search"></i>
      <input type="text" id="searchInput" placeholder="Search workflows…" oninput="window._dashboardSearch(this.value)">
    </div>
    <button class="btn-create" onclick="window.location.hash='/templates'">
      <i class="fas fa-plus"></i> New Workflow
    </button>
  `);

  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading workflows…</span></div>`;

  try {
    const data = await api.getWorkflows();
    _allWorkflows = data?.data || data?.workflows || [];
    updateStats(_allWorkflows);
    await renderDashboardContent(_sortWorkflows(_allWorkflows));
    setupSearch();
  } catch (err) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-plug"></i>
        <h3>Cannot reach n8n</h3>
        <p>${escapeHtml(err.message)}</p>
        <button class="btn-create" onclick="window.location.hash='/dashboard'">
          <i class="fas fa-sync-alt"></i> Retry
        </button>
      </div>`;
    updateStatsError();
  }

  // Refresh stats after execution completes
  window.removeEventListener('cloudpilot:execution-complete', window._dashRefreshHandler);
  window._dashRefreshHandler = () => {
    api.getWorkflows().then(data => {
      _allWorkflows = data?.data || data?.workflows || [];
      updateStats(_allWorkflows);
    }).catch(() => { });
  };
  window.addEventListener('cloudpilot:execution-complete', window._dashRefreshHandler);
}

// Sort: recently-run first, then by name
function _sortWorkflows(workflows) {
  return [...workflows].sort((a, b) => {
    const aRun = _lastRunAt.get(String(a.id)) || 0;
    const bRun = _lastRunAt.get(String(b.id)) || 0;
    if (aRun !== bRun) return bRun - aRun;
    return (a.name || '').localeCompare(b.name || '');
  });
}

async function renderDashboardContent(workflows) {
  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = '';

  // Onboarding checklist
  const onboardingContainer = document.createElement('div');
  onboardingContainer.id = 'onboardingContainer';
  onboardingContainer.style.cssText = 'grid-column:1/-1';
  grid.appendChild(onboardingContainer);
  if (!isOnboarded()) {
    await renderOnboardingChecklist(onboardingContainer);
  }

  if (!workflows.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.style.gridColumn = '1 / -1';
    emptyEl.innerHTML = `
      <i class="fas fa-project-diagram"></i>
      <h3>No workflows yet</h3>
      <p>Import a template to get started with your first automation</p>
      <button class="btn-create" onclick="window.location.hash='/templates'">
        <i class="fas fa-boxes"></i> Browse Templates
      </button>`;
    grid.appendChild(emptyEl);
    return;
  }

  workflows.forEach(wf => {
    const cardEl = document.createElement('div');
    cardEl.innerHTML = buildWorkflowCard(wf);
    grid.appendChild(cardEl.firstElementChild);
  });
}

function updateStats(workflows) {
  const total = workflows.length;
  const active = workflows.filter(w => w.active).length;
  const el = (id) => document.getElementById(id);
  if (el('totalWorkflows')) el('totalWorkflows').textContent = total;
  if (el('activeWorkflows')) el('activeWorkflows').textContent = active;
  if (el('inactiveWorkflows')) el('inactiveWorkflows').textContent = total - active;
  if (el('systemStatus')) el('systemStatus').textContent = 'Online';
  if (el('lastSync')) el('lastSync').textContent = `Synced ${new Date().toLocaleTimeString()}`;
}

function updateStatsError() {
  const el = (id) => document.getElementById(id);
  if (el('systemStatus')) el('systemStatus').textContent = 'Offline';
  if (el('lastSync')) el('lastSync').textContent = 'Failed to sync';
}

function buildWorkflowCard(wf) {
  const nodeCount = (wf.nodes || []).length;
  const id = escapeHtml(String(wf.id));
  const safeName = escapeHtml(wf.name).replace(/'/g, "\\'");
  const wasRecentlyRun = _lastRunAt.has(String(wf.id));

  return `
    <div class="wf-card${wasRecentlyRun ? ' wf-card--just-run' : ''}" id="wfcard-${id}">
      <div class="wf-header">
        <div class="wf-title-group">
          <h3 title="${escapeHtml(wf.name)}">${escapeHtml(wf.name)}</h3>
          <span class="wf-id">${id}</span>
        </div>
        <label class="toggle-switch" title="${wf.active ? 'Deactivate' : 'Activate'} workflow">
          <input type="checkbox" ${wf.active ? 'checked' : ''}
            onchange="window._toggleWorkflow('${id}', this.checked, '${safeName}', this)">
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="wf-meta">
        <div class="meta-item">
          <i class="fas fa-clock"></i>
          <span>Updated ${formatDate(wf.updatedAt)}</span>
        </div>
        <div class="meta-item">
          <i class="fas fa-cubes"></i>
          <span>${nodeCount} node${nodeCount !== 1 ? 's' : ''}</span>
        </div>
        ${wasRecentlyRun ? `
        <div class="meta-item" style="color:var(--primary)">
          <i class="fas fa-bolt" style="opacity:1"></i>
          <span style="font-weight:600">Just run</span>
        </div>` : ''}
      </div>

      <div class="wf-status-row">
        <span class="status-badge ${wf.active ? 'active' : 'inactive'}">
          <span class="status-dot"></span>
          ${wf.active ? 'Active' : 'Inactive'}
        </span>
        <span class="wf-node-pill">${nodeCount} node${nodeCount !== 1 ? 's' : ''}</span>
      </div>

      <div class="wf-actions">
        <button class="wf-btn primary" id="runbtn-${id}"
          onclick="window._runWorkflow('${id}', '${safeName}', ${wf.active ? 'true' : 'false'}, this)">
          <i class="fas fa-play"></i> Run
        </button>
        <button class="wf-btn secondary"
          onclick="window.location.hash='/run-history/${id}'">
          <i class="fas fa-history"></i> History
        </button>
        <button class="wf-btn danger" title="Delete workflow"
          onclick="window._deleteWorkflow('${id}', '${safeName}')">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function setupSearch() {
  window._dashboardSearch = (query) => {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? _allWorkflows.filter(wf =>
        (wf.name || '').toLowerCase().includes(q) ||
        String(wf.id).toLowerCase().includes(q)
      )
      : _allWorkflows;

    const grid = document.getElementById('workflowsGrid');
    grid.querySelectorAll('.wf-card').forEach(c => c.remove());

    if (!filtered.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.style.gridColumn = '1 / -1';
      emptyEl.innerHTML = `
        <i class="fas fa-search"></i>
        <h3>No workflows match "${escapeHtml(q)}"</h3>
        <p>Try a different search term</p>`;
      grid.appendChild(emptyEl);
      return;
    }

    _sortWorkflows(filtered).forEach(wf => {
      const cardEl = document.createElement('div');
      cardEl.innerHTML = buildWorkflowCard(wf);
      grid.appendChild(cardEl.firstElementChild);
    });
  };
}

// ─────────────────────────────────────────────
// Run workflow — check active state first
// ─────────────────────────────────────────────
window._runWorkflow = async (id, name, isActive, btnEl) => {
  // Guard: must be active to run
  if (isActive === false || isActive === 'false') {
    showToast('Activate this workflow before running it', 'warning');
    return;
  }

  const card = document.getElementById(`wfcard-${id}`);
  if (!card) return;

  showToast(`Starting "${name}"…`, 'info', 2000);

  // Look up the full workflow object so timeline can derive a command from its name
  const wf = _allWorkflows.find(w => String(w.id) === String(id)) || null;

  try {
    await runWithLivePanel(id, name, card, wf);
    // Move this card to the top by recording run time
    _lastRunAt.set(String(id), Date.now());
    // Re-sort cards without full reload
    _promoteCard(id);
    window.dispatchEvent(new CustomEvent('cloudpilot:execution-complete'));
  } catch (_) {
    // runWithLivePanel handles its own error display
  }
};

// Move the just-run card to the top of the grid visually
function _promoteCard(id) {
  const grid = document.getElementById('workflowsGrid');
  const card = document.getElementById(`wfcard-${id}`);
  if (!grid || !card) return;

  // Add highlight class
  card.classList.add('wf-card--just-run');

  // Move after the onboarding container (first non-card child)
  const anchor = grid.querySelector('#onboardingContainer') || grid.firstElementChild;
  if (anchor && anchor !== card && anchor.nextSibling !== card) {
    grid.insertBefore(card, anchor.nextSibling);
  }
}

// ─────────────────────────────────────────────
// Toggle
// ─────────────────────────────────────────────
window._toggleWorkflow = async (id, active, name, checkboxEl) => {
  const card = document.getElementById(`wfcard-${id}`);
  const badge = card?.querySelector('.status-badge');
  if (badge) {
    badge.className = `status-badge ${active ? 'active' : 'inactive'}`;
    badge.innerHTML = `<span class="status-dot"></span>${active ? 'Active' : 'Inactive'}`;
  }

  // Update the run button's isActive arg
  const runBtn = document.getElementById(`runbtn-${id}`);
  if (runBtn) {
    runBtn.setAttribute('onclick',
      `window._runWorkflow('${id}', '${name}', ${active}, this)`);
  }

  try {
    await api.toggleWorkflow(id, active);
    const wf = _allWorkflows.find(w => String(w.id) === String(id));
    if (wf) wf.active = active;
    updateStats(_allWorkflows);
    showToast(`${active ? 'Activated' : 'Deactivated'}: ${name}`, active ? 'success' : 'info');
  } catch (err) {
    if (checkboxEl) checkboxEl.checked = !active;
    if (badge) {
      badge.className = `status-badge ${!active ? 'active' : 'inactive'}`;
      badge.innerHTML = `<span class="status-dot"></span>${!active ? 'Active' : 'Inactive'}`;
    }
    showToast(err.message, 'error');
  }
};

// ─────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────
window._deleteWorkflow = async (id, name) => {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await api.deleteWorkflow(id);
    _allWorkflows = _allWorkflows.filter(w => String(w.id) !== String(id));
    _lastRunAt.delete(String(id));
    const card = document.getElementById(`wfcard-${id}`);
    if (card) {
      card.style.transition = 'opacity 0.2s, transform 0.2s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.97)';
      setTimeout(() => { card.remove(); updateStats(_allWorkflows); }, 220);
    }
    showToast(`"${name}" deleted`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
};