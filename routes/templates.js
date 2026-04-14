// routes/templates.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../utils/supabase.js';
import { n8nRequest } from '../utils/n8n.js';
import { getDecryptedCredential } from './credentials.js';
import { DEMO_TEMPLATES } from '../utils/demo.js';

const router = Router();
router.use(requireAuth);

const N8N_CRED_TYPE_MAP = {
  aws: 'aws',
  gcp: 'googleApi',
  azure: 'microsoftAzureOAuth2Api',
  github: 'githubApi',
  slack: 'slackApi',
  openai: 'openAiApi',
  dropbox: 'dropboxApi',
  smtp: 'smtp',
  http: 'httpBasicAuth',
};

// GET /api/templates
// Lists all workflow JSON files from Supabase Storage bucket "workflow_templates"
router.get('/', async (req, res) => {
  if (process.env.DEMO_MODE === 'true') return res.json({ templates: DEMO_TEMPLATES });

  try {
    const supabase = getSupabaseAdmin();

    const { data: files, error: listErr } = await supabase
      .storage
      .from('workflows_templates')
      .list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });

    if (listErr) throw new Error('Storage list failed: ' + listErr.message);
    if (!files || files.length === 0) return res.json({ templates: [] });

    const jsonFiles = files.filter(f => f.name && f.name.endsWith('.json') && f.id);

    const BATCH = 20;
    const templates = [];

    for (let i = 0; i < jsonFiles.length; i += BATCH) {
      const batch = jsonFiles.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const { data: blob, error: dlErr } = await supabase
            .storage
            .from('workflows_templates')
            .download(file.name);

          if (dlErr) throw new Error(`Download failed for ${file.name}: ${dlErr.message}`);
          let json;
          try { json = JSON.parse(await blob.text()); }
          catch (_) { throw new Error(`Invalid JSON in ${file.name}`); }

          return {
            id: file.name,
            template_id: file.name,
            name: json.name || file.name.replace(/\.json$/i, ''),
            description: json.meta?.description || json.description || '',
            category: detectCategory(json.name || file.name, json.nodes || []),
            node_count: (json.nodes || []).length,
            tags: extractTags(json.name || file.name, json.nodes || []),
            required_credentials: [],
            storage_path: file.name,
          };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') templates.push(result.value);
        else console.warn('Template parse error:', result.reason?.message);
      }
    }

    templates.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ templates });
  } catch (err) {
    console.error('GET /api/templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function detectCategory(name, nodes) {
  const n = (name || '').toUpperCase();
  if (n.includes('AWS') || n.includes('EC2') || n.includes('S3') || n.includes('IAM') || n.includes('REKOGNITION')) return 'AWS';
  if (n.includes('GCS') || n.includes('GCP') || n.includes('GOOGLE') || n.includes('FIREBASE')) return 'GCP';
  if (n.includes('AZURE')) return 'Azure';
  if (n.includes('DROPBOX')) return 'Storage';
  if (n.includes('SLACK')) return 'Messaging';
  if (n.includes('RAG') || n.includes('AI') || n.includes('OPENAI')) return 'AI';
  const types = nodes.map(nd => (nd.type || '').toLowerCase()).join(' ');
  if (types.includes('aws')) return 'AWS';
  if (types.includes('google')) return 'GCP';
  if (types.includes('slack')) return 'Messaging';
  return 'General';
}

function extractTags(name, nodes) {
  const tags = new Set();
  const n = (name || '').toLowerCase();
  if (n.includes('aws') || n.includes('ec2') || n.includes('s3') || n.includes('iam')) tags.add('aws');
  if (n.includes('gcs') || n.includes('gcp') || n.includes('google')) tags.add('gcp');
  if (n.includes('webhook')) tags.add('webhook');
  if (n.includes('automat')) tags.add('automation');
  if (n.includes('monitor')) tags.add('monitoring');
  if (n.includes('scale') || n.includes('scaling')) tags.add('scaling');
  if (n.includes('rag') || n.includes('ai')) tags.add('ai');
  if (n.includes('dropbox')) tags.add('storage');
  if (n.includes('firebase')) tags.add('database');
  for (const node of nodes) {
    const t = (node.type || '').toLowerCase();
    if (t.includes('slack')) tags.add('slack');
    if (t.includes('gmail') || t.includes('email')) tags.add('email');
    if (t.includes('http')) tags.add('http');
  }
  return [...tags].slice(0, 5);
}

// POST /api/templates/install-from-storage
router.post('/install-from-storage', async (req, res) => {
  const { storage_path, workflow_name } = req.body;
  if (!storage_path) return res.status(400).json({ error: 'storage_path is required' });

  const userId = req.user.id;
  const supabase = getSupabaseAdmin();

  try {
    const { data: fileData, error: dlErr } = await supabase
      .storage.from('workflow_templates').download(storage_path);
    if (dlErr) throw new Error('Storage download failed: ' + dlErr.message);

    let rawJson;
    try { rawJson = JSON.parse(await fileData.text()); }
    catch (_) { throw new Error('Invalid JSON in storage file'); }

    const finalName = (workflow_name || '').trim() || rawJson.name || 'Imported Workflow';

    // Strict sanitize then inject trigger
    const sanitized = sanitizeWorkflow(rawJson, finalName);
    const workflowJson = injectCloudPilotTrigger(sanitized);

    // Build the payload sent to n8n — only the 4 allowed fields
    const n8nPayload = {
      name: workflowJson.name,
      nodes: workflowJson.nodes,
      connections: workflowJson.connections,
      settings: workflowJson.settings,
    };

    const n8nWorkflow = await n8nRequest('/workflows', 'POST', n8nPayload);
    if (!n8nWorkflow?.id) throw new Error('n8n did not return a workflow ID');

    // Activate so webhook is live
    try { await n8nRequest('/workflows/' + n8nWorkflow.id + '/activate', 'POST'); }
    catch (e) { console.warn('Activate failed:', e.message); }

    const webhookUrl = deriveWebhookUrl(workflowJson.nodes);

    const { data: uw, error: uwErr } = await supabase
      .from('user_workflows')
      .insert({
        user_id: userId,
        engine_workflow_ref: String(n8nWorkflow.id),
        workflow_name: finalName,
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select('id, workflow_name').single();

    if (uwErr) {
      console.warn('user_workflows insert failed:', uwErr.message);
      return res.json({
        success: true,
        workflow: { id: String(n8nWorkflow.id), n8n_id: n8nWorkflow.id, name: finalName },
        webhook_url: webhookUrl,
        warning: 'Workflow created but could not save to database',
      });
    }

    res.json({
      success: true,
      workflow: { id: uw.id, n8n_id: n8nWorkflow.id, name: uw.workflow_name },
      webhook_url: webhookUrl,
    });
  } catch (err) {
    console.error('install-from-storage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates/import
// template_id is the storage file path
router.post('/import', async (req, res) => {
  const { template_id, workflow_name, credential_mappings = {} } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });

  if (process.env.DEMO_MODE === 'true') {
    const t = DEMO_TEMPLATES.find(x => x.id === template_id || x.template_id === template_id);
    return res.json({ success: true, workflow: { id: 'demo-wf-' + Date.now(), name: workflow_name || t?.name || 'Imported Workflow' } });
  }

  const userId = req.user.id;
  const supabase = getSupabaseAdmin();

  try {
    const { data: fileData, error: dlErr } = await supabase
      .storage.from('workflow_templates').download(template_id);
    if (dlErr) throw new Error('Storage download failed: ' + dlErr.message);

    let rawJson;
    try { rawJson = JSON.parse(await fileData.text()); }
    catch (_) { throw new Error('Invalid JSON in storage file'); }

    // Credential handling
    const n8nCredIds = {};
    for (const [credType, credId] of Object.entries(credential_mappings)) {
      if (!credId) continue;
      try {
        const credInfo = await getDecryptedCredential(credId, userId);
        const n8nType = N8N_CRED_TYPE_MAP[credType] || credType;
        const n8nCred = await n8nRequest('/credentials', 'POST', {
          name: credInfo.credential_name + '_' + Date.now(),
          type: n8nType,
          data: credInfo.data,
        });
        n8nCredIds[credType] = { id: n8nCred.id, name: credInfo.credential_name };
      } catch (e) { console.warn('Credential failed for ' + credType + ':', e.message); }
    }

    const finalName = (workflow_name || '').trim() || rawJson.name || 'Imported Workflow';
    const sanitized = sanitizeWorkflow(rawJson, finalName);
    const workflowJson = injectCloudPilotTrigger(sanitized);

    // Inject credential IDs into nodes
    if (Object.keys(n8nCredIds).length > 0) {
      workflowJson.nodes = workflowJson.nodes.map(node => {
        if (node.credentials) {
          for (const credKey of Object.keys(node.credentials)) {
            const match = Object.keys(n8nCredIds).find(t =>
              credKey.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(credKey.toLowerCase())
            );
            if (match) node.credentials[credKey] = n8nCredIds[match];
          }
        }
        return node;
      });
    }

    // Build the payload sent to n8n — only the 4 allowed fields
    const n8nPayload = {
      name: workflowJson.name,
      nodes: workflowJson.nodes,
      connections: workflowJson.connections,
      settings: workflowJson.settings,
    };

    const n8nWorkflow = await n8nRequest('/workflows', 'POST', n8nPayload);
    if (!n8nWorkflow?.id) throw new Error('n8n did not return a workflow ID');

    try { await n8nRequest('/workflows/' + n8nWorkflow.id + '/activate', 'POST'); }
    catch (e) { console.warn('Activate failed:', e.message); }

    const webhookUrl = deriveWebhookUrl(workflowJson.nodes);

    const { data: uw, error: uwErr } = await supabase
      .from('user_workflows')
      .insert({
        user_id: userId,
        engine_workflow_ref: String(n8nWorkflow.id),
        workflow_name: finalName,
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select('id, workflow_name').single();

    if (uwErr) {
      console.warn('user_workflows insert failed:', uwErr.message);
      return res.json({
        success: true,
        workflow: { id: String(n8nWorkflow.id), n8n_id: n8nWorkflow.id, name: finalName },
        webhook_url: webhookUrl,
        manual_trigger_injected: workflowJson._manualTriggerInjected || false,
        warning: 'Workflow created but could not save to database',
      });
    }

    res.json({
      success: true,
      workflow: { id: uw.id, n8n_id: n8nWorkflow.id, name: uw.workflow_name },
      webhook_url: webhookUrl,
      manual_trigger_injected: workflowJson._manualTriggerInjected || false,
    });
  } catch (err) {
    console.error('Template import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HELPERS ────────────────────────────────

// Strictly sanitize workflow JSON for n8n POST /workflows.
// n8n ONLY accepts: name, nodes, connections, settings
// Removes ALL other top-level fields (id, active, tags, versionId, meta,
// pinData, staticData, createdAt, updatedAt, etc.)
// Also removes "id" from every node object.
function sanitizeWorkflow(raw, name) {
  const wf = JSON.parse(JSON.stringify(raw));

  // Only keep valid settings fields — strip any unknown sub-fields
  const rawSettings = (wf.settings && typeof wf.settings === 'object') ? wf.settings : {};
  const settings = {};
  if (rawSettings.executionOrder) settings.executionOrder = rawSettings.executionOrder;
  if (rawSettings.saveManualExecutions !== undefined) settings.saveManualExecutions = rawSettings.saveManualExecutions;
  if (rawSettings.saveDataSuccessExecution) settings.saveDataSuccessExecution = rawSettings.saveDataSuccessExecution;
  if (rawSettings.saveDataErrorExecution) settings.saveDataErrorExecution = rawSettings.saveDataErrorExecution;
  if (rawSettings.callerPolicy) settings.callerPolicy = rawSettings.callerPolicy;
  if (rawSettings.errorWorkflow) settings.errorWorkflow = rawSettings.errorWorkflow;
  if (rawSettings.timezone) settings.timezone = rawSettings.timezone;
  // Always ensure executionOrder is set
  if (!settings.executionOrder) settings.executionOrder = 'v1';
  // Always ensure executions are saved
  settings.saveManualExecutions = true;
  settings.saveDataSuccessExecution = 'all';
  settings.saveDataErrorExecution = 'all';

  // Strip id from every node; ensure valid position
  const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []).map(node => {
    const n = { ...node };
    delete n.id;
    if (!Array.isArray(n.position) || n.position.length < 2) n.position = [250, 300];
    return n;
  });

  // Return ONLY the four fields n8n accepts — nothing else
  return {
    name: (name && name.trim()) || wf.name || 'Imported Workflow',
    nodes,
    connections: (wf.connections && typeof wf.connections === 'object') ? wf.connections : {},
    settings,
  };
}

// Inject a CloudPilot webhook trigger that fully connects to the workflow.
//
// Rules:
//   1. If workflow already has a webhook trigger — skip injection, use it as-is.
//   2. If workflow has a manual trigger — add webhook + wire both to entry node directly.
//      (No merge node needed; n8n runs whichever trigger fires.)
//   3. If workflow has no triggers at all — add webhook + manual trigger + Merge node.
//      Merge mode "passThrough" passes data from whichever input arrives first.
//
// Critical: responseMode must be 'responseNode' (not 'onReceived') so the webhook
// does NOT stop execution after the trigger — data flows through to all downstream nodes.
function injectCloudPilotTrigger(wf) {
  const nodes = [...(wf.nodes || [])];
  const connections = JSON.parse(JSON.stringify(wf.connections || {}));

  const WEBHOOK_TYPES = ['n8n-nodes-base.webhook'];
  const MANUAL_TYPES = [
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.start',
    '@n8n/n8n-nodes-langchain.manualChatTrigger',
  ];
  const ALL_TRIGGER_TYPES = [...WEBHOOK_TYPES, ...MANUAL_TYPES];

  // Already has a webhook trigger — nothing to do
  if (nodes.some(n => WEBHOOK_TYPES.includes(n.type))) {
    return { ...wf, nodes, connections };
  }

  // Layout helpers
  const minX = nodes.length > 0
    ? Math.min(...nodes.map(n => (Array.isArray(n.position) ? n.position[0] : 250)))
    : 250;
  const avgY = nodes.length > 0
    ? Math.round(nodes.reduce((s, n) => s + (Array.isArray(n.position) ? n.position[1] : 300), 0) / nodes.length)
    : 300;

  const hasManual = nodes.some(n => MANUAL_TYPES.includes(n.type));

  // Find the true entry node: a non-trigger node with no incoming connections.
  // This is the first action node data should flow into.
  const connectedNodes = new Set();
  for (const srcConns of Object.values(connections)) {
    if (!srcConns || typeof srcConns !== 'object') continue;
    for (const outputs of Object.values(srcConns)) {
      if (!Array.isArray(outputs)) continue;
      for (const branch of outputs) {
        if (Array.isArray(branch)) {
          for (const conn of branch) { if (conn?.node) connectedNodes.add(conn.node); }
        }
      }
    }
  }

  // Entry node = first non-trigger with no incoming connections
  const entryNode = nodes.find(n =>
    !ALL_TRIGGER_TYPES.includes(n.type) && !connectedNodes.has(n.name)
  );

  // Fallback: if all nodes have incoming connections (e.g. circular or all connected),
  // pick the first non-trigger node
  const firstActionNode = entryNode
    || nodes.find(n => !ALL_TRIGGER_TYPES.includes(n.type))
    || nodes[0];

  const webhookPath = 'cp-' + Math.random().toString(36).slice(2, 10);

  // CRITICAL: use responseMode 'responseNode' so n8n does NOT stop execution
  // at the webhook node — data must flow through to all downstream nodes.
  // 'onReceived' causes execution to stop after the webhook, which is why
  // workflows only ran to the 3rd node.
  const cloudPilotTrigger = {
    parameters: {
      httpMethod: 'POST',
      path: webhookPath,
      responseMode: 'responseNode',
      options: {},
    },
    name: 'CloudPilot Trigger',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 1,
    position: [minX - 440, avgY - 70],
    webhookId: webhookPath,
  };

  nodes.unshift(cloudPilotTrigger);

  if (hasManual && firstActionNode) {
    // Manual trigger already present — wire CloudPilot Trigger directly to first action node.
    // Also wire the existing manual trigger to the same node (it may already be wired).
    connections['CloudPilot Trigger'] = {
      main: [[{ node: firstActionNode.name, type: 'main', index: 0 }]],
    };
  } else if (firstActionNode) {
    // No manual trigger — add one + a Merge node so both paths are runnable.
    const manualTrigger = {
      parameters: {},
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [minX - 440, avgY + 110],
    };

    // Merge node: passThrough passes whichever input arrives first straight through.
    const mergeNode = {
      parameters: { mode: 'passThrough', output: 'input1' },
      name: 'Merge Triggers',
      type: 'n8n-nodes-base.merge',
      typeVersion: 2,
      position: [minX - 200, avgY + 20],
    };

    nodes.push(manualTrigger);
    nodes.push(mergeNode);

    connections['CloudPilot Trigger'] = {
      main: [[{ node: 'Merge Triggers', type: 'main', index: 0 }]],
    };
    connections['Manual Trigger'] = {
      main: [[{ node: 'Merge Triggers', type: 'main', index: 1 }]],
    };
    connections['Merge Triggers'] = {
      main: [[{ node: firstActionNode.name, type: 'main', index: 0 }]],
    };

    wf._manualTriggerInjected = true;
  } else {
    // No downstream nodes found — wire to empty output
    connections['CloudPilot Trigger'] = { main: [[]] };
  }

  // Return only the four fields n8n accepts — no _manualTriggerInjected leaks through
  return {
    name: wf.name,
    nodes,
    connections,
    settings: wf.settings,
    // Carry _manualTriggerInjected as a non-enumerable-style side channel
    // (it's used by the caller for the response, stripped before POST to n8n
    //  because the POST body is built from only name/nodes/connections/settings)
    _manualTriggerInjected: wf._manualTriggerInjected || false,
  };
}

function deriveWebhookUrl(nodes) {
  const n8nBase = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
  const webhookNode = (nodes || []).find(n =>
    n.type === 'n8n-nodes-base.webhook' && n.name === 'CloudPilot Trigger'
  );
  const path = webhookNode?.parameters?.path;
  return path ? n8nBase + '/webhook/' + path : null;
}

export default router;