// public/script.js - CloudPilot SPA entry point
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { setToken, api } from './api.js';
import { initRouter, defineRoute } from './router.js';
import { setActiveNav } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { templatesView } from './views/templates.js';
import { credentialsView } from './views/credentials.js';
import { settingsView } from './views/settings.js';
import { timelineView } from './views/timeline.js';
import { workflowsView } from './views/workflows.js';
import { runHistoryView } from './views/runhistory.js';

let supabase;
let currentUser;

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
async function init() {
  const overlay = document.getElementById('loadingOverlay');

  try {
    // Fetch backend config (Supabase public keys)
    const config = await fetch('/api/config').then(r => r.json());

    // Demo mode banner
    if (config.demoMode) {
      showDemoBanner();
    }

    // Initialize Supabase
    if (config.supabase?.url && config.supabase?.anonKey) {
      supabase = createClient(config.supabase.url, config.supabase.anonKey);
      window.supabase = supabase;

      // Check session
      const { data: { session }, error } = await supabase.auth.getSession();

      if (error || (!session && !config.demoMode)) {
        window.location.href = '/login.html';
        return;
      }

      if (session) {
        setToken(session.access_token);
        currentUser = session.user;
        window._currentUser = currentUser;
        updateUserUI(session.user);
      }

      // Auth state listener
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          window.location.href = '/login.html';
        } else if (session) {
          setToken(session.access_token);
          currentUser = session.user;
          window._currentUser = currentUser;
        }
      });

      // Real-time subscriptions
      if (session && config.supabase.url) {
        setupRealtimeSubscriptions();
      }
    } else if (config.demoMode) {
      // Demo mode — no real auth needed
      currentUser = { email: 'demo@cloudpilot.dev', user_metadata: { full_name: 'Demo User' } };
      window._currentUser = currentUser;
      updateUserUI(currentUser);
    } else {
      showConfigError('Supabase is not configured on the server. Please set SUPABASE_URL and SUPABASE_ANON_KEY in .env');
    }

  } catch (err) {
    console.error('Init error:', err);
    if (!window.location.hash.includes('login')) {
      showConfigError(err.message);
    }
  } finally {
    overlay?.classList.add('hidden');
  }

  // Setup nav click handlers
  setupNavigation();

  // Setup SPA routes
  defineRoute('/dashboard', async () => { setActiveNav('dashboard'); await dashboardView(); });
  defineRoute('/templates', async () => { setActiveNav('templates'); await templatesView(); });
  defineRoute('/credentials', async () => { setActiveNav('credentials'); await credentialsView(); });
  defineRoute('/settings', async () => { setActiveNav('settings'); await settingsView(); });
  defineRoute('/execution', async (params) => { setActiveNav('execution'); await timelineView(params); });
  defineRoute('/workflow', async (params) => { setActiveNav('dashboard'); await timelineView(params); });
  defineRoute('/workflows', async () => { setActiveNav('workflows'); await workflowsView(); });
  defineRoute('/run-history', async (params) => { setActiveNav('run-history'); await runHistoryView(params); });
  defineRoute('/executions', async (params) => { setActiveNav('executions'); await runHistoryView(params); });

  initRouter();
}

// ─────────────────────────────────────────────
// USER UI
// ─────────────────────────────────────────────
function updateUserUI(user) {
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const email = user?.email || '';
  const initials = fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const nameEl = document.getElementById('userName');
  const emailEl = document.getElementById('userEmail');
  const avatarEl = document.getElementById('userAvatar');

  if (nameEl) nameEl.textContent = fullName;
  if (emailEl) emailEl.textContent = email;
  if (avatarEl) avatarEl.textContent = initials;
}

// ─────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────
function setupNavigation() {
  const navMap = {
    'Dashboard': '/dashboard',
    'Workflows': '/workflows',
    'Executions': '/executions',
    'Templates': '/templates',
    'Credentials': '/credentials',
    'Settings': '/settings',
  };

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const span = item.querySelector('span');
      if (!span) return;
      const text = span.textContent.trim();
      const route = navMap[text];
      if (route) window.location.hash = route;
    });
  });
}

// ─────────────────────────────────────────────
// REAL-TIME SUBSCRIPTIONS
// ─────────────────────────────────────────────
function setupRealtimeSubscriptions() {
  if (!supabase || !currentUser) return;

  // Live execution status updates
  supabase
    .channel('executions-changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'executions',
      filter: `user_id=eq.${currentUser.id}`,
    }, (payload) => {
      console.log('📡 Execution update:', payload);
      // Trigger UI update if on dashboard
      const hash = window.location.hash;
      if (hash.includes('dashboard') || hash === '' || hash === '#') {
        // Refresh stats silently
        api.getWorkflows().then(data => {
          const workflows = data?.data || data?.workflows || [];
          const total = workflows.length;
          const active = workflows.filter(w => w.active).length;
          const el_total = document.getElementById('totalWorkflows');
          const el_active = document.getElementById('activeWorkflows');
          const el_inactive = document.getElementById('inactiveWorkflows');
          if (el_total) el_total.textContent = total;
          if (el_active) el_active.textContent = active;
          if (el_inactive) el_inactive.textContent = total - active;
        }).catch(() => {});
      }
    })
    .subscribe();
}

// ─────────────────────────────────────────────
// DEMO BANNER
// ─────────────────────────────────────────────
function showDemoBanner() {
  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  banner.innerHTML = `
    <i class="fas fa-flask"></i>
    <strong>Demo Mode Active</strong> — No real n8n or Supabase required. Data is mocked.
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  document.querySelector('.main-wrapper')?.style.setProperty('padding-top', '3.5rem');
}

// ─────────────────────────────────────────────
// CONFIG ERROR
// ─────────────────────────────────────────────
function showConfigError(msg) {
  const grid = document.getElementById('workflowsGrid');
  if (grid) {
    grid.innerHTML = `
      <div class="empty-state" style="border-color:var(--accent)">
        <i class="fas fa-exclamation-triangle" style="color:var(--accent)"></i>
        <h3>Configuration Error</h3>
        <p>${msg}</p>
        <p style="font-size:12px;margin-top:0.5rem">Check your .env file and restart the server</p>
      </div>
    `;
  }
}

// ─────────────────────────────────────────────
// GLOBALS
// ─────────────────────────────────────────────
window._logout = async () => {
  try {
    if (supabase) await supabase.auth.signOut();
  } finally {
    window.location.href = '/login.html';
  }
};

// Legacy compat
window.logout = window._logout;
window.loadWorkflows = () => { window.location.hash = '/dashboard'; };
window.switchView = (view) => { window.location.hash = `/${view}`; };

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
init();