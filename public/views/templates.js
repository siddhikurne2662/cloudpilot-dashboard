// public/views/templates.js
import { api, escapeHtml } from '../api.js';
import { showModal, showToast, setPageHeader, setTopActions } from '../ui.js';

let _allTemplates = [];
let _savedCredentials = []; // loaded once, reused

export async function templatesView() {
  setPageHeader('Template Marketplace', 'Browse and import pre-built automation templates');
  setTopActions(`
    <div class="search-wrapper">
      <i class="fas fa-search"></i>
      <input type="text" id="searchInput" placeholder="Search templates…" oninput="window._templateSearch(this.value)">
    </div>
  `);

  const grid = document.getElementById('workflowsGrid');
  grid.innerHTML = `<div class="loading-card"><div class="spinner-small"></div><span>Loading templates…</span></div>`;

  try {
    // Load templates + saved credentials in parallel
    const [templateData, credData] = await Promise.all([
      api.getTemplates(),
      api.getCredentials().catch(() => ({ credentials: [] })),
    ]);
    _allTemplates = templateData?.templates || [];
    _savedCredentials = credData?.credentials || [];
    renderTemplates(_allTemplates);
    setupTemplateSearch();
  } catch (err) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-boxes"></i>
        <h3>Failed to load templates</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function renderTemplates(templates) {
  const grid = document.getElementById('workflowsGrid');

  if (!templates.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-boxes"></i>
        <h3>No templates found</h3>
        <p>No workflow files found in storage. Upload JSON workflow files to the "workflow_templates" Supabase Storage bucket.</p>
      </div>
    `;
    return;
  }

  const catColors = { AWS: '#f97316', GCP: '#3b82f6', AZURE: '#8b5cf6', AI: '#8b5cf6', STORAGE: '#06b6d4', MESSAGING: '#10b981', DEFAULT: '#6366f1' };
  const getCatColor = (cat) => {
    const upper = (cat || '').toUpperCase();
    return catColors[Object.keys(catColors).find(k => upper.includes(k))] || catColors.DEFAULT;
  };

  _templateMap.clear();
  grid.innerHTML = templates.map(t => {
    // Storage-based templates use storage_path for install; no credential mapping needed
    _templateMap.set(t.id || t.template_id, { ...t, creds: [] });
    const catColor = getCatColor(t.category);

    return `
      <div class="wf-card template-card">
        <div class="template-header">
          <div class="template-icon" style="background:linear-gradient(135deg,${catColor}22,${catColor}44);color:${catColor}">
            <i class="fas fa-bolt"></i>
          </div>
          <div style="flex:1;min-width:0">
            <h3>${escapeHtml(t.name)}</h3>
            <div class="template-category" style="color:${catColor}">${escapeHtml(t.category || 'General')}</div>
            ${t.node_count ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px"><i class="fas fa-cubes"></i> ${t.node_count} nodes</div>` : ''}
          </div>
        </div>

        <p class="template-desc">${escapeHtml(t.description || 'No description provided')}</p>

        <div class="template-tags">
          ${(t.tags || []).slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>

        <button class="wf-btn primary" style="width:100%;margin-top:1rem"
          onclick="window._importTemplate('${escapeHtml(t.id || t.template_id)}')">
          <i class="fas fa-download"></i> Install Template
        </button>
      </div>
    `;
  }).join('');
}

function normalizeCreds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try { return JSON.parse(raw); } catch { return []; }
}

// Global lookup so onclick handlers can find template data without
// encoding it into HTML attribute strings (which breaks on quotes/brackets).
const _templateMap = new Map();

function setupTemplateSearch() {
  window._templateSearch = (query) => {
    const q = query.toLowerCase();
    if (!q) return renderTemplates(_allTemplates);
    renderTemplates(_allTemplates.filter(t =>
      (t.name || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q) ||
      (t.tags || []).some(tag => tag.toLowerCase().includes(q))
    ));
  };
}

// ─────────────────────────────────────────────
// Import modal — shows credential DROPDOWNS
// populated from saved credentials, not text inputs
// ─────────────────────────────────────────────
window._importTemplate = async (templateId) => {
  const tmpl = _templateMap.get(templateId);
  const templateName = tmpl?.name || templateId;

  showModal('Install Template', `
    <div class="import-form">
      <div class="import-template-name">${escapeHtml(templateName)}</div>

      <div class="form-group">
        <label class="form-label">Workflow Name</label>
        <input type="text" id="importWfName" class="form-input"
          value="${escapeHtml(templateName)}" placeholder="Custom workflow name…">
      </div>

      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;margin-bottom:1rem;font-size:12px;color:var(--text-muted);line-height:1.5">
        <i class="fas fa-magic" style="color:var(--primary)"></i>
        <strong style="color:var(--text-main)">Auto-setup:</strong>
        A <em>CloudPilot Trigger</em> webhook node will be injected so this workflow can run from CloudPilot immediately after install.
      </div>

      <button class="wf-btn primary" style="width:100%"
        onclick="window._doImport('${escapeHtml(templateId)}')">
        <i class="fas fa-download"></i> Install &amp; Set Up
      </button>
    </div>
  `);
};

window._doImport = async (templateId) => {
  const tmpl = _templateMap.get(templateId);
  const name = document.getElementById('importWfName')?.value?.trim();
  const storagePath = tmpl?.storage_path || templateId;

  try {
    const btn = document.querySelector('.modal .wf-btn.primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner-small"></div> Installing…'; }

    const result = await api.installFromStorage({
      storage_path: storagePath,
      workflow_name: name,
    });

    document.getElementById('modal').classList.remove('active');

    showToast(`"${result.workflow?.name || 'Workflow'}" installed successfully!`, 'success');
    setTimeout(() => { window.location.hash = '/dashboard'; }, 1000);
  } catch (err) {
    showToast('Install failed: ' + err.message, 'error');
    const btn = document.querySelector('.modal .wf-btn.primary');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Install & Set Up'; }
  }
};