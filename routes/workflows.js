// routes/workflows.js
import { Router } from 'express';
import { n8nRequest, getN8nHeaders } from '../utils/n8n.js';
import { getSupabaseAdmin } from '../utils/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { DEMO_WORKFLOWS, DEMO_EXECUTIONS } from '../utils/demo.js';
import fetch from 'node-fetch';

const router = Router();
router.use(requireAuth);

function getN8nBaseUrl() {
  return (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
}

// ─────────────────────────────────────────────
// GET /api/workflows
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ data: DEMO_WORKFLOWS, count: DEMO_WORKFLOWS.length });
  try { res.json(await n8nRequest('/workflows')); }
  catch (err) { res.status(502).json({ error: err.message, source: 'n8n' }); }
});

// ─────────────────────────────────────────────
// GET /api/workflows/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') {
    const wf = DEMO_WORKFLOWS.find(w => String(w.id) === req.params.id);
    return wf ? res.json(wf) : res.status(404).json({ error: 'Not found' });
  }
  try { res.json(await n8nRequest(`/workflows/${req.params.id}`)); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// POST /api/workflows
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ id: `demo-wf-${Date.now()}`, active: false, ...req.body });
  try {
    const payload = {
      name: req.body.name || 'New Workflow',
      nodes: req.body.nodes || [],
      connections: req.body.connections || {},
      settings: req.body.settings || {},
    };
    res.json(await n8nRequest('/workflows', 'POST', payload));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// DELETE /api/workflows/:id
// ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ success: true });
  try {
    await n8nRequest(`/workflows/${req.params.id}`, 'DELETE');
    try {
      const supabase = getSupabaseAdmin();
      await supabase.from('user_workflows').delete()
        .eq('engine_workflow_ref', req.params.id)
        .eq('user_id', req.user.id);
    } catch (_) { }
    res.json({ success: true });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// POST /api/workflows/:id/toggle
// ─────────────────────────────────────────────
router.post('/:id/toggle', async (req, res) => {
  const { active } = req.body;
  const workflowId = req.params.id;
  if (process.env.DEMO_MODE === 'true') return res.json({ success: true, id: workflowId, active });

  try {
    const action = active ? 'activate' : 'deactivate';
    const data = await n8nRequest(`/workflows/${workflowId}/${action}`, 'POST');
    await syncToggleToSupabase(workflowId, active, req.user.id);
    return res.json({ success: true, active, data });
  } catch (err) {
    console.log(`   toggle activate/deactivate failed: ${err.message}`);
  }

  try {
    const existing = await n8nRequest(`/workflows/${workflowId}`);
    const body = buildFullBody(existing, { active });
    const data = await putWorkflow(workflowId, body);
    await syncToggleToSupabase(workflowId, active, req.user.id);
    return res.json({ success: true, active, data });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/workflows/:id/run
//
// CRITICAL: respond to the client IMMEDIATELY after the webhook fires.
// Do NOT wait for polling — that caused ERR_CONNECTION_RESET.
// Polling + DB writes happen in background after response is sent.
// ─────────────────────────────────────────────
router.post('/:id/run', async (req, res) => {
  const workflowId = req.params.id;
  const userId = req.user.id;

  if (process.env.DEMO_MODE === 'true') {
    return res.json({
      success: true,
      executionId: `exec-${Date.now()}`,
      execution: { id: `exec-${Date.now()}`, workflow_id: workflowId, status: 'running' },
    });
  }

  const n8nBase = getN8nBaseUrl();

  // ── 1. Fetch workflow ──
  let wf;
  try {
    wf = await n8nRequest(`/workflows/${workflowId}`);
  } catch (err) {
    return res.status(502).json({ error: `Cannot read workflow: ${err.message}` });
  }

  // ── 2. Patch settings so n8n saves executions ──
  const currentSettings = wf.settings || {};
  const needsPatch =
    currentSettings.saveManualExecutions !== true ||
    currentSettings.saveDataSuccessExecution !== 'all' ||
    currentSettings.saveDataErrorExecution !== 'all';

  if (needsPatch) {
    try {
      const patched = buildFullBody(wf, {
        settings: {
          ...currentSettings,
          saveManualExecutions: true,
          saveDataSuccessExecution: 'all',
          saveDataErrorExecution: 'all',
          executionOrder: currentSettings.executionOrder || 'v1',
        },
      });
      wf = await putWorkflow(workflowId, patched);
    } catch (err) {
      console.warn(`Could not patch workflow settings: ${err.message}`);
    }
  }

  // ── 3. Resolve webhook URL ──
  let webhookUrl = await getStoredWebhookUrl(workflowId, userId);

  if (!webhookUrl) {
    const webhookNode = findWebhookTriggerNode(wf.nodes || []);

    if (webhookNode) {
      webhookUrl = deriveWebhookUrl(n8nBase, webhookNode);
    } else {
      try {
        const result = await injectWebhookTrigger(workflowId, wf, n8nBase);
        wf = result.wf;
        webhookUrl = result.webhookUrl;
      } catch (err) {
        return res.status(502).json({ error: `Could not set up workflow: ${err.message}` });
      }
    }

    try {
      await n8nRequest(`/workflows/${workflowId}/activate`, 'POST');
      await delay(600);
    } catch (err) {
      console.warn(`Could not activate workflow: ${err.message}`);
    }

    await storeWebhookUrl(workflowId, userId, webhookUrl);
  }

  // ── 4. Snapshot highest execution ID before firing ──
  let highestIdBefore = 0;
  try {
    const before = await n8nRequest(`/executions?workflowId=${workflowId}&limit=5`);
    const list = before?.data || before?.executions || [];
    if (list.length > 0) {
      highestIdBefore = Math.max(...list.map(e => Number(e.id) || 0));
    }
  } catch (_) { }

  // ── 5. Fire the webhook ──
  // command is intentionally NOT required here — the n8n Extract node owns
  // action detection (from email subject, body, or webhook context).
  // Dashboard triggers send only { email }; IMAP triggers parse their own subject.
  console.log('Incoming body:', req.body);

  const payload = {
    email: typeof req.body.email === 'string' ? req.body.email : '',
    ...(req.body.command ? { command: req.body.command } : {}),
    ...(req.body.task_type ? { task_type: req.body.task_type } : {})
  };

  console.log('Webhook Payload:', payload);

  const startedAt = new Date().toISOString();
  const tempExecutionId = `wh-${Date.now()}`;

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    console.log(`[run] Webhook response status: ${r.status}`);

    // 404 on webhook can mean workflow just became active — try once more
    if (!r.ok && r.status !== 404) {
      await delay(1000);
      const r2 = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!r2.ok) {
        await clearStoredWebhookUrl(workflowId, userId);
        const text = await r2.text().catch(() => '');
        return res.status(502).json({ error: `Webhook returned ${r2.status}: ${text.slice(0, 200)}` });
      }
    }
  } catch (err) {
    await clearStoredWebhookUrl(workflowId, userId);
    return res.status(502).json({ error: `Execution failed: ${err.message}` });
  }

  // ── 6. Respond immediately — do NOT wait for polling ──
  // The frontend receives this response right away; no connection reset.
  res.json({
    success: true,
    executionId: tempExecutionId,
    execution: {
      id: tempExecutionId,
      workflow_id: workflowId,
      status: 'running',
    },
  });

  // ── 7. Background: poll for real execution ID + save to Supabase ──
  // This runs AFTER the response has been sent. Errors here are non-fatal.
  setImmediate(() => {
    pollAndStoreExecution(workflowId, userId, highestIdBefore, startedAt).catch(err => {
      console.warn('Background execution tracking failed:', err.message);
    });
  });
});

// ─────────────────────────────────────────────
// Background execution tracking — runs after response is sent
// ─────────────────────────────────────────────
async function pollAndStoreExecution(workflowId, userId, highestIdBefore, startedAt) {
  let n8nExecutionId = null;

  // Poll up to 20 attempts (20s) for the new execution to appear
  for (let i = 0; i < 20; i++) {
    await delay(1000);
    try {
      const execList = await n8nRequest(`/executions?workflowId=${workflowId}&limit=5`);
      const list = execList?.data || execList?.executions || [];
      const newest = list
        .filter(e => Number(e.id) > highestIdBefore)
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (newest) {
        n8nExecutionId = String(newest.id);
        console.log(`Background: resolved execution ID ${n8nExecutionId}`);
        break;
      }
    } catch (_) { }
  }

  if (!n8nExecutionId) {
    console.warn('Background: could not resolve execution ID after 20 attempts');
    return;
  }

  const userWorkflowId = await getOrCreateUserWorkflow(workflowId, userId);
  if (!userWorkflowId) {
    console.warn('Background: could not resolve user_workflow_id');
    return;
  }

  const supabase = getSupabaseAdmin();

  // Write initial "running" row immediately so history shows something
  try {
    const { error } = await supabase.from('executions').upsert({
      user_id: userId,
      user_workflow_id: userWorkflowId,
      engine_workflow_ref: String(workflowId),
      engine_execution_ref: n8nExecutionId,
      status: 'running',
      started_at: startedAt,
    }, { onConflict: 'engine_execution_ref' });
    if (error) console.warn('Background executions upsert (running) error:', error.message);
    else console.log(`Background: saved execution ${n8nExecutionId} as running`);
  } catch (err) {
    console.warn('Background: Supabase write (running) failed:', err.message);
  }

  // Poll for completion and update final status
  for (let i = 0; i < 30; i++) {
    await delay(2000);
    try {
      const exec = await n8nRequest(`/executions/${n8nExecutionId}`);
      if (exec && exec.finished !== false && exec.finished !== undefined) {
        const finalStatus = exec.status === 'error' ? 'error' : 'success';
        const finishedAt = exec.stoppedAt || null;
        await supabase.from('executions').upsert({
          user_id: userId,
          user_workflow_id: userWorkflowId,
          engine_workflow_ref: String(workflowId),
          engine_execution_ref: n8nExecutionId,
          status: finalStatus,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: startedAt && finishedAt ? Math.max(0, new Date(finishedAt) - new Date(startedAt)) : null,
        }, { onConflict: 'engine_execution_ref' });
        console.log(`Background: updated execution ${n8nExecutionId} → ${finalStatus}`);
        return;
      }
    } catch (_) { }
  }
  console.warn(`Background: execution ${n8nExecutionId} did not finish within 60s`);
}

// ─────────────────────────────────────────────
// GET /api/workflows/:id/history
// ─────────────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ data: DEMO_EXECUTIONS, count: DEMO_EXECUTIONS.length });

  try {
    const limit = Number(req.query.limit) || 20;
    const data = await n8nRequest(`/executions?workflowId=${req.params.id}&limit=${limit}`);
    const executions = data?.data || data?.executions || [];

    const normalized = executions.map(exec => ({
      id: exec.id,
      engine_execution_ref: String(exec.id),
      engine_workflow_ref: String(req.params.id),
      status: exec.finished
        ? (exec.status === 'error' ? 'error' : 'success')
        : (exec.status || 'running'),
      started_at: exec.startedAt || exec.started_at || null,
      finished_at: exec.stoppedAt || exec.finishedAt || exec.finished_at || null,
      duration_ms: getDurationMs(
        exec.startedAt || exec.started_at,
        exec.stoppedAt || exec.finishedAt || exec.finished_at
      ),
    }));

    // Back-fill Supabase in background
    if (normalized.length && req.user?.id) {
      const workflowId = req.params.id;
      const userId = req.user.id;
      setImmediate(async () => {
        try {
          const userWorkflowId = await getOrCreateUserWorkflow(workflowId, userId);
          if (!userWorkflowId) return;
          const supabase = getSupabaseAdmin();
          for (const exec of normalized) {
            try {
              await supabase.from('executions').upsert({
                user_id: userId,
                user_workflow_id: userWorkflowId,
                engine_workflow_ref: String(workflowId),
                engine_execution_ref: String(exec.id),
                status: exec.status,
                started_at: exec.started_at,
              }, { onConflict: 'engine_execution_ref' });
            } catch (_) { }
          }
        } catch (_) { }
      });
    }

    res.json({ data: normalized, count: normalized.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/:id/executions', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ data: DEMO_EXECUTIONS, count: DEMO_EXECUTIONS.length });
  try {
    res.json(await n8nRequest(`/executions?workflowId=${req.params.id}&limit=${req.query.limit || 20}`));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// Get or create a user_workflows row for this n8n workflow ID.
// Returns the Supabase UUID (user_workflows.id).
// Uses the correct column name: engine_workflow_ref
// ─────────────────────────────────────────────
async function getOrCreateUserWorkflow(workflowId, userId, wfGetter) {
  try {
    const supabase = getSupabaseAdmin();

    // Look up existing row
    const { data: existing } = await supabase
      .from('user_workflows')
      .select('id')
      .eq('engine_workflow_ref', String(workflowId))
      .eq('user_id', userId)
      .maybeSingle();

    if (existing?.id) return existing.id;

    // Not found — create it
    let workflowName = `Workflow ${workflowId}`;
    try {
      const wf = await n8nRequest(`/workflows/${workflowId}`);
      workflowName = wf.name || workflowName;
    } catch (_) { }

    const { data: created, error } = await supabase
      .from('user_workflows')
      .insert({
        user_id: userId,
        engine_workflow_ref: String(workflowId),
        workflow_name: workflowName,
        is_active: true,
      })
      .select('id')
      .single();

    if (error) {
      console.warn('getOrCreateUserWorkflow insert error:', error.message);
      return null;
    }
    return created.id;
  } catch (err) {
    console.warn('getOrCreateUserWorkflow failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// WEBHOOK URL STORAGE
// Uses engine_workflow_ref (correct column name)
// Stores webhook_url inside a metadata JSONB column if available,
// otherwise falls back gracefully without crashing.
// ─────────────────────────────────────────────
async function getStoredWebhookUrl(workflowId, userId) {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from('user_workflows')
      .select('id')
      .eq('engine_workflow_ref', String(workflowId))
      .eq('user_id', userId)
      .maybeSingle();
    // webhook URL stored in a separate lookup — use in-memory cache instead
    return _webhookCache.get(`${userId}:${workflowId}`) || null;
  } catch (_) { return null; }
}

// In-memory webhook URL cache (survives process lifetime, cheap & sufficient)
const _webhookCache = new Map();

async function storeWebhookUrl(workflowId, userId, webhookUrl) {
  _webhookCache.set(`${userId}:${workflowId}`, webhookUrl);
  // Also ensure the user_workflows row exists
  try {
    await getOrCreateUserWorkflow(workflowId, userId);
  } catch (_) { }
}

async function clearStoredWebhookUrl(workflowId, userId) {
  _webhookCache.delete(`${userId}:${workflowId}`);
}

// ─────────────────────────────────────────────
// WEBHOOK NODE HELPERS
// ─────────────────────────────────────────────
function findWebhookTriggerNode(nodes) {
  return nodes.find(n =>
    (n.type || '').toLowerCase().includes('webhook') &&
    !(n.type || '').toLowerCase().includes('respond')
  ) || null;
}

function generateWebhookPath() {
  return 'cp-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function deriveWebhookUrl(n8nBase, webhookNode) {
  const path = webhookNode?.parameters?.path || webhookNode?.parameters?.webhookId;
  if (!path) return null;
  return `${n8nBase}/webhook/${path}`;
}

async function injectWebhookTrigger(workflowId, wf, n8nBase) {
  const nodes = [...(wf.nodes || [])];
  const connections = JSON.parse(JSON.stringify(wf.connections || {}));

  const MANUAL_TYPES = [
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.start',
    '@n8n/n8n-nodes-langchain.manualChatTrigger',
  ];
  const ALL_TRIGGER_TYPES = ['n8n-nodes-base.webhook', ...MANUAL_TYPES];

  const webhookPath = generateWebhookPath();
  const webhookUrl = `${n8nBase}/webhook/${webhookPath}`;

  const minX = nodes.length > 0 ? Math.min(...nodes.map(n => n.position?.[0] ?? 250)) : 250;
  const avgY = nodes.length > 0
    ? Math.round(nodes.reduce((s, n) => s + (n.position?.[1] ?? 300), 0) / nodes.length)
    : 300;

  // CRITICAL: responseMode must be 'responseNode' (not 'onReceived').
  // 'onReceived' stops execution at the webhook and returns immediately —
  // downstream nodes never run. 'responseNode' lets data flow through.
  const webhookNode = {
    parameters: {
      httpMethod: 'POST',
      path: webhookPath,
      responseMode: 'responseNode',
      options: {},
    },
    name: 'CloudPilot Trigger',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 1,
    position: [minX - 240, Math.round(avgY)],
    webhookId: webhookPath,
  };

  const newNodes = [webhookNode, ...nodes];

  // Find nodes that already receive connections
  const receivingNodes = new Set();
  for (const src of Object.values(connections)) {
    if (!src || typeof src !== 'object') continue;
    for (const outputs of Object.values(src)) {
      if (!Array.isArray(outputs)) continue;
      for (const branch of outputs) {
        if (Array.isArray(branch)) {
          for (const conn of branch) { if (conn?.node) receivingNodes.add(conn.node); }
        }
      }
    }
  }

  // Entry node = first non-trigger node with no incoming connections
  const entryNode = nodes.find(n =>
    !ALL_TRIGGER_TYPES.includes(n.type) && !receivingNodes.has(n.name)
  ) || nodes.find(n => !ALL_TRIGGER_TYPES.includes(n.type));

  if (entryNode) {
    connections['CloudPilot Trigger'] = {
      main: [[{ node: entryNode.name, type: 'main', index: 0 }]],
    };
  }

  if (wf.active) {
    try { await n8nRequest(`/workflows/${workflowId}/deactivate`, 'POST'); } catch (_) { }
  }

  const updatedWf = await putWorkflow(workflowId, buildFullBody(wf, {
    nodes: newNodes,
    connections,
    settings: {
      ...(wf.settings || {}),
      saveManualExecutions: true,
      saveDataSuccessExecution: 'all',
      saveDataErrorExecution: 'all',
      executionOrder: (wf.settings || {}).executionOrder || 'v1',
    },
  }));

  return { wf: updatedWf, webhookUrl };
}

// ─────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────
function buildFullBody(existing, overrides = {}) {
  // n8n POST/PUT /workflows only accepts: name, nodes, connections, settings
  // All other fields cause "request/body must NOT have additional properties"
  const merged = { ...existing, ...overrides };

  const settings = merged.settings || { executionOrder: 'v1' };
  if (!settings.executionOrder) settings.executionOrder = 'v1';

  const nodes = (merged.nodes || []).map(node => {
    const n = { ...node };
    delete n.id; // n8n rejects node-level id on create/update
    if (!Array.isArray(n.position) || n.position.length < 2) n.position = [250, 300];
    return n;
  });

  return {
    name: merged.name || 'Workflow',
    nodes,
    connections: merged.connections || {},
    settings,
  };
}

async function putWorkflow(workflowId, body) {
  return n8nRequest(`/workflows/${workflowId}`, 'PUT', body);
}

async function syncToggleToSupabase(workflowId, active, userId) {
  try {
    const supabase = getSupabaseAdmin();
    await supabase.from('user_workflows')
      .update({ is_active: active })
      .eq('engine_workflow_ref', String(workflowId))
      .eq('user_id', userId);
  } catch (_) { }
}

function getDurationMs(startedAt, stoppedAt) {
  if (!startedAt || !stoppedAt) return null;
  try {
    const ms = new Date(stoppedAt) - new Date(startedAt);
    return ms > 0 ? ms : null;
  } catch (_) { return null; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

export default router;