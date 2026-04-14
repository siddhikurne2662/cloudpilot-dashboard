// public/onboarding.js - SaaS onboarding flow for new users
import { api, escapeHtml } from './api.js';

const ONBOARDING_KEY = 'cloudpilot_onboarded_v2';
const STEPS_KEY = 'cloudpilot_onboarding_steps';

// Steps definition
const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to CloudPilot ⚡',
    subtitle: 'Your command center for cloud automation',
    icon: 'fas fa-microchip',
    color: '#6366f1',
    description: 'CloudPilot lets you control AWS, GCP, and Azure automation workflows — no coding required. Let\'s get you set up in 2 minutes.',
    action: 'Get Started',
    skippable: false,
  },
  {
    id: 'credentials',
    title: 'Connect Your Cloud',
    subtitle: 'Step 1 of 3',
    icon: 'fas fa-key',
    color: '#f59e0b',
    description: 'Add your cloud provider credentials to unlock automation workflows. All secrets are encrypted with AES-256-GCM — we never store plaintext.',
    action: 'Add Credentials',
    actionRoute: '/credentials',
    skippable: true,
    checkFn: async () => {
      try {
        const data = await api.getCredentials();
        return (data?.credentials || []).length > 0;
      } catch { return false; }
    },
  },
  {
    id: 'templates',
    title: 'Import a Workflow',
    subtitle: 'Step 2 of 3',
    icon: 'fas fa-boxes',
    color: '#10b981',
    description: 'Browse our pre-built automation templates for AWS S3 backups, GCP cost monitoring, Azure VM scheduling, and more. One click to import.',
    action: 'Browse Templates',
    actionRoute: '/templates',
    skippable: true,
    checkFn: async () => {
      try {
        const data = await api.getWorkflows();
        return (data?.data || data?.workflows || []).length > 0;
      } catch { return false; }
    },
  },
  {
    id: 'run',
    title: 'Run Your First Workflow',
    subtitle: 'Step 3 of 3',
    icon: 'fas fa-play-circle',
    color: '#f43f5e',
    description: 'Head to your Dashboard and click Run on any workflow. CloudPilot handles the rest — live execution monitoring, node-by-node visualization, and instant alerts.',
    action: 'Go to Dashboard',
    actionRoute: '/dashboard',
    skippable: true,
    checkFn: async () => {
      try {
        const data = await api.getExecutions();
        return (data?.executions || []).length > 0;
      } catch { return false; }
    },
  },
];

export function isOnboarded() {
  return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

export function markOnboarded() {
  localStorage.setItem(ONBOARDING_KEY, 'true');
}

export function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
  localStorage.removeItem(STEPS_KEY);
}

// Check completed steps
function getCompletedSteps() {
  try {
    return JSON.parse(localStorage.getItem(STEPS_KEY) || '[]');
  } catch { return []; }
}

function markStepComplete(stepId) {
  const done = getCompletedSteps();
  if (!done.includes(stepId)) {
    done.push(stepId);
    localStorage.setItem(STEPS_KEY, JSON.stringify(done));
  }
}

// ─────────────────────────────────────────────
// CHECKLIST WIDGET (shown in dashboard for new users)
// ─────────────────────────────────────────────
export async function renderOnboardingChecklist(containerEl) {
  if (!containerEl) return;

  const completed = getCompletedSteps();
  const checkableSteps = STEPS.filter(s => s.checkFn);

  // Check all steps silently
  const statuses = await Promise.all(
    checkableSteps.map(async s => {
      if (completed.includes(s.id)) return true;
      const done = await s.checkFn().catch(() => false);
      if (done) markStepComplete(s.id);
      return done;
    })
  );

  const allDone = statuses.every(Boolean);

  if (allDone) {
    markOnboarded();
    containerEl.innerHTML = '';
    return;
  }

  const progressCount = statuses.filter(Boolean).length;
  const progressPct = Math.round((progressCount / checkableSteps.length) * 100);

  containerEl.innerHTML = `
    <div class="onboarding-checklist" id="onboardingChecklist">
      <div class="onb-header">
        <div class="onb-header-left">
          <div class="onb-icon"><i class="fas fa-rocket"></i></div>
          <div>
            <div class="onb-title">Get Started with CloudPilot</div>
            <div class="onb-subtitle">${progressCount} of ${checkableSteps.length} steps complete</div>
          </div>
        </div>
        <button class="onb-dismiss" onclick="window._dismissOnboarding()" title="Dismiss">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <div class="onb-progress-wrap">
        <div class="onb-progress-bar">
          <div class="onb-progress-fill" style="width:${progressPct}%"></div>
        </div>
        <span class="onb-progress-label">${progressPct}%</span>
      </div>

      <div class="onb-steps">
        ${checkableSteps.map((step, i) => {
          const done = statuses[i];
          return `
            <div class="onb-step ${done ? 'onb-step--done' : ''}">
              <div class="onb-step-icon" style="background:${done ? 'rgba(16,185,129,0.12)' : step.color + '18'};color:${done ? 'var(--success)' : step.color}">
                <i class="fas fa-${done ? 'check' : step.icon.replace('fas fa-', '')}"></i>
              </div>
              <div class="onb-step-body">
                <div class="onb-step-label ${done ? 'onb-step-label--done' : ''}">${escapeHtml(step.title)}</div>
                <div class="onb-step-desc">${escapeHtml(step.description)}</div>
              </div>
              ${!done ? `
                <a class="onb-step-action" onclick="window.location.hash='${step.actionRoute}'">
                  ${escapeHtml(step.action)} <i class="fas fa-arrow-right"></i>
                </a>` : `<span class="onb-step-done-badge"><i class="fas fa-check"></i></span>`}
            </div>`;
        }).join('')}
      </div>
    </div>`;

  window._dismissOnboarding = () => {
    markOnboarded();
    containerEl.innerHTML = '';
  };
}

// ─────────────────────────────────────────────
// WELCOME MODAL (first time only)
// ─────────────────────────────────────────────
export function showWelcomeModal(userName = 'there') {
  // Don't show if already onboarded
  if (isOnboarded() || localStorage.getItem('cloudpilot_welcome_shown')) return;
  localStorage.setItem('cloudpilot_welcome_shown', 'true');

  const overlay = document.createElement('div');
  overlay.id = 'welcomeOverlay';
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `
    <div class="welcome-modal">
      <div class="welcome-bg-orbs">
        <div class="orb orb1"></div>
        <div class="orb orb2"></div>
        <div class="orb orb3"></div>
      </div>

      <div class="welcome-content">
        <div class="welcome-logo">
          <div class="welcome-logo-icon"><i class="fas fa-microchip"></i></div>
          <div class="welcome-logo-ring"></div>
        </div>

        <h1 class="welcome-title">Welcome, ${escapeHtml(userName)}! 👋</h1>
        <p class="welcome-subtitle">
          CloudPilot is your no-code command center for cloud automation.<br>
          Let's get you running your first workflow in under 2 minutes.
        </p>

        <div class="welcome-features">
          <div class="welcome-feature">
            <div class="wf-feat-icon" style="background:rgba(249,115,22,0.12);color:#f97316">
              <i class="fab fa-aws"></i>
            </div>
            <div class="wf-feat-text">
              <div class="wf-feat-title">AWS, GCP, Azure</div>
              <div class="wf-feat-desc">Pre-built workflows for all major clouds</div>
            </div>
          </div>
          <div class="welcome-feature">
            <div class="wf-feat-icon" style="background:rgba(16,185,129,0.12);color:#10b981">
              <i class="fas fa-shield-alt"></i>
            </div>
            <div class="wf-feat-text">
              <div class="wf-feat-title">AES-256 Encrypted</div>
              <div class="wf-feat-desc">Credentials never stored in plaintext</div>
            </div>
          </div>
          <div class="welcome-feature">
            <div class="wf-feat-icon" style="background:rgba(99,102,241,0.12);color:#6366f1">
              <i class="fas fa-chart-line"></i>
            </div>
            <div class="wf-feat-text">
              <div class="wf-feat-title">Live Monitoring</div>
              <div class="wf-feat-desc">Node-by-node execution visualization</div>
            </div>
          </div>
        </div>

        <div class="welcome-steps-preview">
          <div class="wsp-step">
            <div class="wsp-num">1</div>
            <span>Add credentials</span>
          </div>
          <div class="wsp-arrow"><i class="fas fa-chevron-right"></i></div>
          <div class="wsp-step">
            <div class="wsp-num">2</div>
            <span>Import template</span>
          </div>
          <div class="wsp-arrow"><i class="fas fa-chevron-right"></i></div>
          <div class="wsp-step">
            <div class="wsp-num">3</div>
            <span>Run & monitor</span>
          </div>
        </div>

        <div class="welcome-actions">
          <button class="welcome-cta" onclick="window._startOnboarding()">
            <i class="fas fa-rocket"></i> Get Started — It's Free
          </button>
          <button class="welcome-skip" onclick="window._skipOnboarding()">
            Skip intro, take me to dashboard
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('welcome-overlay--visible'));

  window._startOnboarding = () => {
    overlay.remove();
    window.location.hash = '/credentials';
  };

  window._skipOnboarding = () => {
    markOnboarded();
    overlay.remove();
  };
}

// ─────────────────────────────────────────────
// ONBOARDING CSS (injected once)
// ─────────────────────────────────────────────
export function injectOnboardingStyles() {
  if (document.getElementById('onboarding-styles')) return;
  const style = document.createElement('style');
  style.id = 'onboarding-styles';
  style.textContent = `
    /* ── Welcome Modal ── */
    .welcome-overlay {
      position: fixed; inset: 0;
      background: rgba(10,15,30,0.85);
      backdrop-filter: blur(12px);
      display: flex; align-items: center; justify-content: center;
      z-index: 2000; padding: 20px;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .welcome-overlay--visible { opacity: 1; }

    .welcome-modal {
      background: var(--sidebar-bg);
      border: 1px solid var(--sidebar-border);
      border-radius: 20px;
      padding: 2.5rem;
      max-width: 540px; width: 100%;
      position: relative; overflow: hidden;
      box-shadow: 0 40px 80px rgba(0,0,0,0.5);
      animation: welcomeSlideUp 0.4s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes welcomeSlideUp {
      from { transform: translateY(30px) scale(0.96); opacity: 0; }
      to { transform: none; opacity: 1; }
    }

    .welcome-bg-orbs { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
    .orb { position: absolute; border-radius: 50%; filter: blur(60px); opacity: 0.15; }
    .orb1 { width: 300px; height: 300px; background: #6366f1; top: -100px; right: -80px; }
    .orb2 { width: 200px; height: 200px; background: #f43f5e; bottom: -80px; left: -60px; }
    .orb3 { width: 150px; height: 150px; background: #10b981; top: 50%; left: 50%; transform: translate(-50%,-50%); }

    .welcome-content { position: relative; z-index: 1; }

    .welcome-logo {
      position: relative; width: 72px; height: 72px;
      margin: 0 auto 1.5rem;
    }
    .welcome-logo-icon {
      width: 72px; height: 72px;
      background: linear-gradient(135deg, #6366f1, #818cf8);
      border-radius: 18px;
      display: flex; align-items: center; justify-content: center;
      font-size: 30px; color: white;
      position: relative; z-index: 1;
      box-shadow: 0 10px 30px rgba(99,102,241,0.4);
    }
    .welcome-logo-ring {
      position: absolute; inset: -8px;
      border: 2px solid rgba(99,102,241,0.3);
      border-radius: 26px;
      animation: ringPulse 2s ease-in-out infinite;
    }
    @keyframes ringPulse {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.05); opacity: 1; }
    }

    .welcome-title {
      font-size: 26px; font-weight: 800;
      color: #e8edf8; text-align: center;
      margin-bottom: 10px; line-height: 1.2;
    }
    .welcome-subtitle {
      font-size: 14px; color: #6b7fa3;
      text-align: center; line-height: 1.6;
      margin-bottom: 1.75rem;
    }

    .welcome-features {
      display: flex; flex-direction: column; gap: 10px;
      margin-bottom: 1.5rem;
    }
    .welcome-feature {
      display: flex; align-items: center; gap: 14px;
      padding: 12px 14px;
      background: rgba(255,255,255,0.04);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .wf-feat-icon {
      width: 40px; height: 40px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
    }
    .wf-feat-title { font-size: 13px; font-weight: 700; color: #c8d3eb; }
    .wf-feat-desc { font-size: 11px; color: #4a5a7a; margin-top: 1px; }

    .welcome-steps-preview {
      display: flex; align-items: center; justify-content: center;
      gap: 8px; margin-bottom: 1.75rem;
      padding: 14px; background: rgba(255,255,255,0.03);
      border-radius: 12px; border: 1px solid rgba(255,255,255,0.06);
    }
    .wsp-step {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: #8a9bc0; font-weight: 600;
    }
    .wsp-num {
      width: 24px; height: 24px; border-radius: 50%;
      background: rgba(99,102,241,0.2);
      color: var(--primary-light);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 800;
    }
    .wsp-arrow { color: #2a3550; font-size: 11px; }

    .welcome-actions { display: flex; flex-direction: column; gap: 10px; }
    .welcome-cta {
      width: 100%; padding: 13px;
      background: linear-gradient(135deg, #6366f1, #818cf8);
      color: white; border: none; border-radius: 12px;
      font-family: var(--font-body); font-size: 14px; font-weight: 700;
      cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
      transition: all 0.2s;
      box-shadow: 0 8px 20px rgba(99,102,241,0.3);
    }
    .welcome-cta:hover { transform: translateY(-1px); box-shadow: 0 12px 25px rgba(99,102,241,0.4); }
    .welcome-skip {
      background: none; border: none; color: #3a4a6b;
      font-size: 12px; cursor: pointer; padding: 6px;
      font-family: var(--font-body);
      transition: color 0.2s;
    }
    .welcome-skip:hover { color: #6b7fa3; }

    /* ── Onboarding Checklist ── */
    .onboarding-checklist {
      grid-column: 1 / -1;
      background: var(--sidebar-bg);
      border: 1px solid var(--sidebar-border);
      border-radius: var(--radius-xl);
      padding: 1.5rem;
      margin-bottom: 0.5rem;
      position: relative;
      overflow: hidden;
      animation: checklistIn 0.4s ease;
    }
    @keyframes checklistIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:none; } }

    .onboarding-checklist::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, #6366f1, #f43f5e, #10b981);
    }

    .onb-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1rem;
    }
    .onb-header-left { display: flex; align-items: center; gap: 12px; }
    .onb-icon {
      width: 40px; height: 40px;
      background: rgba(99,102,241,0.15);
      border: 1px solid rgba(99,102,241,0.25);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; color: var(--primary-light);
    }
    .onb-title { font-size: 15px; font-weight: 700; color: #c8d3eb; }
    .onb-subtitle { font-size: 11px; color: #4a5a7a; margin-top: 2px; }
    .onb-dismiss {
      background: none; border: none; color: #3a4a6b;
      cursor: pointer; padding: 6px; border-radius: 6px;
      font-size: 14px; transition: color 0.2s;
    }
    .onb-dismiss:hover { color: #6b7fa3; }

    .onb-progress-wrap {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 1.25rem;
    }
    .onb-progress-bar {
      flex: 1; height: 6px;
      background: rgba(255,255,255,0.06);
      border-radius: 3px; overflow: hidden;
    }
    .onb-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #10b981);
      border-radius: 3px;
      transition: width 0.6s cubic-bezier(0.34,1.56,0.64,1);
    }
    .onb-progress-label { font-size: 11px; font-weight: 700; color: var(--primary-light); min-width: 28px; }

    .onb-steps { display: flex; flex-direction: column; gap: 8px; }
    .onb-step {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 12px; border-radius: var(--radius-md);
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      transition: all 0.2s;
    }
    .onb-step:hover { background: rgba(255,255,255,0.05); }
    .onb-step--done { opacity: 0.6; }

    .onb-step-icon {
      width: 34px; height: 34px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; flex-shrink: 0;
    }
    .onb-step-body { flex: 1; min-width: 0; }
    .onb-step-label { font-size: 13px; font-weight: 700; color: #c8d3eb; margin-bottom: 2px; }
    .onb-step-label--done { text-decoration: line-through; color: #4a5a7a; }
    .onb-step-desc { font-size: 11px; color: #4a5a7a; line-height: 1.4; }

    .onb-step-action {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 700; color: var(--primary-light);
      cursor: pointer; white-space: nowrap;
      padding: 5px 10px;
      background: rgba(99,102,241,0.12);
      border-radius: 6px;
      border: 1px solid rgba(99,102,241,0.2);
      transition: all 0.18s;
      flex-shrink: 0;
    }
    .onb-step-action:hover { background: rgba(99,102,241,0.2); }

    .onb-step-done-badge {
      width: 26px; height: 26px; border-radius: 50%;
      background: rgba(16,185,129,0.12);
      color: var(--success);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; flex-shrink: 0;
    }

    /* ── Template Tabs ── */
    .template-tabs {
      display: flex; gap: 8px; flex-wrap: wrap;
      margin-bottom: 1.25rem;
    }
    .template-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--card-white);
      color: var(--text-muted);
      font-family: var(--font-body);
      font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all 0.18s;
      white-space: nowrap;
    }
    .template-tab:hover { border-color: var(--primary); color: var(--primary); }
    .template-tab.active {
      background: rgba(99,102,241,0.1);
      border-color: var(--primary);
      color: var(--primary);
    }
    .tab-count {
      background: var(--bg-secondary);
      color: var(--text-muted);
      font-size: 10px; font-weight: 800;
      padding: 1px 6px; border-radius: 10px;
    }
    .template-tab.active .tab-count {
      background: rgba(99,102,241,0.15);
      color: var(--primary);
    }

    .templates-inner-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
    }

    .template-card { cursor: default; }
    .template-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }

    @media (max-width: 768px) {
      .welcome-modal { padding: 1.5rem; }
      .welcome-features { gap: 8px; }
      .welcome-steps-preview { flex-wrap: wrap; }
      .templates-inner-grid { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}