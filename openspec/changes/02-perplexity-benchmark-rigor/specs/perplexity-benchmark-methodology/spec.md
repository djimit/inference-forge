# Spec Delta: `perplexity-benchmark-methodology`

**Type:** ADDED (new capability), MODIFIES existing `/api/perplexity/*` route semantics (breaking, acceptable — 0 consumers, current output is wrong), DELETES the existing `services/perplexity.ts` timing-proxy behavior.

## DELETED Behavior

### Requirement: Removal of Latency-Derived "Perplexity"
The system SHALL NOT compute or expose any value labeled "perplexity" that is derived from generation timing, token latency, or text-similarity heuristics. The existing `services/perplexity.ts` implementation (`avgLogProb = -log(msPerEvalToken / msPerPromptToken)` blended with bigram similarity) is removed.

#### Scenario: No latency-derived metric remains
- **WHEN** the proposal is merged
- **THEN** the repository SHALL contain no code path that produces a "perplexity" value from latency ratios or similarity scores
- **AND** the `/api/perplexity/*` routes SHALL either be absent or return genuine NLL-derived measurements

## ADDED Requirements

### Requirement: Fixed Reference Corpus
The system SHALL compute perplexity using a content-hash-pinned, versioned evaluation corpus, defaulting to WikiText-2-raw test split, and SHALL refuse to run against a corpus whose hash does not match the pinned reference.

#### Scenario: Corpus integrity verification
- **WHEN** a perplexity benchmark run begins
- **THEN** the system SHALL verify the local corpus file's SHA-256 hash matches the pinned reference value
- **AND** SHALL refuse to run and emit a clear error if the hash does not match, rather than silently scoring against a corrupted or substituted corpus

### Requirement: Sliding Window NLL Computation
The system SHALL compute negative log-likelihood using a sliding window with stride strictly less than context length, scoring only the non-overlapping new portion of each window, and SHALL hold context length and stride constant across compared KV cache types within a single benchmark run.

#### Scenario: Context length held constant across comparison
- **WHEN** a benchmark run compares multiple KV cache types (f16, q8_0, q4_0) for the same model
- **THEN** the system SHALL use an identical context length and stride across all compared configurations within that run
- **AND** SHALL reject a benchmark configuration that varies context length across compared KV cache types, since this would confound the comparison

### Requirement: Logprob Capability Gating
The system SHALL gate the perplexity feature on the active backend's `supportsLogProbs` capability and SHALL NOT attempt to compute perplexity against a backend that does not expose actual-token log-probabilities.

#### Scenario: Backend without logprobs
- **WHEN** the active backend has `supportsLogProbs=false`
- **THEN** the system SHALL return HTTP 501 with a machine-readable `CAPABILITY_NOT_SUPPORTED` code from the perplexity routes
- **AND** the dashboard SHALL hide the perplexity panel rather than present a disabled-but-clickable affordance

### Requirement: Statistical Confidence Reporting
The system SHALL report perplexity results with an uncertainty value computed via Gaussian error propagation over per-token logit error (matching llama.cpp's reference methodology), never as a bare point estimate.

#### Scenario: Insufficient tokens scored for reliable uncertainty
- **WHEN** the configured corpus or context length results in fewer than 10,000 scored tokens
- **THEN** the system SHALL warn the user that the uncertainty estimate is statistically unreliable
- **AND** SHALL still display the value (not suppress it) but with the warning attached, so the user is never shown false precision without context

### Requirement: Cross-Tool Comparability Disclaimer
The system SHALL NOT present its perplexity numbers as directly comparable to perplexity figures from other tools or published papers without an explicit caveat, consistent with the non-comparability documented by llama.cpp's own reference implementation.

#### Scenario: Displaying or exporting a perplexity result
- **WHEN** a perplexity result is displayed in the UI or included in an exported report
- **THEN** the system SHALL include a caveat stating the value is valid for within-tool, within-session comparison and for cross-validation against llama.cpp specifically, and is not guaranteed comparable to figures from other harnesses

### Requirement: Reproducible Export
The system SHALL embed full methodology metadata (corpus identifier, corpus hash, context length, stride, segment count, uncertainty method) in every exported benchmark report.

#### Scenario: Third-party verification of exported report
- **WHEN** a benchmark report is exported as JSON
- **THEN** it SHALL contain sufficient methodology metadata that an independent party could re-run the identical benchmark configuration without consulting the source code

### Requirement: Independent Reference Cross-Validation
The system's NLL computation SHALL be cross-validated against llama.cpp's `perplexity` reference implementation before being exposed to end users, and the validation evidence SHALL be persisted in the repository.

#### Scenario: Cross-validation evidence persisted
- **WHEN** the perplexity capability is considered ready for release
- **THEN** `docs/validation/perplexity-cross-check.md` SHALL exist in the repository
- **AND** SHALL contain the model, context/stride, both outputs, and the diff for at least 2 model architectures
- **AND** agreement SHALL be within floating-point tolerance (~3-4 significant figures)

## MODIFIED Requirements

### Requirement: KV Cache Quality Claims (supersedes the unsourced README table)
The system's documentation SHALL NOT present quantization quality-impact claims (e.g. "minimal quality loss") without either (a) a citation to measured benchmark data produced by this capability, or (b) an explicit disclaimer that the claim is sourced from upstream Ollama/llama.cpp documentation and has not been independently verified by Inference Forge.

#### Scenario: Interim state before measurement capability ships
- **WHEN** the perplexity benchmark capability has not yet produced measured data
- **THEN** the README's KV cache quality table SHALL carry an explicit "not independently verified" disclaimer with a source link
- **AND** SHALL NOT present the qualitative labels ("Very small," "Small-medium") as if they were Inference Forge's own measured conclusion
