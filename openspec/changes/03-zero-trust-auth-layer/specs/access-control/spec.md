# Spec Delta: `access-control`

**Type:** ADDED (new capability)

## ADDED Requirements

### Requirement: Loopback-Only Default
The system SHALL permit unauthenticated access only when bound exclusively to loopback addresses (`127.0.0.1` or `localhost`), and SHALL enforce this by startup guard, not by post-startup warning.

#### Scenario: Default localhost deployment
- **WHEN** the server starts with no `HOST` override and no `AUTH_MODE` set
- **THEN** the system SHALL bind to loopback only and SHALL NOT require authentication
- **AND** behavior SHALL be unchanged from the pre-existing default
- **AND** no post-startup security warning SHALL be emitted (the guard makes it unnecessary)

### Requirement: Fail-Fast on Misconfigured Exposure
The system SHALL refuse to start if configured to bind to a non-loopback address while authentication is disabled.

#### Scenario: Non-loopback bind without auth
- **WHEN** `HOST` is set to a non-loopback address AND `AUTH_MODE=none`
- **THEN** the system SHALL exit with a non-zero status code at startup, before opening the listening socket
- **AND** SHALL print a clear, actionable error explaining the required configuration change (`AUTH_MODE=token` + `AUTH_TOKEN`, or bind to loopback)

#### Scenario: Token mode without token
- **WHEN** `AUTH_MODE=token` AND `AUTH_TOKEN` is unset or empty
- **THEN** the system SHALL exit with a non-zero status code at startup
- **AND** SHALL print a clear error requiring `AUTH_TOKEN` to be set

### Requirement: Bearer Token Authentication
The system SHALL validate a bearer token on every REST request and WebSocket connection when `AUTH_MODE=token`, including SSE-streaming routes.

#### Scenario: Missing or invalid token on REST request
- **WHEN** `AUTH_MODE=token` and a REST request is made without a valid `Authorization: Bearer` header matching the configured token
- **THEN** the system SHALL respond with HTTP 401 Unauthorized
- **AND** SHALL NOT process the request further

#### Scenario: SSE route auth completes before stream opens
- **WHEN** `AUTH_MODE=token` and a `POST /models/pull` request lacks a valid token
- **THEN** the system SHALL respond with HTTP 401 before writing any `text/event-stream` frame
- **AND** SHALL NOT open the SSE stream

#### Scenario: Missing or invalid token on WebSocket handshake
- **WHEN** `AUTH_MODE=token` and a WebSocket connection attempt does not present a valid token at handshake
- **THEN** the system SHALL reject the connection before the upgrade completes
- **AND** SHALL NOT establish the WebSocket session

#### Scenario: Constant-time token comparison
- **WHEN** validating a presented token against the configured token
- **THEN** the system SHALL use a constant-time comparison function
- **AND** SHALL NOT use a comparison whose execution time varies with the position of the first mismatched character

### Requirement: Audit Logging of State-Mutating Actions
The system SHALL record an audit log entry for every state-mutating action, including actor token identity (hashed), action type, timestamp, and outcome, persisted to an append-only rotated log file.

#### Scenario: Successful inference trigger
- **WHEN** an authenticated actor triggers a generation request (`/sessions/:id/message`, `/workflows/:id/execute`, or benchmark run)
- **THEN** the system SHALL append an audit log entry with the corresponding `action` value, the hashed token identifier, timestamp, and `outcome: 'success'`

#### Scenario: Model creation / Modelfile write
- **WHEN** an authenticated actor triggers `POST /templates/:id/create`, `/modelfile/generate`, or `/modelfile/generate-auto`
- **THEN** the system SHALL append an audit log entry with `action: 'modelfile.write'` (or `template.write`), hashed actor, timestamp, and outcome

#### Scenario: Denied authentication attempt
- **WHEN** a request is rejected for missing/invalid token
- **THEN** the system SHALL append an audit log entry with `action: 'auth.denied'` and `outcome: 'denied'`
- **AND** the raw token SHALL NOT appear in the entry

#### Scenario: Token never appears in plaintext in logs
- **WHEN** any log entry (audit log or general application log) is written
- **THEN** the raw bearer token value SHALL NOT appear anywhere in the log output
- **AND** only a truncated hash of the token SHALL be used for actor identification
