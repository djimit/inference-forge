/**
 * BackendRegistry — the backend-agnostic replacement for the hand-merge
 * currently living in services/model-registry.ts.
 *
 * It holds a set of `InferenceBackend` adapters and produces a unified
 * `RegistrySnapshot` by iterating them through the port ONLY. It knows nothing
 * about Ollama or LM Studio specifically: the per-backend normalization
 * (OllamaModel → ModelInfo, LmsModel → ModelInfo) happens inside each adapter,
 * not here. Adding a third backend (increment 2 and beyond) requires NO change
 * to this file — register a new adapter and its models appear in the snapshot.
 *
 * Increment-1 scope: this module is delivered standalone and tested against a
 * fake adapter. It is NOT yet wired into index.ts/routes.ts — that rewiring
 * (increment 2) happens after the real adapters are extracted and characterized
 * against live Ollama + LM Studio. See
 * openspec/changes/01-backend-abstraction-layer/implementation-increment-1.md.
 */

import type {
  BackendStatus,
  DuplicatePair,
  InferenceBackend,
  ModelInfo,
  RegistrySnapshot,
  RunningModelStatus,
  UnifiedModel,
} from './InferenceBackend.js';

export class BackendRegistry {
  private readonly backends: readonly InferenceBackend[];

  constructor(backends: InferenceBackend[] = []) {
    this.backends = Object.freeze([...backends]);
  }

  getBackendNames(): string[] {
    return this.backends.map((b) => b.name);
  }

  /** Look up a model by its canonical id across all registered backends. */
  findBackendForModel(modelId: string): InferenceBackend | undefined {
    const prefix = modelId.split(':')[0];
    return this.backends.find((b) => b.name === prefix);
  }

  /**
   * Build a unified snapshot by asking each adapter for its available + running
   * models through the port. Failures in a single adapter degrade gracefully
   * (that backend reports running:false with an empty model list) rather than
   * failing the whole snapshot — matches the current model-registry behavior,
   * where an offline Ollama or LMS yields an empty list, not a crash.
   */
  async getSnapshot(): Promise<RegistrySnapshot> {
    const perBackend = await Promise.all(
      this.backends.map((b) => this.collectBackend(b)),
    );

    const models: UnifiedModel[] = [];
    const backends: BackendStatus[] = [];
    const totalStorageByBackend: Record<string, number> = {};

    for (const entry of perBackend) {
      models.push(...entry.models);
      backends.push(entry.status);
      totalStorageByBackend[entry.status.backend] = entry.status.modelCount > 0
        ? entry.models.reduce((sum, m) => sum + m.sizeMb, 0)
        : 0;
    }

    const duplicates = detectDuplicates(models);
    // Annotate duplicates on the unified models (mirrors current behavior).
    for (const dup of duplicates) {
      const m1 = models.find((m) => m.id === dup.model1);
      const m2 = models.find((m) => m.id === dup.model2);
      if (m1) m1.duplicate = dup.model2;
      if (m2) m2.duplicate = dup.model1;
    }

    return {
      timestamp: Date.now(),
      backends,
      models,
      duplicates,
      totalStorageMb: Object.values(totalStorageByBackend).reduce((a, b) => a + b, 0),
      totalStorageByBackend,
    };
  }

  private async collectBackend(backend: InferenceBackend): Promise<{
    status: BackendStatus;
    models: UnifiedModel[];
  }> {
    let running = false;
    let available: ModelInfo[] = [];
    let loaded: RunningModelStatus[] = [];

    try {
      running = await backend.healthCheck();
    } catch {
      running = false;
    }

    if (running) {
      [available, loaded] = await Promise.all([
        backend.listAvailableModels().catch(() => [] as ModelInfo[]),
        backend.listRunningModels().catch(() => [] as RunningModelStatus[]),
      ]);
    }

    const loadedIds = new Set(loaded.map((m) => m.modelId));

    const models: UnifiedModel[] = available.map((m) => {
      const runInfo = loaded.find((r) => r.modelId === m.id);
      return {
        id: m.id,
        name: m.displayName,
        backend: m.backend,
        backendModelId: m.backendModelId,
        type: m.type,
        sizeMb: m.sizeMb,
        parameterSize: m.parameterSize ?? 'unknown',
        architecture: m.architecture ?? 'unknown',
        quantization: m.quantization ?? 'unknown',
        maxContextLength: m.contextWindow,
        vision: m.vision ?? false,
        toolUse: m.toolUse ?? false,
        loaded: loadedIds.has(m.id),
        vramUsageMb: runInfo ? Math.round(runInfo.vramBytes / (1024 * 1024)) : null,
        duplicate: null,
      };
    });

    return {
      status: {
        backend: backend.name,
        running,
        // The adapter knows its own base URL; expose it via a capability-free
        // accessor on the registry only when needed. For the snapshot we report
        // the backend name; routes.ts can resolve the URL from the adapter.
        // (See implementation-increment-1.md for the getBaseUrl question.)
        url: getBackendUrl(backend),
        modelCount: models.length,
        loadedCount: loaded.length,
      },
      models,
    };
  }
}

// -- URL accessor (kept out of the InferenceBackend port on purpose) -----
//
// `getBaseUrl` is an adapter-concern leak if it lives on the port: not every
// backend has a single URL (the LMS adapter talks to BOTH a REST URL and a
// CLI binary). Rather than bloat the port with a method most backends don't
// need cleanly, the registry resolves a display URL via an optional,
// well-known side channel. This is an explicit, documented seam — not an
// accidental leak — and is revisited in increment 2 when real adapters exist.
export interface HasBaseUrl {
  getBaseUrl?(): string;
}

function getBackendUrl(backend: InferenceBackend): string {
  const withUrl = backend as InferenceBackend & HasBaseUrl;
  return withUrl.getBaseUrl?.() ?? '';
}

// -- Duplicate detection (moved here from model-registry.ts, unchanged logic) --

function detectDuplicates(models: UnifiedModel[]): DuplicatePair[] {
  const duplicates: DuplicatePair[] = [];
  const seen = new Map<string, UnifiedModel>();

  for (const model of models) {
    const baseName = normalizeModelName(model.backendModelId);

    for (const [existingKey, existing] of seen) {
      if (existing.backend === model.backend) continue; // only cross-backend dupes

      const existingBase = normalizeModelName(existing.backendModelId);

      if (baseName === existingBase) {
        duplicates.push({
          model1: existing.id,
          model2: model.id,
          reason: `Same model "${baseName}" in both backends`,
        });
        continue;
      }

      if (
        model.type === existing.type &&
        model.architecture === existing.architecture &&
        model.parameterSize === existing.parameterSize &&
        model.architecture !== 'unknown'
      ) {
        duplicates.push({
          model1: existing.id,
          model2: model.id,
          reason: `Same architecture "${model.architecture}" and size "${model.parameterSize}"`,
        });
      }
    }

    seen.set(model.id, model);
  }

  return duplicates;
}

function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(library\/|registry\.ollama\.ai\/library\/)/, '')
    .replace(/:(latest|[\w.]+)$/, '') // strip tags
    .replace(/@[\w._]+$/, '') // strip variant suffixes
    .replace(/[-_]v?\d+(\.\d+)*$/, '') // strip version numbers
    .trim();
}
