// public/api.js - Centralized API client
let _token = null;

export function setToken(token) { _token = token; }
export function getToken() { return _token; }

async function request(url, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (networkErr) {
    throw new Error(`Network error: cannot reach server — ${networkErr.message}`);
  }

  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }

  // Always try to parse the body for error details
  let data;
  const text = await res.text().catch(() => '');
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    // Build the most useful error message possible
    // Priority: data.error > data.message > data.hint > raw text > HTTP status
    const msg = data?.error || data?.message || data?.raw || `HTTP ${res.status}`;
    const hint = data?.hint ? ` — ${data.hint}` : '';
    throw new Error(`${msg}${hint}`);
  }

  return data;
}

export const api = {
  // Workflows
  getWorkflows:       ()         => request('/api/workflows'),
  getWorkflow:        (id)       => request(`/api/workflows/${id}`),
  runWorkflow:        (id, payload) => request(`/api/workflows/${id}/run`, 'POST', payload || {}),
  toggleWorkflow:     (id, act)  => request(`/api/workflows/${id}/toggle`, 'POST', { active: act }),
  deleteWorkflow:     (id)       => request(`/api/workflows/${id}`, 'DELETE'),
  getWorkflowHistory: (id)       => request(`/api/workflows/${id}/history`),

  // Credentials
  getCredentials:   ()     => request('/api/credentials'),
  addCredential:    (data) => request('/api/credentials', 'POST', data),
  deleteCredential: (id)   => request(`/api/credentials/${id}`, 'DELETE'),

  // Templates
  getTemplates:       ()     => request('/api/templates'),
  importTemplate:     (data) => request('/api/templates/import', 'POST', data),
  installFromStorage: (data) => request('/api/templates/install-from-storage', 'POST', data),

  // Executions
  getExecutions:  ()   => request('/api/executions'),
  getExecution:   (id) => request(`/api/executions/${id}`),
  getTimeline:    (id) => request(`/api/executions/${id}/timeline`),

  // Health / Config
  health: () => request('/api/health'),
  config: () => request('/api/config'),
};

export function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

export function formatDate(dateStr) {
  if (!dateStr) return 'Never';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return dateStr; }
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try { return new Date(dateStr).toLocaleString(); }
  catch { return dateStr; }
}

export function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}