# JARVIS AI Recruiter – MSpectra Hackathon 2026

A full-stack AI-powered recruiting platform that automates candidate interviews, resume analysis, and hiring workflow management.

## 🔗 Getting Started

- **Live Demo** – https://jarvis-psi-black.vercel.app/
- **Video Demo** – https://drive.google.com/file/d/1yvVjBhtDjfvqg90655x78XTWlsI1GIAn/view?usp=sharing
- **Presentation** – https://app.presentations.ai/view/mvJy3HG5ZD

## 📋 Table of Contents

- [Project Overview](#project-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Development](#development)
- [Deployment](#deployment)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## 📌 Project Overview

JARVIS is a recruiting automation platform featuring:

- **Candidate Management** – Profile uploads, resume analysis, and interview scheduling
- **AI-Powered Interviews** – Real-time voice/text interaction with LLM interviewers
- **Resume Analysis** – Automated skill extraction and experience level inference
- **Interview Scoring** – LLM-based structured evaluation with retry mechanisms
- **Admin Dashboard** – Candidate search, bulk updates, interview playback, and ops tools
- **Reliability Features** – Stale session recovery, transcript persistence, and resilient reconnect

## 🛠️ Tech Stack

### Backend
- **Framework** – FastAPI (Python 3.x)
- **Database** – Supabase (PostgreSQL + managed auth)
- **Auth** – Supabase Auth (JWT-based)
- **LLM Providers** – OpenRouter (resume/scoring), Groq (interview questions)
- **Realtime Voice** – OpenAI Realtime API

### Frontend
- **Framework** – React 19 + Vite
- **Routing** – React Router v7
- **Styling** – Tailwind CSS + postcss
- **State** – Context API
- **API Client** – Axios
- **Auth** – Supabase.js SDK

### Infrastructure
- **Hosting** – Vercel (frontend)
- **Database** – Supabase Cloud
- **API** – Backend deployed separately (see Deployment)

## 📂 Project Structure

```
.
├── backend/                           # FastAPI backend
│   ├── app/
│   │   ├── main.py                   # CORS setup and router includes
│   │   ├── config.py                 # Environment configuration
│   │   ├── api/
│   │   │   └── routes.py             # All API endpoints (candidate, interview, admin)
│   │   └── llm/
│   │       └── providers.py          # LLM provider abstraction (OpenRouter, Groq)
│   ├── run.py                        # ASGI entrypoint
│   ├── requirements.txt              # Python dependencies
│   ├── .env.example                  # Environment template
│   └── README.md                     # Backend-specific docs
├── frontend/                          # Vite + React app
│   ├── src/
│   │   ├── App.jsx                   # Route configuration and auth guard
│   │   ├── main.jsx                  # React root
│   │   ├── pages/
│   │   │   ├── Landing.jsx           # Public homepage
│   │   │   ├── auth/                 # Login/signup flows
│   │   │   ├── candidate/            # Candidate dashboard, interview, schedule
│   │   │   └── admin/                # Admin dashboard, candidate details
│   │   ├── components/               # Reusable UI components
│   │   ├── contexts/                 # AuthContext (user, role, session)
│   │   └── lib/                      # utilities (axios, supabase, storage)
│   ├── package.json                  # Node dependencies
│   ├── vite.config.js                # Vite config
│   └── README.md                     # Frontend-specific docs
├── supabase/
│   └── schema.sql                    # Database schema and migrations
├── vercel.json                       # Vercel deployment config
└── README.md                         # This file

```

## 🚀 Quick Start

### Prerequisites
- Python 3.11+
- Node.js 18+
- Git
- Supabase project (cloud or self-hosted)

### Backend Setup

```bash
# 1. Navigate to backend
cd backend

# 2. Create virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1  # Windows
source .venv/bin/activate      # macOS/Linux

# 3. Install dependencies
python -m pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your Supabase and LLM API keys

# 5. Apply database schema
psql -d your_supabase_url < ../supabase/schema.sql

# 6. Run backend
python -m uvicorn run:app --reload --host 127.0.0.1 --port 8000
```

### Frontend Setup

```bash
# 1. Navigate to frontend
cd frontend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Supabase credentials and API base URL

# 4. Start dev server
npm run dev
```

Access the app at http://localhost:5173

## 🔧 Development

### Backend

Run tests:
```bash
pytest backend/tests/ -v
```

Auto-reload on code changes:
```bash
python -m uvicorn --app-dir backend run:app --reload --port 8000
```

Key endpoints for testing:
- `POST /candidate/profile-upload` – Upload resume
- `POST /candidate/interview-session/start` – Begin interview
- `GET /admin/candidates` – List all candidates (admin only)
- `GET /admin/candidates/{id}` – Candidate details (admin only)

### Frontend

Run linter:
```bash
npm run lint
```

Run E2E tests:
```bash
npm run test:e2e
```

Key pages:
- `/` – Landing page
- `/login`, `/signup` – Auth flow
- `/candidate` – Candidate dashboard
- `/interview/live` – Live interview room
- `/admin` – Admin dashboard
- `/admin/candidate/:id` – Candidate details

### Environment Variables

**Backend** (`backend/.env`):
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=xxx
SUPABASE_SERVICE_ROLE_KEY=xxx
SUPABASE_DB_URL=postgresql://xxx
OPENROUTER_API_KEY=xxx
GROQ_API_KEY=xxx
INTERVIEW_TURN_PROVIDER=groq
GROQ_INTERVIEW_MAX_TOKENS=300
LLM_PROVIDER=openrouter
LLM_MODEL=openai/gpt-4o-mini
INTERVIEW_REALTIME_PROVIDER=openai
INTERVIEW_REALTIME_MODEL=gpt-4o-realtime-preview-2024-12-17
FRONTEND_ORIGIN=http://localhost:5173
```

**Frontend** (`frontend/.env`):
```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=xxx
VITE_API_BASE_URL=http://127.0.0.1:8000
```

## 🌐 Deployment

### Frontend (Vercel)

```bash
# Login to Vercel
npm install -g vercel
vercel login

# Deploy
vercel
```

Vercel config is in `vercel.json`. On every deploy:
1. Runs `cd frontend && npm install`
2. Builds with `cd frontend && npm run build`
3. Serves from `frontend/dist`
4. Rewrites all routes to `index.html` (SPA mode)

### Backend

Deploy FastAPI to your preferred host (AWS, Railway, Heroku, etc.):

```bash
# Example: Railway
# Ensure run.py and requirements.txt are in root or adjust build command

gunicorn --workers 4 --worker-class uvicorn.workers.UvicornWorker run:app
```

Ensure environment variables are set in your hosting platform.

## 📡 API Reference

See [backend/README.md](backend/README.md) for full endpoint documentation.

### Key Candidate Endpoints
- `POST /candidate/profile-upload` – Upload resume
- `POST /candidate/interview-session/start` – Start interview
- `POST /candidate/interview-session/respond` – Submit interview answer
- `POST /candidate/interview-session/{id}/complete` – Finalize interview

### Key Admin Endpoints
- `GET /admin/candidates` – Search and list candidates
- `GET /admin/candidates/{id}` – Get candidate details
- `POST /admin/candidates/{id}/stage` – Update candidate stage
- `POST /admin/candidates/bulk-stage` – Bulk update stages
- `POST /admin/interview-sessions/auto-complete-stale` – Recover stale sessions
- `GET /admin/background-jobs/{id}` – Poll background job status

## 🏗️ Architecture

### Authentication Flow
1. User signs up or logs in via Supabase Auth
2. Supabase returns JWT access token
3. Frontend includes token in `Authorization: Bearer <token>` header
4. Backend validates token with Supabase service role key

### Interview Flow
1. Candidate schedules or starts interview
2. Backend creates session and generates first question via LLM
3. Frontend opens WebSocket or establishes Realtime connection
4. Candidate responds via text or voice
5. Backend processes response, generates follow-up question
6. Loop continues until max questions or `INTERVIEW_COMPLETE` signal
7. Backend computes final score using LLM rubric evaluation
8. Result persisted to database

### Admin Operations
- **Search** – Filters candidates by name, skills, or stage
- **Bulk Updates** – Queues background job for stage updates
- **Playback** – Renders interview transcript and optionally video/audio
- **Stale Session Recovery** – Admin-triggered action to finalize abandoned sessions

### Reliability
- **Transcript Versioning** – Each turn increments version to prevent duplicate processing
- **Idempotent Completion** – Server-side `INTERVIEW_COMPLETE` detection prevents re-scoring
- **Retry Mechanisms** – Failed scoring can be retried from admin UI
- **Stale Session Auto-Complete** – Background job to gracefully finalize sessions idle beyond threshold

## ⚠️ Troubleshooting

### Backend won't start
```bash
# Check Python version
python --version

# Check dependencies
pip list | grep fastapi

# If uvicorn not found, use full venv path
.\backend\.venv\Scripts\python.exe -m uvicorn run:app --port 8000
```

### Frontend shows "API is not configured"
- Ensure `VITE_API_BASE_URL` is set in `frontend/.env`
- On localhost, auto-filled to `http://127.0.0.1:8000`
- On production Vercel, set via Vercel environment variables

### Interview timeout (408 error)
- Backend was performing expensive analysis during page load
- Fixed: Use "Generate AI Summary" button explicitly instead of auto-analysis
- Try refreshing the page after waiting 10 seconds

### Admin details page shows "Candidate details are unavailable"
- Ensure user is authenticated with an admin-marked account
- Backend validates `app_metadata.role == 'admin'` or email contains 'admin'
- Check that Supabase has the candidate record

### Database migrations not applied
```bash
# Apply schema manually
psql -U postgres -d your_db < supabase/schema.sql

# Or use Supabase dashboard SQL editor
# Copy contents of supabase/schema.sql and run
```

## 📝 License

Part of MSpectra Hackathon 2026 submission.
