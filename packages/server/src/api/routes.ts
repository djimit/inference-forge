/**
 * REST API Routes — Inference Forge
 */

import { Router } from 'express';
import { ollama } from '../services/ollama.js';
import { monitor } from '../services/monitor.js';
import { benchmark, STANDARD_PROMPTS, type BenchmarkConfig, type ExpandedBenchmarkConfig } from '../services/benchmark.js';
import { modelfileGenerator, type HardwareProfile, type ModelfileConfig } from '../services/modelfile.js';
import { hardware } from '../services/hardware.js';
import { throughput } from '../services/throughput.js';
import { alerts } from '../services/alerts.js';
import { perplexity } from '../services/perplexity.js';
import { promptLibrary } from '../services/prompt-library.js';
import { modelfileLibrary } from '../services/modelfile-library.js';
import { orchestrator, type AgentConfig, type Workflow } from '../services/orchestrator.js';
import { pressure } from '../services/pressure.js';
import { database } from '../services/database.js';
import { ioProfiler } from '../services/io-profiler.js';
import { costTracker } from '../services/cost-tracker.js';

export const router = Router();

// -- Health ---------------------------------------------------------

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

// -- Models ---------------------------------------------------------

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

// -- Model Pull (streaming SSE) -------------------------------------

router.post('/models/pull', async (req, res) => {
  const { name } = req.body as { name: string };
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await ollama.pullModel(name, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ status: 'success' })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ status: 'error', error: String(err) })}\n\n`);
  }
  res.end();
});

// -- Metrics --------------------------------------------------------

router.get('/metrics', (_req, res) => {
  const metrics = monitor.getLastMetrics();
  if (!metrics) {
    res.status(503).json({ error: 'Metrics not yet available' });
    return;
  }
  res.json(metrics);
});

// -- v0.2: Hardware -------------------------------------------------

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

// -- v0.2: Throughput -----------------------------------------------

router.get('/throughput', (_req, res) => {
  res.json(throughput.getSnapshot());
});

router.get('/throughput/:model', (req, res) => {
  const history = throughput.getModelHistory(req.params.model);
  res.json({ model: req.params.model, samples: history });
});

// -- v0.2: Alerts ---------------------------------------------------

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

// -- Benchmark ------------------------------------------------------

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

router.post('/benchmark/run-expanded', async (req, res) => {
  if (benchmark.isRunning()) {
    res.status(409).json({ error: 'Benchmark already in progress' });
    return;
  }

  const config = req.body as ExpandedBenchmarkConfig;
  if (!config.model || !config.mode) {
    res.status(400).json({ error: 'model and mode are required' });
    return;
  }

  res.json({ status: 'started', config });

  try {
    const result = await benchmark.runExpanded(config);
    (globalThis as any).__lastExpandedBenchmarkResult = result;
    (globalThis as any).__lastBenchmarkResult = result;
  } catch (err) {
    console.error('[Benchmark] Expanded error:', err);
  }
});

router.get('/benchmark/result-expanded', (_req, res) => {
  const result = (globalThis as any).__lastExpandedBenchmarkResult;
  if (!result) {
    res.status(404).json({ error: 'No expanded benchmark result available' });
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

// -- History (SQLite) -----------------------------------------------

router.get('/benchmark/history', (_req, res) => {
  const limit = parseInt(String(_req.query.limit) || '50', 10);
  const mode = _req.query.mode as string | undefined;
  res.json({ runs: database.listBenchmarkRuns(limit, mode) });
});

router.get('/benchmark/history/:id', (req, res) => {
  const run = database.getBenchmarkRun(req.params.id);
  if (!run) { res.status(404).json({ error: 'Benchmark run not found' }); return; }
  res.json(run);
});

router.get('/hardware/history', (req, res) => {
  const since = parseInt(String(req.query.since) || '0', 10);
  const limit = parseInt(String(req.query.limit) || '100', 10);
  res.json({ snapshots: database.getHardwareHistory(since, limit) });
});

router.get('/alerts/history', (req, res) => {
  const limit = parseInt(String(req.query.limit) || '100', 10);
  const since = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
  res.json({ alerts: database.getAlertHistory(limit, since) });
});

// -- v0.3: Perplexity -----------------------------------------------

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

// -- v0.3: Prompt Library -------------------------------------------

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

// -- v0.4: Modelfile Library ----------------------------------------

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

// -- Modelfile Generator --------------------------------------------

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

router.post('/modelfile/generate-auto', async (req, res) => {
  const { config } = req.body as { config: ModelfileConfig };
  if (!config) {
    res.status(400).json({ error: 'config is required' });
    return;
  }

  const snapshot = hardware.getLastSnapshot();
  if (!snapshot) {
    res.status(503).json({ error: 'Hardware not detected yet. Try again shortly.' });
    return;
  }

  const gpu = snapshot.gpus[0];
  const profile: HardwareProfile = {
    gpuVramMb: gpu?.vramFreeMb || 0,
    systemRamMb: snapshot.system.ramTotalMb,
    gpuName: gpu?.name || 'CPU Only',
    cpuCores: snapshot.system.cpuCores,
    cpuPhysicalCores: snapshot.system.cpuPhysicalCores,
    numaNodes: snapshot.system.numaNodes,
    coresPerNuma: snapshot.system.coresPerNuma,
    pcieGeneration: snapshot.system.pcieGeneration,
    pcieBandwidthGBs: snapshot.system.pcieBandwidthGBs,
  };

  try {
    const result = await modelfileGenerator.generate(profile, config);
    res.json({ ...result, hardwareDetected: profile });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate Modelfile', details: String(err) });
  }
});

// -- I/O Profiling --------------------------------------------------

router.get('/io/profile', async (_req, res) => {
  try {
    const profile = await ioProfiler.profile();
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'I/O profiling failed', details: String(err) });
  }
});

router.post('/io/benchmark', async (_req, res) => {
  if (ioProfiler.isBenchmarkRunning()) {
    res.status(409).json({ error: 'I/O benchmark already running' });
    return;
  }
  res.json({ status: 'started' });
  ioProfiler.runBenchmark().catch((err) => console.error('[IO] Benchmark error:', err));
});

router.get('/io/benchmark/result', (_req, res) => {
  const profile = ioProfiler.getLastProfile();
  res.json({
    readBandwidthMBs: profile?.readBandwidthMBs || null,
    running: ioProfiler.isBenchmarkRunning(),
  });
});

// -- Cost Tracking ---------------------------------------------------

router.get('/costs', (_req, res) => {
  res.json(costTracker.getSnapshot());
});

router.post('/costs/record', (req, res) => {
  const sample = req.body;
  if (!sample.provider || !sample.model) {
    res.status(400).json({ error: 'provider and model required' });
    return;
  }
  sample.timestamp = sample.timestamp || Date.now();
  sample.estimatedCostUsd = sample.estimatedCostUsd ||
    costTracker.estimateCost(sample.provider, sample.model, sample.inputTokens || 0, sample.outputTokens || 0);
  costTracker.recordUsage(sample);
  res.json({ success: true, estimatedCostUsd: sample.estimatedCostUsd });
});

router.post('/costs/budget', (req, res) => {
  const { budgetUsd } = req.body;
  if (typeof budgetUsd !== 'number') {
    res.status(400).json({ error: 'budgetUsd must be a number' });
    return;
  }
  costTracker.setCreditBudget(budgetUsd);
  res.json({ success: true });
});

router.get('/costs/samples', (req, res) => {
  const limit = parseInt(String(req.query.limit) || '100', 10);
  res.json({ samples: costTracker.getSamples(limit) });
});

// -- Resource Pressure -----------------------------------------------

router.get('/pressure', (_req, res) => {
  const data = pressure.getLastPressure();
  if (!data) {
    res.status(503).json({ error: 'Pressure data not available yet' });
    return;
  }
  res.json(data);
});

router.post('/pressure/predict', async (req, res) => {
  const { model } = req.body as { model: string };
  if (!model) {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  try {
    const prediction = await pressure.predictLoadImpact(model);
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: 'Prediction failed', details: String(err) });
  }
});

// -- v0.5: Agents ---------------------------------------------------

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

// -- v0.5: Sessions -------------------------------------------------

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

// Streaming chat endpoint — sends tokens as SSE
router.post('/sessions/:id/message/stream', async (req, res) => {
  const { content } = req.body as { content: string };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  orchestrator.sendMessageStream(
    req.params.id,
    content,
    (token) => res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`),
    (fullResponse) => {
      res.write(`data: ${JSON.stringify({ type: 'done', content: fullResponse })}\n\n`);
      res.end();
    },
    (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
      res.end();
    }
  );
});

router.delete('/sessions/:id', (req, res) => {
  const success = orchestrator.closeSession(req.params.id);
  res.json({ success });
});

// -- v0.5: Workflows ------------------------------------------------

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

// -- v0.5: Orchestrator Status --------------------------------------

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
