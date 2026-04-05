# Backend API – JARVIS AI Recruiter

FastAPI backend service for candidate interview management, AI scoring, and admin operations.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
- [Environment Configuration](#environment-configuration)
- [Database Schema](#database-schema)
- [Interview Flow](#interview-flow)
- [LLM Integration](#llm-integration)
- [Admin Operations](#admin-operations)
- [Debugging & Logs](#debugging--logs)

## 🚀 Quick Start

### Prerequisites
- Python 3.11+
- Supabase project
- OpenRouter API key (resume analysis, interview scoring)
- Groq API key (optional, for interview question generation)
- OpenAI API key (realtime voice, optional)

### Setup

```bash
# 1. Create virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1  # Windows
source .venv/bin/activate      # macOS/Linux

# 2. Install dependencies
python -m pip install -r requirements.txt

# 3. Copy environment template
cp .env.example .env

# 4. Configure environment (edit .env with your keys)
# See Environment Configuration section below

# 5. Run backend
python -m uvicorn run:app --reload --host 127.0.0.1 --port 8000
```

Server runs at `http://127.0.0.1:8000`. Check health: `curl http://127.0.0.1:8000/health`

## 📂 Project Structure

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py              # CORS, middleware, router setup
│   ├── config.py            # Environment variables and Pydantic models
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py        # All endpoint handlers
│   └── llm/
│       ├── __init__.py
│       └── providers.py     # LLM provider abstraction (OpenRouter, Groq, OpenAI)
├── run.py                   # ASGI entrypoint
├── requirements.txt         # Python dependencies
├── .env.example            # Environment template
└── tests/
    ├── conftest.py         # pytest fixtures
    └── test_routes.py      # Endpoint tests

Key modules in routes.py:
- Authentication helpers (_get_bearer_token, _get_supabase_user, _is_admin)
- Profile upload flow
- Interview session lifecycle
- Resume analysis and scoring
- Admin dashboard and operations
- Background job management
```

## 📡 API Endpoints

### Authentication
All endpoints except `/`, `/health`, `/login`, `/signup` require Supabase JWT bearer token in header:
```
Authorization: Bearer <supabase_access_token>
```

### Candidate Endpoints

#### Profile Upload
```
POST /candidate/profile-upload
Content-Type: application/json

{
  "filename": "resume.pdf",
  "size": 15234,
  "type": "application/pdf",
  "filePath": "...",      # Optional, if pre-hosted
  "fileUrl": "...",       # Optional, if pre-hosted
  "targetRole": "Backend Developer",
  "submittedAt": "2026-04-05T10:00:00Z"
}

Response: 200 OK { "id": "...", "candidate_id": "...", "file_url": "..." }
```

#### Interview Session Start
```
POST /candidate/interview-session/start
Content-Type: application/json

{
  "consentGiven": true
}

Response: 200 OK
{
  "sessionId": "uuid",
  "initialQuestion": "Tell me about your background...",
  "provider": "groq",
  "timestamp": "2026-04-05T10:00:00Z"
}
```

#### Interview Response (Next Question)
```
POST /candidate/interview-session/respond
Content-Type: application/json

{
  "sessionId": "...",
  "transcriptTurns": [
    { "role": "interviewer", "text": "..." },
    { "role": "candidate", "text": "My response..." }
  ],
  "questionsAsked": 1
}

Response: 200 OK
{
  "nextQuestion": "Follow-up question...",
  "questionsRemaining": 4,
  "status": "in_progress"
}
```

#### Interview Completion
```
POST /candidate/interview-session/{session_id}/complete
Content-Type: application/json

{
  "transcript": "Full interview transcript",
  "scorePayload": { "scoringRubric": {...}, "overallScore": 78 },
  "durationSeconds": 420,
  "audioPath": "interview/...",
  "videoPath": "interview/..."
}

Response: 200 OK { "sessionId": "...", "status": "completed", "score": 78 }
```

### Admin Endpoints

#### List Candidates
```
GET /admin/candidates?search=john&stage=under_review&minScore=60&maxScore=90
Response: 200 OK
{
  "candidates": [
    {
      "id": "...",
      "name": "John Doe",
      "role": "Backend Developer",
      "stage": "under_review",
      "score": 75,
      "latestUpload": { "filename": "resume.pdf", "created_at": "..." }
    },
    ...
  ]
}
```

#### Get Candidate Details
```
GET /admin/candidates/{candidate_id}
Response: 200 OK
{
  "candidate": {
    "id": "...",
    "name": "John Doe",
    "position": "Backend Developer",
    "stage": "under_review",
    "score": 75,
    "aiSummary": "...",
    "aiSkills": ["Python", "FastAPI", "PostgreSQL"],
    "aiExperienceLevel": "Mid level"
  },
  "latestUpload": { "filename": "resume.pdf", "file_url": "..." },
  "slots": [{"slotTime": "..."}],
  "interviewSessions": [
    {
      "id": "...",
      "status": "completed",
      "startedAt": "...",
      "scoringStatus": "completed",
      "rubricOverall": 78
    }
  ],
  "transcript": "Full interview transcript...",
  "summary": "AI resume analysis..."
}
```

#### Update Candidate Stage
```
POST /admin/candidates/{candidate_id}/stage
PATCH /admin/candidates/{candidate_id}/stage

{
  "stage": "interview_scheduled"
}

Response: 200 OK { "candidate": {...}, "latestUpload": {...}, "slots": [] }
```

#### Bulk Update Candidate Stages
```
POST /admin/candidates/bulk-stage
PATCH /admin/candidates/bulk-stage

{
  "candidateIds": ["id1", "id2", "id3"],
  "stage": "under_review",
  "runInBackground": true
}

Response: 200 OK
{
  "id": "job-uuid",
  "type": "candidate_bulk_stage_update",
  "status": "queued",
  "context": { "candidateCount": 3, "stage": "under_review" }
}
```

#### Auto-Complete Stale Sessions
```
POST /admin/interview-sessions/auto-complete-stale

{
  "limit": 100,
  "idleMinutes": 30,
  "runInBackground": true
}

Response: 200 OK
{
  "id": "job-uuid",
  "type": "stale_session_auto_complete",
  "status": "queued",
  "context": { "limit": 100, "idleMinutes": 30 }
}
```

#### Poll Background Job Status
```
GET /admin/background-jobs/{job_id}
Response: 200 OK
{
  "id": "job-uuid",
  "type": "candidate_bulk_stage_update",
  "status": "running",
  "progress": {
    "percent": 45,
    "processed": 45,
    "total": 100
  },
  "context": {...},
  "error": null
}
```

#### View Interview Session Details
```
GET /admin/interview-session/{session_id}
Response: 200 OK
{
  "session": {...},
  "artifact": {
    "score_payload": {...},
    "videoSignedUrl": { "signedUrl": "..." },
    "audioSignedUrl": { "signedUrl": "..." }
  }
}
```

#### Retry Interview Scoring
```
POST /admin/interview-session/{session_id}/score/retry
Response: 200 OK { "artifact": {...} }
```

#### Analyze Resume (Force)
```
POST /admin/analyze-resume/{candidate_id}

{
  "force": true,
  "runInBackground": false
}

Response: 200 OK { "candidate": {...} }
```

## ⚙️ Environment Configuration

Copy `.env.example` and fill in your values:

```bash
# App Configuration
APP_NAME=Jarvis Recruit API
APP_ENV=development
APP_PORT=8000

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_DB_URL=postgresql://user:password@host/dbname

# LLM Providers
LLM_PROVIDER=openrouter              # or groq, openai
LLM_PROVIDER_FALLBACKS=groq
LLM_MODEL=openai/gpt-4o-mini
OPENROUTER_API_KEY=your_key
OPENROUTER_SITE_URL=http://localhost:5173
GROQ_API_KEY=your_key

# Interview Settings
INTERVIEW_TURN_PROVIDER=groq         # groq or heuristic
GROQ_INTERVIEW_MAX_TOKENS=300
INTERVIEW_REALTIME_PROVIDER=openai
INTERVIEW_REALTIME_MODEL=gpt-4o-realtime-preview-2024-12-17
INTERVIEW_REALTIME_VOICE=alloy
INTERVIEW_MAX_QUESTIONS=6
INTERVIEW_MAX_DURATION_SECONDS=900

# Frontend
FRONTEND_ORIGIN=http://localhost:5173
```

## 📊 Database Schema

Schema is managed via `supabase/schema.sql`. Key tables:

- **candidates** – User profiles with AI analysis results
- **profile_uploads** – Resume metadata and file references
- **interview_sessions** – Interview records (status, transcript version)
- **interview_artifacts** – Scoring results (rubric, overall score, analysis)
- **interview_slots** – Scheduled interview times
- **admin_audit_logs** – Admin action history
- **background_jobs** – Async job tracking
- **interview_upload_nonces** – Signed URL tokens for video/audio

Apply schema:
```bash
psql -U postgres -d your_db < supabase/schema.sql
```

Or use Supabase dashboard SQL editor.

## 🎤 Interview Flow

### Session Lifecycle

1. **Start** – `POST /candidate/interview-session/start`
   - Creates `interview_sessions` record with status `in_progress`
   - Generates initial question via LLM (Groq default)
   - Returns session ID and first question

2. **Respond Loop** – `POST /candidate/interview-session/respond`
   - Receives candidate answer and transcript turns
   - Validates transcript version (prevents duplicate processing)
   - Generates next question via LLM
   - Returns follow-up question or completion signal

3. **Complete** – `POST /candidate/interview-session/{id}/complete`
   - Receives final transcript and optional score payload
   - Creates `interview_artifacts` record
   - Triggers LLM-based rubric scoring if not pre-computed
   - Sets session status to `completed`
   - Result persisted for admin review

### Provider Split

- **Interview Turn Generation** – `INTERVIEW_TURN_PROVIDER`
  - `groq` – Fast, cost-efficient question generation (default)
  - `heuristic` – Rule-based fallback (degraded mode)

- **Resume Analysis & Final Scoring** – Always `LLM_PROVIDER` (OpenRouter priority)
  - Rubric evaluation, skill extraction, experience level inference
  - Retry on failure (pending status)

## 🧠 LLM Integration

### Resume Analysis
Triggered on:
- Admin clicking "Generate AI Summary"
- Candidate uploading resume (if new candidate)

Extracts:
- Professional summary
- Key skills
- Experience level (Junior, Mid, Senior)
- Interview readiness

### Interview Scoring
Triggered on interview completion. Evaluates across dimensions:
- Technical depth
- Communication clarity
- Problem-solving approach
- Cultural fit indicators

If scoring provider is unavailable, score remains `pending` and can be retried via admin UI.

## 🛠️ Admin Operations

### Candidate Search & Filter
```
GET /admin/candidates
Filters: search (name/skills), stage, score range
```

### Bulk Stage Updates
```
POST /admin/candidates/bulk-stage
Queues background job, reports progress
```

### Stale Session Recovery
```
POST /admin/interview-sessions/auto-complete-stale
Limit: number of sessions to evaluate
idleMinutes: threshold for "abandoned" (default 30)
runInBackground: true for async, false for sync response
```

### Audit Logging
All admin actions logged to `admin_audit_logs`:
- Actor (user ID, email)
- Action type (stage update, analysis, cleanup)
- Affected resources
- Timestamp

## 🐛 Debugging & Logs

### Enable Verbose Logging
```bash
# Reload mode with debug output
python -m uvicorn run:app --reload --log-level debug --host 127.0.0.1 --port 8000
```

### Check Supabase Connectivity
```python
# In Python shell
from app.config import settings
import httpx

resp = httpx.get(
    f"{settings.supabase_url}/rest/v1/candidates?limit=1",
    headers={"Authorization": f"Bearer {settings.supabase_service_role_key}"}
)
print(resp.status_code, resp.json())
```

### Common Errors

**"Missing Supabase access token"**
- Client requests missing `Authorization: Bearer <token>` header
- Check frontend axios interceptor

**"Invalid Supabase access token"**
- Token expired or signed with different key
- User needs to re-authenticate

**"Unauthorized: 401 – Your session has expired"**
- Supabase auth returned error
- Check SUPABASE_ANON_KEY and SUPABASE_URL

**"Admin access required"**
- User's Supabase metadata missing `role: admin` flag
- Or email does not contain 'admin'

**Interview timeout (408)**
- Backend task exceeded frontend timeout (12 seconds)
- Removed expensive sync analysis from detail page load (Phase 8 fix)

## 📝 Testing

```bash
# Run all tests
pytest backend/tests/ -v

# Run specific test
pytest backend/tests/test_routes.py::test_interview_completion -v

# Coverage report
pytest --cov=app backend/tests/
```

Tests cover:
- Groq turn generation
- Transcript versioning
- Idempotent session completion
- Stale-session auto-complete
- Resume analysis and scoring
