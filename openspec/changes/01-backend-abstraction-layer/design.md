# Design: Inference Backend Abstraction Layer

## Context

Hexagonal architecture (ports & adapters, Cockburn 2005) is the correct pattern here, not a generic plugin system. The "port" is the `InferenceBackend` interface; each inference engine (Ollama, LM Studio, llama.cpp-server, vLLM) is an "adapter." The application core (`monitor`, `benchmark`, `modelfile`, `perplexity`, `model-registry`, `route-advisor`) depends only on the port. This is a deliberate, narrow application of the pattern — we are not introducing a general plugin framework, because that would solve a problem (third-party extensibility) we don't have yet, at the cost of solving the problem we do have (the existing ad-hoc `ollama.ts` + `lmstudio.ts` + `model-registry.ts` glue) less directly.

A key correction relative to the original draft: this is **not** "introduce abstraction where there is one backend." It is "consolidate the two backends already present behind a single port, replacing the `model-registry.ts` hand-merge and `route-advisor.ts` union branching." The validation is whether the existing registry and router code *shrinks* after the refactor — if it grows, the abstraction is wrong.

## The Interface Contract

The interface is derived from the **existing** type shapes so the migration is a normalization, not a redesign. Current source references:

- `services/ollama.ts`: `OllamaModel`, `RunningModel`, `ModelArchInfo`, `parseModelArch`
- `services/lmstudio.ts`: `LmsModel`, `LmsLoadedModel`, `LmsChatMessage`, `LmsChatResponse`
- `services/model-registry.ts`: `UnifiedModel`, `BackendStatus`, `RegistrySnapshot`, `Backend = 'ollama' | 'lmstudio'`

```typescript
// packages/server/src/core/InferenceBackend.ts

/**
 * Canonical model descriptor. Adapter-normalized: each adapter translates its
 * native shape (OllamaModel / LmsModel) into this. This REPLACES the hand-merge
 * currently performed in services/model-registry.ts.
 */
export interface ModelInfo {
  id: string;                    // canonical, adapter-prefixed: "ollama:llama3:8b"
  displayName: string;
  backend: string;               // adapter name: 'ollama' | 'lmstudio' | ...
  parameterCount?: number;       // billions, if known
  quantization?: string;         // adapter-normalized vocab: "Q4_0", "AWQ", "fp16"
  contextWindow: number;
  architecture?: string;         // "llama", "mistral", "qwen2"
  vision?: boolean;
  toolUse?: boolean;
  sizeBytes?: number;
}

export interface RunningModelStatus {
  modelId: string;
  backend: string;
  vramBytes: number;
  loadedAt: string;              // ISO 8601
  expiresAt?: string;            // if backend supports TTL eviction (Ollama does)
  contextUsed: number;
  contextTotal: number;
}

export interface GenerationRequest {
  modelId: string;              // canonical id
  prompt: string;
  stream: boolean;
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';   // gated by supportsKvCacheQuantization
  maxTokens?: number;
  temperature?: number;
}

export interface GenerationMetrics {
  tokensPerSecond: number;
  totalTokens: number;
  evalDurationMs: number;
  promptEvalDurationMs: number;
  vramDeltaBytes: number;
}

/**
 * Per-token log-probability result. THIS is the contract proposal 02 depends on.
 * Resolves the open question logged in the original draft: supportsPerplexity
 * is a backend capability (does the adapter expose logprobs), not an IF-side flag.
 */
export interface LogProbResult {
  tokens: string[];
  logProbs: number[];           // log P(t_i | t_<i) for each token, base e
  // some backends only return top-k; adapter normalizes to actual-token logprob.
}

export interface BackendCapabilities {
  supportsKvCacheQuantization: boolean;   // Ollama yes, LM Studio partial
  supportsModelfileExport: boolean;        // Ollama-specific concept; vLLM has none
  supportsLogProbs: boolean;                // required for perplexity (proposal 02)
  supportsStreamingMetrics: boolean;       // per-token metrics during generation
  supportsHotModelSwap: boolean;           // load/unload without restart
  supportsToolUse: boolean;
  maxConcurrentModels: number | null;       // null = unbounded / unknown
}

export interface InferenceBackend {
  readonly name: string;                    // 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm'
  readonly capabilities: BackendCapabilities;

  healthCheck(): Promise<boolean>;
  listAvailableModels(): Promise<ModelInfo[]>;
  listRunningModels(): Promise<RunningModelStatus[]>;
  getModelDetails(modelId: string): Promise<ModelInfo>;

  generate(req: GenerationRequest): AsyncIterable<string>;  // streaming generator
  generateWithMetrics(req: GenerationRequest): Promise<{ text: string; metrics: GenerationMetrics }>;

  // Capability-gated — callers MUST check `capabilities.supportsLogProbs` first.
  // Throws CapabilityNotSupportedError if called on an adapter that lacks it.
  getLogProbs?(req: GenerationRequest): Promise<LogProbResult>;

  // Capability-gated — callers MUST check `capabilities.supportsModelfileExport` first.
  exportModelfile?(modelId: string, params: Record<string, unknown>): Promise<string>;

  // Lifecycle (capability-gated by supportsHotModelSwap)
  loadModel?(modelId: string): Promise<void>;
  unloadModel?(modelId: string): Promise<void>;
}
```

**Design decision — optional methods + capability flags instead of separate sub-interfaces per capability:** TypeScript structural typing makes capability-interface composition attractive in theory (e.g. `LogProbBackend extends InferenceBackend`), but the service layer needs *runtime* capability checks (the active backend set is chosen by env var, not by compile-time type). A `capabilities` descriptor plus optional methods is the correct match for runtime-polymorphic, config-driven backend selection. This deliberately trades compile-time safety for runtime flexibility, justified because backend selection is inherently a deployment concern, not a build-time one.

**Why `getLogProbs` lives on the backend, not on an IF-side module:** the raw per-token log-probability is a backend-specific API surface (Ollama returns it via a flag on `/api/generate`; vLLM via the OpenAI-compatible `logprobs` param; llama.cpp-server via `n_probs`). IF's perplexity computation (proposal 02) consumes the normalized `LogProbResult` and is backend-agnostic *only if* this method exists. This is the hard dependency that sequences 02 after 01.

## Error Taxonomy

All adapters normalize errors into a shared hierarchy so consumers don't leak backend-specific error shapes:

```typescript
// packages/server/src/core/errors.ts
export class BackendError extends Error {
  readonly code: string;        // machine-readable, e.g. 'BACKEND_UNAVAILABLE'
}
export class BackendUnavailableError extends BackendError {}     // connection refused
export class ModelNotFoundError extends BackendError {}
export class CapabilityNotSupportedError extends BackendError {} // optional method on adapter lacking it
export class BackendTimeoutError extends BackendError {}
export class GenerationFailedError extends BackendError {}      // generation started, then errored
```

This matters concretely today: Ollama returns HTTP 404 with a plain-text body for missing models; LM Studio's OpenAI-compatible server returns a structured JSON error with a different schema. `routes.ts` currently has ad-hoc `catch (err) { res.status(500).json({ error: ..., details: String(err) }) }` repeated across handlers — without normalization, every consumer must know which adapter it is talking to, which defeats the abstraction.

## Migration Sequencing (Strangler Fig, not Big Bang)

The repo is too large (8,075 LoC server) for a big-bang refactor. Strangler-fig, one consumer at a time:

1. **Characterization tests first.** Before touching `ollama.ts` or `lmstudio.ts`, write integration tests (real local instances, or `nock`/`msw` recorded fixtures) pinning current behavior for every method that will move. The repo already has `packages/server/src/__tests__/routes.test.ts` (25 route-guard tests per the latest commit) — extend it, do not replace it. The refactor is "done" only when these pass unchanged against the new adapters.
2. **Extract interface + error hierarchy.** Create `packages/server/src/core/InferenceBackend.ts` and `core/errors.ts` per above.
3. **Ollama adapter.** Move `services/ollama.ts` logic into `adapters/ollama/OllamaBackend.ts` implementing `InferenceBackend`. Normalize `OllamaModel` → `ModelInfo`, `RunningModel` → `RunningModelStatus`. Preserve `parseModelArch` (used downstream) by exposing it as a static helper or moving the arch-parsing concern into `getModelDetails`.
4. **LM Studio adapter.** Move `services/lmstudio.ts` into `adapters/lmstudio/LmStudioBackend.ts` implementing `InferenceBackend`. Normalize `LmsModel` → `ModelInfo`, `LmsLoadedModel` → `RunningModelStatus`. This is the consolidation payoff: the two backends now produce identical shapes.
5. **BackendRegistry replaces model-registry merge.** `model-registry.ts`'s `getOllamaModels()` + `getLmsModels()` + hand-merge becomes a registry that iterates `InferenceBackend[]` and concatenates their `listAvailableModels()` results. The `Backend = 'ollama' | 'lmstudio'` union is deleted; `backend` becomes a plain `string` populated from `adapter.name`.
6. **Invert service dependencies.** Change `monitor.ts`, `benchmark.ts`, `modelfile.ts`, `perplexity.ts` constructors to accept `InferenceBackend` (or `BackendRegistry`) via constructor injection rather than importing singletons. Wire concrete instances in `index.ts` via `BackendFactory`.
7. **Rewire routes.ts.** Replace direct `ollama`/`lmstudio` imports (lines 6, 22) with injected backends resolved by canonical id prefix (`ollama:...` vs `lmstudio:...`). This is the largest mechanical change in the proposal — 1,063 LoC touched selectively, not rewritten.
8. **Validation stub adapter.** Build a minimal `LlamaCppBackend` stub implementing `healthCheck()` and `listAvailableModels()` only, everything else throwing `CapabilityNotSupportedError`. If the stub requires changing `InferenceBackend.ts`, the abstraction was wrong — fix it now, before a real third adapter is built.

## Validation / Acceptance

- [ ] All pre-refactor characterization tests pass against `OllamaBackend` and `LmStudioBackend` post-refactor, behaviorally equivalent.
- [ ] No file outside `adapters/ollama/` or `adapters/lmstudio/` imports anything from those directories directly (enforced via `eslint-plugin-boundaries` or equivalent import-restriction rule, not just code review).
- [ ] `services/model-registry.ts` and `services/route-advisor.ts` **shrink** in LoC after refactor (the consolidation payoff). If they grow, revisit the interface.
- [ ] `LlamaCppBackend` stub implements the interface without requiring any change to `InferenceBackend.ts` — falsifiable test of "is this actually an abstraction."
- [ ] `BackendCapabilities` is consulted (not assumed) at every call site using an optional capability — verified via lint rule or test that fails if `getLogProbs`/`exportModelfile`/`loadModel` is called without a preceding capability check.
- [ ] `supportsLogProbs` is `true` for both Ollama and LM Studio adapters (verify LM Studio's OpenAI-compatible `logprobs` param actually surfaces actual-token logprobs, not just top-k — this is the contract proposal 02 depends on and is an implementation-detail risk flagged for the engineer).

## Cost-of-Delay Analysis (re-anchored to live scope)

| Scenario | Refactor cost if done now | Refactor cost if deferred to post-Phase-4 |
|---|---|---|
| Service layer coupling | ~6 service files touched (monitor, benchmark, modelfile, perplexity, registry, router) + routes.ts | Same 6 files + ~7+ React components (Dashboard, ModelList, BenchmarkRunner, ModelfileEditor, KvCachePanel, MetricsChart, VramGauge) now consuming Ollama/LM-Studio-shaped data directly |
| Multi-backend glue | `model-registry.ts` merge + `route-advisor.ts` branching rewritten once | A third backend added to the `Backend` union multiplies the branching; the ad-hoc pattern is already showing O(backends × services) cost |
| WebSocket payload shape | Defined once, backend-agnostic | Already-shipped WS clients (handler.ts broadcasts `metrics`, `hardware`, `alerts`, `throughput`, `benchmark-progress`, `pressure`) depend on current shapes; changing later is a breaking change for any dashboard consumer |
| Benchmark data model | Designed backend-agnostic from Phase 3 start | `perplexity.ts` already encodes Ollama-specific `ollama.generate()` calls; proposal 02 must replace it anyway, but doing so against a stable logprob contract avoids a second rewrite |

This table is the actual argument for sequencing 01 *before* 02 (Perplexity) and 04 (Modelfile Studio) — a dependency, not a preference.

## Resolved: `getLogProbs` is a scoring contract, not a sampling contract

The open question "does LM Studio return the actual-token logprob or only top-k?" is resolved **by design**, not by empirical luck. `getLogProbs()` is specified as a **scoring-flow**: the caller supplies the text to score (a corpus window), and the backend returns `log P(token_i | token_<i)` for each *provided* token. There is no sampling, so "actual token vs top-k" dissolves — the actual token IS the token the caller supplied.

Concretely, each adapter implements this via its server's prompt-eval / echo mechanism, not its generation mechanism:

- **Ollama** — `/api/generate` with `num_predict: 0` (do not generate) and eval-logprobs enabled; read per-prompt-token logprobs of the actual prompt tokens.
- **LM Studio** — `/v1/completions` (the completions endpoint, NOT `/v1/chat/completions`) with `echo: true`, `logprobs: 0`, `max_tokens: 0`. The OpenAI completions spec returns `logprobs.tokens` + `logprobs.token_logprobs` including the *echoed prompt tokens* — i.e. per-prompt-token logprob of the actual token. This is the canonical way to compute perplexity over an OpenAI-compatible server and sidesteps the top-k-vs-actual distinction by construction.
- **llama.cpp-server** — `/completion` with `n_probs`; same scoring semantics.

The interface method therefore reads:

```typescript
// Score a PROVIDED sequence (no sampling). Returns log P(token_i | token_<i) for each supplied token.
// Capability-gated by supportsLogProbs. Used by proposal 02's perplexity computation.
getLogProbs?(req: { text: string; contextLength: number }): Promise<LogProbResult>;
```

**Remaining empirical verification (flagged, not assumed):** whether the *running LM Studio build* fully implements `echo: true` + per-prompt-token `token_logprobs` on `/v1/completions` must be confirmed against an actual instance before setting `LmStudioBackend.supportsLogProbs = true`. LM Studio implements the OpenAI-compatible completions API, so this is the correct target — but if the current build does not surface echoed-prompt logprobs correctly, `supportsLogProbs = false` for LM Studio until it does, and perplexity is temporarily Ollama-only. That is the safe fallback; a false metric is never shipped (the explicit lesson from the existing `perplexity.ts`).
