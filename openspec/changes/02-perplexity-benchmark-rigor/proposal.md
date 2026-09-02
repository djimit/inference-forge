# Change Proposal: Rigorous Perplexity Benchmark (Replace the Existing Timing-Proxy with Measurement)

**Change ID:** `02-perplexity-benchmark-rigor`
**Status:** Draft — pending review
**Owner:** Dennis (DjimIT B.V.)
**Severity:** Credibility blocker — the repo *already ships* a `perplexity.ts` that emits a number labeled "perplexity" which is not perplexity. This is a replacement task, not a new-feature task.
**Estimated effort:** 4–6 engineering days (corpus integration, NLL computation, cross-validation, removal + replacement of existing proxy)
**Depends on:** `01-backend-abstraction-layer` — perplexity computation must consume the normalized `LogProbResult` from the `InferenceBackend` interface (specifically `getLogProbs()` + `supportsLogProbs`), not call Ollama's `/api/generate` directly.

---

## Why

### The existing implementation is a false metric, not a missing metric

The original drafts framed this as "the benchmarker has no defined methodology." The live repository is worse than that: `packages/server/src/services/perplexity.ts` (208 LoC) **already implements a perplexity estimator that does not measure perplexity.** Concretely, the current `PerplexityService.estimate()`:

1. Takes a corpus from a hand-written `REFERENCE_CORPORA` map (three short paragraphs: `technical`, `general`, `code`, `reasoning`) — hundreds of words, not a standardized evaluation set.
2. Splits the corpus in half, prompts the model to "Continue this text exactly as written," and generates a continuation.
3. **Derives a fake log-probability from generation timing:** `avgLogProb = -log(msPerEvalToken / msPerPromptToken)` — i.e. the ratio of generation-token latency to prompt-eval latency.
4. Converts to `estimatedPerplexity = exp(-avgLogProb)`.
5. Blends in a Jaccard bigram-similarity heuristic between generated and expected text: `adjustedPerplexity = estimatedPerplexity * (2 - similarity)`.

This number is **latency-derived**, not likelihood-derived. Token generation latency is dominated by model size, hardware, batch state, and thermal throttling — none of which are quantization-quality signals. A faster GPU produces a lower "perplexity" under this method; a quantized model that happens to eval faster would appear *better* than f16, which is the opposite of the truth. The metric is not merely unrigorous; it is **inversely misleading** for the exact comparison (KV cache quantization) it is the project's stated differentiator for.

This is exposed to users today at:
- `POST /api/perplexity/estimate` (routes.ts:394)
- `POST /api/perplexity/compare` (routes.ts:414)

And its results flow into comparison reports. Shipping a false metric under the perplexity label is the textbook credibility-destroying failure mode for a *measurement* tool — and it is already shipping, which makes this a **removal + replacement** task, not a green-field addition.

### The README compounds the problem

The README's KV cache quality table asserts qualitative claims — "Very small" for q8_0, "Small-medium" for q4_0 — **without any measurement existing in the codebase** (the existing `perplexity.ts` cannot back these claims; it produces a latency-derived number). Those labels are currently sourced from Ollama's own documentation, repeated without independent verification. For a project explicitly positioned to *evaluate* inference quality trade-offs in a sovereignty-conscious, public-sector-adjacent context (DjimIT advisory, IVO-Rechtspraak environment), this is the one place where rigor cannot be optional.

## What Changes

- **Remove** the existing `services/perplexity.ts` timing-proxy implementation and its `REFERENCE_CORPORA` hand-written paragraphs. It is a liability, not a base to build on.
- **Replace** with a fully specified benchmark methodology:
  - **Fixed, versioned, content-hash-pinned evaluation corpus**: WikiText-2 (raw, test split, ~245K tokens) as the primary corpus — the de facto standard for LLM perplexity in the quantization literature (used by GPTQ, AWQ, and llama.cpp's own `perplexity` tool), which makes Inference Forge's numbers comparable to published research rather than isolated. An optional secondary Dutch-language corpus for the project's public-sector-NL context, explicitly labeled exploratory until validated.
  - **Exact NLL computation**: sliding-window negative log-likelihood with stride < context length, scoring only the non-overlapping "new" portion of each window (matching llama.cpp's `perplexity` binary methodology, so numbers are cross-checkable against an independent reference implementation — this cross-check IS the validation step).
  - **Confidence reporting, not point estimates**: perplexity reported with an uncertainty interval computed via Gaussian error propagation over per-token logit error (matching llama.cpp's reference methodology exactly), never a bare float.
- **Consume `InferenceBackend.getLogProbs()`** (defined in proposal 01) rather than calling `ollama.generate()` directly. This is the hard dependency that sequences 02 after 01 — and it means perplexity becomes capability-gated on `supportsLogProbs`, not Ollama-specific.
- **Replace the README quality table** with either measured values once this lands, or an explicit "not independently verified — source: Ollama/llama.cpp documentation, see [link]" disclaimer until it does. The interim state must not repeat the false-precision problem while the real fix is in progress.
- **Embed full methodology metadata** (corpus id + hash, context length, stride, segment count, uncertainty method, comparability caveat) in every exported benchmark report, so any exported result is self-documenting and reproducible by a third party without reading source code.

## Impact

- **Affected specs:** `perplexity-benchmark-methodology` (new capability), MODIFIES the existing `perplexity` capability surface (the `/api/perplexity/*` routes change semantics — they now return real measurements, not latency-derived estimates; this is a breaking change to those route responses, acceptable because 0 stars and the current output is wrong).
- **Affected code:**
  - `packages/server/src/services/perplexity.ts` — **deleted and rewritten** as `packages/server/src/core/perplexity/` module
  - `packages/server/src/api/routes.ts` lines 394-435 (`/api/perplexity/estimate`, `/api/perplexity/compare`) — response schema changes to include uncertainty + methodology metadata
  - `components/BenchmarkRunner.tsx` — display CI alongside point estimate
  - `README.md` KV cache quality table — flagged provisional as interim mitigation (Task 0.1, do immediately regardless of when the rest lands)
- **Affected docs:** `README.md` quality table; new `docs/validation/perplexity-cross-check.md` (permanent cross-validation evidence).

## Rejected Alternatives

1. **"Keep the existing `perplexity.ts` and refine the timing proxy."** Rejected: the timing proxy is not a rough approximation of perplexity, it is an unrelated quantity (latency ratio) wearing perplexity's label. Refining it preserves the false-metric problem. The only correct action is removal and replacement with actual NLL computation.
2. **"Use a smaller, custom prompt set instead of WikiText-2."** Rejected: the current `REFERENCE_CORPORA` (three short paragraphs) is already this mistake. Custom prompt sets produce numbers comparable to nothing. WikiText-2 is the standard precisely because it enables cross-tool, cross-paper comparability.
3. **"Skip the cross-check against llama.cpp's reference `perplexity` tool."** Rejected: without an independent reference implementation, a bug in IF's NLL computation would silently produce wrong-but-plausible numbers indefinitely — exactly the failure mode the current `perplexity.ts` already demonstrates is possible. The cross-check is the only thing that makes "we computed this correctly" falsifiable rather than asserted.
4. **"Ship the vague 'estimation' as originally scoped and refine later."** Rejected: it has already shipped, and it is already wrong. This is precisely the anti-pattern the proposal exists to fix.
