# Design: Modelfile Studio Implementation (DRAFT — gated)

## Resolving the Backend-Agnostic Modelfile Abstraction

Proposal 04's open question was: does `InferenceBackend.exportModelfile()` remain an Ollama-specific optional capability (non-Ollama backends just don't support Modelfile Studio), or does the studio need a higher-level "model configuration profile" concept that each backend translates natively?

The resolution is **both, layered** — and the justification is that the apparent either/or conflates two independent axes:

### Axis 1 — Persistence modality (the real gap)

| Backend | Model configuration as… | Persistent portable artifact? |
|---|---|---|
| Ollama | Modelfile (FROM/PARAMETER/SYSTEM/TEMPLATE/ADAPTER) → `ollama create` | **Yes** — the Modelfile is a recipe you can share, version-control, re-create from |
| vLLM | Launch flags (`--model`, `--quantization`, `--max-model-len`, `--gpu-memory-utilization`, `--kv-cache-dtype`) | **No** — the config *is* the launch command, ephemeral |
| llama.cpp-server | Launch flags / CLI (`-m`, `-c`, `--kv-cache-dtype`, `-ngl`) | **No** — same, ephemeral |

The thing that makes "Modelfile" non-portable is not the text format — it's that Ollama has a *persistent artifact* concept and the others have *ephemeral launch configuration*. Treating them as the same kind of object produces a leaky abstraction either way.

### Axis 2 — Serialization vs application

Two distinct operations, often conflated under "export Modelfile":
- **Apply** = take an intent and make a backend run a model with it (Ollama `create`+load; vLLM launch with flags; llama.cpp-server launch).
- **Serialize-to-Modelfile** = produce Ollama's portable text artifact from an intent. Meaningful only where a portable artifact exists (Ollama).

### The two-layer resolution

**Layer 1 — `ModelConfigurationProfile` (backend-agnostic, the portable core):**

```typescript
// packages/server/src/core/model-config/ModelConfigurationProfile.ts
export interface ModelConfigurationProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  baseModel: string;           // canonical backend-prefixed, e.g. "ollama:llama3:8b"
  quantization?: string;       // profile-normalized vocab, gated by backend capability
  contextLength?: number;
  systemPrompt?: string;
  chatTemplate?: string;       // Ollama-specific in origin; null for backends w/o template concept
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';  // gated by supportsKvCacheQuantization
  inferenceParams: {           // backend-normalized superset; adapter ignores irrelevant fields
    temperature?: number;
    topP?: number;
    topK?: number;
    numGpuLayers?: number;
    // …adapter-translated to each backend's native param names
  };
  useCase?: 'chat' | 'coding' | 'analysis' | 'creative' | 'agent';
  notes?: string;
}
```

The Modelfile Studio UI edits **only** this. It is the artifact stored in the model library and the thing templates produce. It is portable across backends by construction (a profile targeting an Ollama base model can be re-pointed at an LM Studio equivalent by changing `baseModel`).

**Layer 2 — adapter operations on profiles:**

```typescript
// extension to InferenceBackend (from proposal 01)
export interface ApplyProfileResult {
  backend: string;
  appliedAs: 'modelfile_create' | 'launch_flags' | 'config_file';
  artifact?: string;           // the Modelfile text or launch-flags string produced
  loaded: boolean;
}

export interface InferenceBackend {
  // …existing methods…

  // Universal: translate profile -> backend's native mechanism. Every adapter implements this.
  applyProfile(profile: ModelConfigurationProfile): Promise<ApplyProfileResult>;

  // Capability-gated by supportsModelfileExport (Ollama: true; vLLM/llama.cpp-server: false).
  // Serializes the profile into Ollama Modelfile TEXT — the portable artifact.
  exportModelfile?(profile: ModelConfigurationProfile): Promise<string>;
}
```

Note: proposal 01's `exportModelfile` signature took `(modelId, params)`. This proposal **re-specs** it to take a `ModelConfigurationProfile` — the profile is the unit of configuration, not a bare model id. That is a deliberate delta to the `inference-backend-contract` spec, noted in proposal §Impact, and only lands after 01 is merged (so the interface already exists to be extended).

### Why this is the right cut (not either/or)

- The editor and the stored library are backend-agnostic (option b's benefit): a profile moves between backends; the editor never hardcodes Ollama semantics.
- Ollama's portable Modelfile is preserved as a first-class, capability-gated export (option a's benefit): users who want the shareable artifact get it; users on vLLM get launch-flags application instead, which is the honest representation of what that backend actually does.
- No speculative "universal model-definition format": vLLM/llama.cpp-server get `applyProfile` → launch flags, which is exactly what they natively support. We do not invent persistence they lack.
- The Modelfile-Studio-as-Ollama-companion risk from proposal 01 is structurally avoided: the editor's data model is the profile, and "Export as Modelfile" is a projection, not the core.

## Auth Integration (gate condition, not optional)

Per proposal 03 and gate 04: every Modelfile Studio write route (`POST /modelfile/generate`, `/modelfile/generate-auto`, `/templates/:id/create`, future `/profiles/apply`) is behind the bearer-token middleware from day one. The existing unauthenticated `/templates/:id/create` and `/modelfile/generate` routes — today's highest-blast-radius unauthenticated write surface (per 03's threat model) — are *replaced* by profile-based, auth-gated versions as part of this implementation. This is non-negotiable; it is the security half of the gate.

## Perplexity Advisory Integration (uses proposal 02, doesn't replace human judgment)

The editor surfaces the measured perplexity delta (from proposal 02's results) as advisory text when the user selects a KV cache type:

> "q4_0 KV cache: measured perplexity +X.XX ± Y.YY vs f16 on this model family (WikiText-2, n=…). See benchmark run <link>."

It does **not** auto-apply. The benchmark tool recommends; the human decides. This keeps the measurement/decision boundary clean (rejected-alternative 3).

## Validation / Acceptance (additional to the gate's 01-03 acceptance)

- [ ] `ModelConfigurationProfile` is the only artifact the editor and library store; no Ollama-Modelfile text is stored as the primary form
- [ ] `applyProfile` is implemented on Ollama *and* LM Studio adapters (LM Studio: profile → recommended launch flags / load-params; verify it doesn't claim a Modelfile it can't produce)
- [ ] `exportModelfile` is implemented only on Ollama, gated by `supportsModelfileExport`; calling it on LM Studio returns HTTP 501 `CAPABILITY_NOT_SUPPORTED`
- [ ] All Modelfile Studio write routes return 401 without a valid token (proposal 03's middleware applied) — verified by test
- [ ] A profile authored against an Ollama base model can be re-pointed to an LM Studio equivalent model by changing only `baseModel`, and `applyProfile` succeeds on both (the falsifiable test that the profile is actually backend-agnostic)
- [ ] Perplexity advisory is displayed (when proposal 02 data exists for the model+quant) but never auto-applies

## Why This Is a Draft, Not an Activation

The gate (04) is not passed: 01-03 are not merged, their acceptance criteria (live Ollama+LM Studio characterization, llama.cpp perplexity cross-validation, auth across 60+ routes) are not verified, and the repo cannot be committed from this environment. This design is written so the abstraction question is resolved *before* implementation begins (the gate's explicit requirement), not so implementation can start. When 01-03 are verified, 04 is archived and this proposal's status moves from "Draft — gated" to "In implementation".
