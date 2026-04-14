// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();

import { checkN8nHealth, detectBasePath, getN8nHeaders } from './utils/n8n.js';
import workflowsRouter   from './routes/workflows.js';
import credentialsRouter from './routes/credentials.js';
import templatesRouter   from './routes/templates.js';
import executionsRouter  from './routes/executions.js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const execAsync = promisify(exec);
const app       = express();
const PORT      = process.env.PORT || 4000;
const DEMO_MODE = process.env.DEMO_MODE === 'true';

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:8000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4000',
    'http://127.0.0.1:8000',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const supabaseUrl    = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!DEMO_MODE && (!supabaseUrl || !supabaseAnonKey)) {
    return res.status(500).json({
      error: 'Server misconfigured',
      message: 'SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env',
    });
  }

  res.json({
    supabase: { url: supabaseUrl || '', anonKey: supabaseAnonKey || '' },
    demoMode: DEMO_MODE,
    version: '2.0.0',
  });
});

app.get('/api/health', async (req, res) => {
  if (DEMO_MODE) {
    return res.json({
      status: 'demo',
      demo: true,
      services: { n8n: 'mocked', supabase: 'mocked' },
      timestamp: new Date().toISOString(),
    });
  }

  const n8nHealth = await checkN8nHealth();
  const status    = n8nHealth.connected ? 'healthy' : 'degraded';

  res.status(n8nHealth.connected ? 200 : 503).json({
    status,
    services: {
      n8n:      n8nHealth.connected ? 'connected' : 'disconnected',
      supabase: process.env.SUPABASE_URL ? 'configured' : 'not configured',
    },
    n8n: n8nHealth,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// Diagnostic route (no auth required)
// ─────────────────────────────────────────────
app.get('/api/n8n-debug', async (req, res) => {
  const n8nBase = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
  const headers = getN8nHeaders();

  const result = {
    config: {
      n8n_url:         n8nBase,
      api_key_set:     !!process.env.N8N_API_KEY,
      api_key_preview: process.env.N8N_API_KEY
        ? process.env.N8N_API_KEY.slice(0, 10) + '...'
        : 'NOT SET',
      container_name: process.env.N8N_CONTAINER_NAME || 'n8n (default)',
    },
    endpoint_tests: [],
    docker_test:    null,
    instructions:   [],
  };

  const tests = [
    { method: 'GET',  path: '/api/v1/workflows?limit=1',  note: 'Public API — list/toggle/delete' },
    { method: 'GET',  path: '/rest/workflows?limit=1',    note: 'Internal REST — needs session cookie' },
    { method: 'POST', path: '/api/v1/workflows/FAKE/run', note: 'Public run endpoint' },
    { method: 'POST', path: '/rest/workflows/run',        note: 'Internal run endpoint' },
  ];

  for (const { method, path, note } of tests) {
    const url = `${n8nBase}${path}`;
    try {
      const body = method === 'POST'
        ? JSON.stringify({ workflowData: { nodes: [], connections: {}, name: 'test' } })
        : undefined;
      const r    = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(5000) });
      const text = await r.text().catch(() => '');
      result.endpoint_tests.push({ method, url, note, status: r.status, ok: r.ok, response: text.slice(0, 400) });
    } catch (err) {
      result.endpoint_tests.push({ method, url, note, error: err.message });
    }
  }

  // Docker check
  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}}" 2>&1');
    const containers = stdout.trim().split('\n').filter(Boolean);
    result.docker_test = { available: true, containers };

    const containerName = process.env.N8N_CONTAINER_NAME || 'n8n';
    try {
      await execAsync(`docker exec ${containerName} n8n --version`, { timeout: 5000 });
      result.docker_test.exec_test = { container: containerName, status: 'ok' };
    } catch (e) {
      result.docker_test.exec_test = {
        container: containerName,
        status:    'exec failed',
        error:     e.message,
        tip:       `Set N8N_CONTAINER_NAME to one of: ${containers.join(', ')}`,
      };
    }
  } catch (err) {
    result.docker_test = {
      available: false,
      error:     err.message,
      tip:       'Docker not accessible. Run: sudo usermod -aG docker $USER then re-login.',
    };
  }

  const runEndpointWorks = result.endpoint_tests.find(t => t.url.includes('/run') && t.ok);
  const dockerWorks      = result.docker_test?.exec_test?.status === 'ok';

  if (runEndpointWorks) {
    result.instructions.push('Run endpoint works directly.');
  } else if (dockerWorks) {
    result.instructions.push('Docker exec works — workflow running should work.');
  } else if (result.docker_test?.available && !dockerWorks) {
    result.instructions.push(
      `Docker available but cannot exec into "${process.env.N8N_CONTAINER_NAME || 'n8n'}".`,
      `Set N8N_CONTAINER_NAME in .env to one of: ${(result.docker_test.containers || []).join(', ')}`,
      'Restart the backend after updating .env.'
    );
  } else {
    result.instructions.push(
      'Neither API run endpoints nor Docker exec are working.',
      'Fix Docker access: sudo usermod -aG docker $USER && newgrp docker',
      'Add N8N_CONTAINER_NAME=<container-name> to .env and restart.'
    );
  }

  res.json(result);
});

// ─────────────────────────────────────────────
// Protected API routes
// ─────────────────────────────────────────────
app.use('/api/workflows',   workflowsRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/templates',   templatesRouter);
app.use('/api/executions',  executionsRouter);

// ─────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
if (!DEMO_MODE) {
  detectBasePath().catch(err => console.warn('n8n base path detection failed:', err.message));
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Health:  /api/health`);
  console.log(`Debug:   /api/n8n-debug`);
  if (DEMO_MODE) console.log('Demo mode active.');
});