/**
 * Performance Profiler Service
 * Benchmarks all local models across backends and builds performance profiles.
 * Profiles inform the intelligent routing engine.
 */

import { ollama } from './ollama.js';
import { lmstudio } from './lmstudio.js';
import { modelRegistry, type UnifiedModel, type Backend } from './model-registry.js';
import { database } from './database.js';

// -- Types ----------------------------------------------------------

export interface ModelProfile {
  id: string;
  backend: Backend;
  modelId: string;
  displayName: string;
  parameterSize: string;
  quantization: string;
  architecture: string;
  tokSGpu: number | null;      // tok/s with GPU offload
  tokSCpu: number | null;      // tok/s CPU-only
  promptTokS: number | null;   // prompt eval tok/s
  firstTokenMs: number | null; // time to first token
  vramUsageMb: number | null;
  ramUsageMb: number | null;
  optimalGpuLayers: number | null;
  optimalThreads: number | null;
  qualityProxy: number | null; // 0-1 score based on response coherence
  maxContextTested: number | null;
  benchmarkedAt: number;
}

export interface ProfileProgress {
  model: string;
  backend: string;
  step: string;
  progress: number; // 0-1
}

type ProgressCallback = (progress: ProfileProgress) => void;

// -- Test Prompt ----------------------------------------------------

const PROFILE_PROMPT = 'Explain the concept of recursion in programming with a simple example in Python. Be concise.';

// -- Service --------------------------------------------------------

export class PerfProfiler {
  private running = false;
  private progressCallbacks: Set<ProgressCallback> = new Set();

  isRunning(): boolean {
    return this.running;
  }

  subscribeProgress(cb: ProgressCallback): () => void {
    this.progressCallbacks.add(cb);
    return () => this.progressCallbacks.delete(cb);
  }

  private emitProgress(p: ProfileProgress): void {
    for (const cb of this.progressCallbacks) {
      try { cb(p); } catch {}
    }
  }

  /** Get all stored profiles */
  getProfiles(): ModelProfile[] {
    const rows = database.getAllModelProfiles();
    return rows.map(this.rowToProfile);
  }

  /** Get profile for a specific model */
  getProfile(backend: Backend, modelId: string): ModelProfile | null {
    const row = database.getModelProfile(backend, modelId);
    return row ? this.rowToProfile(row) : null;
  }

  /** Profile a single model */
  async profileModel(backend: Backend, modelId: string): Promise<ModelProfile | null> {
    if (backend === 'ollama') {
      return this.profileOllamaModel(modelId);
    } else if (backend === 'lmstudio') {
      return this.profileLmsModel(modelId);
    }
    return null;
  }

  /** Profile ALL models across all backends */
  async profileAll(): Promise<ModelProfile[]> {
    if (this.running) throw new Error('Profiling already in progress');
    this.running = true;

    const snapshot = modelRegistry.getSnapshot();
    if (!snapshot) {
      this.running = false;
      throw new Error('Model registry not initialized');
    }

    const results: ModelProfile[] = [];
    const llmModels = snapshot.models.filter((m) => m.type === 'llm');
    const total = llmModels.length;

    for (let i = 0; i < llmModels.length; i++) {
      const model = llmModels[i];
      this.emitProgress({
        model: model.name,
        backend: model.backend,
        step: `Profiling ${i + 1}/${total}: ${model.name}`,
        progress: i / total,
      });

      try {
        const profile = await this.profileModel(model.backend, model.backendModelId);
        if (profile) results.push(profile);
      } catch (err) {
        console.error(`[PerfProfiler] Failed to profile ${model.id}:`, err);
      }
    }

    this.emitProgress({
      model: '',
      backend: '',
      step: `Profiling complete: ${results.length}/${total} models`,
      progress: 1,
    });

    this.running = false;
    return results;
  }

  // -- Ollama Profiling ---------------------------------------------

  private async profileOllamaModel(modelId: string): Promise<ModelProfile | null> {
    try {
      // Run a generation and measure performance
      const start = Date.now();
      const result = await ollama.generate({
        model: modelId,
        prompt: PROFILE_PROMPT,
        options: { num_predict: 256 },
      });

      const totalMs = (result.total_duration || 0) / 1_000_000;
      const evalCount = result.eval_count || 0;
      const evalDuration = (result.eval_duration || 0) / 1_000_000;
      const promptEvalDuration = (result.prompt_eval_duration || 0) / 1_000_000;
      const promptEvalCount = result.prompt_eval_count || 0;
      const loadDuration = (result.load_duration || 0) / 1_000_000;

      const tokS = evalDuration > 0 ? (evalCount / evalDuration) * 1000 : 0;
      const promptTokS = promptEvalDuration > 0 ? (promptEvalCount / promptEvalDuration) * 1000 : 0;
      const firstTokenMs = loadDuration + promptEvalDuration;

      // Get model info for metadata
      let paramSize = '';
      let quant = '';
      let arch = '';
      let vramMb: number | null = null;

      try {
        const info = await ollama.showModel(modelId);
        paramSize = info.details?.parameter_size || '';
        quant = info.details?.quantization_level || '';
        arch = info.details?.family || '';
      } catch {}

      // Check VRAM usage if model is loaded
      try {
        const running = await ollama.listRunning();
        const loaded = running.find((m) => m.name === modelId);
        if (loaded) {
          vramMb = Math.round(loaded.size_vram / (1024 * 1024));
        }
      } catch {}

      const profile: ModelProfile = {
        id: `ollama:${modelId}`,
        backend: 'ollama',
        modelId,
        displayName: modelId,
        parameterSize: paramSize,
        quantization: quant,
        architecture: arch,
        tokSGpu: vramMb && vramMb > 100 ? Math.round(tokS * 100) / 100 : null,
        tokSCpu: !vramMb || vramMb < 100 ? Math.round(tokS * 100) / 100 : null,
        promptTokS: Math.round(promptTokS * 100) / 100,
        firstTokenMs: Math.round(firstTokenMs),
        vramUsageMb: vramMb,
        ramUsageMb: null,
        optimalGpuLayers: null,
        optimalThreads: null,
        qualityProxy: this.estimateQuality(result.response || ''),
        maxContextTested: null,
        benchmarkedAt: Date.now(),
      };

      // Persist (convert null → undefined for DB method)
      database.saveModelProfile(this.profileToDbRow(profile));

      return profile;
    } catch (err) {
      console.error(`[PerfProfiler] Ollama profile error for ${modelId}:`, err);
      return null;
    }
  }

  // -- LM Studio Profiling ------------------------------------------

  private async profileLmsModel(modelId: string): Promise<ModelProfile | null> {
    if (!await lmstudio.isServerRunning()) {
      console.warn(`[PerfProfiler] LM Studio not running, skipping ${modelId}`);
      return null;
    }

    try {
      const start = Date.now();
      const result = await lmstudio.chat(modelId, [
        { role: 'user', content: PROFILE_PROMPT },
      ], { max_tokens: 256 });

      const totalMs = Date.now() - start;
      const completionTokens = result.usage?.completion_tokens || 0;
      const promptTokens = result.usage?.prompt_tokens || 0;
      const tokS = completionTokens > 0 && totalMs > 0
        ? (completionTokens / totalMs) * 1000
        : 0;

      // Get model metadata from registry
      const registry = modelRegistry.getSnapshot();
      const regModel = registry?.models.find((m) => m.backend === 'lmstudio' && m.backendModelId === modelId);

      const profile: ModelProfile = {
        id: `lmstudio:${modelId}`,
        backend: 'lmstudio',
        modelId,
        displayName: regModel?.name || modelId,
        parameterSize: regModel?.parameterSize || '',
        quantization: regModel?.quantization || '',
        architecture: regModel?.architecture || '',
        tokSGpu: null,
        tokSCpu: Math.round(tokS * 100) / 100,
        promptTokS: null, // OpenAI API doesn't separate prompt eval
        firstTokenMs: null,
        vramUsageMb: null,
        ramUsageMb: null,
        optimalGpuLayers: null,
        optimalThreads: null,
        qualityProxy: this.estimateQuality(result.choices[0]?.message?.content || ''),
        maxContextTested: null,
        benchmarkedAt: Date.now(),
      };

      database.saveModelProfile(this.profileToDbRow(profile));

      return profile;
    } catch (err) {
      console.error(`[PerfProfiler] LMS profile error for ${modelId}:`, err);
      return null;
    }
  }

  // -- Quality Estimation -------------------------------------------

  /**
   * Simple quality proxy: measures response coherence.
   * Checks for code blocks, reasonable length, sentence structure.
   * Returns 0-1 score.
   */
  private estimateQuality(response: string): number {
    if (!response || response.length < 20) return 0;

    let score = 0;
    const len = response.length;

    // Length score (prefer 200-1000 chars for this prompt)
    if (len >= 100 && len <= 2000) score += 0.25;
    else if (len >= 50) score += 0.1;

    // Contains code (expected for recursion question)
    if (/```[\s\S]*```/.test(response) || /def\s+\w+/.test(response)) score += 0.25;

    // Contains "recursion" or "recursive" (topic relevance)
    if (/recursi(on|ve)/i.test(response)) score += 0.2;

    // Has sentence structure (periods, proper capitalization)
    const sentences = response.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length >= 2) score += 0.15;

    // Doesn't contain garbage (repeated tokens, null bytes)
    if (!/(.)\1{10,}/.test(response)) score += 0.15;

    return Math.min(1, Math.round(score * 100) / 100);
  }

  // -- Helpers ------------------------------------------------------

  private profileToDbRow(p: ModelProfile) {
    const n = (v: number | null) => v ?? undefined;
    return {
      id: p.id, backend: p.backend, modelId: p.modelId, displayName: p.displayName,
      parameterSize: p.parameterSize || undefined, quantization: p.quantization || undefined,
      architecture: p.architecture || undefined,
      tokSGpu: n(p.tokSGpu), tokSCpu: n(p.tokSCpu), promptTokS: n(p.promptTokS),
      firstTokenMs: n(p.firstTokenMs), vramUsageMb: n(p.vramUsageMb), ramUsageMb: n(p.ramUsageMb),
      optimalGpuLayers: n(p.optimalGpuLayers), optimalThreads: n(p.optimalThreads),
      qualityProxy: n(p.qualityProxy), maxContextTested: n(p.maxContextTested),
      benchmarkedAt: p.benchmarkedAt,
    };
  }

  private rowToProfile(row: any): ModelProfile {
    return {
      id: row.id,
      backend: row.backend as Backend,
      modelId: row.model_id,
      displayName: row.display_name,
      parameterSize: row.parameter_size || '',
      quantization: row.quantization || '',
      architecture: row.architecture || '',
      tokSGpu: row.tok_s_gpu,
      tokSCpu: row.tok_s_cpu,
      promptTokS: row.prompt_tok_s,
      firstTokenMs: row.first_token_ms,
      vramUsageMb: row.vram_usage_mb,
      ramUsageMb: row.ram_usage_mb,
      optimalGpuLayers: row.optimal_gpu_layers,
      optimalThreads: row.optimal_threads,
      qualityProxy: row.quality_proxy,
      maxContextTested: row.max_context_tested,
      benchmarkedAt: row.benchmarked_at,
    };
  }
}

export const perfProfiler = new PerfProfiler();
