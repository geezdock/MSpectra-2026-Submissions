# Backend (FastAPI)

## Setup

1. Create and activate a virtual environment:
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
2. Install dependencies:
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
3. Copy environment file:
   copy .env.example .env
4. Run server:
   .\.venv\Scripts\python.exe -m uvicorn run:app --reload --port 8000

## API Endpoints

- GET /            -> basic API message
- GET /health      -> health check
- POST /candidate/profile-upload -> saves upload metadata in Supabase
- POST /candidate/interview-session/start -> starts candidate interview session
- GET /candidate/interview-session/start -> compatibility alias for start flow
- POST /candidate/interview-session/respond -> compatibility alias for next-question flow
- GET /candidate/interview-session/end -> compatibility alias to end latest in-progress session
- POST /candidate/interview-session/{session_id}/complete -> completes session and stores scoring state
- POST /candidate/interview-session/{session_id}/score/retry -> candidate retry scoring
- POST/PATCH /admin/candidates/{candidate_id}/stage -> update candidate stage
- POST/PATCH /admin/candidates/bulk-stage -> bulk update candidate stages
- GET /admin/background-jobs/{job_id} -> background job status
- GET /admin/audit-logs -> admin audit log listing
- POST /admin/interview-sessions/auto-complete-stale -> auto-finalize stale in-progress interviews

## Frontend Integration

Your frontend axios base URL is configured via:
- VITE_API_BASE_URL=http://localhost:8000

The frontend currently posts to:
- /candidate/profile-upload

The backend route validates the Supabase bearer token, resolves the user, and inserts into Supabase tables.

## Supabase Schema

Apply the migration in:
- supabase/schema.sql

## Backend Environment

Use `backend/.env.example` as the source of truth for backend-only values, including:

- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_DB_URL

Interview runtime provider split settings:

- INTERVIEW_TURN_PROVIDER=groq (or heuristic)
- GROQ_INTERVIEW_MAX_TOKENS=300

## AI Resume Summarization

The resume analysis endpoint uses the configured LLM provider (`LLM_PROVIDER`).

- Supported providers: `openrouter`, `groq`
- Default provider: `openrouter`
- Default model: `openai/gpt-4o-mini` (via OpenRouter)
- Keep requests short by extracting only the relevant resume text before sending it to the model
- Review provider pricing and rate limits before enabling production traffic
- Scoring is strict LLM-based, with retry/backoff and pending status handling instead of heuristic fallback

## Ops Runbook (Interview Reliability)

1. Enable Groq turn mode and token cap in backend env:
   - INTERVIEW_TURN_PROVIDER=groq
   - GROQ_INTERVIEW_MAX_TOKENS=300
2. Keep OpenRouter configured for analytical tasks:
   - Resume parsing/scoring and final interview scoring use OpenRouter-priority chain.
3. Recover stale in-progress sessions (sync):
   - POST /admin/interview-sessions/auto-complete-stale
   - Body example: {"limit": 100, "idleMinutes": 30, "runInBackground": false}
4. Recover stale sessions (background):
   - POST /admin/interview-sessions/auto-complete-stale
   - Body example: {"limit": 500, "idleMinutes": 30, "runInBackground": true}
   - Poll GET /admin/background-jobs/{job_id}
5. Expected behavior:
   - Stale session transitions from in_progress to completed.
   - Scoring runs immediately when provider is available.
   - If scoring provider is unavailable, scoringStatus becomes pending and can be retried later.
