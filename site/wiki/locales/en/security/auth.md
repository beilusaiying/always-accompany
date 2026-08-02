# Authentication and Permissions

always-accompany's authentication system (auth.mjs) covers JWT, API Key, user CRUD, and brute-force defense.

## Authentication System

always-accompany's authentication system (auth.mjs) encompasses five core responsibility domains:

1. JWT issuance / verification / refresh / revocation
2. Authentication middleware (route protection)
3. API Key management and scope system
4. User CRUD (registration / login / rename / delete / password change / security question password recovery)
5. Brute-force defense

## Initialization Flow

On server startup, `initAuth()` completes the following initialization:

- ES256 key pair loading (used for JWT signature verification)
- Argon2 warm-up (password hashing algorithm; prefers Rust FFI implementation, falls back to pure JS if unavailable)
- User data cleanup

## Authentication Paths

When a request reaches a protected endpoint, `try_auth_request` attempts four authentication paths in order of priority:

| Priority | Auth Method | Source | Description |
|----------|------------|--------|-------------|
| 1 | API Key | `x-api-key` header | Verified against SHA256 hash table |
| 2 | API Access Token | `cookies.apiAccessToken` | JWT api type (passes through scopes, prevents scope laundering) |
| 3 | Access Token | `cookies.accessToken` | Standard JWT verification (own session, scope=['*']) |
| 4 | Refresh Token | `cookies.refreshToken` | Refresh token renewal (rotation + persistence to prevent loss on restart) |

The first match returns immediately; subsequent paths are not attempted.

## Middleware

### authenticate

Standard authentication middleware. Unauthenticated requests return 401. All endpoints requiring login use this middleware.

### requireOwner

Owner Permission middleware. Non-owner users receive 403. Used for security policy mutation endpoints (e.g., modifying security-sensitive configuration).

### auth_request

Internal authentication request function for non-Express route scenarios (e.g., API v1 routes).

## Owner System

### Instance Owner

The first registered user automatically becomes the instance owner (persisted in `config.ownerUsername`). The owner has the highest permissions:

- Modify security policies (deployment mode, security-sensitive configuration)
- Manage other user accounts
- Access all owner-only endpoints

### Local Single-User

In local deployment, the sole user is the owner, and all owner permissions are naturally granted.

## JWT Implementation

### Signature Algorithm

Uses ES256 (ECDSA P-256) algorithm. The key pair is automatically generated on first startup and persisted. The private key is not stored in config.json (security isolation); it is held in a module variable.

### Token Expiry

| Token Type | Expiry |
|-----------|--------|
| Access Token | 1 day |
| Refresh Token | 30 days |

### Token Refresh

Refresh Token supports a rotation mechanism: each time a Refresh Token is used for renewal, the old Token is invalidated and a new one is issued. Refresh Tokens are persisted to disk to prevent users from being logged out on service restart.

### Token Cache

JWT verification results are cached in memory (last 32 entries), reducing the cryptographic overhead of repeated verification.

## API Key

### Management

The owner can create API Keys, each bound to specific scopes (Permission ranges). Keys are stored as SHA256 hashes; the plaintext is displayed only once at creation time.

### SEC-T6 Scope System

The scope of an API Key determines which endpoints can be accessed. Endpoint-level scope checks are performed via the `requireApiKeyScope` middleware, preventing low-Permission Keys from accessing high-Permission functions.

API Access Tokens (JWTs issued from API Keys) pass through the scopes field, preventing scope laundering (original scopes are preserved during JWT renewal).

## Brute-Force Defense

### Account Lockout

After 5 consecutive failed login attempts, the account is locked for 10 minutes.

### Honeypot Mechanism

When brute-force attempts exceed the threshold (8 attempts), the system has a probability (1/3) of returning a "fake success" response. This prevents attackers from distinguishing real passwords from fake successes, increasing the difficulty of cracking.

### Timing Attack Protection

Login verification uses constant-time comparison, preventing password correctness from being inferred through response time differences.

## Password Storage

User passwords are stored using Argon2id hashing. The system prefers `@node-rs/argon2` (Rust FFI implementation for better performance) and falls back to a pure JavaScript implementation if unavailable.

## Security Events

The auth module emits the following events during user lifecycle events for other modules to listen to:

| Event | Timing |
|-------|--------|
| BeforeUserDeleted | Before deleting a user |
| AfterUserDeleted | After deleting a user |
| AfterUserRenamed | After renaming a user |

## Cookie Security

Cookie options are set dynamically based on connection type:

- HTTPS connections: Set the `Secure` flag (determined dynamically by request protocol)
- Always set `HttpOnly` (JavaScript cannot read)
- Set `SameSite=Lax` (restricts cross-site sending while allowing top-level navigation)

## Navigation

- [Security Center](overview.md) — Security system overview
- [System Architecture](../developer/architecture.md) — Overall architecture
- [API Endpoint Reference](../developer/api-reference.md) — Endpoint authentication requirements
