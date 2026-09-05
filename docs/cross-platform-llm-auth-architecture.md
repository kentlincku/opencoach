# Cross-platform LLM provider and authorization architecture

This document is the canonical contract for Voice Practice model providers. All platform plans and acceptance evidence must link here rather than inventing platform-specific provider semantics.

## Product routes

Voice Practice has exactly three top-level routes:

1. **API / endpoint route** (`openai-compatible`)
   - Cloud APIs such as OpenAI and Gemini use their official HTTPS endpoint and an endpoint-bound API key.
   - Local servers such as llama.cpp, Ollama, LM Studio, and oMLX use an explicitly selected HTTP endpoint, usually without a credential.
   - Cloud and local endpoints share model discovery and chat semantics. They differ in endpoint policy, credential requirements, and network trust—not in the user-facing chat contract.
2. **Subscription login route**
   - **ChatGPT / Codex subscription** (`chatgpt-subscription`).
   - **Grok / SuperGrok subscription** (`grok-subscription`).
   - These are provider-specific authorization and inference adapters, not a generic consumer-session bridge.
3. **Platform-local route**
   - **Apple Foundation Models / Apple Intelligence** (`apple-foundation-models`) is the only model route that does not use HTTP.

Google Gemini remains in the API / endpoint route. There is no Gemini consumer-account login route.

A consumer subscription is not an API credential. ChatGPT subscription authorization is not an OpenAI API key, and Grok subscription authorization is not an xAI API key. Provider entitlement, available models, quota, and billing remain provider decisions.

## Shared runtime contract

```text
LlmRuntime
  capabilities()
  credentialStatus(providerId)
  setCredential(providerId, credential)
  clearCredential(providerId)
  listModels(providerId)
  chat(request)
  cancel(requestId)
  dispose()
```

`api-key-or-none` is the auth product for the shared API / endpoint route. `CredentialStore` binds a credential to the selected provider profile and normalized endpoint.

Subscription authorization is owned by a trusted native `SubscriptionAuthBroker`:

```text
beginSubscriptionLogin(providerId)
pollSubscriptionLogin(providerId, loginId)
cancelSubscriptionLogin(providerId, loginId)
subscriptionStatus(providerId)
subscriptionLogout(providerId)
subscriptionOperation(request)
```

None of these methods returns access tokens, refresh tokens, device secrets, or stored credentials. The Shared Web UI receives only typed capability, public verification, status, model, and reply data.

## Desktop implementation

Electron Desktop is the first implemented subscription platform:

```text
Shared Web UI
  → context-isolated preload typed IPC
  → Main Process SubscriptionAuthBroker
  → provider device authorization / token endpoint
  → OS safeStorage (Keychain on macOS, DPAPI on Windows)
  → fixed provider host and Responses protocol
```

The Desktop build/runtime must receive Voice Practice's own provider registration values:

- `VOICE_OPENAI_CODEX_CLIENT_ID`
- `VOICE_XAI_OAUTH_CLIENT_ID`
- `VOICE_XAI_OAUTH_SCOPE`

These values are configuration, not user tokens. They must belong to a Voice Practice registration authorized by the provider. The product must not reuse another app's client identity, CLI-only scopes, cookies, browser session, or tokens. When required registration is absent, `capabilities()` omits that provider and the UI remains `UNAVAILABLE_ACCURATELY_DISABLED`.

Device secrets remain in Main Process memory. API keys and subscription token bundles use separate OS-encrypted `CredentialStore` namespaces (`provider-credentials` and `subscription-tokens`); renderer-facing credential IPC can access only the API-key namespace. Renderer localStorage may retain the selected provider and model but must not retain subscription credentials, authorization URLs, or token bundles. Subscription network requests use a 15-second timeout and streaming response-size enforcement; cancellation aborts in-flight device polling, the provider interval is enforced before the first and every subsequent poll (including `slow_down`), and refresh rotation is single-flight per provider. Logout increments a provider session generation, aborts all of that provider's active requests, serializes token deletion, and prevents any stale refresh or response from restoring credentials.

Provider network requests are fixed:

- ChatGPT/Codex: OpenAI authorization hosts and the provider-authorized Codex Responses route.
- Grok/SuperGrok: xAI authorization hosts and the provider-authorized xAI Responses route.

The adapter uses a Voice Practice user agent and registered scope. It must not impersonate Codex CLI, Grok CLI, Hermes, or another client.

## Platform availability

| Platform | API / endpoint | Subscription login | Apple Foundation Models |
|---|---|---|---|
| Browser/PWA | Available subject to CORS, Local Network Access, and endpoint policy | `UNAVAILABLE_ACCURATELY_DISABLED`; no refresh token in localStorage | unavailable |
| macOS Electron | API keys in Keychain-backed safeStorage; explicit local profiles | available only with registered provider configuration | unavailable |
| Windows Electron | API keys in DPAPI-backed safeStorage; explicit local profiles | available only with registered provider configuration | unavailable |
| iOS | planned typed Swift provider service | unavailable until ASWebAuthenticationSession + Keychain adapter is implemented | capability-driven native adapter |
| Android | planned typed Kotlin provider service | unavailable until Custom Tabs + Android Keystore adapter is implemented | unavailable |

Common UI semantics do not imply common credential storage. Browser, Main Process, Swift, and Kotlin adapters report truthful capability state independently.

## Endpoint and credential safety

- API keys are bound to the selected normalized endpoint.
- Changing an endpoint clears incompatible Browser credentials and never retargets a saved key.
- Desktop API traffic uses allowlisted profiles; arbitrary renderer-to-network proxying is prohibited.
- Local endpoints require explicit user selection; the product does not scan the private network.
- Cloud credentials must never be sent to loopback, LAN, or a different cloud origin.
- Subscription tokens are bound to exact provider, client registration, audience, and account context.
- Apple Foundation Models has no endpoint and no credential.

## Fail-closed behavior

- Missing or partial native adapters are unavailable.
- Unknown or retired provider IDs trigger no fetch, OAuth window, IPC login, model discovery, or paid request.
- ChatGPT login failure must not silently fall back to an OpenAI API key.
- Grok login failure must not silently fall back to an xAI API key.
- Local endpoint failure must not silently switch to cloud.
- Apple capability failure must not silently trigger a paid cloud request.
- Model entitlement errors such as 401, 403, and unavailable models are reported without exposing provider response bodies or credentials.
- Provider changes and explicit cancellation delete the in-memory device transaction.
- Logout clears the corresponding encrypted local token and cancels provider-specific in-flight authorization state.

No provider route may use cookie extraction, consumer-site session scraping, an unrestricted local proxy, or agent-mediated credential reuse.

## Account and sync boundary

There is currently **沒有Voice Practice統一帳號**. Devices **不得同步credential**. A future account/sync service requires a separate security design and does not inherit authorization from this contract.

## Migration

Legacy API provider IDs migrate into `openai-compatible`. Retired generic subscription IDs and OAuth state are deleted. For the two canonical subscription IDs, renderer storage may retain only model selection; keys, bindings, URLs, device transactions, and tokens are removed or kept exclusively in the native broker store.

Persisted unavailable selections remain blocked until the user explicitly chooses another available provider. Migration不得靜默切換 to a paid or authenticated route.

## Acceptance

Each provider/platform combination must record `SUPPORTED`, `MANUAL_TEST_PENDING`, or `UNAVAILABLE_ACCURATELY_DISABLED`.

API acceptance sequence:

```text
set → status → models → chat → restart/refresh → clear → post-clear fail closed
```

Subscription acceptance sequence:

```text
capability → begin → public verification data only → pending → authorized
→ models → chat → restart → refresh → logout → post-logout fail closed
```

Tests must also prove cancellation, expiry, refresh rotation, malformed response handling, response-size limits, fixed hosts, unknown-provider rejection, no renderer token getter, no secret in logs/settings/localStorage, and no implicit fallback.

Live authorization remains `MANUAL_TEST_PENDING` until the provider has approved Voice Practice's own client registration and a maintainer executes the flow with a consenting account. Fixture tests do not establish provider approval or live entitlement.
