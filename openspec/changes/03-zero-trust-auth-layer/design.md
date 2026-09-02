# Design: Authentication & Authorization Layer

## Threat Model (scoped, not generic)

This is explicitly NOT a general web-application security threat model. It targets the specific exposure profile of Inference Forge, mapped to the **actual** 60+ route surface in `api/routes.ts`:

| Asset (route) | Exposure without auth | Severity |
|---|---|---|
| Model inventory (`GET /models`, `/models/running`, `/registry`) | Information disclosure: what models, what sizes, what use cases configured — reveals capability/intent | Low-Medium |
| Hardware + VRAM telemetry (`GET /hardware`, `/hardware/last`, `/hardware/history`, WS `hardware` stream) | Reconnaissance: hardware fingerprinting (GPU type inferable from VRAM patterns) | Medium |
| Metrics/throughput/pressure (`GET /metrics`, `/throughput`, `/pressure`, WS streams) | Operational pattern disclosure | Low-Medium |
| Trigger inference (`POST /sessions/:id/message`, `/sessions/:id/message/stream`, `/benchmark/run`, `/io/benchmark`, `/profiles/run`) | Resource exhaustion: unauthenticated actor saturates GPU/CPU; on metered/cloud-burst setups, cost impact; prompt-data exfiltration risk | Medium-High |
| Pull model (`POST /models/pull`) | Supply-chain + disk fill: unauthenticated actor pulls arbitrary models from a registry, consuming disk/bandwidth | Medium-High |
| Mutate config / state (`PUT /alerts/thresholds/:id`, `POST /prompts`, `PUT /templates/:id`, `DELETE /templates/:id`, `POST /route/policies`) | Integrity: unauthenticated config/state tampering | High |
| Create model / generate Modelfile (`POST /templates/:id/create`, `/modelfile/generate`, `/modelfile/generate-auto`) | Integrity: unauthenticated model creation — this is the highest-blast-radius write surface today, and the literal reason proposal 04 gates Modelfile Studio | High |
| Workflow/agent execution (`POST /workflows/:id/execute`, `/agents`) | Integrity + resource: unauthenticated multi-agent orchestration | High |

The token-based MVP addresses all of these directly. RBAC (deferred) would only add value once there's a need to differentiate *which* authenticated actors can do *which* of these — not before.

## Startup Guard Logic

The current code in `index.ts`:

```ts
server.listen(PORT, HOST, () => {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`[Security] Inference Forge is bound to ${HOST}. ...`);
  }
  console.log(`... banner ...`);
});
```

This is replaced by a guard that runs **before** `server.listen()`:

```ts
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_MODE = process.env.AUTH_MODE || 'none';   // 'none' | 'token'
const authToken = process.env.AUTH_TOKEN;

const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost';

if (!isLoopback && AUTH_MODE === 'none') {
  console.error(
    'FATAL: Inference Forge is configured to bind to a non-loopback address ' +
    `(${HOST}) with AUTH_MODE=none. This would expose an unauthenticated API ` +
    'to the network. Set AUTH_MODE=token and AUTH_TOKEN=<secret>, or bind to ' +
    '127.0.0.1. Refusing to start.'
  );
  process.exit(1);
}

if (AUTH_MODE === 'token' && !authToken) {
  console.error('FATAL: AUTH_MODE=token requires AUTH_TOKEN to be set. Refusing to start.');
  process.exit(1);
}

// also: token strength check (min length) to prevent trivial tokens like 'a'
if (AUTH_MODE === 'token' && authToken && authToken.length < 16) {
  console.warn('[Security] AUTH_TOKEN is shorter than 16 chars — weak.');
}
```

This is the single most important piece of this proposal: it converts "developer forgot to read the README warning" into "server won't start." A warning in documentation is not a control; a startup guard is.

## Token Scheme

- Bearer token via `Authorization: Bearer <token>` header on all REST routes.
- Compared using constant-time comparison (`crypto.timingSafeEqual` in Node), not `===`, to avoid timing-attack token recovery — the kind of detail that separates "looks like auth" from "is auth."
- Token stored as a single value in `AUTH_TOKEN` env var for the MVP (`AUTH_MODE=token`).
- Token is never logged, even at debug level — audit log entries reference a hashed/truncated token identifier (first 8 chars of SHA-256 of the token) for traceability without storing the secret in logs.

### The two non-trivial cases

1. **SSE route (`POST /models/pull`, `routes.ts:165`)**: validate the bearer token in middleware *before* the handler sets `Content-Type: text/event-stream` and writes the first `data:` frame. A 401 mid-stream is indistinguishable from a stream error to a naive EventSource client, so auth must complete before the stream opens.
2. **WebSocket (`/ws`, `ws/handler.ts`)**: browsers cannot set arbitrary headers on a WS upgrade request. Validate the token at handshake via either:
   - a `?token=...` query parameter (simplest; appears in server logs unless explicitly scrubbed — must be scrubbed), or
   - the `Sec-WebSocket-Protocol` subprotocol header carrying the token (cleaner, doesn't appear in default access logs).

   The connection SHALL be rejected (upgrade aborted) before the WS session is established — not closed after. The existing `wss.on('connection', ...)` handler runs only on accepted connections, so the validation hook goes on `wss.on('headers', ...)` or via a custom `verifyClient` option on `WebSocketServer`.

## Audit Log Schema

```typescript
interface AuditLogEntry {
  timestamp: string;          // ISO 8601
  actorTokenHash: string;    // first 8 chars of SHA-256(token), never the raw token
  action: 'model.generate' | 'model.pull' | 'model.load' | 'model.unload'
        | 'benchmark.run' | 'modelfile.write' | 'template.write' | 'policy.write'
        | 'agent.create' | 'session.message' | 'workflow.execute' | 'auth.denied';
  resourceId?: string;       // model id / template id / session id affected
  outcome: 'success' | 'denied' | 'error';
  sourceIp?: string;
}
```

Written to a local append-only log file (rotated), not just console output — console logs are ephemeral and typically not retained, which defeats the audit purpose. Structured JSON lines so the format is SIEM-exportable later without a rewrite (proportionate for this maturity; full SIEM integration is a future concern, not this proposal).

The audit writer is wired at the service-call sites for state-mutating actions (the routes enumerated in the threat model), not by a generic HTTP logger — because the audit requirement is "who triggered which *meaningful* action," not "every GET."

## Why Not Just Document the Risk and Move On

A reasonable objection: this is a 0-star OSS dev tool, is full auth proportionate? Yes, conditionally — proportionate to the *intended* deployment trajectory, not the *current* star count. The roadmap names "Remote instance management" as a future goal, and the project's context (DjimIT sovereign AI advisory, IVO-Rechtspraak public-sector environment) means this tool's credibility as something Dennis might reference or deploy in a professional advisory context is directly undermined if it ships with a known, documented, unaddressed access-control gap. The existing `console.warn` in `index.ts` is itself evidence that the exposure was recognized but not controlled — this proposal finishes that thought.

## Validation / Acceptance

- [ ] Server refuses to start (exit non-zero) when `HOST` is non-loopback and `AUTH_MODE=none` — verified by test
- [ ] Server refuses to start when `AUTH_MODE=token` and `AUTH_TOKEN` unset — verified by test
- [ ] REST request without/with-wrong token returns 401 when `AUTH_MODE=token`; valid token succeeds
- [ ] WebSocket handshake without/with-wrong token is rejected before upgrade; valid token connects
- [ ] SSE route (`/models/pull`) returns 401 before opening the stream when token is missing
- [ ] Token comparison uses a constant-time function (verified by test asserting no early-return path)
- [ ] Raw token string never appears in any log output across the test suite (grep-based assertion)
- [ ] Audit log entry written for every state-mutating action with hashed actor identity, action, outcome
- [ ] Default localhost-only deployment requires zero new configuration — `AUTH_MODE=none` + loopback HOST remains friction-free
