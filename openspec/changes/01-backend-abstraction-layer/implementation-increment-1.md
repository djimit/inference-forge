# Implementation — Increment 1 (the port + registry, verified here)

This records what **increment 1** of proposal 01 delivered, what was verified in this environment, what could NOT be verified here (and why), and the concrete next-increment plan (adapter extraction + consumer rewiring) that must be validated locally against live Ollama + LM Studio.

Increment 1 deliberately delivers the **port and the registry that consumes it**, validated against an in-repo fake adapter — the parts verifiable without live inference backends. It does **not** touch the live app wiring (`index.ts`, `routes.ts`, `services/*`) so the running server is unchanged and the working tree stays buildable. That rewiring is increment 2.

## What was delivered (increment 1)

```
packages/server/src/core/
├── errors.ts                         # BackendError hierarchy with stable `code` field
├── InferenceBackend.ts              # the port + all normalized types (ModelInfo, RunningModelStatus,
│                                     #   GenerationRequest/Metrics, LogProbResult, BackendCapabilities,
│                                     #   UnifiedModel, BackendStatus, RegistrySnapshot)
├── BackendRegistry.ts               # backend-agnostic snapshot builder (replaces model-registry hand-merge)
└── __tests__/backend-contract.test.ts # 13 pure conformance tests against a FakeBackend
```

Key design decisions baked into the code (not just the design doc):

- **`ModelInfo.backend: string`** (open set), not a `'ollama' | 'lmstudio'` union. A third adapter registers itself; nothing in core changes. The falsifiable test is that the contract tests pass with a fake adapter named anything.
- **`getLogProbs` is a scoring contract** (`{ text, contextLength } → LogProbResult`), per the resolution in proposal 01 design.md §Resolved. No sampling → the "actual-token vs top-k" question dissolves.
- **`getBaseUrl` is NOT on the port.** Not every backend has a single URL (LM Studio talks to a REST URL *and* a CLI binary). Instead, the registry resolves a display URL via a documented `HasBaseUrl` side channel. This is an explicit, commented seam (`BackendRegistry.ts` `getBackendUrl`), not an accidental leak — and it is flagged for revisiting in increment 2.
- **The registry's output shapes (`UnifiedModel`, `BackendStatus`, `RegistrySnapshot`, `DuplicatePair`) intentionally mirror the current `services/model-registry.ts` shapes** so the increment-2 rewiring of consumers (`routes.ts`, dashboard) is mechanical, not a data-model redesign.
- **`UnifiedModel.duplicate` remains mutable** (set during snapshot annotation) to preserve current behavior exactly — the contract test asserts both models get annotated.

## Verified in this environment ✅

- `npm run typecheck -w packages/server` — **green** (no type errors across the new `core/` modules).
- `npx vitest run packages/server/src/core/__tests__/backend-contract.test.ts` — **13/13 green**:
  - error hierarchy: every error carries a stable `code` + `backend`; `CapabilityNotSupportedError` records the missing capability; `instanceof` preserved.
  - capability gating: backends without `supportsModelfileExport` / `supportsLogProbs` expose no optional method; `CapabilityNotSupportedError` is the documented fallback.
  - registry: unified snapshot from ≥2 adapters via the port; loaded + VRAM reporting; graceful degradation when a backend is unreachable; cross-backend duplicate detection + dual annotation; no same-backend false dupes; canonical-id prefix routing; `ModelNotFoundError` on missing model.

## Could NOT be verified here — must be validated locally

1. **The existing `packages/server/src/__tests__/routes.test.ts` does not run in this sandbox.** It uses `supertest`, which binds a socket; the sandbox returns `EPERM listen 0.0.0.0`, so all 25 of those tests fail to *run* here (they are not broken on disk — they are socket-binding tests in a no-socket environment). This is a **pre-existing limitation of this sandbox, not introduced by increment 1.** Run the full suite locally: `npx vitest run`.
2. **No live Ollama / LM Studio in this sandbox**, so the real adapter extraction (increment 2) and the proposal-01 characterization tests (tasks 1.1–1.5) cannot be exercised here. They are the local-validation step.

## Increment 2 — adapter extraction + consumer rewiring (do locally, against live services)

Strict strangler-fig order. Do not skip step 2 (characterization tests) — it is the safety net that makes the refactor "done" rather than "looks done."

### Step 2.1 — Characterization tests (the safety net)

Stand up live Ollama (≥2 pulled models) + live LM Studio (≥1 loaded model). Record fixture responses (via `nock`/`msw` record mode) so the same tests run in CI later. Pin current behavior for every method that will move:

- `ollama.listModels`, `ollama.listRunning`, `ollama.showModel`, `ollama.generate`, `ollama.ping`, `ollama.getBaseUrl`
- `lmstudio.listModelsDetailed`, `lmstudio.listLoaded`, `lmstudio.chat`, `lmstudio.isServerRunning`, `lmstudio.getBaseUrl`

Add these to a new `packages/server/src/adapters/__tests__/characterization.test.ts` (not the supertest-based `routes.test.ts`, which is route-level). Confirm green on `main` *before* any refactor.

### Step 2.2 — Extract Ollama adapter

Create `packages/server/src/adapters/ollama/OllamaBackend.ts`. It wraps the existing `OllamaClient` (do not rewrite the fetch logic — delegate), implements `InferenceBackend`, and does the normalization that used to live in `model-registry.ts.getOllamaModels()`:

```ts
// OllamaBackend.ts — normalization map (the ONLY thing that knows Ollama shapes)
private toModelInfo(m: OllamaModel): ModelInfo {
  return {
    id: `ollama:${m.name}`,
    displayName: m.name,
    backend: 'ollama',
    backendModelId: m.name,
    type: m.details.family === 'nomic-bert' ? 'embedding' : 'llm',
    sizeMb: Math.round(m.size / (1024 * 1024)),
    parameterSize: m.details.parameter_size,
    architecture: m.details.family,
    quantization: m.details.quantization_level,
    contextWindow: 0, // resolved by monitor today; leave 0 to preserve behavior
    vision: false, toolUse: false,
  };
}
// listAvailableModels -> maps OllamaModel[] via toModelInfo
// listRunningModels -> maps RunningModel -> RunningModelStatus { vramBytes: size_vram, loadedAt, expiresAt, ... }
// capabilities: { supportsKvCacheQuantization: true, supportsModelfileExport: true,
//                supportsLogProbs: <VERIFY per design.md §Resolved — set false until verified>,
//                supportsStreamingMetrics: true, supportsHotModelSwap: true, supportsToolUse: false,
//                maxConcurrentModels: null }
// healthCheck -> ollama.ping()
// errors: catch fetch failures -> BackendUnavailableError; 404 on showModel -> ModelNotFoundError
```

`OllamaBackend` also implements `HasBaseUrl.getBaseUrl()` (delegates to `ollama.getBaseUrl()`) so the registry's URL accessor works.

### Step 2.3 — Extract LM Studio adapter

`packages/server/src/adapters/lmstudio/LmStudioBackend.ts`, wrapping `LmStudioClient`. Normalization moves out of `model-registry.ts.getLmsModels()`:

```ts
// LmsModel -> ModelInfo: id `lmstudio:${m.modelKey}`, type from m.type, sizeMb from sizeBytes,
//   parameterSize from m.paramsString, architecture from m.architecture,
//   quantization from m.quantization?.name ?? 'unknown', contextWindow from m.maxContextLength,
//   vision from m.vision, toolUse from m.trainedForToolUse
// capabilities: { supportsKvCacheQuantization: false, supportsModelfileExport: false,
//                supportsLogProbs: <VERIFY echo+logprobs on /v1/completions; false until verified>,
//                supportsStreamingMetrics: true, supportsHotModelSwap: true, supportsToolUse: true,
//                maxConcurrentModels: null }
```

LM Studio exposes both a REST URL and a CLI binary; `getBaseUrl()` returns the REST URL for the snapshot's `BackendStatus.url`. The CLI lifecycle (`startServer`/`stopServer`) stays adapter-internal — not on the port.

### Step 2.4 — Rewire `services/model-registry.ts` (the consolidation)

This is where the LoC-reduction acceptance criterion is measured. `model-registry.ts` shrinks from 281 LoC (hand-merge + two backend-specific fetchers + duplicate detection + normalizeModelName) to a thin orchestrator around `BackendRegistry`. Concretely:

**Before** (current): `getOllamaModels()` + `getLmsModels()` + `detectDuplicates()` + `normalizeModelName()` + `Backend = 'ollama' | 'lmstudio'` union + direct `import { ollama }` / `import { lmstudio }`.

**After** (increment 2):
```ts
import { BackendRegistry } from '../core/BackendRegistry.js';
import type { RegistrySnapshot } from '../core/InferenceBackend.js';
import { OllamaBackend } from '../adapters/ollama/OllamaBackend.js';
import { LmStudioBackend } from '../adapters/lmstudio/LmStudioBackend.js';

class ModelRegistry {
  private registry: BackendRegistry;
  // ... polling loop unchanged ...
  constructor(refreshIntervalMs = 10000) {
    this.registry = new BackendRegistry([new OllamaBackend(), new LmStudioBackend()]);
  }
  async refresh(): Promise<RegistrySnapshot> {
    this.lastSnapshot = await this.registry.getSnapshot(); // the entire merge/dedupe/totals logic is now in core/BackendRegistry.ts
    return this.lastSnapshot;
  }
  getSnapshot(): RegistrySnapshot | null { return this.lastSnapshot; }
}
```

**Deleted from `model-registry.ts`:** `getOllamaModels`, `getLmsModels`, `detectDuplicates`, `normalizeModelName`, the `Backend` union, the direct `ollama`/`lmstudio` imports, the `OllamaModel`/`LmsModel`/`RunningModel`/`LmsLoadedModel` type imports. All of that logic now lives in `core/BackendRegistry.ts` (already delivered + tested) and in the two adapters (increment 2.2/2.3).

**Acceptance check:** `model-registry.ts` LoC must drop substantially (target: <60 LoC). `route-advisor.ts` must drop its `Backend`-union branching (next step). If either grows, revisit the interface.

### Step 2.5 — Rewire `services/route-advisor.ts` (remove the union)

`route-advisor.ts` imports `Backend` from `model-registry.js` and branches on `request.preferBackend !== profile.backend`. After increment 2, `Backend` is gone. Change:

```ts
// Before: import { modelRegistry, type Backend } from './model-registry.js';
//         preferBackend?: Backend;
// After:
import { modelRegistry } from './model-registry.js';
type BackendName = string; // open set; the registry's snapshot carries `backend: string`
// preferBackend?: BackendName   — comparison `profile.backend !== request.preferBackend` still works (string vs string)
```

The routing *logic* is unchanged — it already only compares strings. The change is deleting the closed union so a third backend doesn't require editing `route-advisor.ts`. No behavioral change; the existing `routes.test.ts` (route-guard tests) must stay green.

### Step 2.6 — Wire into `index.ts`

`packages/server/src/index.ts` currently constructs `modelRegistry` directly. After 2.4, `modelRegistry` internally builds the `BackendRegistry` from adapters — `index.ts` needs no change for the registry path. (A later increment introduces `BackendFactory` from `INFERENCE_BACKENDS` env; for increment 2, hard-coding Ollama+LM Studio preserves current behavior — exactly the v0.5 default of "Ollama + LM Studio both registered.")

### Step 2.7 — Verify (the gate for moving on)

- [ ] Characterization tests (2.1) green against the new adapters — behavior byte-equivalent.
- [ ] `npm run typecheck -w packages/server` green.
- [ ] Full `npx vitest run` green locally (incl. the 25 `routes.test.ts` route guards — they can't run in this sandbox but must run on your machine).
- [ ] `eslint-plugin-boundaries` (or equivalent) added and failing if anything in `services/`, `api/`, `ws/` imports from `adapters/*` directly (proposal 01 task 2.3).
- [ ] `model-registry.ts` LoC reduced (acceptance: registry/router consolidation paid off).
- [ ] Manual smoke: `npm run dev`, dashboard shows Ollama + LM Studio models unified, duplicates flagged — behavior identical to pre-refactor.

### Step 2.8 — Validation stub (the "did the abstraction hold" test)

Per proposal 01 task 8.1: create `packages/server/src/adapters/llamacpp/LlamaCppBackend.ts` implementing `healthCheck()` + `listAvailableModels()` only, everything else throwing `CapabilityNotSupportedError`. If it requires *any* change to `core/InferenceBackend.ts`, the abstraction is wrong — fix it before a real third adapter is built. (The contract test already passes with an arbitrary-named fake, so this is expected to hold; the stub confirms it against a real adapter-shaped file, not just a test fixture.)

## Out of scope for increments 1–2 (later changes)

- `BackendFactory` from `INFERENCE_BACKENDS` env var (proposal 01 task 5.1) — increment 2 hard-codes the two existing backends to preserve behavior; the env-driven factory is increment 3, after the seam is proven by the stub.
- Rewiring the *service-layer singletons* (`monitor.ts`, `benchmark.ts`, `modelfile.ts`, `perplexity.ts`) to take `InferenceBackend` via constructor injection (proposal 01 tasks 6.1–6.4) — these are larger, consumer-specific refactors that follow once the registry consolidation is green. They are sequenced after 2.7, not in parallel, to keep the diff reviewable.
- Proposal 02's perplexity replacement (depends on `supportsLogProbs` being verified on a real adapter — a 2.2/2.3 sub-step, not this increment).
