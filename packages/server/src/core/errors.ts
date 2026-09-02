/**
 * Shared backend error hierarchy.
 *
 * Every adapter MUST normalize its native errors (HTTP 404 plain-text from
 * Ollama, structured JSON errors from LM Studio's OpenAI-compatible server,
 * ECONNREFUSED, timeouts, etc.) into this hierarchy before they cross the
 * adapter boundary. Without normalization, every consumer of `InferenceBackend`
 * would have to know which adapter it is talking to in order to parse errors —
 * which defeats the abstraction (see openspec proposal 01).
 *
 * Design note: the `code` field is machine-readable and stable across backends,
 * so API-layer translation (HTTP status + error code) and audit logging can
 * branch on `code` rather than `instanceof` against adapter-private classes.
 */

export type BackendErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'BACKEND_TIMEOUT'
  | 'GENERATION_FAILED'
  | 'BACKEND_ERROR'; // catch-all for backend errors that don't fit a more specific code

export abstract class BackendError extends Error {
  abstract readonly code: BackendErrorCode;
  readonly backend: string;

  constructor(message: string, backend: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.backend = backend;
  }
}

/** Connection refused, backend not running, host unreachable. */
export class BackendUnavailableError extends BackendError {
  readonly code = 'BACKEND_UNAVAILABLE' as const;
}

/** The requested model id does not exist on this backend. */
export class ModelNotFoundError extends BackendError {
  readonly code = 'MODEL_NOT_FOUND' as const;
}

/**
 * An optional, capability-gated method was called on an adapter that does not
 * support it (e.g. `exportModelfile` on LM Studio, `getLogProbs` on a backend
 * without logprob support). Callers MUST check `capabilities` first; this error
 * is the defense-in-depth when they don't.
 */
export class CapabilityNotSupportedError extends BackendError {
  readonly code = 'CAPABILITY_NOT_SUPPORTED' as const;
  readonly capability: string;

  constructor(backend: string, capability: string, options?: ErrorOptions) {
    super(
      `Backend "${backend}" does not support capability "${capability}".`,
      backend,
      options,
    );
    this.capability = capability;
  }
}

/** A backend operation exceeded its timeout. */
export class BackendTimeoutError extends BackendError {
  readonly code = 'BACKEND_TIMEOUT' as const;
}

/** Generation started but the backend reported an error mid-stream. */
export class GenerationFailedError extends BackendError {
  readonly code = 'GENERATION_FAILED' as const;
}

/** Catch-all for backend errors that don't fit a more specific code. */
export class BackendOperationError extends BackendError {
  readonly code = 'BACKEND_ERROR' as const;
}
