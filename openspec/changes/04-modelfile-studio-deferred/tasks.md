# Tasks: Modelfile Studio & Multi-Agent Deferral Gate

This is a gate-condition checklist, not an implementation task list. "Done" here means the gate is correctly enforced, not that any feature shipped.

## 1. Roadmap annotation
- [ ] 1.1 Update `README.md` roadmap section: annotate v0.4 (Modelfile Studio) and v0.5 (Multi-Agent Support) with explicit "Blocked on: #01 backend abstraction, #02 benchmark rigor, #03 auth layer"
- [ ] 1.2 Add a note in `README.md` that the existing `/modelfile/generate`, `/modelfile/generate-auto`, and `/templates/:id/create` routes are write-capable and MUST NOT be exposed beyond loopback until proposal 03's auth layer lands (cross-reference 03's interim mitigation)
- [ ] 1.3 Add a short note in CONTRIBUTING (or `.github/copilot-instructions.md`) that any PR targeting Modelfile Studio or Multi-Agent roadmap items MUST reference this proposal's gate condition in its description and confirm 01–03 are merged

## 2. Gate verification (check before allowing `05-modelfile-studio-implementation` to begin)
- [ ] 2.1 Confirm `01-backend-abstraction-layer` is merged and its acceptance criteria (design.md §Validation) are checked off — including the `LlamaCppBackend` stub requiring zero interface changes and the `model-registry.ts` / `route-advisor.ts` LoC reduction
- [ ] 2.2 Confirm `02-perplexity-benchmark-rigor` is merged and its acceptance criteria are checked off — including `docs/validation/perplexity-cross-check.md` existing with ≥2 architectures agreeing within tolerance, and `services/perplexity.ts` (timing proxy) deleted
- [ ] 2.3 Confirm `03-zero-trust-auth-layer` MVP (token auth, startup guard, audit logging across the 60+ route surface) is merged and its acceptance criteria are checked off

## 3. Containment of already-scaffolded scope (do not let it grow while gated)
- [ ] 3.1 Confirm no new routes are added under `/agents`, `/sessions`, `/workflows`, `/orchestrator`, `/modelfile`, `/templates` while the gate is active (enforced by PR review referencing this proposal)
- [ ] 3.2 Confirm `services/orchestrator.ts`, `services/hivemind-bridge.ts`, `services/openclaw-bridge.ts` receive no new feature scope while the gate is active (bug fixes acceptable; new features are not)

## 4. Archival
- [ ] 4.1 Once gate conditions are met and a real `05-modelfile-studio-implementation` proposal is written, archive this proposal per OpenSpec `archive` convention, with a note pointing to the successor proposal
- [ ] 4.2 The successor proposal MUST resolve the Open Question (backend-agnostic Modelfile abstraction) before implementation begins
