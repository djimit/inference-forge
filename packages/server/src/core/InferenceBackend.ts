/**
 * InferenceBackend — the port (hexagonal architecture).
 *
 * Each inference engine (Ollama, LM Studio, llama.cpp-server, vLLM) is an
 * ADAPTER implementing this interface. The application core (monitor, benchmark,
 * modelfile, perplexity, BackendRegistry, route-advisor) depends ONLY on this
 * interface, never on a concrete adapter. See openspec proposal 01.
 *
 * The types here are derived from — and normalized over — the existing
 * backend-specific shapes so the migration is a normalization, not a redesign:
 *   OllamaModel / RunningModel / ModelInfo  (services/ollama.ts)
 *   LmsModel / LmsLoadedModel               (services/lmstudio.ts)
 *   UnifiedModel / BackendStatus            (services/model-registry.ts)
 *
 * Canonical model id convention: "<backend>:<nativeModelId>" (e.g.
 * "ollama:llama3:8b", "lmstudio:qwen2-7b-instruct"). Adapter-prefixing makes
 * cross-backend model ids unambiguous and lets the registry dedupe without
 * collisions.
 */

import type { BackendErrorCode } from './errors.js';

// -- Model & status shapes (adapter-normalized) --------------------

export type ModelType = 'llm' | 'embedding';

/**
 * Canonical, backend-agnostic model descriptor. Each adapter translates its
 * native shape (OllamaModel / LmsModel) into this. This REPLACES the hand-merge
 * currently performed in services/model-registry.ts.
 *
 * `sizeMb` is rounded; adapters that only know raw bytes compute it here so the
 * registry stays backend-agnostic.
 */
export interface ModelInfo {
  /** Canonical, adapter-prefixed: "ollama:llama3:8b". */
  readonly id: string;
  /** Human-readable name for UI. */
  readonly displayName: string;
  /** Adapter name: 'ollama' | 'lmstudio' | ... (open set; no closed union). */
  readonly backend: string;
  /** Native model id for API calls to THIS backend (without the prefix). */
  readonly backendModelId: string;
  readonly type: ModelType;
  /** Size on disk in MiB, rounded. Computed from `sizeBytes` when only bytes known. */
  readonly sizeMb: number;
  /** e.g. "14.7B", "80B". Adapter-normalized string form. */
  readonly parameterSize?: string;
  /** Billions, when determinable. */
  readonly parameterCount?: number;
  /** Adapter-normalized vocab: "Q4_0", "AWQ", "fp16", "unknown". */
  readonly quantization?: string;
  /** "llama", "mistral", "qwen2", ... */
  readonly architecture?: string;
  /** Max context the model was trained for, if known from metadata. */
  readonly contextWindow: number;
  /** Whether the model can process images. */
  readonly vision?: boolean;
  /** Whether the model is trained for tool/function calling. */
  readonly toolUse?: boolean;
}

/** A currently-loaded model and its runtime memory state. */
export interface RunningModelStatus {
  readonly modelId: string;
  readonly backend: string;
  /** Bytes of VRAM the loaded instance occupies. */
  readonly vramBytes: number;
  /** ISO 8601 load time. */
  readonly loadedAt: string;
  /** ISO 8601 expiry, if the backend supports TTL eviction (Ollama does). */
  readonly expiresAt?: string;
  readonly contextUsed: number;
  readonly contextTotal: number;
}

// -- Generation -----------------------------------------------------

export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

export interface GenerationRequest {
  /** Canonical model id. */
  readonly modelId: string;
  readonly prompt: string;
  readonly stream: boolean;
  /** Gated by `capabilities.supportsKvCacheQuantization`. */
  readonly kvCacheType?: KvCacheType;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface GenerationMetrics {
  readonly tokensPerSecond: number;
  readonly totalTokens: number;
  readonly evalDurationMs: number;
  readonly promptEvalDurationMs: number;
  readonly vramDeltaBytes: number;
}

/**
 * Per-token log-probability result. THIS is the contract proposal 02 depends on.
 *
 * Design resolution (see proposal 01 design.md §Resolved): `getLogProbs` is a
 * SCORING contract, not a sampling contract. The caller supplies the text to
 * score (a corpus window); the backend returns `log P(token_i | token_<i)` for
 * each PROVIDED token. There is no sampling, so "actual-token vs top-k" is
 * resolved by construction — the actual token IS the token the caller supplied.
 *
 * Per-backend scoring mechanism (implementation in each adapter):
 *   Ollama        /api/generate with num_predict:0 + eval logprobs
 *   LM Studio     /v1/completions with echo:true, logprobs:0, max_tokens:0
 *   llama.cpp     /completion with n_probs
 */
export interface LogProbResult {
  readonly tokens: string[];
  /** log P(token_i | token_<i), base e. Aligned 1:1 with `tokens`. */
  readonly logProbs: number[];
}

// -- Capabilities ---------------------------------------------------

/**
 * Per-backend capability descriptor. Consumers MUST consult this BEFORE calling
 * optional methods (`getLogProbs`, `exportModelfile`, `loadModel`, `unloadModel`).
 * Capability-gated methods throw `CapabilityNotSupportedError` as defense-in-depth.
 */
export interface BackendCapabilities {
  readonly supportsKvCacheQuantization: boolean;
  /** Ollama-specific artifact concept; vLLM/llama.cpp have no equivalent. */
  readonly supportsModelfileExport: boolean;
  /** Required for perplexity (proposal 02). Gated, not assumed. */
  readonly supportsLogProbs: boolean;
  readonly supportsStreamingMetrics: boolean;
  /** Load/unload models without restarting the backend. */
  readonly supportsHotModelSwap: boolean;
  readonly supportsToolUse: boolean;
  /** null = unbounded / unknown. */
  readonly maxConcurrentModels: number | null;
}

// -- The port -------------------------------------------------------

export interface InferenceBackend {
  /** 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' (open set). */
  readonly name: string;
  readonly capabilities: BackendCapabilities;

  /** Health probe — resolves true/false, never throws. */
  healthCheck(): Promise<boolean>;

  /** All models known to this backend (downloaded on disk). */
  listAvailableModels(): Promise<ModelInfo[]>;
  /** Models currently loaded in memory. */
  listRunningModels(): Promise<RunningModelStatus[]>;
  /** Details for a single model id. Throws `ModelNotFoundError` if absent. */
  getModelDetails(modelId: string): Promise<ModelInfo>;

  /** Streaming generation. Yields token chunks. */
  generate(req: GenerationRequest): AsyncIterable<string>;
  /** Non-streaming generation with collected metrics. */
  generateWithMetrics(req: GenerationRequest): Promise<{ text: string; metrics: GenerationMetrics }>;

  // -- Capability-gated optional methods ---------------------------
  // Callers MUST check the corresponding `capabilities` flag first.

  /**
   * Score a PROVIDED sequence (no sampling). Returns log P(token_i | token_<i)
   * for each supplied token. Used by proposal 02's perplexity computation.
   * Throws `CapabilityNotSupportedError` if `supportsLogProbs` is false.
   */
  getLogProbs?(req: { text: string; contextLength: number }): Promise<LogProbResult>;

  /**
   * Serialize a ModelConfigurationProfile (proposal 05) into Ollama Modelfile TEXT.
   * Capability-gated by `supportsModelfileExport`. Non-Ollama adapters throw.
   */
  exportModelfile?(profile: unknown): Promise<string>;

  /** Load a model into memory. Gated by `supportsHotModelSwap`. */
  loadModel?(modelId: string): Promise<void>;
  /** Unload a model from memory. Gated by `supportsHotModelSwap`. */
  unloadModel?(modelId: string): Promise<void>;
}

// -- Registry output types (consumer-facing, backend-agnostic) -----
// These mirror the current services/model-registry.ts shapes so the
// increment-2 rewiring of consumers (routes.ts, dashboard) is mechanical.

export interface BackendStatus {
  readonly backend: string;
  readonly running: boolean;
  readonly url: string;
  readonly modelCount: number;
  readonly loadedCount: number;
}

export interface UnifiedModel {
  readonly id: string;
  readonly name: string;
  readonly backend: string;
  readonly backendModelId: string;
  readonly type: ModelType;
  readonly sizeMb: number;
  readonly parameterSize: string;
  readonly architecture: string;
  readonly quantization: string;
  readonly maxContextLength: number;
  readonly vision: boolean;
  readonly toolUse: boolean;
  readonly loaded: boolean;
  readonly vramUsageMb: number | null;
  /** Id of a duplicate model in another backend, or null. */
  duplicate: string | null;
}

export interface DuplicatePair {
  readonly model1: string;
  readonly model2: string;
  readonly reason: string;
}

export interface RegistrySnapshot {
  readonly timestamp: number;
  readonly backends: BackendStatus[];
  readonly models: UnifiedModel[];
  readonly duplicates: DuplicatePair[];
  readonly totalStorageMb: number;
  readonly totalStorageByBackend: Record<string, number>;
}

export type { BackendErrorCode };
