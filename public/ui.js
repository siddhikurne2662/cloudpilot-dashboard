// public/ui.js - Shared UI utilities

export function showModal(title, content) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = content;
  document.getElementById('modal').classList.add('active');
}

export function closeModal() {
  document.getElementById('modal').classList.remove('active');
}
window.closeModal = closeModal;

export function setPageHeader(title, subtitle) {
  const h1 = document.querySelector('.page-header h1');
  const p = document.querySelector('.page-header p');
  if (h1) h1.textContent = title;
  if (p) p.textContent = subtitle || '';
}

export function setTopActions(html) {
  const el = document.querySelector('.top-actions');
  if (el) el.innerHTML = html;
}

// ─────────────────────────────────────────────
// Toast system — stacked, top-right, light-themed
// Types: success | error | info | warning
// ─────────────────────────────────────────────
let _toastContainer = null;

function getToastContainer() {
  if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.id = 'toastContainer';
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

export function showToast(message, type = 'info', duration = 3500) {
  const container = getToastContainer();

  const icons = {
    success: 'check-circle',
    error:   'exclamation-circle',
    info:    'info-circle',
    warning: 'exclamation-triangle',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fas fa-${icons[type] || 'info-circle'}"></i>
    <span>${message}</span>
    <button onclick="this.parentElement.remove()" style="
      background:none;border:none;cursor:pointer;
      color:inherit;opacity:0.5;font-size:14px;
      padding:0 0 0 4px;line-height:1;
    "><i class="fas fa-times"></i></button>
  `;

  container.appendChild(toast);

  // Trigger show animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });

  // Auto-dismiss
  const timer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
  }, duration);

  // Click to dismiss early
  toast.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I') {
      clearTimeout(timer);
      toast.classList.remove('show');
      setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
    }
  });
}

// ─────────────────────────────────────────────
// Active nav
// ─────────────────────────────────────────────
export function setActiveNav(routeName) {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

  const navMap = {
    dashboard:    'Dashboard',
    workflows:    'Workflows',
    'run-history':'Executions',
    executions:   'Run History',
    templates:    'Templates',
    credentials:  'Credentials',
    settings:     'Settings',
    execution:    'Dashboard',
    workflow:     'Dashboard',
  };

  const targetText = navMap[routeName] || 'Dashboard';

  document.querySelectorAll('.nav-item').forEach(item => {
    const span = item.querySelector('span');
    if (span && span.textContent.trim() === targetText) {
      item.classList.add('active');
    }
  });
}