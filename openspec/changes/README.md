# Inference Forge — Architectural Remediation Program

**Format:** OpenSpec change proposals (`openspec/changes/`)
**Prepared by:** Claude, for Dennis (DjimIT B.V.)
**Date:** 2026-06-20 (deepened against the live `inference-forge` repository)
**Scope:** Four sequenced change proposals addressing the architectural, scientific, and security gaps observed in the current `inference-forge` codebase.

---

## Reality Check — the actual state of the repo (read first)

The original drafts of these proposals described the project as *"23 commits, Phase 1-2 complete, four service files."* That is **not** the state of the repository today. Inspecting the live tree yields a materially different picture, and every proposal below is re-anchored to it:

| Dimension | Original-draft assumption | Actual state observed in the repo |
|---|---|---|
| Server source size | "four service files" | `packages/server/src` = ~8,075 LoC across 25 services + 1,063-line `api/routes.ts` + `ws/handler.ts` + `index.ts` |
| REST API surface | "~3 route groups" | **60+ routes** spanning models, metrics, hardware, throughput, alerts, benchmark, perplexity, prompts, templates, modelfile, I/O, costs, pressure, agents, sessions, workflows, orchestrator, routing, registry, storage, profiles |
| Backends supported | "hard-coupled to a single backend (Ollama)" | Ollama is primary, **but a second backend already exists** as `services/lmstudio.ts`, glued into `services/model-registry.ts` (`Backend = 'ollama' | 'lmstudio'`) and `services/route-advisor.ts`. The coupling problem is therefore not "single-backend" — it is **ad-hoc multi-backend without a port boundary**: two clients, one registry that imports both, one router that branches on the union type. |
| KV cache quality metric | "no methodology" | Worse than absent: `services/perplexity.ts` exists and **pretends to measure perplexity while measuring nothing of the sort** — it uses *generation token-latency* as a proxy for log-probability (`avgLogProb = -log(msPerEvalToken / msPerPromptToken)`) and blends it with a Jaccard bigram-similarity heuristic. The number it emits is latency-influenced, hardware-influenced, and unrelated to quantization quality in any clean way. This is an active credibility liability, not a missing feature. |
| Auth | "no access control" | Confirmed. `index.ts` already contains the exact informal mitigation this program replaces: a `console.warn` printed *after* `server.listen()` when `HOST` is non-loopback. A warning that fires after successful startup is not a control; it is a disclaimer. |

**Why this matters for sequencing:** The original drafts argued these fixes get more expensive "the longer the roadmap proceeds." The reality check makes that argument *stronger and more urgent*, because three of the four problems are no longer hypothetical future risk — they are already-shipped code that is actively wrong (perplexity proxy) or actively accreting debt (ad-hoc lmstudio glue, growing write-capable API surface with no auth). Cost-of-delay is no longer theoretical; it is being paid now, every commit.

## Executive Summary

`inference-forge` is a competently structured TypeScript monorepo that has grown well beyond its original Phase 1-2 framing into a broad inference-management surface (monitoring, benchmarking, multi-backend registry, routing, agents, workflows). The code quality is not the problem. The problem is that **three foundational decisions are being made by default rather than by design**, and the repo now contains concrete evidence that each one is already incurring cost:

1. The project already has a second backend (`lmstudio.ts`) bolted on through direct cross-imports rather than through a port/adapter boundary — so the abstraction debt is not future, it is present, and `route-advisor.ts` branching on a `Backend` union type is the visible symptom.
2. The project's core differentiator — a "perplexity" feature — already ships a number that is **not perplexity**, computed from token latency. This is worse than "no methodology": it is a false metric with a real label.
3. The project has no access control across a 60+ route surface that already includes write-capable and resource-consuming endpoints (`/models/pull`, `/agents`, `/sessions/:id/message/stream`, `/workflows/:id/execute`, `/route/policies`, `/templates/:id/create`, `/modelfile/generate`).

None of these are reasons to discard the project. They are reasons to sequence the next ~10-15 engineering days correctly before continuing to add roadmap features (Modelfile Studio, Multi-Agent Support) on top of an already-straining foundation. This is the standard "fix the foundation before you build the third floor" judgment call, made explicit and falsifiable rather than left as an assumption — and now grounded in the actual files rather than an idealized project sketch.

## The Four Proposals, and Why This Order

```
                    ┌─────────────────────────────┐
                    │  01: Backend Abstraction      │
                    │  Layer (Hexagonal Architecture)│
                    │  — consolidates the existing   │
                    │    ad-hoc lmstudio/registry/   │
                    │    route-advisor glue into a   │
                    │    real port boundary          │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼                                ▼
     ┌─────────────────────────┐      ┌─────────────────────────┐
     │ 02: Perplexity Benchmark │      │ 03: Auth & Access Control│
     │ Rigor — REPLACES the     │      │ Layer — converts the     │
     │ existing timing-proxy    │      │ existing index.ts        │
     │ perplexity.ts with a real│      │ console.warn into a      │
     │ NLL measurement (depends │      │ startup guard across the │
     │ on backend logprob port) │      │ existing 60+ route surface│
     └─────────────────────────┘      └─────────────────────────┘
                    │                                │
                    └───────────────┬────────────────┘
                                    ▼
                    ┌─────────────────────────────┐
                    │  04: Modelfile Studio /       │
                    │  Multi-Agent — GATED, not      │
                    │  started until 01-03 merged    │
                    └─────────────────────────────┘
```

**01 (Backend Abstraction)** comes first because (a) it is a pure-cost decision that only gets more expensive, and (b) the repo already contains a second backend glued in ad-hoc — so this is now partly a *consolidation* task, not a green-field abstraction. Proposal 02's perplexity work must be designed against a backend-agnostic logprob contract from the start; building it against raw Ollama endpoints first means rebuilding it once 01 lands.

**02 (Benchmark Rigor)** and **03 (Auth)** can technically proceed in parallel once 01 is merged — they touch different parts of the codebase and have no hard dependency on each other. They are sequenced together here because both are credibility/trust fixes (one scientific, one security) that should land before any further roadmap feature work. Note that **02 is now a replacement task, not a new-feature task**: it supersedes the existing broken `perplexity.ts`, so part of its work is *removing* a false metric that is currently exposed at `POST /api/perplexity/estimate` and `POST /api/perplexity/compare`.

**04 is not a feature proposal.** It is a gate, formalized as an OpenSpec change so the dependency is enforceable and reviewable rather than tribal knowledge. The repo already contains `services/orchestrator.ts` (511 LoC) and the agents/sessions/workflows route groups — meaning the "Multi-Agent" feature is already partially scaffolded *before* the foundation is fixed. This makes the gate more relevant, not less: it is not preventing speculative work, it is preventing *already-started* speculative work from accreting further scope before 01-03 land.

## Engineering Effort Estimate (revised against actual scope)

| Proposal | Effort | Type | Notes |
|---|---|---|---|
| 01 — Backend Abstraction | 3-4 days (interface + Ollama + lmstudio extraction) | Architecture | Larger than original estimate because the lmstudio adapter already exists and must be migrated, not just Ollama. `model-registry.ts` and `route-advisor.ts` must be rewired off the `Backend` union type. |
| 02 — Perplexity Rigor | 4-6 days | Scientific/measurement | Includes *deleting and replacing* the existing `perplexity.ts`; the proxy implementation is a liability, not a base to build on. |
| 03 — Auth Layer | 5-7 days (token MVP across 60+ routes) | Security/compliance | Larger than original "3 route groups" estimate because the real API surface is 60+ routes including SSE streaming (`/models/pull`) and WS handshake. |
| 04 — Gate (process only) | <1 day | Process | Documentation + gate enforcement + roadmap annotation. |
| **Total before resuming feature roadmap** | **~13-18 engineering days** | | |

This is roughly three working weeks for one engineer — against a roadmap that otherwise commits to multiple additional months of feature work built on a foundation that the repo itself now demonstrates is already straining.

## Risk Register (re-anchored to actual shipped evidence)

| Risk | If proposal 01 skipped | If proposal 02 skipped | If proposal 03 skipped |
|---|---|---|---|
| **Technical debt** | `route-advisor.ts` continues to branch on a growing `Backend` union type; every new backend adds another `if` across registry + router + UI. The ad-hoc pattern already present scales as O(backends × services). | The false perplexity metric continues to be exposed at `POST /api/perplexity/estimate`; any downstream feature (comparison charts, README claims, advisory reports) built on it inherits a wrong number | Auth retrofit across the already-large 60+ route surface (incl. SSE pull streaming and WS) instead of a clean middleware insertion today |
| **Credibility** | The existing `lmstudio.ts` proves multi-backend is wanted; without a port boundary it ships as fragile glue that breaks on the third backend, visibly | A "perplexity" tool that emits latency-derived numbers under the perplexity label is the textbook credibility-destroying failure mode for a *measurement* tool — and it is already shipping | A 60+ route tool with write-capable endpoints and a post-startup `console.warn` as the only exposure mitigation is unsuitable to reference in any DjimIT public-sector advisory context |
| **Compliance** | Indirect sovereignty implication (no clean path to vLLM/llama.cpp-server) | n/a directly | Direct NIS2/BIO2 access-control gap; the existing `console.warn` is itself evidence that the exposure was recognized but not controlled |

## What This Plan Deliberately Does NOT Do

- It does not propose OIDC/SSO, RBAC, or multi-tenant auth — explicitly scoped out of proposal 03 as premature engineering, with an open question logged for when it is needed.
- It does not propose building a *third* backend adapter (vLLM/llama.cpp-server) — proposal 01 delivers the seam and a *stub* adapter as validation. The existing `lmstudio.ts` is migrated as the second real adapter because it already exists; a third is a future change.
- It does not touch Phase 3/4/5 feature *scope* (KV cache benchmarker UX, Modelfile editor UX, multi-agent orchestration UX) — those remain valid roadmap items, correctly sequenced behind the foundation.
- It does not propose deleting `orchestrator.ts` or the agents/sessions/workflows routes. They are scaffolded and out of scope for this program; proposal 04 gates *further* scope there, not removal of what exists.

This is intentional minimalism: fix exactly the three things that are already incurring cost, formalize the sequencing decision, and leave everything else where it already was — correctly ordered rather than re-scoped.

## How to Use This

Each `openspec/changes/NN-*/` folder is a self-contained, reviewable unit: `proposal.md` (why + what + impact + rejected alternatives), `design.md` (the actual technical contract — interfaces, algorithms, schemas, grounded in the real source files), `tasks.md` (file-level implementation checklist), and `specs/{capability}/spec.md` (EARS-format requirements with testable scenarios). Review and approve proposals 01-03 independently; treat 04 as the standing gate condition until they are merged.

A top-level `openspec/project.md` is intentionally **not** added by this program — it would be speculative structure before any proposal is merged. It can be added when the first capability spec is accepted, per OpenSpec convention.
