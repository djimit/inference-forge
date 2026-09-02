# Tasks: Inference Backend Abstraction Layer

File-level checklist. Every task names the actual source file it touches so progress is auditable against the live tree.

## 1. Safety net (do before any refactor)
- [ ] 1.1 Stand up local Ollama instance with 2+ pulled models for integration testing
- [ ] 1.2 Stand up local LM Studio instance with 1+ loaded model (the second adapter must be characterized too — original draft omitted this)
- [ ] 1.3 Extend `packages/server/src/__tests__/routes.test.ts` (currently 25 route-guard tests) with characterization tests pinning current behavior for: `ollama.listModels`, `ollama.listRunningModels`, `ollama.show`, `ollama.generate` (streaming + metrics), `lmstudio.listModels`, `lmstudio.listLoaded`, `lmstudio.chat`
- [ ] 1.4 Record fixture responses via `nock`/`msw` record mode so tests run in CI without live backends
- [ ] 1.5 Confirm characterization tests pass against current `main` before refactor begins (baseline)

## 2. Interface definition
- [ ] 2.1 Create `packages/server/src/core/InferenceBackend.ts` (interface, `ModelInfo`, `RunningModelStatus`, `GenerationRequest`, `GenerationMetrics`, `LogProbResult`, `BackendCapabilities`)
- [ ] 2.2 Create `packages/server/src/core/errors.ts` (`BackendError` hierarchy with `code` field)
- [ ] 2.3 Add `eslint-plugin-boundaries` (or equivalent) config enforcing that nothing in `services/`, `api/`, `ws/` imports from `adapters/*`
- [ ] 2.4 Add lint rule / test asserting every call to an optional method is preceded by a capability check

## 3. Ollama adapter extraction
- [ ] 3.1 Create `packages/server/src/adapters/ollama/OllamaBackend.ts`
- [ ] 3.2 Move `services/ollama.ts` logic into the adapter, implementing `InferenceBackend`
- [ ] 3.3 Normalize `OllamaModel` → `ModelInfo`, `RunningModel` → `RunningModelStatus` in the adapter (keep `parseModelArch` reachable by `getModelDetails`)
- [ ] 3.4 Normalize all Ollama HTTP errors (404 plain-text, connection refused, timeouts) into `BackendError` subclasses
- [ ] 3.5 Define `OllamaBackend.capabilities` accurately: `supportsKvCacheQuantization=true`, `supportsModelfileExport=true`, `supportsLogProbs=true` (verify exact Ollama API mechanism — see Open Question), `supportsStreamingMetrics=true`, `supportsHotModelSwap=true`, `maxConcurrentModels=null`
- [ ] 3.6 Run characterization tests from step 1 against the new adapter — must pass unchanged

## 4. LM Studio adapter extraction (consolidation — second existing backend)
- [ ] 4.1 Create `packages/server/src/adapters/lmstudio/LmStudioBackend.ts`
- [ ] 4.2 Move `services/lmstudio.ts` logic into the adapter, implementing `InferenceBackend`
- [ ] 4.3 Normalize `LmsModel` → `ModelInfo`, `LmsLoadedModel` → `RunningModelStatus`
- [ ] 4.4 Preserve the `lms` CLI lifecycle management (start/stop server) — expose as adapter-internal concern, not a service-layer one
- [ ] 4.5 Define `LmStudioBackend.capabilities`: `supportsKvCacheQuantization=partial/false`, `supportsModelfileExport=false`, `supportsLogProbs=?` (RESOLVE Open Question in design.md before setting), `supportsStreamingMetrics=true`, `supportsHotModelSwap=true`, `supportsToolUse=true`
- [ ] 4.6 Run characterization tests against the new adapter — must pass unchanged

## 5. BackendRegistry + BackendFactory
- [ ] 5.1 Implement `BackendRegistry` iterating `InferenceBackend[]`, replacing the `getOllamaModels()` + `getLmsModels()` hand-merge in `services/model-registry.ts`
- [ ] 5.2 Delete the `Backend = 'ollama' | 'lmstudio'` union type; `backend` becomes `string` from `adapter.name`
- [ ] 5.3 Implement `BackendFactory.create(config): InferenceBackend[]` resolving from `INFERENCE_BACKENDS` env var (default `ollama`)
- [ ] 5.4 Add fail-fast startup health check — server refuses to start if any selected backend's `healthCheck()` fails
- [ ] 5.5 Update `.env.example` with `INFERENCE_BACKENDS` documentation

## 6. Service-layer dependency inversion
- [ ] 6.1 Refactor `services/monitor.ts` to accept `InferenceBackend` via constructor injection
- [ ] 6.2 Refactor `services/benchmark.ts` likewise (it currently imports `ollama` directly)
- [ ] 6.3 Refactor `services/modelfile.ts` likewise, with capability check before `exportModelfile`
- [ ] 6.4 Refactor `services/perplexity.ts` likewise — NOTE: this file is replaced wholesale by proposal 02, so only inject enough here to make the seam real; do not invest in the proxy logic
- [ ] 6.5 Refactor `services/route-advisor.ts` to consume `BackendCapabilities` and adapter instances, removing `Backend` union branching
- [ ] 6.6 Refactor WebSocket handlers in `ws/handler.ts` to consume backend-agnostic event payloads
- [ ] 6.7 Wire concrete adapters via `BackendFactory` in `packages/server/src/index.ts`

## 7. Routes rewiring (largest mechanical change)
- [ ] 7.1 In `api/routes.ts`, replace direct `ollama` and `lmstudio` imports (lines 6, 22) with injected backends resolved by canonical id prefix
- [ ] 7.2 Route handlers that call `ollama.pullModel` (SSE streaming, `/models/pull`) — keep streaming behavior, route through adapter
- [ ] 7.3 Route handlers that call `lmstudio.chat` (`/sessions/:id/message`, `/sessions/:id/message/stream`) — route through adapter
- [ ] 7.4 Add `BackendCapabilities` to `/api/health` and `/api/registry/backends` response payloads

## 8. Validation stub adapter
- [ ] 8.1 Create minimal `packages/server/src/adapters/llamacpp/LlamaCppBackend.ts` stub implementing `healthCheck()` + `listAvailableModels()` only
- [ ] 8.2 Confirm the stub requires zero changes to `InferenceBackend.ts` — if it does, revisit interface design
- [ ] 8.3 Document findings in design.md addendum (the "did the abstraction hold" evidence)

## 9. Frontend + documentation
- [ ] 9.1 Update dashboard `useOllama.ts` (rename to `useInferenceBackend.ts`) to read `BackendCapabilities` from `/api/health` and gate UI
- [ ] 9.2 Update `ARCHITECTURE.md` with new `core/` + `adapters/` structure, replacing the current "services/ → ollama.ts, monitor.ts, benchmark.ts, modelfile.ts" four-file sketch (which no longer reflects reality)
- [ ] 9.3 Update `CLAUDE.md` / `.github/copilot-instructions.md` architecture sketch likewise

## Resolved Questions
- **Perplexity capability location:** `supportsLogProbs` (backend capability) vs `supportsPerplexityEstimation` (IF-side). Resolved in favor of `supportsLogProbs` on the backend — perplexity *computation* is IF-side, but it is *gated* on the backend exposing logprobs. Proposal 02 confirms this.
- **LM Studio actual-token vs top-k:** Resolved by design — `getLogProbs()` is a *scoring* contract (caller supplies the text to score), not a *sampling* contract. See design.md §Resolved. The only remaining empirical check is whether the running LM Studio build fully implements `echo:true` + per-prompt-token `token_logprobs` on `/v1/completions`; if not, `LmStudioBackend.supportsLogProbs = false` until it does (perplexity temporarily Ollama-only — the safe fallback).
