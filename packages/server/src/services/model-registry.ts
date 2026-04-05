/**
 * Unified Model Registry
 * Merges models from all backends (Ollama, LM Studio) into a single view.
 * Detects duplicates, tracks backend ownership, and provides unified search.
 */

import { ollama, type OllamaModel, type RunningModel } from './ollama.js';
import { lmstudio, type LmsModel, type LmsLoadedModel } from './lmstudio.js';

// -- Types ----------------------------------------------------------

export type Backend = 'ollama' | 'lmstudio';

export interface UnifiedModel {
  id: string;                       // unique key: backend:name
  name: string;                     // display name
  backend: Backend;
  backendModelId: string;           // original model identifier for API calls
  type: 'llm' | 'embedding';
  sizeMb: number;
  parameterSize: string;            // e.g. "14.7B", "80B"
  architecture: string;
  quantization: string;
  maxContextLength: number;
  vision: boolean;
  toolUse: boolean;
  loaded: boolean;                  // currently in memory
  vramUsageMb: number | null;       // if loaded, how much VRAM
  duplicate: string | null;         // ID of duplicate in other backend, or null
}

export interface BackendStatus {
  backend: Backend;
  running: boolean;
  url: string;
  modelCount: number;
  loadedCount: number;
}

export interface RegistrySnapshot {
  timestamp: number;
  backends: BackendStatus[];
  models: UnifiedModel[];
  duplicates: Array<{ model1: string; model2: string; reason: string }>;
  totalStorageMb: number;
  totalStorageByBackend: Record<Backend, number>;
}

// -- Service --------------------------------------------------------

export class ModelRegistry {
  private lastSnapshot: RegistrySnapshot | null = null;
  private refreshIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(refreshIntervalMs = 10000) {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  start(): void {
    if (this.intervalId) return;
    this.refresh();
    this.intervalId = setInterval(() => this.refresh(), this.refreshIntervalMs);
    console.log(`[Registry] Refreshing every ${this.refreshIntervalMs}ms`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getSnapshot(): RegistrySnapshot | null {
    return this.lastSnapshot;
  }

  async refresh(): Promise<RegistrySnapshot> {
    const [ollamaStatus, lmsStatus] = await Promise.all([
      this.getOllamaModels(),
      this.getLmsModels(),
    ]);

    const allModels = [...ollamaStatus.models, ...lmsStatus.models];

    // Detect duplicates based on architecture + param size similarity
    const duplicates = this.detectDuplicates(allModels);

    // Mark duplicate IDs on models
    for (const dup of duplicates) {
      const m1 = allModels.find((m) => m.id === dup.model1);
      const m2 = allModels.find((m) => m.id === dup.model2);
      if (m1) m1.duplicate = dup.model2;
      if (m2) m2.duplicate = dup.model1;
    }

    const totalStorageByBackend: Record<Backend, number> = {
      ollama: ollamaStatus.models.reduce((s, m) => s + m.sizeMb, 0),
      lmstudio: lmsStatus.models.reduce((s, m) => s + m.sizeMb, 0),
    };

    const snapshot: RegistrySnapshot = {
      timestamp: Date.now(),
      backends: [ollamaStatus.status, lmsStatus.status],
      models: allModels,
      duplicates,
      totalStorageMb: totalStorageByBackend.ollama + totalStorageByBackend.lmstudio,
      totalStorageByBackend,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  // -- Backend-specific fetchers ------------------------------------

  private async getOllamaModels(): Promise<{
    status: BackendStatus;
    models: UnifiedModel[];
  }> {
    const running = await ollama.ping();
    let available: OllamaModel[] = [];
    let loaded: RunningModel[] = [];

    if (running) {
      [available, loaded] = await Promise.all([
        ollama.listModels().catch(() => [] as OllamaModel[]),
        ollama.listRunning().catch(() => [] as RunningModel[]),
      ]);
    }

    const loadedNames = new Set(loaded.map((m) => m.name));

    const models: UnifiedModel[] = available.map((m) => {
      const runInfo = loaded.find((r) => r.name === m.name);
      return {
        id: `ollama:${m.name}`,
        name: m.name,
        backend: 'ollama' as Backend,
        backendModelId: m.name,
        type: m.details.family === 'nomic-bert' ? 'embedding' as const : 'llm' as const,
        sizeMb: Math.round(m.size / (1024 * 1024)),
        parameterSize: m.details.parameter_size,
        architecture: m.details.family,
        quantization: m.details.quantization_level,
        maxContextLength: 0, // resolved by monitor
        vision: false,
        toolUse: false,
        loaded: loadedNames.has(m.name),
        vramUsageMb: runInfo ? Math.round(runInfo.size_vram / (1024 * 1024)) : null,
        duplicate: null,
      };
    });

    return {
      status: {
        backend: 'ollama',
        running,
        url: ollama.getBaseUrl(),
        modelCount: models.length,
        loadedCount: loaded.length,
      },
      models,
    };
  }

  private async getLmsModels(): Promise<{
    status: BackendStatus;
    models: UnifiedModel[];
  }> {
    const running = await lmstudio.isServerRunning();
    let detailed: LmsModel[] = [];
    let loaded: LmsLoadedModel[] = [];

    // CLI works even when server is off
    detailed = await lmstudio.listModelsDetailed().catch(() => []);

    if (running) {
      loaded = await lmstudio.listLoaded().catch(() => []);
    }

    const loadedIds = new Set(loaded.map((m) => m.identifier || m.path));

    const models: UnifiedModel[] = detailed.map((m) => ({
      id: `lmstudio:${m.modelKey}`,
      name: m.displayName || m.modelKey,
      backend: 'lmstudio' as Backend,
      backendModelId: m.modelKey,
      type: m.type === 'embedding' ? 'embedding' as const : 'llm' as const,
      sizeMb: Math.round(m.sizeBytes / (1024 * 1024)),
      parameterSize: m.paramsString,
      architecture: m.architecture,
      quantization: m.quantization?.name || 'unknown',
      maxContextLength: m.maxContextLength || 0,
      vision: m.vision,
      toolUse: m.trainedForToolUse,
      loaded: loadedIds.has(m.modelKey) || loadedIds.has(m.path),
      vramUsageMb: null, // LMS doesn't expose per-model VRAM easily
      duplicate: null,
    }));

    return {
      status: {
        backend: 'lmstudio',
        running,
        url: lmstudio.getBaseUrl(),
        modelCount: models.length,
        loadedCount: loaded.length,
      },
      models,
    };
  }

  // -- Duplicate Detection ------------------------------------------

  private detectDuplicates(
    models: UnifiedModel[]
  ): Array<{ model1: string; model2: string; reason: string }> {
    const duplicates: Array<{ model1: string; model2: string; reason: string }> = [];
    const seen = new Map<string, UnifiedModel>();

    for (const model of models) {
      // Normalize: strip backend prefix, version tags, quantization suffixes
      const baseName = this.normalizeModelName(model.backendModelId);

      for (const [existingKey, existing] of seen) {
        if (existing.backend === model.backend) continue; // only cross-backend dupes

        const existingBase = this.normalizeModelName(existing.backendModelId);

        // Exact base name match
        if (baseName === existingBase) {
          duplicates.push({
            model1: existing.id,
            model2: model.id,
            reason: `Same model "${baseName}" in both backends`,
          });
          continue;
        }

        // Architecture + size match (e.g. nomic-embed-text in both)
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

  private normalizeModelName(name: string): string {
    return name
      .toLowerCase()
      .replace(/^(library\/|registry\.ollama\.ai\/library\/)/, '')
      .replace(/:(latest|[\w.]+)$/, '')       // strip tags
      .replace(/@[\w._]+$/, '')                // strip variant suffixes
      .replace(/[-_]v?\d+(\.\d+)*$/, '')       // strip version numbers
      .trim();
  }
}

export const modelRegistry = new ModelRegistry();
