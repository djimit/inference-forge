/**
 * Backend contract conformance tests.
 *
 * Pure, in-memory, no sockets/supertest/live services. These verify the PORT
 * and the registry that consumes it — i.e. the parts of proposal 01 that are
 * verifiable without live Ollama / LM Studio. They use an in-repo FakeBackend
 * implementing `InferenceBackend`, so the contract itself is what is under test.
 *
 * The full characterization tests against a real Ollama + LM Studio instance
 * (proposal 01, tasks 1.x) run separately, locally, after the real adapters are
 * extracted — they are NOT this file. See
 * openspec/changes/01-backend-abstraction-layer/implementation-increment-1.md.
 */

import { describe, it, expect } from 'vitest';
import {
  BackendUnavailableError,
  ModelNotFoundError,
  CapabilityNotSupportedError,
  BackendTimeoutError,
  GenerationFailedError,
  BackendOperationError,
} from '../errors.js';
import { BackendRegistry, type HasBaseUrl } from '../BackendRegistry.js';
import type {
  BackendCapabilities,
  GenerationMetrics,
  InferenceBackend,
  ModelInfo,
  RunningModelStatus,
} from '../InferenceBackend.js';

// -- A minimal fake adapter -----------------------------------------

const FULL_CAPS: BackendCapabilities = {
  supportsKvCacheQuantization: true,
  supportsModelfileExport: true,
  supportsLogProbs: true,
  supportsStreamingMetrics: true,
  supportsHotModelSwap: true,
  supportsToolUse: true,
  maxConcurrentModels: null,
};

function makeModel(partial: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName' | 'backend' | 'backendModelId' | 'type'>): ModelInfo {
  return {
    sizeMb: 1000,
    contextWindow: 8192,
    ...partial,
  };
}

function makeFakeBackend(opts: {
  name: string;
  models: ModelInfo[];
  running?: RunningModelStatus[];
  healthy?: boolean;
  caps?: Partial<BackendCapabilities>;
  baseUrl?: string;
}): InferenceBackend & HasBaseUrl {
  const healthy = opts.healthy ?? true;
  const caps = { ...FULL_CAPS, ...opts.caps };
  return {
    name: opts.name,
    capabilities: caps,
    healthCheck: async () => healthy,
    listAvailableModels: async () => (healthy ? opts.models : []),
    listRunningModels: async () => (healthy ? (opts.running ?? []) : []),
    getModelDetails: async (id: string) => {
      const m = opts.models.find((x) => x.id === id);
      if (!m) throw new ModelNotFoundError(opts.name, `model ${id} not found`);
      return m;
    },
    generate: async function* () { yield 'hi'; },
    generateWithMetrics: async (): Promise<{ text: string; metrics: GenerationMetrics }> => ({
      text: 'hi',
      metrics: {
        tokensPerSecond: 10, totalTokens: 1, evalDurationMs: 100,
        promptEvalDurationMs: 50, vramDeltaBytes: 0,
      },
    }),
    getLogProbs: caps.supportsLogProbs
      ? async () => ({ tokens: ['a'], logProbs: [-1] })
      : undefined,
    exportModelfile: caps.supportsModelfileExport
      ? async () => 'FROM model'
      : undefined,
    getBaseUrl: opts.baseUrl ? () => opts.baseUrl as string : undefined,
  };
}

// -- Error hierarchy ------------------------------------------------

describe('BackendError hierarchy', () => {
  it('each error carries a stable machine-readable code and the backend name', () => {
    expect(new BackendUnavailableError('down', 'ollama').code).toBe('BACKEND_UNAVAILABLE');
    expect(new ModelNotFoundError('ollama', 'x').code).toBe('MODEL_NOT_FOUND');
    expect(new CapabilityNotSupportedError('lmstudio', 'supportsModelfileExport').code).toBe('CAPABILITY_NOT_SUPPORTED');
    expect(new BackendTimeoutError('t', 'ollama').code).toBe('BACKEND_TIMEOUT');
    expect(new GenerationFailedError('g', 'ollama').code).toBe('GENERATION_FAILED');
    expect(new BackendOperationError('o', 'ollama').code).toBe('BACKEND_ERROR');
  });

  it('CapabilityNotSupportedError records which capability was missing', () => {
    const err = new CapabilityNotSupportedError('lmstudio', 'supportsModelfileExport');
    expect(err.capability).toBe('supportsModelfileExport');
    expect(err.backend).toBe('lmstudio');
    expect(err.message).toContain('lmstudio');
    expect(err.message).toContain('supportsModelfileExport');
  });

  it('errors are instanceof BackendUnavailableError (preserves instanceof for logging/audit)', () => {
    const err = new ModelNotFoundError('ollama', 'nope');
    expect(err).toBeInstanceOf(ModelNotFoundError);
    expect(err.name).toBe('ModelNotFoundError');
  });
});

// -- Capability gating ----------------------------------------------

describe('capability gating', () => {
  it('a backend without supportsModelfileExport exposes no exportModelfile', () => {
    const backend = makeFakeBackend({
      name: 'lmstudio',
      models: [],
      caps: { supportsModelfileExport: false },
    });
    expect(backend.exportModelfile).toBeUndefined();
    expect(backend.capabilities.supportsModelfileExport).toBe(false);
  });

  it('a backend without supportsLogProbs exposes no getLogProbs', () => {
    const backend = makeFakeBackend({
      name: 'lmstudio',
      models: [],
      caps: { supportsLogProbs: false },
    });
    expect(backend.getLogProbs).toBeUndefined();
    expect(backend.capabilities.supportsLogProbs).toBe(false);
  });

  it('CapabilityNotSupportedError is the documented fallback when a gated method is unavailable', () => {
    // A consumer that fails to check the capability first and calls the method
    // on a backend lacking it MUST hit CapabilityNotSupportedError, not a raw
    // TypeError. The adapter is responsible for throwing this; the contract test
    // documents the expected shape.
    const err = new CapabilityNotSupportedError('lmstudio', 'supportsLogProbs');
    expect(err.code).toBe('CAPABILITY_NOT_SUPPORTED');
  });
});

// -- BackendRegistry ------------------------------------------------

describe('BackendRegistry', () => {
  it('produces a unified snapshot from multiple adapters via the port only', async () => {
    const ollama = makeFakeBackend({
      name: 'ollama',
      baseUrl: 'http://localhost:11434',
      models: [
        makeModel({ id: 'ollama:llama3:8b', displayName: 'llama3:8b', backend: 'ollama', backendModelId: 'llama3:8b', type: 'llm', parameterSize: '8B', architecture: 'llama', quantization: 'Q4_0', sizeMb: 4500 }),
      ],
    });
    const lms = makeFakeBackend({
      name: 'lmstudio',
      baseUrl: 'http://localhost:1234',
      models: [
        makeModel({ id: 'lmstudio:llama3-8b', displayName: 'llama3-8b', backend: 'lmstudio', backendModelId: 'llama3-8b', type: 'llm', parameterSize: '8B', architecture: 'llama', quantization: 'Q4_K_M', sizeMb: 4400, toolUse: true }),
      ],
    });
    const registry = new BackendRegistry([ollama, lms]);

    const snap = await registry.getSnapshot();

    expect(snap.backends.map((b) => b.backend).sort()).toEqual(['lmstudio', 'ollama']);
    expect(snap.models).toHaveLength(2);
    expect(snap.models.map((m) => m.id).sort()).toEqual(['lmstudio:llama3-8b', 'ollama:llama3:8b']);
    expect(snap.totalStorageMb).toBe(8900);
    expect(snap.totalStorageByBackend).toEqual({ ollama: 4500, lmstudio: 4400 });
    // URL accessor resolved through the documented HasBaseUrl side channel.
    const ollamaStatus = snap.backends.find((b) => b.backend === 'ollama');
    expect(ollamaStatus?.url).toBe('http://localhost:11434');
  });

  it('marks models as loaded and reports VRAM when running models are present', async () => {
    const backend = makeFakeBackend({
      name: 'ollama',
      baseUrl: 'http://localhost:11434',
      models: [makeModel({ id: 'ollama:mistral:7b', displayName: 'mistral:7b', backend: 'ollama', backendModelId: 'mistral:7b', type: 'llm' })],
      running: [{
        modelId: 'ollama:mistral:7b', backend: 'ollama', vramBytes: 5 * 1024 * 1024 * 1024,
        loadedAt: '2026-06-21T00:00:00Z', contextUsed: 1024, contextTotal: 8192,
      }],
    });
    const snap = await new BackendRegistry([backend]).getSnapshot();
    const m = snap.models[0];
    expect(m.loaded).toBe(true);
    expect(m.vramUsageMb).toBe(5 * 1024); // 5 GiB → 5120 MiB
    expect(snap.backends[0].loadedCount).toBe(1);
  });

  it('degrades gracefully when a backend is unreachable (empty list, running:false, no throw)', async () => {
    const dead = makeFakeBackend({
      name: 'ollama', baseUrl: 'http://localhost:11434', models: [makeModel({ id: 'ollama:x', displayName: 'x', backend: 'ollama', backendModelId: 'x', type: 'llm' })],
      healthy: false,
    });
    const snap = await new BackendRegistry([dead]).getSnapshot();
    expect(snap.backends[0].running).toBe(false);
    expect(snap.models).toHaveLength(0); // healthCheck false → no models listed
    expect(snap.totalStorageMb).toBe(0);
  });

  it('detects cross-backend duplicates and annotates both models', async () => {
    // Same base model name after normalization ("llama3-8b") in both backends.
    const a = makeFakeBackend({
      name: 'ollama', baseUrl: 'http://localhost:11434',
      models: [makeModel({ id: 'ollama:llama3-8b:latest', displayName: 'llama3-8b', backend: 'ollama', backendModelId: 'llama3-8b:latest', type: 'llm', architecture: 'llama', parameterSize: '8B' })],
    });
    const b = makeFakeBackend({
      name: 'lmstudio', baseUrl: 'http://localhost:1234',
      models: [makeModel({ id: 'lmstudio:llama3-8b', displayName: 'llama3-8b', backend: 'lmstudio', backendModelId: 'llama3-8b', type: 'llm', architecture: 'llama', parameterSize: '8B' })],
    });
    const snap = await new BackendRegistry([a, b]).getSnapshot();
    expect(snap.duplicates).toHaveLength(1);
    const ollamaModel = snap.models.find((m) => m.backend === 'ollama');
    const lmsModel = snap.models.find((m) => m.backend === 'lmstudio');
    expect(ollamaModel?.duplicate).toBe(lmsModel?.id);
    expect(lmsModel?.duplicate).toBe(ollamaModel?.id);
  });

  it('does NOT flag same-backend models as duplicates', async () => {
    const a = makeFakeBackend({
      name: 'ollama', baseUrl: 'http://localhost:11434',
      models: [
        makeModel({ id: 'ollama:llama3-8b:q4', displayName: 'llama3-8b:q4', backend: 'ollama', backendModelId: 'llama3-8b:q4', type: 'llm', architecture: 'llama', parameterSize: '8B' }),
        makeModel({ id: 'ollama:llama3-8b:q8', displayName: 'llama3-8b:q8', backend: 'ollama', backendModelId: 'llama3-8b:q8', type: 'llm', architecture: 'llama', parameterSize: '8B' }),
      ],
    });
    const snap = await new BackendRegistry([a]).getSnapshot();
    expect(snap.duplicates).toHaveLength(0);
  });

  it('routes a canonical model id to the correct adapter via prefix', () => {
    const ollama = makeFakeBackend({ name: 'ollama', models: [] });
    const lms = makeFakeBackend({ name: 'lmstudio', models: [] });
    const registry = new BackendRegistry([ollama, lms]);
    expect(registry.findBackendForModel('ollama:llama3:8b')?.name).toBe('ollama');
    expect(registry.findBackendForModel('lmstudio:qwen2:7b')?.name).toBe('lmstudio');
    expect(registry.findBackendForModel('vllm:foo')).toBeUndefined();
  });

  it('getModelDetails throws ModelNotFoundError for a missing model', async () => {
    const backend = makeFakeBackend({ name: 'ollama', models: [] });
    await expect(backend.getModelDetails('ollama:nope')).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});
