# Change Proposal: Modelfile Studio & Multi-Agent Features — Explicit Deferral with Entry Gate

**Change ID:** `04-modelfile-studio-deferred`
**Status:** **Active gate — not archived.** 01-03 are NOT yet implemented, so the gate stands. A draft `05-modelfile-studio-implementation` proposal now exists (backend-agnostic Modelfile abstraction resolved in its design.md), but it is explicitly DRAFT/gated and SHALL NOT activate until 01-03 are merged and acceptance-verified. This proposal is intentionally a deferral/gate record, not an implementation plan.
**Owner:** Dennis (DjimIT B.V.)
**Severity:** N/A — this proposal's purpose is sequencing discipline, not a feature
**Depends on:** `01-backend-abstraction-layer` (MUST be merged), `02-perplexity-benchmark-rigor` (MUST be merged), `03-zero-trust-auth-layer` (MUST be merged, at minimum the token-auth MVP + startup guard)

---

## Why This Proposal Exists

This is not a typical change proposal — it describes no new functionality to build. It exists to make explicit and reviewable a sequencing decision that would otherwise happen implicitly and be easy to violate under feature-delivery pressure: **Modelfile Studio (roadmap v0.4) and Multi-Agent Support (roadmap v0.5) SHALL NOT accrue further implementation scope until proposals 01, 02, and 03 are merged and their acceptance criteria verified.**

The reasoning, stated plainly:

### The gate is urgent because the work is already partially started

The repo contradicts the assumption that this is preventing *future speculative* work. The Multi-Agent feature is **already scaffolded**:

- `packages/server/src/services/orchestrator.ts` — 511 LoC, implements `AgentConfig`, `Workflow`, session/conversation management
- Route groups already shipped: `/agents` (GET/POST/PUT/DELETE), `/sessions` (POST/GET), `/sessions/:id/message`, `/sessions/:id/message/stream` (POST), `/workflows` (GET/POST), `/workflows/:id/execute` (POST), `/orchestrator/status`
- `services/hivemind-bridge.ts` and `services/openclaw-bridge.ts` exist as ecosystem bridges

Modelfile Studio itself is partly present:
- `services/modelfile.ts` (458 LoC) and `services/modelfile-library.ts` (278 LoC)
- `POST /modelfile/generate`, `POST /modelfile/generate-auto`, `POST /templates/:id/create` — these are write-capable endpoints already exposed with no auth

So proposal 04 is not preventing hypothetical scope creep; it is gating **already-started** scope from accreting *further* before the foundation is fixed. This makes the gate more relevant, not less.

### Why each dependency is load-bearing

- **Modelfile Studio is a write-capable feature** (model configuration changes, "one-click model creation via API" — and the `/templates/:id/create` route already exists doing exactly this). Shipping/advancing it before the auth layer (proposal 03) means advancing a feature whose blast radius — on any deployment beyond strict localhost — is unauthenticated configuration tampering. The `/templates/:id/create` and `/modelfile/generate` routes are today's highest-blast-radius unauthenticated write surface (per proposal 03's threat model).
- **Modelfile Studio is Ollama-specific.** A Modelfile is an Ollama concept; vLLM and llama.cpp-server have no equivalent artifact. Building/advancing it before the backend abstraction (proposal 01) lands means encoding an Ollama-specific data model that has to be redesigned — not just re-pointed — when a second/third backend is added. The proposal-01 cost-of-delay table applies directly here.
- **Multi-Agent Support** — "concurrent model orchestration," "agent workflow builder," "session and conversation memory management" — implicitly assumes the perplexity/benchmark data model (proposal 02) and the backend abstraction (proposal 01) are stable. Orchestrating multiple models across potentially multiple backends without a stable backend contract multiplies the surface area of an already-straining foundation. The existing `orchestrator.ts` already calls `ollama` and `lmstudio` directly — exactly the coupling proposal 01 exists to remove.

This proposal's only "requirement" is a gate condition, formalized so it can be checked rather than assumed.

## What Changes

- No code changes in this proposal.
- Adds an explicit gate check to the project's contribution/roadmap process: any PR or change proposal targeting Modelfile Studio or Multi-Agent Support features SHALL reference this proposal and confirm proposals 01–03 are merged in the proposal's "Depends on" section, per OpenSpec convention.
- When proposals 01–03 are complete, this proposal is archived and superseded by an actual `05-modelfile-studio-implementation` proposal, written at that time with full design rigor matching the other three (interface-first for the backend-agnostic Modelfile-equivalent concept — see Open Question — auth-aware from day one, not retrofitted).

## Impact

- **Affected specs:** None directly — this is a process/sequencing artifact, not a spec delta.
- **Affected docs:** `README.md` roadmap section — v0.4 and v0.5 entries annotated with "blocked on: backend abstraction, benchmark rigor, auth layer" so the public-facing roadmap reflects the actual dependency graph instead of implying a simple linear progression.
- **Affected code:** None merged. Existing scaffolded `orchestrator.ts`, `modelfile.ts`, `/templates/:id/create`, etc. are left in place (out of scope) — the gate is on *further* scope, not removal. The exception is the README caveat: the existing `/modelfile/generate` and `/templates/:id/create` routes being write-capable-and-unauthenticated is exactly what proposal 03 fixes; until 03 lands, the README SHOULD note these endpoints are not safe to expose beyond loopback (cross-reference proposal 03's interim note).

## Rejected Alternatives

1. **"Just build Modelfile Studio next since it's the next roadmap item."** Rejected: the existing roadmap was not derived from a dependency analysis; it was a feature wish-list ordered by narrative progression (monitoring → benchmarking → editing → orchestration). This proposal replaces that ordering with a dependency-derived one. The presence of already-scaffolded `orchestrator.ts` and `/templates/:id/create` shows the wishlist ordering has been followed into code ahead of the foundation — the gate exists to stop that, not to legitimize it.
2. **"Build Modelfile Studio now, retrofit backend-agnosticism and auth later."** Rejected: this is the exact anti-pattern proposals 01 and 03 exist to prevent. The whole point of foundational work first is that retrofitting is more expensive than building correctly the first time. Repeating that mistake a third time, on the most write-capable, highest-blast-radius feature in the roadmap, would be the worst place to repeat it.
3. **"Delete the existing scaffolded `orchestrator.ts` and agent routes now, since they're premature."** Rejected: removing working code without a replacement is not in scope for a process gate, and the scaffolded code is not actively wrong — it's incomplete. The gate prevents *more* of it, not the existence of what's there. Cleanup, if warranted, is a separate decision.

## Open Question (for the eventual `05-modelfile-studio-implementation` proposal, not resolved here)

What is the backend-agnostic abstraction for "Modelfile"? Ollama's Modelfile is a specific artifact format; vLLM and llama.cpp-server configure models via different mechanisms (launch flags, config files, no persistent "model definition" artifact at all in some cases). Does `InferenceBackend.exportModelfile()` remain an Ollama-specific optional capability (per `BackendCapabilities.supportsModelfileExport`, already defined in proposal 01), with non-Ollama backends simply not supporting this feature — or does Modelfile Studio need a higher-level "model configuration profile" concept that each backend translates into its own native format? This is a real design decision, not a detail, and should not be decided implicitly when the implementation proposal is eventually written.
