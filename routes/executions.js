// routes/executions.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../utils/supabase.js';
import { n8nRequest } from '../utils/n8n.js';
import { DEMO_EXECUTIONS, DEMO_TIMELINE } from '../utils/demo.js';

const router = Router();
router.use(requireAuth);

// ─────────────────────────────────────────────
// GET /api/executions
// Returns all executions for the user.
// Primary: Supabase executions table.
// Fallback: fetch from n8n directly and back-fill Supabase.
router.get('/', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ executions: DEMO_EXECUTIONS });

  try {
    const supabase = getSupabaseAdmin();
    const userId = req.user.id;

    // 1. Try Supabase first
    const { data: dbRows, error: dbErr } = await supabase
      .from('executions')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(50);

    if (!dbErr && dbRows && dbRows.length > 0) {
      return res.json({ executions: dbRows });
    }

    // 2. Supabase empty — fetch from n8n for all user workflows
    // First get the list of workflow IDs this user has
    const { data: userWfs } = await supabase
      .from('user_workflows')
      .select('engine_workflow_ref')
      .eq('user_id', userId)
      .limit(20);

    let rawList = [];

    if (userWfs && userWfs.length > 0) {
      // Fetch executions per workflow and merge
      const perWfResults = await Promise.allSettled(
        userWfs.map(uw =>
          n8nRequest(`/executions?workflowId=${uw.engine_workflow_ref}&limit=10`)
        )
      );
      for (const r of perWfResults) {
        if (r.status === 'fulfilled') {
          const list = r.value?.data || r.value?.executions || [];
          rawList.push(...list);
        }
      }
    } else {
      // No user_workflows rows yet — fetch all n8n executions
      const n8nData = await n8nRequest('/executions?limit=50');
      rawList = n8nData?.data || n8nData?.executions || [];
    }

    if (!rawList.length) return res.json({ executions: [] });

    // Deduplicate by id, sort newest first
    const seen = new Set();
    const deduped = rawList.filter(e => {
      if (seen.has(String(e.id))) return false;
      seen.add(String(e.id));
      return true;
    }).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 50);

    const executions = deduped.map(exec => ({
      id: String(exec.id),
      engine_execution_ref: String(exec.id),
      engine_workflow_ref: String(exec.workflowId || ''),
      workflow_id: String(exec.workflowId || ''),
      status: normalizeStatus(exec),
      started_at: exec.startedAt || exec.started_at || null,
      finished_at: exec.stoppedAt || exec.finishedAt || exec.finished_at || null,
      duration_ms: getDurationMs(
        exec.startedAt || exec.started_at,
        exec.stoppedAt || exec.finishedAt || exec.finished_at
      ),
    }));

    // Back-fill Supabase in background
    setImmediate(async () => {
      try {
        for (const exec of executions) {
          if (!exec.engine_workflow_ref) continue;
          const userWorkflowId = await getOrCreateUserWorkflow(exec.engine_workflow_ref, userId);
          if (!userWorkflowId) continue;
          await supabase.from('executions').upsert({
            user_id: userId,
            user_workflow_id: userWorkflowId,
            engine_workflow_ref: exec.engine_workflow_ref,
            engine_execution_ref: exec.engine_execution_ref,
            status: exec.status,
            started_at: exec.started_at,
            finished_at: exec.finished_at,
            duration_ms: exec.duration_ms,
          }, { onConflict: 'engine_execution_ref' });
        }
      } catch (e) { console.warn('executions back-fill failed:', e.message); }
    });

    res.json({ executions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/executions/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') {
    const exec = DEMO_EXECUTIONS.find(e => e.id === req.params.id);
    return exec ? res.json(exec) : res.status(404).json({ error: 'Not found' });
  }
  try {
    const n8nId = await resolveN8nId(req.params.id, req.user.id);
    const data = await n8nRequest('/executions/' + n8nId);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/executions/:id/timeline
// :id can be an n8n execution ID or a Supabase UUID
// ─────────────────────────────────────────────
router.get('/:id/timeline', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') {
    return res.json({ timeline: DEMO_TIMELINE, status: 'success', execution_id: req.params.id });
  }

  try {
    const supabase = getSupabaseAdmin();
    const n8nId = await resolveN8nId(req.params.id, req.user.id);
    const execution = await n8nRequest('/executions/' + n8nId + '?includeData=true');

    const timeline = [];
    const runData = execution?.data?.resultData?.runData || {};

    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      const run = nodeRuns?.[0] || {};
      const startTime = run.startTime ? new Date(run.startTime) : null;
      const execTime = run.executionTime || 0;
      const finishTime = startTime ? new Date(startTime.getTime() + execTime) : null;

      let outputPreview = null;
      try {
        const outputItems = run.data?.main?.[0];
        if (outputItems?.length > 0) {
          outputPreview = JSON.stringify(outputItems[0]?.json || {}, null, 2).slice(0, 500);
        }
      } catch (_) {}

      timeline.push({
        node_name: nodeName,
        node_type: run.source?.[0]?.previousNode ? 'action' : 'trigger',
        status: run.error ? 'failed' : 'success',
        started_at: startTime?.toISOString() || null,
        finished_at: finishTime?.toISOString() || null,
        duration_ms: execTime,
        output_preview: outputPreview,
        error: run.error?.message || null,
      });
    }

    const finalStatus = execution.finished
      ? (execution.status === 'error' ? 'error' : 'success')
      : 'running';

    const startedAt = execution.startedAt || null;
    const finishedAt = execution.stoppedAt || null;
    const durationMs = startedAt && finishedAt ? Math.max(0, new Date(finishedAt) - new Date(startedAt)) : null;

    const workflowId = String(execution.workflowId || '');
    const userId = req.user.id;

    setImmediate(async () => {
      try {
        const userWorkflowId = await getOrCreateUserWorkflow(workflowId, userId);
        if (!userWorkflowId) return;
        await supabase.from('executions').upsert({
          user_id: userId,
          user_workflow_id: userWorkflowId,
          engine_workflow_ref: workflowId,
          engine_execution_ref: String(n8nId),
          status: finalStatus,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: durationMs,
        }, { onConflict: 'engine_execution_ref' });
      } catch (e) { console.warn('Timeline Supabase update failed:', e.message); }
    });

    res.json({ timeline, status: finalStatus, execution_id: n8nId, workflow_id: execution.workflowId, started_at: startedAt, finished_at: finishedAt, duration_ms: durationMs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/executions/:id
// ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ success: true });
  try {
    const n8nId = await resolveN8nId(req.params.id, req.user.id);
    await n8nRequest('/executions/' + n8nId, 'DELETE');
    try {
      const supabase = getSupabaseAdmin();
      await supabase.from('executions').delete()
        .eq('engine_execution_ref', String(n8nId))
        .eq('user_id', req.user.id);
    } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── HELPERS ───────────────────────────────────

// Resolve n8n execution ID from a Supabase UUID or numeric n8n ID.
// n8n execution IDs are always numeric. Workflow IDs are also numeric but
// are a different namespace — they must NOT be passed to /executions/:id.
// If the param is a UUID, look it up in Supabase to find engine_execution_ref.
// If the param is numeric, pass it through as the n8n execution ID.
// If the param is neither, throw so the caller returns a clean 400/502.
async function resolveN8nId(paramId, userId) {
  if (!paramId) throw new Error('Execution ID is required');

  // Supabase UUID — look up the real n8n execution ID
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paramId);
  if (isUuid) {
    try {
      const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from('executions')
        .select('engine_execution_ref')
        .eq('id', paramId)
        .eq('user_id', userId)
        .maybeSingle();
      if (data?.engine_execution_ref) return data.engine_execution_ref;
    } catch (_) {}
    throw new Error(`Execution not found: ${paramId}`);
  }

  // Must be a numeric string — n8n execution IDs are integers
  if (/^\d+$/.test(String(paramId))) {
    return String(paramId);
  }

  // Anything else (e.g. a workflow ID with non-numeric chars, or a "wh-" fake ID)
  throw new Error(`Invalid execution ID: ${paramId}. Expected a numeric n8n execution ID.`);
}

async function getOrCreateUserWorkflow(workflowId, userId) {
  if (!workflowId) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data: existing } = await supabase
      .from('user_workflows')
      .select('id')
      .eq('engine_workflow_ref', String(workflowId))
      .eq('user_id', userId)
      .maybeSingle();
    if (existing?.id) return existing.id;

    let workflowName = 'Workflow ' + workflowId;
    try { const wf = await n8nRequest('/workflows/' + workflowId); workflowName = wf.name || workflowName; } catch (_) {}

    const { data: created, error } = await supabase
      .from('user_workflows')
      .insert({ user_id: userId, engine_workflow_ref: String(workflowId), workflow_name: workflowName, is_active: true })
      .select('id').single();
    if (error) { console.warn('getOrCreateUserWorkflow error:', error.message); return null; }
    return created.id;
  } catch (err) { console.warn('getOrCreateUserWorkflow failed:', err.message); return null; }
}

function normalizeStatus(exec) {
  if (exec.status === 'success' || exec.finished === true) return 'success';
  if (exec.status === 'error' || exec.status === 'failed') return 'error';
  if (exec.status === 'running' || exec.finished === false) return 'running';
  return exec.status || 'unknown';
}

function getDurationMs(start, end) {
  if (!start || !end) return null;
  try { const ms = new Date(end) - new Date(start); return ms > 0 ? ms : null; } catch (_) { return null; }
}

export default router;