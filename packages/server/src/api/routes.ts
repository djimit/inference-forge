/**
 * REST API Routes — Inference Forge
 */

import { Router } from 'express';
import { ollama } from '../services/ollama.js';
import { monitor } from '../services/monitor.js';
import { benchmark, STANDARD_PROMPTS, type BenchmarkConfig } from '../services/benchmark.js';
import { modelfileGenerator, type HardwareProfile, type ModelfileConfig } from '../services/modelfile.js';
import { hardware } from '../services/hardware.js';
import { throughput } from '../services/throughput.js';
import { alerts } from '../services/alerts.js';
import { perplexity } from '../services/perplexity.js';
import { promptLibrary } from '../services/prompt-library.js';
import { modelfileLibrary } from '../services/modelfile-library.js';
import { orchestrator, type AgentConfig, type Workflow } from '../services/orchestrator.js';

export const router = Router();

// ▶ Health ◀ ▶ Health ◀ ▶ Health ◀ ▶ Health ◀

router.get('/health', async (_req, res) => {
  const ollamaOnline = await ollama.ping();
  res.json({
    status: 'ok',
    version: '0.5.0',
    ollama: ollamaOnline ? 'connected' : 'disconnected',
    ollamaUrl: ollama.getBaseUrl(),
    timestamp: Date.now(),
  });
});

// ▶ Models ◀ ▶ Models ◀ ▶ Models ◀ ▶ Models ◀

router.get('/models', async (_req, res) => {
  try {
    const models = await ollama.listModels();
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch models from Ollama', details: String(err) });
  }
});

router.get('/models/running', async (_req, res) => {
  try {
    const models = await ollama.listRunning();
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch running models', details: String(err) });
  }
});

router.get('/models/:name/info', async (req, res) => {
  try {
    const info = await ollama.showModel(req.params.name);
    res.json(info);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch model info', details: String(err) });
  }
});

// ▶ Metrics ◀ ▶ Metrics ◀ ▶ Metrics ◀ ▶ Metrics ◀

router.get('/metrics', (_req, res) => {
  const metrics = monitor.getLastMetrics();
  if (!metrics) {
    res.status(503).json({ error: 'Metrics not yet available' });
    return;
  }
  res.json(metrics);
});

// ▶ v0.2: Hardware ◀ ▶ Hardware ◀ ▶ Hardware ◀

router.get('/hardware', async (_req, res) => {
  try {
    const snapshot = await hardware.detect();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: 'Hardware detection failed', details: String(err) });
  }
});

router.get('/hardware/last', (_req, res) => {
  const snapshot = hardware.getLastSnapshot();
  if (!snapshot) {
    res.status(503).json({ error: 'Hardware data not yet available' });
    return;
  }
  res.json(snapshot);
});

// ▶ v0.2: Throughput ◀ ▶ Throughput ◀ ▶ Throughput ◀

router.get('/throughput', (_req, res) => {
  res.json(throughput.getSnapshot());
});

router.get('/throughput/:model', (req, res) => {
  const history = throughput.getModelHistory(req.params.model);
  res.json({ model: req.params.model, samples: history });
});

// ▶ v0.2: Alerts ◀ ▶ Alerts ◀ ▶ Alerts ◀ ▶ Alerts ◀

router.get('/alerts', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 50;
  res.json({ alerts: alerts.getAlerts(limit) });
});

router.get('/alerts/thresholds', (_req, res) => {
  res.json({ thresholds: alerts.getThresholds() });
});

router.put('/alerts/thresholds/:id', (req, res) => {
  const success = alerts.updateThreshold(req.params.id, req.body);
  if (!success) {
    res.status(404).json({ error: 'Threshold not found' });
    return;
  }
  res.json({ success: true });
});

router.post('/alerts/:id/acknowledge', (req, res) => {
  const success = alerts.acknowledge(req.params.id);
  res.json({ success });
});

router.post('/alerts/acknowledge-all', (_req, res) => {
  alerts.acknowledgeAll();
  res.json({ success: true });
});

// ▶ Benchmark ◀ ▶ Benchmark ◀ ▶ Benchmark ◀

router.get('/benchmark/status', (_req, res) => {
  res.json({ running: benchmark.isRunning() });
});

router.post('/benchmark/run', async (req, res) => {
  if (benchmark.isRunning()) {
    res.status(409).json({ error: 'Benchmark already in progress' });
    return;
  }

  const { model, kvCacheTypes, runs, promptSetId } = req.body as {
    model: string;
    kvCacheTypes?: string[];
    runs?: number;
    promptSetId?: string;
  };

  if (!model) {
    res.status(400).json({ error: 'Model name is required' });
    return;
  }

  // Use custom prompt set if specified
  let prompts = STANDARD_PROMPTS;
  if (promptSetId) {
    const set = promptLibrary.get(promptSetId);
    if (set) {
      prompts = set.prompts.map((p) => ({
        label: p.label,
        text: p.text,
        expectedTokens: p.expectedTokens,
      }));
    }
  }

  const config: BenchmarkConfig = {
    model,
    kvCacheTypes: kvCacheTypes || ['f16', 'q8_0', 'q4_0'],
    prompts,
    runs: runs || 2,
  };

  res.json({ status: 'started', config });

  try {
    const result = await benchmark.run(config);
    (globalThis as any).__lastBenchmarkResult = result;
  } catch (err) {
    console.error('[Benchmark] Error:', err);
  }
});

router.get('/benchmark/result', (_req, res) => {
  const result = (globalThis as any).__lastBenchmarkResult;
  if (!result) {
    res.status(404).json({ error: 'No benchmark result available' });
    return;
  }
  res.json(result);
});

router.get('/benchmark/export/:format', (req, res) => {
  const result = (globalThis as any).__lastBenchmarkResult;
  if (!result) {
    res.status(404).json({ error: 'No benchmark result to export' });
    return;
  }

  if (req.params.format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="benchmark-${result.model}-${Date.now()}.json"`);
    res.json(result);
  } else {
    res.status(400).json({ error: 'Supported formats: json' });
  }
});

// ▶ v0.3: Perplexity ◀ ▶ Perplexity ◀ ▶ Perplexity ◀

router.post('/perplexity/estimate', async (req, res) => {
  const { model, kvCacheType, corpus } = req.body as {
    model: string;
    kvCacheType?: string;
    corpus?: string;
  };

  if (!model) {
    res.status(400).json({ error: 'Model name is required' });
    return;
  }

  try {
    const result = await perplexity.estimate(model, kvCacheType || 'f16', corpus);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Perplexity estimation failed', details: String(err) });
  }
});

router.post('/perplexity/compare', async (req, res) => {
  const { model, kvCacheTypes, corpus } = req.body as {
    model: string;
    kvCacheTypes?: string[];
    corpus?: string;
  };

  if (!model) {
    res.status(400).json({ error: 'Model name is required' });
    return;
  }

  try {
    const result = await perplexity.compare(model, kvCacheTypes, corpus);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Perplexity comparison failed', details: String(err) });
  }
});

// ▶ v0.3: Prompt Library ◀ ▶ Prompt Library ◀

router.get('/prompts', (_req, res) => {
  res.json({ sets: promptLibrary.getAll() });
});

router.get('/prompts/:id', (req, res) => {
  const set = promptLibrary.get(req.params.id);
  if (!set) { res.status(404).json({ error: 'Prompt set not found' }); return; }
  res.json(set);
});

router.post('/prompts', (req, res) => {
  promptLibrary.add(req.body);
  res.json({ success: true });
});

router.post('/prompts/import', (req, res) => {
  try {
    const set = promptLibrary.importSet(JSON.stringify(req.body));
    res.json(set);
  } catch (err) {
    res.status(400).json({ error: 'Invalid prompt set', details: String(err) });
  }
});

router.get('/prompts/:id/export', (req, res) => {
  const json = promptLibrary.exportSet(req.params.id);
  if (!json) { res.status(404).json({ error: 'Prompt set not found' }); return; }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="prompt-set-${req.params.id}.json"`);
  res.send(json);
});

// ▶ v0.4: Modelfile Library ◀ ▶ Modelfile Library ◀

router.get('/templates', (req, res) => {
  const query = req.query.q as string;
  const tag = req.query.tag as string;
  if (query) {
    res.json({ templates: modelfileLibrary.search(query) });
  } else if (tag) {
    res.json({ templates: modelfileLibrary.getByTag(tag) });
  } else {
    res.json({ templates: modelfileLibrary.getAll() });
  }
});

router.get('/templates/:id', (req, res) => {
  const template = modelfileLibrary.get(req.params.id);
  if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
  res.json(template);
});

router.post('/templates', (req, res) => {
  modelfileLibrary.add(req.body);
  res.json({ success: true });
});

router.put('/templates/:id', (req, res) => {
  const success = modelfileLibrary.update(req.params.id, req.body);
  if (!success) { res.status(404).json({ error: 'Template not found' }); return; }
  res.json({ success: true });
});

router.delete('/templates/:id', (req, res) => {
  const success = modelfileLibrary.delete(req.params.id);
  res.json({ success });
});

router.post('/templates/:id/create', async (req, res) => {
  const { modelName } = req.body as { modelName: string };
  if (!modelName) { res.status(400).json({ error: 'modelName is required' }); return; }

  const result = await modelfileLibrary.createModel(req.params.id, modelName);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ success: true, modelName });
});

router.get('/templates/:id/export', (req, res) => {
  const json = modelfileLibrary.exportTemplate(req.params.id);
  if (!json) { res.status(404).json({ error: 'Template not found' }); return; }
  res.setHeader('Content-Disposition', `attachment; filename="template-${req.params.id}.json"`);
  res.json(JSON.parse(json));
});

router.post('/templates/import', (req, res) => {
  try {
    const template = modelfileLibrary.importTemplate(JSON.stringify(req.body));
    res.json(template);
  } catch (err) {
    res.status(400).json({ error: 'Invalid template', details: String(err) });
  }
});

// ▶ Modelfile Generator ◀ ▶ Modelfile Generator ◀

router.post('/modelfile/generate', async (req, res) => {
  const { hardware: hw, config } = req.body as {
    hardware: HardwareProfile;
    config: ModelfileConfig;
  };

  if (!hw || !config) {
    res.status(400).json({ error: 'hardware and config are required' });
    return;
  }

  try {
    const result = await modelfileGenerator.generate(hw, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate Modelfile', details: String(err) });
  }
});

// ▶ v0.5: Agents ◀ ▶ Agents ◀ ▶ Agents ◀ ▶ Agents ◀

router.get('/agents', (_req, res) => {
  res.json({ agents: orchestrator.getAllAgents() });
});

router.get('/agents/:id', (req, res) => {
  const agent = orchestrator.getAgent(req.params.id);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(agent);
});

router.post('/agents', (req, res) => {
  orchestrator.registerAgent(req.body as AgentConfig);
  res.json({ success: true });
});

router.put('/agents/:id', (req, res) => {
  const success = orchestrator.updateAgent(req.params.id, req.body);
  if (!success) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json({ success: true });
});

router.delete('/agents/:id', (req, res) => {
  const success = orchestrator.unregisterAgent(req.params.id);
  res.json({ success });
});

// ▶ v0.5: Sessions ◀ ▶ Sessions ◀ ▶ Sessions ◀

router.get('/sessions', (_req, res) => {
  res.json({ sessions: orchestrator.getAllSessions() });
});

router.post('/sessions', (req, res) => {
  const { agentId } = req.body as { agentId: string };
  try {
    const session = orchestrator.createSession(agentId);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.get('/sessions/:id', (req, res) => {
  const session = orchestrator.getSession(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(session);
});

router.post('/sessions/:id/message', async (req, res) => {
  const { content } = req.body as { content: string };
  try {
    const response = await orchestrator.sendMessage(req.params.id, content);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/sessions/:id', (req, res) => {
  const success = orchestrator.closeSession(req.params.id);
  res.json({ success });
});

// ▶ v0.5: Workflows ◀ ▶ Workflows ◀ ▶ Workflows ◀

router.get('/workflows', (_req, res) => {
  res.json({ workflows: orchestrator.getAllWorkflows() });
});

router.post('/workflows', (req, res) => {
  orchestrator.registerWorkflow(req.body as Workflow);
  res.json({ success: true });
});

router.post('/workflows/:id/execute', async (req, res) => {
  const { input } = req.body as { input: string };
  try {
    const results = await orchestrator.executeWorkflow(req.params.id, input);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ▶ v0.5: Orchestrator Status ◀ ▶ Orchestrator Status ◀

router.get('/orchestrator/status', async (_req, res) => {
  try {
    const status = await orchestrator.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/route', (req, res) => {
  const { content } = req.body as { content: string };
  const agent = orchestrator.routeMessage(content);
  res.json({ agent: agent || null });
});
