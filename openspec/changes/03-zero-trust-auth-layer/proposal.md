# Change Proposal: Authentication & Authorization Layer (Pre-Multi-Tenant Gate)

**Change ID:** `03-zero-trust-auth-layer`
**Status:** Draft — pending review
**Owner:** Dennis (DjimIT B.V.)
**Severity:** Compliance blocker for any deployment beyond single-user localhost. The repo already exposes a 60+ route API surface (including write-capable and resource-consuming endpoints) with only a post-startup `console.warn` as mitigation.
**Estimated effort:** 5–7 engineering days for token-based auth + audit logging across the existing 60+ routes incl. SSE streaming and WebSocket handshake; additional effort if RBAC granularity is required (see open question).
**Depends on:** None technically. Should land before `04-modelfile-studio-deferred` if that capability exposes any state-mutating action to a non-localhost deployment.

---

## Why

### The current "control" is a disclaimer that fires after exposure

The repo's existing mitigation for non-loopback binding is in `packages/server/src/index.ts`, inside the `server.listen()` callback:

```ts
if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn(`[Security] Inference Forge is bound to ${HOST}. This local-first server has no authentication; expose only on trusted networks.`);
}
```

This is the precise thing this proposal replaces. Three properties make it insufficient:

1. **It fires after `server.listen()` succeeds** — the API is already accepting connections when the warning is printed. A warning is not a control; a control prevents the bad state.
2. **It is a `console.warn`** — goes to stdout, typically not monitored, easily missed in a backgrounded/PM2/systemd deployment.
3. **It does not check `AUTH_MODE`** (there is no such concept) — there is no configuration the operator can set to make the warning go away by actually fixing the issue, only by suppressing the symptom.

### The exposure is already large, not future

The original drafts framed the API surface as "~3 route groups." The live `api/routes.ts` exposes **60+ routes**. The auth-relevant subset — endpoints that are state-mutating, resource-consuming, or otherwise not safe to expose unauthenticated — already exists today:

| Route | Method | Why it's auth-relevant |
|---|---|---|
| `/models/pull` | POST | SSE-streamed model download — disk fill / bandwidth / supply-chain (pulls arbitrary model from registry) |
| `/benchmark/run`, `/benchmark/run-expanded` | POST | GPU/CPU saturation, resource exhaustion |
| `/io/benchmark` | POST | Resource exhaustion |
| `/perplexity/estimate`, `/perplexity/compare` | POST | Resource exhaustion (note: replaced by proposal 02, but still exposes a false metric meanwhile — auth gates it either way) |
| `/alerts/thresholds/:id` | PUT | Mutates alert config |
| `/alerts/:id/acknowledge`, `/alerts/acknowledge-all` | POST | Mutates alert state |
| `/prompts`, `/prompts/import` | POST | Mutates persistent prompt library |
| `/templates`, `/templates/:id` | PUT/DELETE | Mutates template library |
| `/templates/:id/create` | POST | **Triggers model creation** (write-capable) |
| `/templates/import` | POST | Mutates library |
| `/modelfile/generate`, `/modelfile/generate-auto` | POST | Generates model config (write-capable) |
| `/costs/record`, `/costs/budget` | POST | Mutates cost records/budget |
| `/pressure/predict` | POST | Resource work |
| `/agents`, `/agents/:id` | POST/PUT/DELETE | Mutates agent definitions |
| `/sessions`, `/sessions/:id/message`, `/sessions/:id/message/stream` | POST | **Triggers inference** (resource + potentially exfiltrates prompt data) |
| `/workflows`, `/workflows/:id/execute` | POST | **Triggers multi-agent execution** (resource + write-capable) |
| `/route`, `/route/advise`, `/route/policies`, `/route/policies/:id` | POST/POST/GET+POST/DELETE | Mutates routing policies |
| `/registry/refresh` | POST | Triggers backend re-scan |
| `/profiles/run`, `/profiles/run-all` | POST | Triggers profiling workloads |

Plus read-only reconnaissance surface (`/models`, `/models/running`, `/hardware`, `/metrics`, `/throughput`, `/pressure`, `/storage`) that fingerprints the deployment (GPU type inferable from VRAM patterns; what models an org runs reveals capability/intent).

This is not a hypothetical future API surface. It exists now. Retrofitting auth across this surface later — after Modelfile Studio (proposal 04's gated feature) adds the highest-blast-radius write endpoints — is more expensive than inserting it now while the surface is already large but not yet larger.

### Why this matters in the DjimIT context specifically

- **NIS2 (EU Directive 2022/2555 → Dutch Cyberbeveiligingswet)** imposes risk-management and access-control obligations on essential/important entities and shapes supplier-tooling expectations even for internal tooling adjacent to in-scope organizations like the Dutch judiciary (Rechtspraak). An unauthenticated dashboard exposing model inventory, hardware telemetry, and inference-trigger ability is the kind of internal asset a NIS2-conscious risk assessment flags, even as "just a dev tool."
- **BIO2 (Baseline Informatiebeveiliging Overheid)** requires documented access control measures (control set maps to ISO 27001 Annex A including A.9 Access Control) for any system exposing organizational information assets. The dashboard's telemetry IS an information asset, however informal the tool feels.
- The practical risk is not exotic: an unauthenticated WebSocket and REST API bound to anything beyond `127.0.0.1` is discoverable on a local network (or, misconfigured, more broadly) and lets any unauthenticated actor enumerate running models, trigger inference (resource exhaustion / cost if metered), and — once Modelfile Studio ships — modify model configuration.

The fix is not "add a login page" as a bolt-on. It is defining an auth boundary now, while the API surface is large but bounded, so it's a clean middleware insertion rather than a retrofit across a Phase 4/5-sized surface.

## What Changes

- **Convert the post-startup `console.warn` into a pre-startup guard**: if `HOST` is non-loopback AND `AUTH_MODE=none`, the server SHALL refuse to start and exit non-zero with a clear, actionable error — the loud-failure posture for a security-relevant default.
- Introduce token-based authentication (bearer token, not session cookies — appropriate for an API-driven, scriptable tool) as the default-on mechanism the moment `HOST` is non-loopback.
- **Localhost-only deployment (today's default) remains zero-friction, no-auth-required** — this proposal does not punish the common case, it gates the *expansion* case.
- Add `AUTH_MODE` configuration: `none` (localhost-only, current default, **enforced by binding check** not just convention), `token` (single shared bearer token via env var, minimum viable for small-team internal use), and a documented extension point for `oidc` (deferred — see Rejected Alternatives, intentionally not built now).
- Add structured audit logging for all state-mutating actions (model load/unload, benchmark runs, modelfile/template/policy writes, agent/session/workflow operations) — who (token identity, hashed), what, when, outcome. This is a NIS2/BIO2 expectation independent of the auth mechanism's sophistication: even a single shared token deployment should produce an auditable trail.
- Apply auth middleware to all `api/` routes when `AUTH_MODE=token`, with explicit handling for the SSE streaming route (`/models/pull`) and the WebSocket handshake (`/ws`) — these are the two non-trivial cases (browsers cannot set arbitrary headers on WS upgrade; SSE responses must not break the stream mid-flight).
- Scope the README's current "Set `HOST` explicitly only on trusted networks" advisory into a documented `AUTH_MODE` requirement — converting the informal warning into an enforced technical control.

## Impact

- **Affected specs:** `access-control` (new capability)
- **Affected code:**
  - `packages/server/src/index.ts` (startup guard before `server.listen()`, not inside the callback)
  - new `packages/server/src/middleware/auth.ts`
  - all route handlers in `packages/server/src/api/routes.ts` (auth middleware applied at the router level, not per-handler)
  - WebSocket handshake in `packages/server/src/ws/handler.ts` (token validated before connection accepted)
  - SSE handler at `routes.ts:165` (`/models/pull`) — token validated before stream begins
  - `.env.example` (`AUTH_MODE`, `AUTH_TOKEN`)
- **Affected docs:** README development setup section (replace "only on trusted networks" with documented `AUTH_MODE` requirement)
- **Breaking changes:** None for the default localhost deployment. Any existing non-default `HOST` override deployment will require setting `AUTH_MODE=token` and a token value to continue starting — this is the intended forcing function.

## Rejected Alternatives

1. **"Build full OIDC/SSO integration now."** Rejected: real effort (provider config, token validation, refresh flow, session management) unjustified before a single non-localhost deployment exists to integrate it for. Scoped as a documented extension point now; build when an actual multi-user/SSO deployment is needed.
2. **"Rely on network-level controls only (firewall, VPN, Tailscale)."** Rejected as the *sole* control, though valid as a complementary layer (consistent with Dennis's existing Tailscale VPN usage). Defense-in-depth: network controls can be misconfigured or bypassed (Tailscale ACL mistake, bridged VM adapter); application-level auth is the layer that fails safe even if the network layer doesn't. NIS2/BIO2 expect layered controls, not a single point of trust.
3. **"Implement full RBAC (roles, permissions, per-model scopes) now."** Rejected for this proposal's scope — flagged as an explicit open question, because the answer depends on actual deployment context (single internal team vs broader org) that isn't yet known.
4. **"Just make the `console.warn` louder / move it before `listen()`."** Rejected: a louder warning is still a warning, not a control. It still allows the operator to ignore it and ship an unauthenticated API. The startup guard converts a configuration mistake into a startup failure, which is the only posture that actually prevents the exposed state.

## Resolved: shared token is the final state for the foreseeable future

Per stakeholder decision (2026-06-20): the near-term deployment is a **single internal team**. `AUTH_MODE=token` (single shared bearer token) is therefore the **final state**, not a temporary stepping stone. RBAC / per-user identity is explicitly **out of scope** — not deferred-and-imminent, just out of scope until a deployment context that needs it actually materializes.

Practical consequences of this decision, baked into the design rather than left implicit:
- The audit log's `actorTokenHash` is the *only* actor identity available — there is exactly one token, so all audit entries share the same hash and the audit log answers "what was done" but not "which named person did it." This is the accepted trade-off for a single-internal-team deployment and is documented in the audit section of design.md.
- Token rotation policy becomes operationally important (a single shared secret that never rotates is a latent risk). Add a documented rotation procedure (rotate `AUTH_TOKEN`, communicate new value to the team) even though it is out of scope to automate it now.
- If the deployment context later broadens (multi-team / external), a *separate* future change proposal introduces RBAC — this proposal's `AUTH_MODE=token` remains valid as the `none`→`oidc` migration path's middle step. The `oidc` extension point documented in Rejected Alternatives stays as the forward path, just no longer the imminent next step.
