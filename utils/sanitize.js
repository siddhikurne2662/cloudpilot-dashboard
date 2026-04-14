// utils/sanitize.js
//
// Sanitizes a raw n8n workflow export so it can be safely sent to:
//   POST /api/v1/workflows
//
// n8n only accepts: name, nodes, connections, settings
// All other top-level fields cause "request/body must NOT have additional properties"

/**
 * @param {object} raw   - Raw workflow JSON (from export, Storage, or DB)
 * @param {string} [name] - Optional name override
 * @returns {object}      - Cleaned workflow safe for n8n POST /workflows
 */
export function sanitizeWorkflowForN8n(raw, name) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('sanitizeWorkflowForN8n: raw must be a non-null object');
  }

  // Deep clone to avoid mutating the source
  const wf = JSON.parse(JSON.stringify(raw));

  // Build the allowed payload — only these four fields
  const clean = {
    name: (name && name.trim()) || wf.name || 'Imported Workflow',
    nodes: Array.isArray(wf.nodes) ? wf.nodes : [],
    connections: (wf.connections && typeof wf.connections === 'object') ? wf.connections : {},
    settings: (wf.settings && typeof wf.settings === 'object') ? wf.settings : {},
  };

  // Ensure executionOrder is set (required by n8n >= 1.x)
  if (!clean.settings.executionOrder) {
    clean.settings.executionOrder = 'v1';
  }

  // Strip 'id' from every node — n8n rejects it on workflow creation
  clean.nodes = clean.nodes.map(node => {
    const n = { ...node };
    delete n.id;
    // Ensure position is a valid [x, y] pair
    if (!Array.isArray(n.position) || n.position.length < 2) {
      n.position = [250, 300];
    }
    return n;
  });

  // Inject a Manual Trigger if no trigger-type node is present,
  // so the workflow is activatable and runnable from the dashboard.
  const TRIGGER_TYPES = [
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.start',
    '@n8n/n8n-nodes-langchain.manualChatTrigger',
  ];

  const hasTrigger = clean.nodes.some(n =>
    TRIGGER_TYPES.includes(n.type) ||
    (n.type || '').toLowerCase().includes('manualtrigger') ||
    (n.name || '').toLowerCase() === 'start' ||
    (n.name || '').toLowerCase().includes('manual trigger')
  );

  if (!hasTrigger) {
    const minX = clean.nodes.length > 0
      ? Math.min(...clean.nodes.map(n => (Array.isArray(n.position) ? n.position[0] : 250)))
      : 250;

    const triggerNode = {
      parameters: {},
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [minX - 200, 300],
    };

    clean.nodes.unshift(triggerNode);

    // Wire trigger to the first node that has no incoming connections
    const connectedNodes = new Set();
    for (const conns of Object.values(clean.connections)) {
      if (!conns || typeof conns !== 'object') continue;
      for (const outputs of Object.values(conns)) {
        if (!Array.isArray(outputs)) continue;
        for (const branch of outputs) {
          if (Array.isArray(branch)) {
            for (const conn of branch) {
              if (conn && conn.node) connectedNodes.add(conn.node);
            }
          }
        }
      }
    }

    const entryNode = clean.nodes.find(n =>
      n.name !== 'Manual Trigger' && !connectedNodes.has(n.name)
    );

    if (entryNode) {
      clean.connections['Manual Trigger'] = {
        main: [[{ node: entryNode.name, type: 'main', index: 0 }]],
      };
    }

    clean._manualTriggerInjected = true;
  }

  return clean;
}