# Vercel Hosting Strategy for Stock Footage Finder

## Goals
- Host the React frontend on Vercel with fast global delivery.
- Expose a minimal set of serverless functions for optional backend logic (e.g., key validation, proxying searches) while remaining user-centric.
- Ensure users supply their own stock-media API keys, scoped to the current browser session.
- Preserve security guidance from the audit while adapting it to a serverless environment.

## Deployment Architecture
1. **Frontend**
   - Deploy the Vite/React app as a static bundle using Vercel’s `@vercel/static-build`.
   - Provide runtime configuration via build-time env variables (e.g., base API URL) and a `/config.json` fetched at load for dynamic overrides.

2. **Serverless Edge/API Routes (optional but recommended)**
   - Create Vercel serverless functions in `/api` to support:
     1. API key format validation and one-off test calls before use.
     2. Optional request proxying to shield third-party APIs from direct exposure if needed.
     3. Session token issuance if moving away from storing raw keys in the browser.
   - Keep functions stateless; use short-lived encrypted tokens to represent the user-supplied key when a round-trip to the server is required.

3. **Client Session Handling**
   - Never persist raw API keys beyond memory. Use React context/state with a `beforeunload` listener to drop keys when the tab closes.
   - For optional persistence within a session, encrypt the key via Web Crypto (`SubtleCrypto`) and store the ciphertext in `sessionStorage`. Rotate the encryption key per session and discard it on refresh.
   - Provide clear UX so the user knows the key only lives for the session and must be re-entered later.

## Security Considerations
- **No Plaintext Storage**: Avoid `localStorage`/cookies for raw keys per guidance @frontend/src/services/storageService.ts#139-175 (critical risk in the audit).
- **Sanitized Inputs**: Reuse backend sanitization logic in serverless functions for search queries, filenames, etc. @backend/services/download_service.py#430-455, @backend/services/stock_media_service.py#33-87.
- **Safe Logging**: Suppress sensitive values in serverless logs; log only generic errors as recommended @backend/api/endpoints.py#343-377.
- **Optional Auth**: If multi-user accounts are introduced, expand to JWT/secure sessions consistent with the roadmap @backend/main.py#17-65.

## Environment Configuration
| Variable | Purpose | Where to set |
| --- | --- | --- |
| `VITE_APP_DEFAULT_BACKEND_URL` | Base URL for optional proxy/API routes | Vercel project settings (build + runtime) |
| `VITE_APP_ALLOWED_SOURCES` | Whitelisted stock providers for dropdowns | Vercel runtime env |
| `ENCRYPTION_SALT` | Client-side key derivation salt (inject via build) | Vercel build env |
| `SESSION_COOKIE_SECRET` | If issuing encrypted session tokens | Vercel serverless env |

## Deployment Steps
1. **Prepare Repository**
   - Add a `vercel.json` with the static build and API route configuration.
   - Ensure Vite build command (`npm run build`) outputs to `dist/`.
2. **Configure Vercel Project**
   - Connect the repository, set environment variables for production and preview.
   - Enable automatic deployments on pushes to the chosen branch.
3. **Implement Session Wrapper**
   - Build a React context handling API key entry, Web Crypto encryption, and cleanup on tab close.
   - Integrate validation by calling `/api/test-key` serverless route before accepting the key.
4. **Optional Proxy Function**
   - Create `/api/search` to accept sanitized queries, retrieve encrypted key token from the client, decrypt server-side, and call the provider API. Keeps provider endpoints hidden and allows rate limiting.
5. **Security Hardening**
   - Add security headers via Vercel edge middleware (`@vercel/edge`) aligning with recommendations (CSP, HSTS, etc.).
   - Implement rate limiting within serverless functions (e.g., using Vercel KV or Upstash Redis) to mirror guidance @backend/main.py#46-65.
6. **Testing & Monitoring**
   - Run `npm run test` (or add tests) covering session handling.
   - Use Vercel analytics/log drains for anomaly detection. Keep detailed errors out of user responses but record them privately.

## Future Enhancements
- Add optional user accounts with secure session tokens and per-user quotas when demand grows.
- Integrate automated dependency scanning in CI/CD (e.g., GitHub Dependabot, Snyk) as noted in the remediation roadmap.
- Explore storing encrypted API keys in the browser only when WebAuthn or OS keychain integration is available for improved UX.
