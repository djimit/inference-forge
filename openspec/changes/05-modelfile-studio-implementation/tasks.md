# Tasks: Modelfile Studio Implementation (DRAFT — gated, not activatable)

Implementation tasks are deliberately **not enumerated in detail** until the `04-modelfile-studio-deferred` gate is passed. Enumerating them now would invite starting them under delivery pressure, which is what the gate exists to prevent. The structural outline below is sufficient for review of the design; full task breakdown happens when the gate is archived.

## 0. Gate precondition (must be verified before any task below is started)
- [ ] 0.1 `01-backend-abstraction-layer` merged + acceptance-verified (per its design.md §Validation)
- [ ] 0.2 `02-perplexity-benchmark-rigor` merged + acceptance-verified (incl. `docs/validation/perplexity-cross-check.md`)
- [ ] 0.3 `03-zero-trust-auth-layer` token MVP merged + acceptance-verified (auth across the 60+ route surface, audit logging, startup guard)
- [ ] 0.4 `04-modelfile-studio-deferred` archived as superseded by this proposal

## 1. Core types (design.md Layer 1)
- [ ] 1.1 `packages/server/src/core/model-config/ModelConfigurationProfile.ts` + validation
- [ ] 1.2 `schemaVersion` field present from day one (insurance per proposal open question)

## 2. Adapter operations (design.md Layer 2)
- [ ] 2.1 Add `applyProfile` to `InferenceBackend`; implement on Ollama (derive Modelfile + `create`) and LM Studio (profile → load params / recommended launch flags)
- [ ] 2.2 Re-spec `exportModelfile` to take a `ModelConfigurationProfile` (delta to proposal 01's signature); implement on Ollama only, gated by `supportsModelfileExport`
- [ ] 2.3 Capability-gated 501 path verified by test

## 3. UI + routes (auth-gated from day one)
- [ ] 3.1 Rewrite `ModelfileEditor.tsx` to edit `ModelConfigurationProfile`; "Export as Modelfile" gated by `supportsModelfileExport`
- [ ] 3.2 Re-point `/modelfile/generate`, `/modelfile/generate-auto`, `/templates/:id/create` to profile-based, auth-gated versions; remove the legacy unauthenticated write surface
- [ ] 3.3 Re-type `services/modelfile-library.ts` to store profiles; migrate existing library entries (lossy where Ollama-specific fields have no profile equivalent — document and confirm)

## 4. Perplexity advisory (uses proposal 02 results)
- [ ] 4.1 Surface measured perplexity delta as advisory text on KV cache selection; never auto-apply

## 5. Validation
- [ ] 5.1 Profile authored against Ollama re-pointable to LM Studio by changing `baseModel` only (the backend-agnostic falsifiable test)
- [ ] 5.2 All write routes return 401 without token (test)
- [ ] 5.3 `exportModelfile` on LM Studio returns 501 `CAPABILITY_NOT_SUPPORTED` (test)

## Open Questions (refine before gate passes; none block the design)
- [ ] Community template gallery: follow-up (recommended) or in-scope?
- [ ] Profile migration strategy beyond `schemaVersion` field.
