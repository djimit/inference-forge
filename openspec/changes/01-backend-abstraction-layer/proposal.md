# Change Proposal: Inference Backend Abstraction Layer

**Change ID:** `01-backend-abstraction-layer`
**Status:** Draft — pending review
**Owner:** Dennis (DjimIT B.V.)
**Severity:** Architectural blocker — must land before Phase 3 (Benchmarker) deepens or Phase 4 (Modelfile Studio) accrues further scope. The repo already contains a second backend (`lmstudio.ts`) glued in ad-hoc, so this is partly a *consolidation* task, not a green-field abstraction.
**Estimated effort:** 3–4 engineering days (interface + Ollama + LM Studio extraction + registry/router rewiring); +3–4 days per future backend adapter.

---

## Why

### The coupling is already present and already accreting

The original framing was "hard-coupled to Ollama." The live repository tells a sharper story: the project has *already tried* to support a second backend, but did so by direct cross-imports rather than through a port boundary. Concretely:

- `services/ollama.ts` (266 LoC) and `services/lmstudio.ts` (322 LoC) are two parallel clients with **incompatible types** (`OllamaModel` vs `LmsModel`, `RunningModel` vs `LmsLoadedModel`).
- `services/model-registry.ts` imports **both** clients directly at module top-level and produces a unified view by hand-merging their divergent shapes into a `UnifiedModel` with a `Backend = 'ollama' | 'lmstudio'` string-union discriminator.
- `services/route-advisor.ts` imports the same `Backend` union and branches on it to recommend models across backends.
- `api/routes.ts` (1,063 LoC) imports both `ollama` and `lmstudio` singletons and calls them by name at the route level (`router.post('/sessions/:id/message', ...)` touches `lmstudio` directly for OpenAI-compatible chat).

This is the textbook symptom of missing abstraction: the *third* backend (`vLLM`, `llama.cpp-server`, both named in the public roadmap under "Future") would require touching `model-registry.ts`, `route-advisor.ts`, `api/routes.ts`, and the dashboard's `useOllama.ts`-equivalent hooks — not adding an adapter file. The cost scales as **O(backends × services)**, when it should scale as **O(backends × 1 adapter)**.

### The DjimIT sovereignty thesis turns this from preference to positioning

A tool that claims to manage "local LLM inference" while being structurally unable to incorporate vLLM (throughput) or llama.cpp-server (minimal footprint) without a multi-file rewrite is not a sovereignty tool — it is an Ollama+LM-Studio companion app. For a project explicitly positioned for public-sector-adjacent, sovereignty-conscious audiences, that positioning gap is a credibility risk the moment it is shown to a technical reviewer who knows the inference-engine landscape. The existing `lmstudio.ts` proves the *intent* to be multi-backend; this proposal is what makes that intent architecturally real instead of architecturally fragile.

## What Changes

- Introduce an `InferenceBackend` TypeScript interface in `packages/server/src/core/` defining the capability contract every backend adapter must implement (see design.md for the full signature, derived from the *existing* `OllamaModel` / `RunningModel` / `UnifiedModel` shapes so the migration is a normalization, not a redesign).
- Refactor `services/ollama.ts` into `adapters/ollama/OllamaBackend.ts` implementing `InferenceBackend`. No behavioral change to existing Ollama functionality — pure extraction, verified by characterization tests written *before* the refactor.
- Refactor `services/lmstudio.ts` into `adapters/lmstudio/LmStudioBackend.ts` implementing `InferenceBackend`. This is the consolidation: the second backend already exists, this makes it conform to the same contract instead of being a parallel client with divergent types.
- Collapse `services/model-registry.ts`'s hand-merge logic into a `BackendRegistry` that iterates registered adapters and produces `UnifiedModel[]` from their (now-shared) return types. The `Backend = 'ollama' | 'lmstudio'` string union becomes an open extensibility point (new adapters register themselves), not a closed type that must be edited on every addition.
- Rewire `route-advisor.ts` to consume `BackendCapabilities` and adapter instances rather than branching on the union type.
- Update all service consumers (`monitor.ts`, `benchmark.ts`, `modelfile.ts`, `perplexity.ts`, the route handlers) to depend on `InferenceBackend` / `BackendRegistry`, never on a concrete adapter directly (dependency inversion — this is the part that actually buys the architectural benefit; swapping the import alone is cosmetic).
- Define a `BackendCapabilities` descriptor (`supportsKvCacheQuantization`, `supportsModelfileExport`, `supportsLogProbs`, `supportsStreamingMetrics`, `supportsHotModelSwap`, `maxConcurrentModels`) so the UI and the router degrade gracefully per-backend instead of assuming Ollama-only features exist universally.
- Add a `BackendFactory` resolving the active backend set from configuration (`INFERENCE_BACKENDS=ollama,lmstudio` — note plural, since the registry already supports multiple simultaneously), defaulting to `ollama` to preserve current behavior.
- Out of scope: actually implementing the vLLM or llama.cpp-server adapters. This proposal delivers the seam plus a stub `LlamaCppBackend` as validation. A third real adapter is a follow-up change, justified once there is an actual reason to run something other than Ollama/LM Studio.

## Impact

- **Affected specs:** `inference-backend-contract` (new capability)
- **Affected code:**
  - `packages/server/src/services/ollama.ts` → `adapters/ollama/OllamaBackend.ts` (move + implement interface)
  - `packages/server/src/services/lmstudio.ts` → `adapters/lmstudio/LmStudioBackend.ts` (move + implement interface)
  - `packages/server/src/services/model-registry.ts` (rewrite merge logic against `BackendRegistry`)
  - `packages/server/src/services/route-advisor.ts` (remove `Backend` union branching)
  - `packages/server/src/services/{monitor,benchmark,modelfile,perplexity}.ts` (constructor injection of `InferenceBackend`)
  - `packages/server/src/api/routes.ts` (1,063 LoC — rewire direct `ollama`/`lmstudio` imports to injected backends)
  - `packages/server/src/ws/handler.ts` (backend-agnostic event payloads)
  - `packages/server/src/index.ts` (DI wiring via `BackendFactory`)
  - `.env.example` (new `INFERENCE_BACKENDS` var)
- **Breaking changes:** None for end users. Internal API surface changes (service constructors take an `InferenceBackend` instead of importing singletons). No external SDK consumers (0 stars, unpublished package).
- **Downstream dependents:** `02-perplexity-benchmark-rigor` requires the `supportsLogProbs` capability and the logprob-access method defined here. `04-modelfile-studio-deferred` gates on this being merged before Modelfile Studio implementation, since that feature's data model must be designed against `BackendCapabilities.supportsModelfileExport`.

## Rejected Alternatives

1. **"Leave the existing `model-registry.ts` merge pattern in place and just add the third backend to the `Backend` union."** Rejected: this is exactly the O(backends × services) scaling the proposal exists to prevent. The union grows, every `switch (backend)` in registry + router + UI grows with it, and capability-gating becomes impossible to express cleanly. The presence of this pattern today is the *evidence* for the proposal, not a counterexample to it.
2. **"Wait until a third backend is actually requested."** Rejected: a second backend has *already* been requested and built (`lmstudio.ts`). The "wait for demand" argument is refuted by the repo's own history — demand arrived, and the response was ad-hoc glue. The cost asymmetry (cheap now, expensive later) is demonstrated, not hypothetical.
3. **"Use an existing inference-gateway library (LiteLLM-style routing) instead of a custom interface."** Rejected for this stage: those libraries target *request-level* chat-completion routing across OpenAI-compatible providers, not *infrastructure-level* management concerns (VRAM telemetry, KV-cache configuration, Modelfile-equivalent generation, logprob extraction for perplexity). Re-evaluate in a later change; an OpenAI-compatible gateway may be worth wrapping *inside* one adapter for chat/generate calls specifically, but it cannot be the outermost seam.
4. **"General plugin system so third parties can register backends."** Rejected: solves a problem (third-party extensibility) the project does not have, at the cost of solving the problem it does have (internal multi-backend coherence) less directly. The `InferenceBackend` interface is intentionally narrow and internal.
