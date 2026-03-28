/**
 * REST API Routes
 */

import { Router } from 'express';
import { ollama } from '../services/ollama.js';
import { monitor } from '../services/monitor.js';
import { benchmark, STANDARD_PROMPTS, type BenchmarkConfig } from '../services/benchmark.js';
import { modelfileGenerator, type HardwareProfile, type ModelfileConfig } from '../services/modelfile.js';

export const router = Router();

// ── Health ─────────────────────────────────────────────────────────

router.get('/health', async (_req, res) => {
  const ollamaOnline = await ollama.ping();
  res.json({
    status: 'ok',
    ollama: ollamaOnline ? 'connected' : 'disconnected',
    ollamaUrl: ollama.getBaseUrl(),
    timestamp: Date.now(),
  });
});

// ── Models ─────────────────────────────────────────────────────────

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

// ── Metrics ────────────────────────────────────────────────────────

router.get('/metrics', (_req, res) => {
  const metrics = monitor.getLastMetrics();
  if (!metrics) {
    res.status(503).json({ error: 'Metrics not yet available' });
    return;
  }
  res.json(metrics);
});

// ── Benchmark ──────────────────────────────────────────────────────

router.get('/benchmark/status', (_req, res) => {
  res.json({ running: benchmark.isRunning() });
});

router.post('/benchmark/run', async (req, res) => {
  if (benchmark.isRunning()) {
    res.status(409).json({ error: 'Benchmark already in progress' });
    return;
  }

  const { model, kvCacheTypes, runs } = req.body as {
    model: string;
    kvCacheTypes?: string[];
    runs?: number;
  };

  if (!model) {
    res.status(400).json({ error: 'Model name is required' });
    return;
  }

  const config: BenchmarkConfig = {
    model,
    kvCacheTypes: kvCacheTypes || ['f16', 'q8_0', 'q4_0'],
    prompts: STANDARD_PROMPTS,
    runs: runs || 2,
  };

  // Run async, return immediately
  res.json({ status: 'started', config });

  try {
    const result = await benchmark.run(config);
    // Store result for later retrieval (could use a simple in-memory store)
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

// ── Modelfile Generator ────────────────────────────────────────────

router.post('/modelfile/generate', async (req, res) => {
  const { hardware, config } = req.body as {
    hardware: HardwareProfile;
    config: ModelfileConfig;
  };

  if (!hardware || !config) {
    res.status(400).json({ error: 'hardware and config are required' });
    return;
  }

  try {
    const result = await modelfileGenerator.generate(hardware, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate Modelfile', details: String(err) });
  }
});
