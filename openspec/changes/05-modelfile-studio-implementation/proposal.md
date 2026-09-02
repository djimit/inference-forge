# Change Proposal: Modelfile Studio Implementation (DRAFT — gated, not activatable)

**Change ID:** `05-modelfile-studio-implementation`
**Status:** Draft — **blocked by the `04-modelfile-studio-deferred` gate.** This proposal may be reviewed and refined, but SHALL NOT enter implementation until proposals 01, 02, and 03 are merged and their acceptance criteria verified. It is written now (ahead of the gate) so the design — in particular the backend-agnostic Modelfile abstraction question — is resolved *before* implementation begins, not decided implicitly mid-build.
**Owner:** Dennis (DjimIT B.V.)
**Depends on:** `01-backend-abstraction-layer` (merged + verified), `02-perplexity-benchmark-rigor` (merged + verified), `03-zero-trust-auth-layer` (token MVP merged + verified). The `04-modelfile-studio-deferred` gate MUST be archived as superseded by this proposal only after those three are verified.

---

## Why

Modelfile Studio (roadmap v0.4) is a write-capable, model-configuration feature: a visual editor for model definitions, import/export of a model-definition library, community templates, and one-click model creation. Per the threat model in proposal 03, this is the highest-blast-radius write surface in the project (unauthenticated model creation = unauthenticated configuration tampering on any non-loopback deployment), which is why it was gated behind the auth layer. Per the dependency analysis in proposal 01, "Modelfile" is an Ollama-specific artifact, which is why it was gated behind the backend abstraction.

The gating rationale is not re-litigated here. This proposal exists to do the one thing the gate said should be done *before implementation begins*: **resolve the backend-agnostic Modelfile abstraction question explicitly.** That resolution is in design.md and summarized in "What Changes" below.

## The Resolved Abstraction (summary — full reasoning in design.md)

The "Modelfile" question is reframed as a **two-layer model**, which dissolves the either/or in proposal 04's open question the same way proposal 02's `getLogProbs` reframing dissolved the actual-vs-top-k question — by recognizing that the apparent binary rests on a conflation:

- Ollama's Modelfile is a **persistent, portable model-definition artifact** (FROM + PARAMETER + SYSTEM + TEMPLATE + ADAPTER). It is a recipe you can `ollama create` from, share, and version-control.
- vLLM and llama.cpp-server configure models via **ephemeral launch flags** (`--model`, `--quantization`, `--max-model-len`, `--gpu-memory-utilization`, `--kv-cache-dtype`, etc.). There is no persistent artifact; the "model config" *is* the launch command.

The gap is therefore not just format but **persistence modality**. The resolution:

1. Introduce a backend-agnostic **`ModelConfigurationProfile`** (the portable intent: base model, quantization, context length, system prompt, chat template, KV cache type, inference params). The Modelfile Studio UI edits this, never a backend-specific artifact directly.
2. Each `InferenceBackend` adapter exposes two capability-gated operations on profiles:
   - **`applyProfile(profile)`** — translate the profile into the backend's native mechanism (Ollama: derive a Modelfile and `create`; vLLM/llama.cpp-server: emit the recommended launch-flags string). This is the backend-agnostic apply path and exists on every adapter.
   - **`exportModelfile(profile)`** — serialize the profile into Ollama's Modelfile *text format*, capability-gated by `supportsModelfileExport` (already defined in proposal 01). Non-Ollama adapters throw `CapabilityNotSupportedError`. The "Export as Modelfile" UI affordance is shown only when the active (or target) backend has this capability.

This is proposal 04's option (b) — a higher-level "model configuration profile" concept — *with* option (a) — `exportModelfile` as a capability-gated Ollama-specific serialization of it — rather than either/or. `ModelConfigurationProfile` is the portable core; the Modelfile is one (Ollama) projection of it.

## What Changes

- Add `packages/server/src/core/model-config/ModelConfigurationProfile.ts` (the backend-agnostic profile type) + a profile-validation module.
- Extend `InferenceBackend` (from proposal 01) with `applyProfile(profile): Promise<ApplyResult>` (universal) and `exportModelfile(profile): Promise<string>` (capability-gated by `supportsModelfileExport`).
- Modelfile Studio UI (`ModelfileEditor.tsx` and the existing `/modelfile/generate`, `/templates/:id/create` routes) is rewritten to operate on `ModelConfigurationProfile`, with "Export as Modelfile" gated by the active backend's `supportsModelfileExport` and "Apply to backend" universal.
- The existing `services/modelfile.ts` (458 LoC, Ollama-specific) becomes the **Ollama adapter's** Modelfile serialization + `create` logic, not a top-level service. The existing `services/modelfile-library.ts` is re-typed to store `ModelConfigurationProfile` (portable) rather than Ollama Modelfile text (non-portable).
- Auth (proposal 03) is enforced on all Modelfile Studio write routes from day one — not retrofitted. This is the gate's security condition.
- The perplexity quality signal (proposal 02) is surfaced in the editor as *advisory* ("this profile sets q4_0 KV cache; measured perplexity delta vs f16 = X ± Y") but never auto-applies a quantization choice without the user's confirmation — the editor recommends, the human decides.

## Impact

- **Affected specs:** `modelfile-studio` (new capability), MODIFIES `inference-backend-contract` (adds `applyProfile` + re-specs `exportModelfile` as profile-based, not model-id-based).
- **Affected code:** `core/model-config/`, adapters (each gets `applyProfile`; Ollama also `exportModelfile`), `services/modelfile.ts` → `adapters/ollama/`, `services/modelfile-library.ts` (re-typed), `ModelfileEditor.tsx`, `api/routes.ts` (`/modelfile/*`, `/templates/*` re-pointed to profiles).
- **Breaking changes:** `/modelfile/generate` and `/templates/:id/create` response/request schemas change to profile-based. Acceptable (0 stars; and the current routes are unauthenticated write-capable liabilities per proposal 03, so changing them during the auth retrofit is the right moment).
- **Gate condition (from proposal 04):** implementation SHALL NOT begin until 01-03 are merged and acceptance-verified, including: backend seam live with Ollama + LM Studio adapters, `LlamaCppBackend` stub requiring zero interface changes, perplexity cross-validation persisted, auth MVP across the 60+ route surface, audit logging live.

## Rejected Alternatives

1. **"Keep Modelfile Studio Ollama-only (`exportModelfile` only, no `ModelConfigurationProfile`)."** Rejected: this is proposal 04's option (a) in pure form. It makes the editor's data model Ollama-specific, so adding a second backend later requires redesigning the editor's data model (not just adding an adapter) — exactly the cost asymmetry proposal 01 exists to prevent. The two-layer model keeps the editor backend-agnostic at the cost of one extra type + one extra adapter method.
2. **"Build a universal 'model definition' artifact format that every backend persists natively."** Rejected: vLLM and llama.cpp-server have no persistent artifact by design (launch flags are ephemeral). Forcing a persistence layer where the backend doesn't have one is speculative engineering against a deployment context that doesn't exist. `applyProfile` translating to launch flags is the correct, minimal answer for those backends; persistence is an Ollama (and future, if any) capability, surfaced via `exportModelfile`.
3. **"Auto-apply the perplexity-recommended quantization on profile creation."** Rejected: crosses the measurement-recommends / human-decides boundary. The editor advises using proposal 02's measured delta; the user confirms. Auto-application would make a benchmark tool silently mutate production model configs — a credibility and safety problem, not a feature.

## Open Questions (for refinement before the gate passes — none block the design above)

- Community template gallery (roadmap v0.4 bullet): is this in-scope for the first implementation, or a follow-up? Recommend follow-up — the first implementation delivers the profile-based editor + apply/export + auth; the gallery is distribution infrastructure, separable.
- Profile versioning/migration: when `ModelConfigurationProfile` evolves, how are stored profiles migrated? Recommend a `schemaVersion` field on the profile from day one (cheap insurance) even if no migration is written yet.
