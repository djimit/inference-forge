# Tasks: Rigorous Perplexity Benchmark

File-level checklist. Task 0 is a cheap interim mitigation decoupled from the rest — do it now regardless.

## 0. Immediate, cheap interim mitigation (do this regardless of when the rest lands)
- [ ] 0.1 Add "not independently verified — source: Ollama/llama.cpp documentation" disclaimer to README KV cache quality table NOW, as a one-line doc fix
- [ ] 0.2 Link to the upstream source for the existing qualitative claims ("Very small" / "Small-medium")
- [ ] 0.3 Add a "the current `/api/perplexity/*` numbers are latency-derived and not true perplexity" note to the README until proposal 02 lands, so users are not misled by the already-shipped false metric

## 1. Removal (do first — the existing proxy is a liability, not a base)
- [ ] 1.1 Delete `packages/server/src/services/perplexity.ts` (the timing-proxy implementation and its `REFERENCE_CORPORA` paragraphs)
- [ ] 1.2 Remove `import { perplexity }` from `packages/server/src/api/routes.ts` (line 13)
- [ ] 1.3 Remove or stub the `/api/perplexity/estimate` (routes.ts:394) and `/api/perplexity/compare` (routes.ts:414) handlers returning HTTP 501 "perplexity under reimplementation — see proposal 02" until the real implementation lands, so no false metric is served in the interim
- [ ] 1.4 Remove any dashboard component wiring that calls `/api/perplexity/*` and hides the panel until 02 ships

## 2. Corpus integration
- [ ] 2.1 Vendor or fetch-and-cache WikiText-2-raw test split under `packages/server/src/core/perplexity/corpora/`
- [ ] 2.2 Pin SHA-256 hash as a constant; implement integrity check on load; refuse to run on hash mismatch
- [ ] 2.3 Tokenize corpus per active model's tokenizer (tokenization is model-specific — per benchmark run, not once globally)
- [ ] 2.4 Add optional secondary Dutch-language corpus (clearly labeled exploratory, not load-bearing)

## 3. NLL computation core (`packages/server/src/core/perplexity/`)
- [ ] 3.1 Implement sliding-window NLL computation consuming `InferenceBackend.getLogProbs()` (NOT `ollama.generate` directly)
- [ ] 3.2 Implement Gaussian error-propagation uncertainty calculation over per-token logit error, matching llama.cpp's reference methodology exactly (not segment-variance approximation)
- [ ] 3.3 Hold context length + stride constant across compared KV cache types within a single benchmark session; reject configs that vary them
- [ ] 3.4 Match BOS/EOS handling to llama.cpp's reference (prepend BOS where expected; do not add EOS to scoring)
- [ ] 3.5 Implement cross-tool comparability caveat as a standard field attached to every result, not optional

## 4. Backend logprob extraction (cross-reference proposal 01)
- [ ] 4.1 Resolve exact Ollama API mechanism for per-token actual-token logprobs — verify against current Ollama version (flagged risk from design.md). If the running version does not expose actual-token logprobs, set `OllamaBackend.supportsLogProbs=false` and hide the perplexity feature rather than shipping a false number
- [ ] 4.2 Confirm `InferenceBackend.getLogProbs()` (defined in proposal 01) returns `LogProbResult { tokens, logProbs[] }` with the *actual next token's* logprob, not top-k only
- [ ] 4.3 Set `supportsLogProbs=true` on `OllamaBackend` once verified
- [ ] 4.4 Verify LM Studio logprob semantics (proposal 01 open question) and set `LmStudioBackend.supportsLogProbs` accordingly

## 5. Cross-validation against llama.cpp reference
- [ ] 5.1 Build/install llama.cpp `perplexity` binary for reference comparison — **accepted prerequisite** (stakeholder decision 2026-06-20): the binary MUST be buildable/runnable in the deployment environment. If unavailable, the capability is not released in that environment (Task-0 disclaimer stays the only published statement). Gate the "trustworthy" acceptance criterion on this.
- [ ] 5.2 Run identical benchmark (same GGUF, same context/stride, same corpus) through both implementations
- [ ] 5.3 Document comparison results in `docs/validation/perplexity-cross-check.md` (checked in, permanent)
- [ ] 5.4 If results diverge beyond floating-point tolerance, debug the IF implementation — do not adjust the reference methodology to force agreement
- [ ] 5.5 Repeat on at least 2 model architectures (e.g. llama-family + qwen-family) to ensure the match isn't architecture-specific

## 6. API surface (new, replacing the deleted handlers)
- [ ] 6.1 Reimplement `POST /api/perplexity/estimate` returning `{ perplexity, perplexity_uncertainty, tokens_scored, methodology, comparability_note }`
- [ ] 6.2 Reimplement `POST /api/perplexity/compare` returning the same per-KV-cache-type with constant context/stride enforcement
- [ ] 6.3 Return HTTP 501 with `code: 'CAPABILITY_NOT_SUPPORTED'` when the active backend has `supportsLogProbs=false`

## 7. UI and export
- [ ] 7.1 Update `BenchmarkRunner.tsx` to display CI alongside point estimate, never bare
- [ ] 7.2 Add low-segment-count / low-token warning UI state (per spec: warn when < 10,000 scored tokens)
- [ ] 7.3 Hide the perplexity panel entirely when no active backend has `supportsLogProbs=true`
- [ ] 7.4 Update JSON export schema with full methodology metadata block
- [ ] 7.5 Update PDF export (if implemented per roadmap) with same metadata + caveat

## 8. Documentation
- [ ] 8.1 Replace README quality table with measured data once available, OR keep the Task-0 disclaimer if measurement isn't yet trustworthy enough to publish
- [ ] 8.2 Write up methodology explanation for `docs/perplexity-methodology.md` so the procedure is documented independent of source code
- [ ] 8.3 Add the cross-tool non-comparability caveat to README and every exported report
