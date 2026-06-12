import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/ollama.js', () => ({
  ollama: {
    ping: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([]),
    listRunning: vi.fn().mockResolvedValue([]),
    showModel: vi.fn().mockResolvedValue({}),
    pullModel: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue('http://localhost:11434'),
  },
}));

vi.mock('../services/monitor.js', () => ({
  monitor: {
    start: vi.fn(),
    stop: vi.fn(),
    getLastMetrics: vi.fn().mockReturnValue(null),
    subscribe: vi.fn(),
  },
}));

vi.mock('../services/hardware.js', () => ({
  hardware: {
    start: vi.fn(),
    stop: vi.fn(),
    detect: vi.fn().mockResolvedValue({}),
    getLastSnapshot: vi.fn().mockReturnValue(null),
    subscribe: vi.fn(),
  },
}));

vi.mock('../services/pressure.js', () => ({
  pressure: {
    start: vi.fn(),
    getLastPressure: vi.fn().mockReturnValue(null),
    predictLoadImpact: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/model-registry.js', () => ({
  modelRegistry: {
    start: vi.fn(),
    stop: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue(null),
    refresh: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/database.js', () => ({
  database: {
    isEnabled: vi.fn().mockReturnValue(false),
    close: vi.fn(),
    listBenchmarkRuns: vi.fn().mockReturnValue([]),
    getBenchmarkRun: vi.fn().mockReturnValue(null),
    getHardwareHistory: vi.fn().mockReturnValue([]),
    getAlertHistory: vi.fn().mockReturnValue([]),
    saveHardwareSnapshot: vi.fn(),
    saveAlert: vi.fn(),
    saveBenchmarkRun: vi.fn(),
  },
}));

vi.mock('../services/benchmark.js', () => ({
  benchmark: {
    isRunning: vi.fn().mockReturnValue(false),
    run: vi.fn().mockResolvedValue({}),
    runExpanded: vi.fn().mockResolvedValue({}),
    subscribeProgress: vi.fn(),
    STANDARD_PROMPTS: [],
  },
}));

vi.mock('../services/benchmark-state.js', () => ({
  benchmarkState: {
    getBenchmarkResult: vi.fn().mockReturnValue(null),
    getExpandedBenchmarkResult: vi.fn().mockReturnValue(null),
    setBenchmarkResult: vi.fn(),
    setExpandedBenchmarkResult: vi.fn(),
  },
}));

vi.mock('../services/perplexity.js', () => ({
  perplexity: {
    estimate: vi.fn().mockResolvedValue({}),
    compare: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/prompt-library.js', () => ({
  promptLibrary: {
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    add: vi.fn(),
    importSet: vi.fn().mockReturnValue({}),
    exportSet: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../services/modelfile-library.js', () => ({
  modelfileLibrary: {
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    getByTag: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    add: vi.fn(),
    update: vi.fn().mockReturnValue(true),
    delete: vi.fn().mockReturnValue(true),
    createModel: vi.fn().mockResolvedValue({ success: true }),
    exportTemplate: vi.fn().mockReturnValue(null),
    importTemplate: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../services/modelfile.js', () => ({
  modelfileGenerator: {
    generate: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/io-profiler.js', () => ({
  ioProfiler: {
    profile: vi.fn().mockResolvedValue({}),
    isBenchmarkRunning: vi.fn().mockReturnValue(false),
    runBenchmark: vi.fn().mockResolvedValue(undefined),
    getLastProfile: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../services/cost-tracker.js', () => ({
  costTracker: {
    getSnapshot: vi.fn().mockReturnValue({}),
    recordUsage: vi.fn(),
    setCreditBudget: vi.fn(),
    getSamples: vi.fn().mockReturnValue([]),
    estimateCost: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('../services/orchestrator.js', () => ({
  orchestrator: {
    getAllAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn().mockReturnValue(null),
    registerAgent: vi.fn(),
    updateAgent: vi.fn().mockReturnValue(false),
    unregisterAgent: vi.fn().mockReturnValue(false),
    getAllSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn().mockReturnValue({ id: 's1' }),
    getSession: vi.fn().mockReturnValue(null),
    sendMessage: vi.fn().mockResolvedValue('ok'),
    sendMessageStream: vi.fn(),
    closeSession: vi.fn().mockReturnValue(false),
    getAllWorkflows: vi.fn().mockReturnValue([]),
    registerWorkflow: vi.fn(),
    executeWorkflow: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({}),
    routeMessage: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../services/lmstudio.js', () => ({
  lmstudio: {
    isServerRunning: vi.fn().mockResolvedValue(false),
    listModelsDetailed: vi.fn().mockResolvedValue([]),
    listLoaded: vi.fn().mockResolvedValue([]),
    startServer: vi.fn().mockResolvedValue(false),
    stopServer: vi.fn().mockResolvedValue(false),
    loadModel: vi.fn().mockResolvedValue(false),
    unloadModel: vi.fn().mockResolvedValue(false),
    chat: vi.fn().mockResolvedValue({}),
    chatStream: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue('http://localhost:1234'),
  },
}));

vi.mock('../services/storage-advisor.js', () => ({
  storageAdvisor: {
    generateReport: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/perf-profiler.js', () => ({
  perfProfiler: {
    getProfiles: vi.fn().mockReturnValue([]),
    getProfile: vi.fn().mockReturnValue(null),
    profileModel: vi.fn().mockResolvedValue({}),
    profileAll: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../services/route-advisor.js', () => ({
  routeAdvisor: {
    recommend: vi.fn().mockReturnValue([]),
    getPolicies: vi.fn().mockReturnValue([]),
    addPolicy: vi.fn(),
    removePolicy: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../services/system-optimizer.js', () => ({
  systemOptimizer: {
    generateReport: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/openclaw-bridge.js', () => ({
  openclawBridge: {
    getAgents: vi.fn().mockReturnValue([]),
    recordAgentUsage: vi.fn(),
    checkCapacity: vi.fn().mockReturnValue({}),
    getRecommendations: vi.fn().mockReturnValue([]),
    adviseForAgent: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../services/hivemind-bridge.js', () => ({
  hivemindBridge: {
    publishAll: vi.fn().mockResolvedValue({}),
    publishProfiles: vi.fn().mockResolvedValue({}),
    publishHardwareSnapshot: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../services/throughput.js', () => ({
  throughput: {
    getSnapshot: vi.fn().mockReturnValue({}),
    getModelHistory: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../services/alerts.js', () => ({
  alerts: {
    getAlerts: vi.fn().mockReturnValue([]),
    getThresholds: vi.fn().mockReturnValue({}),
    updateThreshold: vi.fn().mockReturnValue(false),
    acknowledge: vi.fn().mockReturnValue(false),
    acknowledgeAll: vi.fn(),
    evaluate: vi.fn(),
    subscribe: vi.fn(),
  },
}));

import { router } from '../api/routes.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', router);
  return app;
}

describe('Route Guard Tests — Inference Forge', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { benchmark } = await import('../services/benchmark.js');
    vi.mocked(benchmark.isRunning).mockReturnValue(false);
    app = createApp();
  });

  // 1. CRITICAL: POST /sessions/:id/message with empty body
  describe('POST /api/sessions/:id/message', () => {
    it('returns 400 when body is empty', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/message')
        .send({})
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('returns 400 when content is missing', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/message')
        .send({ notContent: 'x' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });
  });

  // 2. CRITICAL: POST /workflows/:id/execute with empty body
  describe('POST /api/workflows/:id/execute', () => {
    it('returns 400 when body is empty', async () => {
      const res = await request(app)
        .post('/api/workflows/w1/execute')
        .send({})
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('returns 400 when input is missing', async () => {
      const res = await request(app)
        .post('/api/workflows/w1/execute')
        .send({ notInput: 'x' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });
  });

  // 3. CRITICAL: POST /benchmark/run with invalid runs
  describe('POST /api/benchmark/run', () => {
    it('returns 400 when model is missing', async () => {
      const res = await request(app)
        .post('/api/benchmark/run')
        .send({ runs: 2 });
      expect(res.status).toBe(400);
    });

    it('returns 409 when benchmark already running', async () => {
      const { benchmark } = await import('../services/benchmark.js');
      vi.mocked(benchmark.isRunning).mockReturnValue(true);

      const res = await request(app)
        .post('/api/benchmark/run')
        .send({ model: 'llama3' });
      expect(res.status).toBe(409);
    });
  });

  // 4. HIGH: POST /models/pull with missing name
  describe('POST /api/models/pull', () => {
    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/models/pull')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // 5. HIGH: GET /benchmark/export/:format with unsupported format
  describe('GET /api/benchmark/export/:format', () => {
    it('returns 404 when no benchmark result exists', async () => {
      const res = await request(app).get('/api/benchmark/export/json');
      expect(res.status).toBe(404);
    });

    it('returns 400 for unsupported format', async () => {
      const { benchmarkState } = await import('../services/benchmark-state.js');
      vi.mocked(benchmarkState.getBenchmarkResult).mockReturnValue({
        model: 'llama3',
        results: [],
      } as any);

      const res = await request(app).get('/api/benchmark/export/xml');
      expect(res.status).toBe(400);
    });
  });

  // 6. HIGH: POST /agents with missing required fields
  describe('POST /api/agents', () => {
    it('accepts agent registration (no validation)', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'test-agent' });
      expect(res.status).toBe(200);
    });
  });

  // 7. MEDIUM: GET /metrics when no metrics available
  describe('GET /api/metrics', () => {
    it('returns 503 when metrics not yet available', async () => {
      const res = await request(app).get('/api/metrics');
      expect(res.status).toBe(503);
    });

    it('returns 200 when metrics are available', async () => {
      const { monitor } = await import('../services/monitor.js');
      vi.mocked(monitor.getLastMetrics).mockReturnValue({
        timestamp: Date.now(),
        models: { running: [] },
        ollamaOnline: true,
      } as any);

      const res = await request(app).get('/api/metrics');
      expect(res.status).toBe(200);
    });
  });

  // 8. MEDIUM: GET /profiles/:backend/:modelId with invalid backend
  describe('GET /api/profiles/:backend/:modelId', () => {
    it('returns 400 for invalid backend', async () => {
      const res = await request(app).get('/api/profiles/invalid/model1');
      expect(res.status).toBe(400);
    });

    it('returns 404 when profile not found', async () => {
      const res = await request(app).get('/api/profiles/ollama/model1');
      expect(res.status).toBe(404);
    });
  });

  // 9. MEDIUM: DELETE /agents/:id for non-existent agent
  describe('DELETE /api/agents/:id', () => {
    it('returns success: false for non-existent agent', async () => {
      const { orchestrator } = await import('../services/orchestrator.js');
      vi.mocked(orchestrator.unregisterAgent).mockReturnValue(false);

      const res = await request(app).delete('/api/agents/nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
    });
  });

  // 10. MEDIUM: POST /lmstudio/chat with temperature out of range
  describe('POST /api/lmstudio/chat', () => {
    it('returns 400 when model is missing', async () => {
      const res = await request(app)
        .post('/api/lmstudio/chat')
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when temperature is out of range', async () => {
      const res = await request(app)
        .post('/api/lmstudio/chat')
        .send({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 3,
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when messages is empty', async () => {
      const res = await request(app)
        .post('/api/lmstudio/chat')
        .send({ model: 'test', messages: [] });
      expect(res.status).toBe(400);
    });
  });

  // 11. MEDIUM: POST /benchmark/run-expanded with invalid mode
  describe('POST /api/benchmark/run-expanded', () => {
    it('returns 400 when model is missing', async () => {
      const res = await request(app)
        .post('/api/benchmark/run-expanded')
        .send({ mode: 'throughput' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when mode is missing', async () => {
      const res = await request(app)
        .post('/api/benchmark/run-expanded')
        .send({ model: 'llama3' });
      expect(res.status).toBe(400);
    });

    it('returns 409 when already running', async () => {
      const { benchmark } = await import('../services/benchmark.js');
      vi.mocked(benchmark.isRunning).mockReturnValue(true);

      const res = await request(app)
        .post('/api/benchmark/run-expanded')
        .send({ model: 'llama3', mode: 'throughput' });
      expect(res.status).toBe(409);
    });
  });

  // 12. LOW: Health endpoint baseline
  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // Bonus: DELETE /sessions/:id for non-existent
  describe('DELETE /api/sessions/:id', () => {
    it('returns success: false for non-existent session', async () => {
      const { orchestrator } = await import('../services/orchestrator.js');
      vi.mocked(orchestrator.closeSession).mockReturnValue(false);

      const res = await request(app).delete('/api/sessions/nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
    });
  });

  // Bonus: POST /costs/record validation
  describe('POST /api/costs/record', () => {
    it('returns 400 when provider is missing', async () => {
      const res = await request(app)
        .post('/api/costs/record')
        .send({ model: 'gpt-4' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const res = await request(app)
        .post('/api/costs/record')
        .send({ provider: 'openai' });
      expect(res.status).toBe(400);
    });
  });
});
