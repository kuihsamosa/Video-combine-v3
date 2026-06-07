# Stock Footage Finder — Local Focus Tasks

## Immediate Setup
- [ ] Create `.env.local` files for frontend/backend and load API keys via env vars only; never hardcode or store in git @frontend/src/services/storageService.ts#139-175 @backend/services/api_key_manager.py#34-44.
- [ ] Wire API key entry UI to keep keys in React state (memory) and clear them on tab close; optionally encrypt with Web Crypto before storing in `sessionStorage` for the session.
- [ ] Run backend setup: `pip install -r backend/requirements.txt`, create `encryption.key` via environment variable, and start FastAPI with `uvicorn backend.main:app --reload`.
- [ ] Run frontend setup: `npm install --prefix frontend` and `npm run dev --prefix frontend` with Vite proxy to backend.

## Core Functionality Fixes
- [ ] Sanitize generated filenames to prevent path traversal and enforce safe characters @backend/services/download_service.py#430-455.
- [ ] Add query sanitation/validation before calling provider APIs to avoid bad requests and crashes @backend/services/stock_media_service.py#33-87.
- [ ] Ensure download history only references current user/session by using UUIDs and clearing local data between runs @backend/api/downloads.py#178-190.
- [ ] Standardize error handling/logging so UI shows friendly messages while backend logs detail @backend/api/endpoints.py#343-377 @frontend/src/services/apiService.ts#36-49.

## Quality & Stability
- [ ] Patch null-check gaps in media parsing to stop crashes on malformed provider responses @backend/services/stock_media_service.py#58-81.
- [ ] Add smoke tests/integration checks for search + download flows (pytest for backend, React Testing Library for frontend).
- [ ] Document start/stop workflow and API key requirements in README for future reference.

## Nice-to-Have (After Above)
- [ ] Implement lightweight rate limiting to protect local backend from runaway scripts @backend/main.py#46-65.
- [ ] Track dependency updates periodically (`pip-audit`, `npm audit`) to avoid stale vulnerabilities @backend/requirements.txt#1-17 @frontend/package.json#12-19.
