# Tasks: Authentication & Authorization Layer

File-level checklist, anchored to the actual 60+ route surface.

## 1. Configuration & startup guard
- [ ] 1.1 Add `AUTH_MODE` (`none` | `token`) and `AUTH_TOKEN` to config schema and `.env.example`
- [ ] 1.2 Implement startup guard in `packages/server/src/index.ts` BEFORE `server.listen()` (not inside the callback) — refuse to start on non-loopback `HOST` + `AUTH_MODE=none`, and on `AUTH_MODE=token` without `AUTH_TOKEN`
- [ ] 1.3 Remove the existing post-`listen()` `console.warn` security block in `index.ts` (replaced by the guard)
- [ ] 1.4 Add token-strength warning if `AUTH_TOKEN.length < 16`
- [ ] 1.5 Write tests asserting: non-loopback + none → exit non-zero; token mode without token → exit non-zero; loopback + none → starts normally

## 2. Token validation middleware
- [ ] 2.1 Implement `packages/server/src/middleware/auth.ts` Express middleware validating `Authorization: Bearer` header via `crypto.timingSafeEqual` (constant-time)
- [ ] 2.2 Apply middleware to the `/api` router (in `index.ts` or at router construction in `routes.ts`) when `AUTH_MODE=token` — single insertion point, not per-handler
- [ ] 2.3 Implement WebSocket handshake token validation in `ws/handler.ts` via `WebSocketServer` `verifyClient` option (reject upgrade before session established); support token via `Sec-WebSocket-Protocol` subprotocol (preferred) and/or `?token=` query (scrubbed from logs)
- [ ] 2.4 Handle the SSE route (`POST /models/pull`, `routes.ts:165`) — token validated before the first `data:` frame is written; 401 returns cleanly without opening the stream
- [ ] 2.5 Write tests for REST: valid token, missing token, malformed header, wrong token — for both read and write routes
- [ ] 2.6 Write tests for WS: valid token connects, missing/wrong token rejected before upgrade
- [ ] 2.7 Write test asserting constant-time comparison has no early-return path

## 3. Audit logging
- [ ] 3.1 Define `AuditLogEntry` type and append-only rotated file log writer (structured JSON lines)
- [ ] 3.2 Wire audit emission at state-mutating service calls: `model.pull`, `benchmark.run`, `io.benchmark`, `templates.create`, `modelfile.generate`, `alerts.thresholds.update`, `prompts.write`, `templates.write`, `agents.*`, `sessions.message`, `workflows.execute`, `route.policies.write`, `registry.refresh`, `profiles.run`
- [ ] 3.3 Implement token hashing for actor identification (SHA-256, first 8 chars, never raw token)
- [ ] 3.4 Write test asserting the raw token string never appears in any log output across the test suite (grep-based assertion over logs dir + captured stdout)
- [ ] 3.5 Write test asserting a denied-auth attempt emits `action: 'auth.denied'`, `outcome: 'denied'`

## 4. Documentation
- [ ] 4.1 Update README development setup section: replace "Set `HOST` explicitly only on trusted networks" with the documented `AUTH_MODE` requirement and the startup-guard behavior
- [ ] 4.2 Document audit log location, format, and rotation policy
- [ ] 4.3 Add a short BIO2/NIS2 context note (internal documentation, not general OSS README) explaining why this control exists for the IVO-Rechtspraak / DjimIT context
- [ ] 4.4 Update `.github/copilot-instructions.md` if it references the no-auth assumption

## 5. Resolved scope (stakeholder decision 2026-06-20)
- [x] 5.1 RESOLVED: single internal team → shared bearer token is the final state, RBAC explicitly out of scope
- [ ] 5.2 Document the token-rotation procedure (operational, not automated): rotate `AUTH_TOKEN`, communicate new value to the team; add to README/auth docs
- [ ] 5.3 If a future deployment context requires RBAC, scope as a *separate* follow-up change proposal — `AUTH_MODE=token` remains the middle step of the `none`→`oidc` migration path
