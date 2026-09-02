# Spec Delta: `inference-backend-contract`

**Type:** ADDED (new capability)

## ADDED Requirements

### Requirement: Backend Selection
The system SHALL select its set of active inference backend implementations at startup based on the `INFERENCE_BACKENDS` environment variable (comma-separated), defaulting to `ollama` alone when unset or unrecognized values are present.

#### Scenario: Default backend on unset config
- **WHEN** the server starts with no `INFERENCE_BACKENDS` environment variable set
- **THEN** the system SHALL instantiate only the `OllamaBackend` adapter
- **AND** existing Ollama-dependent behavior SHALL be unchanged from pre-refactor behavior

#### Scenario: Multiple backends selected
- **WHEN** `INFERENCE_BACKENDS=ollama,lmstudio` is set
- **THEN** the system SHALL instantiate both adapters and register both in the `BackendRegistry`
- **AND** `/api/registry/backends` SHALL report both as separate `BackendStatus` entries

#### Scenario: Explicit backend selection fails health check
- **WHEN** `INFERENCE_BACKENDS=llamacpp` is set
- **THEN** the system SHALL instantiate the `LlamaCppBackend` adapter
- **AND** SHALL fail fast at startup with a clear error if that adapter's `healthCheck()` fails, rather than failing silently on first request

### Requirement: Adapter Boundary Enforcement
The system SHALL NOT permit any module outside an adapter's own directory to import directly from that adapter directory; all cross-module access SHALL go through the `InferenceBackend` interface in `core/`.

#### Scenario: Static import boundary violation
- **WHEN** the CI lint step runs
- **THEN** it SHALL fail the build if any file in `services/`, `api/`, or `ws/` imports a symbol from `adapters/ollama/` or `adapters/lmstudio/` instead of from `core/InferenceBackend`

### Requirement: Capability Gating
The system SHALL expose a `BackendCapabilities` descriptor for each active backend, and all service-layer code SHALL check capability flags before invoking optional backend methods (`getLogProbs`, `exportModelfile`, `loadModel`, `unloadModel`).

#### Scenario: Calling unsupported optional capability
- **WHEN** a service calls `exportModelfile()` against a backend whose `capabilities.supportsModelfileExport` is `false` (e.g. LM Studio)
- **THEN** the system SHALL throw `CapabilityNotSupportedError`
- **AND** the API layer SHALL translate this into an HTTP 501 Not Implemented response with a machine-readable error code, not a generic 500

#### Scenario: UI capability-aware rendering
- **WHEN** the dashboard frontend receives `BackendCapabilities` for the active backend via `/api/health` or `/api/registry/backends`
- **THEN** the system SHALL hide or disable UI affordances for unsupported capabilities (e.g. the Modelfile editor SHALL be disabled when the only active backend has `supportsModelfileExport=false`) rather than allowing the user to trigger a request that will fail

### Requirement: Error Normalization
The system SHALL normalize all backend-adapter errors into the shared `BackendError` hierarchy (with a machine-readable `code` field) before they propagate beyond the adapter boundary.

#### Scenario: Backend connection failure
- **WHEN** the active backend's HTTP endpoint is unreachable
- **THEN** the adapter SHALL throw `BackendUnavailableError`, not a raw network exception
- **AND** the WebSocket monitoring stream SHALL emit a typed `backend_unavailable` event rather than silently stopping metric updates

#### Scenario: Missing model
- **WHEN** a generation request targets a model id that does not exist on the active backend
- **THEN** the adapter SHALL throw `ModelNotFoundError` regardless of the backend's native error shape (Ollama plain-text 404 vs LM Studio JSON error)

### Requirement: Registry Consolidation
The system SHALL produce a unified model view by iterating registered `InferenceBackend` adapters and normalizing their native model descriptors into the shared `ModelInfo` shape, rather than by hand-merging backend-specific types.

#### Scenario: Adding a third backend
- **WHEN** a new adapter is added (e.g. `LlamaCppBackend`) and registered in `BackendFactory`
- **THEN** the registry SHALL include its models in `listAvailableModels()` results automatically
- **AND** no change to `model-registry.ts`, `route-advisor.ts`, or the `Backend` type SHALL be required (the falsifiable test that the abstraction is real)
