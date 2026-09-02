# Design: Rigorous Perplexity Benchmark

## Why the existing `perplexity.ts` must be deleted, not refined

For the record, the current `services/perplexity.ts` computes:

```
avgLogProb        = -log(msPerEvalToken / msPerPromptToken)
estimatedPerplexity = exp(-avgLogProb)
adjustedPerplexity   = estimatedPerplexity * (2 - bigramSimilarity)
```

`msPerEvalToken / msPerPromptToken` is a ratio of two latencies. It has no information-theoretic relationship to `log P(token | context)`. Two consequences make it actively harmful rather than merely unrigorous:

1. **Wrong sign for the intended use case.** KV cache quantization (q4_0/q8_0) typically *changes inference latency*. Under this formula, a faster quantized run yields a *lower* "perplexity," so the method can report q4_0 as higher quality than f16 — the opposite of the truth, and exactly the comparison the tool exists to evaluate.
2. **Hardware-conditional.** The same model on the same corpus produces a different number on different hardware (GPU vs CPU, thermal-throttled vs cool). A quality metric that changes with the machine it runs on is not a quality metric.

It is therefore removed wholesale. None of its logic is reused.

## The Measurement Procedure (precisely specified)

Perplexity over a tokenized corpus is defined as:

$$
\text{PPL} = \exp\left(-\frac{1}{N}\sum_{i=1}^{N} \log P(t_i \mid t_{<i})\right)
$$

where $N$ is the total number of tokens evaluated and $P(t_i \mid t_{<i})$ is the model's predicted probability of the actual next token given preceding context, obtained from the backend via `InferenceBackend.getLogProbs()` (proposal 01).

### Sliding window, not naive chunking

Naive non-overlapping chunking under-evaluates because early tokens in each chunk have artificially little context. The standard correction (llama.cpp's `perplexity` tool, the GPT-2/GPT-3 evaluation methodology) is a **sliding window with stride < context length**, scoring only the tokens in the non-overlapping "new" portion of each window using the full preceding context:

- **Context length:** matches the model's configured `num_ctx` for the benchmark run. **Held constant** across f16/q8_0/q4_0 within a single benchmark session — comparing different context lengths across quantization levels confounds the KV-cache-quality signal with a context-length signal, invalidating the comparison.
- **Stride:** `context_length / 2` (standard choice balancing compute cost against evaluation thoroughness; configurable for advanced use).
- **BOS/EOS handling:** matched to llama.cpp's reference (prepend BOS where the model expects it; do not add EOS to scoring). This is an implementation detail that materially changes the number, which is why matching the reference exactly matters for cross-validation.

### Corpus

WikiText-2-raw, test split (~245,770 tokens for Llama tokenizer). Pinned by **content hash**, not just filename, and vendored or fetched-and-cached on first run with the hash logged. "WikiText-2" without a content hash is not actually a fixed reference — multiple preprocessed variants circulate (raw vs tokenized vs cleaned), and they produce different perplexity numbers.

The current `REFERENCE_CORPORA` map (3 hand-written paragraphs) is deleted. There is no path to a credible measurement from a ~200-word corpus; the corpus must be large enough for the uncertainty estimate to be meaningful (see below).

### Output: confidence interval, not a bare float

llama.cpp's reference implementation computes uncertainty empirically by assuming a Gaussian distribution of the per-token logit error and applying error propagation across the full token sequence — not a naive standard-deviation-across-coarse-segments approach. Inference Forge's implementation SHALL match this method exactly (not an approximation of it), both because it is the more statistically defensible choice and because matching it is what makes the cross-validation step meaningful — comparing two different uncertainty methodologies would not actually validate anything.

Report format:

```
PPL = 6.42 ± 0.08 (n=28,672 tokens scored)
```

rather than `PPL = 6.42`. The uncertainty is the only thing that tells the user whether a 0.1 PPL difference between q8_0 and q4_0 is a real quality delta or noise.

**Important caveat, stated explicitly:** llama.cpp's own documentation is direct — perplexity numbers are not directly comparable across different tools or implementations, because exact values depend on tokenization, BOS/EOS handling, and windowing details. Inference Forge's numbers are valid for **within-tool, within-session comparison** (f16 vs q8_0 vs q4_0 for the same model, same run) and for **cross-validation against llama.cpp specifically** (methodology deliberately matched) — not as figures directly comparable to other harnesses. The README, UI, and every exported report SHALL carry this caveat.

## Validation Against Independent Reference

Before this feature is considered trustworthy enough to expose a number to end users:

1. Run Inference Forge's NLL computation against a small GGUF model (e.g. a 1B-parameter model for fast iteration) on WikiText-2.
2. Run llama.cpp's own `perplexity` binary against the identical GGUF file, identical context length and stride.
3. Compare. They should agree within floating-point tolerance (~3-4 significant figures; the only legitimate divergence is f16/f32 accumulation order).
4. Document the comparison run (model, both outputs, diff) in `docs/validation/perplexity-cross-check.md` as permanent evidence, checked into the repo — not a one-time manual sanity check that leaves no trace.

If step 3 fails, the bug is in Inference Forge's implementation, full stop — llama.cpp's reference is the ground truth here, given its maturity and broad adoption as the de facto standard for this exact measurement in the quantization community.

## Backend Capability Resolution

Per proposal 01 (now resolved): `getLogProbs()` is a **scoring contract** — the caller supplies the corpus window text and the backend returns `log P(token_i | token_<i)` for each *provided* token. No sampling. This sidesteps the "actual-token vs top-k" question by construction: the actual token is the token the caller supplied.

Per-backend scoring mechanism:

- **Ollama** — `/api/generate` with `num_predict: 0` and eval-logprobs enabled; read per-prompt-token logprobs of the actual prompt tokens. Verify the exact request/response field against the running Ollama version before setting `OllamaBackend.supportsLogProbs = true`. If unavailable, `supportsLogProbs = false` and perplexity is hidden — preferable to a false number (the explicit lesson from the deleted `perplexity.ts`).
- **LM Studio** — `/v1/completions` (completions, NOT chat) with `echo: true`, `logprobs: 0`, `max_tokens: 0`; the OpenAI completions spec returns per-prompt-token `token_logprobs` of the echoed tokens. Confirm the running LM Studio build fully implements this before setting `LmStudioBackend.supportsLogProbs = true`; otherwise `false` and perplexity is Ollama-only.
- **vLLM** (future adapter) — OpenAI-compatible `/v1/completions` with `echo` + `logprobs`; same scoring semantics.
- **llama.cpp-server** (future adapter) — `/completion` with `n_probs`.

The capability flag exists so a future hosted-API adapter that doesn't expose scoring logprobs degrades gracefully (UI hides the perplexity feature) instead of crashing or — worse — emitting a wrong number.

## Cross-Validation Runtime Prerequisite (accepted)

Per stakeholder decision (2026-06-20): the llama.cpp `perplexity` reference binary is a **documented prerequisite** for the "trustworthy" acceptance criterion, not optional. Task 5.1 in tasks.md gates release of this capability on a local `perplexity` binary being buildable/runnable in the deployment environment. If it is not available in a given environment, this capability is not considered trustworthy enough to release there; the interim Task-0 disclaimer remains the only published statement. This is the proportionate call: a measurement tool whose measurement cannot be independently cross-checked is not yet a measurement tool.

## Statistical Reporting in Exported Results

Exported JSON includes:

```json
{
  "methodology": {
    "corpus": "wikitext-2-raw-test",
    "corpus_sha256": "...",
    "context_length": 4096,
    "stride": 2048,
    "tokens_scored": 28672,
    "uncertainty_method": "gaussian_error_propagation",
    "comparability_note": "Valid for within-tool comparison and llama.cpp cross-validation only; not guaranteed comparable to other harnesses."
  },
  "results": [
    {
      "kv_cache_type": "q8_0",
      "perplexity": 6.42,
      "perplexity_uncertainty": 0.08,
      "tokens_per_second": 47.3,
      "vram_delta_bytes": 4290772992
    }
  ]
}
```

This makes every exported report independently auditable — a third party (or a future version of Inference Forge itself) can verify the claim without re-running the benchmark, because the methodology travels with the data.

## Migration: replacing the existing `/api/perplexity/*` routes

The current routes (`routes.ts:394` `/api/perplexity/estimate`, `routes.ts:414` `/api/perplexity/compare`) return `PerplexityResult`/`PerplexityComparison` shapes built from the timing proxy. These response schemas change to include `perplexity_uncertainty`, `methodology`, and the `comparability_note`. This is a breaking change to those route responses — acceptable because (a) 0 stars / no external consumers, and (b) the current output is wrong, so backward compatibility would be preserving a bug. The new `PerplexityResult` type lives in `core/perplexity/`, not `services/perplexity.ts` (which is deleted).

## Validation / Acceptance

- [ ] `services/perplexity.ts` is deleted; no timing-derived "perplexity" code remains in the repo
- [ ] NLL computation matches llama.cpp reference implementation within documented tolerance on at least 2 different model architectures (e.g. llama + qwen)
- [ ] Uncertainty values (Gaussian error propagation, matching llama.cpp methodology) are computed and displayed for every perplexity result — no bare point estimates anywhere in UI or export
- [ ] Every displayed or exported perplexity value carries the cross-tool comparability caveat
- [ ] README quality-impact table is either replaced with measured data or explicitly marked provisional with a source citation — no unsourced claims remain
- [ ] Corpus is content-hash-pinned and the hash is logged on every benchmark run; a hash mismatch refuses to run
- [ ] Perplexity feature is hidden in the UI when the active backend has `supportsLogProbs=false`
- [ ] Cross-validation evidence persisted in `docs/validation/perplexity-cross-check.md`
