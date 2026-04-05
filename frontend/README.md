# Frontend – JARVIS AI Recruiter

React 19 + Vite frontend for candidate interviews, profile management, and admin operations.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Pages & Routes](#pages--routes)
- [Environment Configuration](#environment-configuration)
- [Development](#development)
- [API Integration](#api-integration)
- [Authentication](#authentication)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Configure environment
# Edit .env with Supabase credentials and backend API URL
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=xxx
VITE_API_BASE_URL=http://127.0.0.1:8000

# 4. Start dev server
npm run dev
```

Server runs at `http://localhost:5173`

## 📂 Project Structure

```
frontend/
├── src/
│   ├── App.jsx                          # Main router and route guards
│   ├── index.css                        # Global styles
│   ├── main.jsx                         # React root
│   ├── App.css                          # App-level styles
│   ├── pages/
│   │   ├── Landing.jsx                 # Public landing page
│   │   ├── auth/
│   │   │   ├── Login.jsx               # Login form
│   │   │   └── Signup.jsx              # Registration form
│   │   ├── candidate/
│   │   │   ├── Dashboard.jsx           # Candidate home (profile, schedule, history)
│   │   │   ├── ProfileUpload.jsx       # Resume upload UI
│   │   │   ├── Schedule.jsx            # Interview scheduling
│   │   │   └── Interview.jsx           # Live interview room
│   │   └── admin/
│   │       ├── Dashboard.jsx           # Admin candidate list, search, bulk actions
│   │       └── CandidateDetails.jsx    # Candidate details, interview playback
│   ├── components/
│   │   ├── layout/
│   │   │   └── Navbar.jsx              # Navigation bar
│   │   └── ui/
│   │       ├── Button.jsx              # Reusable button
│   │       ├── Card.jsx                # Card container
│   │       └── Input.jsx               # Form input
│   ├── contexts/
│   │   └── AuthContext.jsx             # User auth state (user, role, session)
│   ├── lib/
│   │   ├── axios.js                    # Axios instance with interceptors
│   │   ├── supabase.js                 # Supabase client
│   │   ├── cn.js                       # Classname utility
│   │   ├── interviewRoles.js           # Interview role constants
│   │   └── resumeStorage.js            # Local resume upload tracking
│   └── assets/                         # Images, fonts, static files
├── tests/
│   └── e2e/
│       └── interview-auto-flow.spec.js # End-to-end Playwright tests
├── public/                             # Static assets
├── package.json                        # Dependencies and scripts
├── vite.config.js                      # Vite build config
├── eslint.config.js                    # Linter rules
├── playwright.config.js                # E2E test config
└── README.md                          # This file
```

## 🗺️ Pages & Routes

### Public Routes
- `/` – Landing page with signup/login links
- `/login` – User login form
- `/signup` – User registration form

### Protected Candidate Routes (role: `candidate`)
- `/candidate` – Candidate dashboard (profile, scheduled interviews, history)
- `/profile-upload` – Resume upload interface
- `/interview` – Interview schedule and booking
- `/interview/live` – Live interview room (voice/text interaction)

### Protected Admin Routes (role: `admin`)
- `/admin` – Admin dashboard (search, filter, bulk updates)
- `/admin/candidate/:id` – Candidate details and interview playback

### Special Routes
- `/dashboard` – Redirects to correct dashboard based on user role

## ⚙️ Environment Configuration

Create `frontend/.env`:

```bash
# Supabase
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key

# Backend API
VITE_API_BASE_URL=http://127.0.0.1:8000

# Interview configuration
VITE_AI_INTERVIEW_OUTPUT_MODE=browser_tts  # or realtime_voice, browser_text
```

### Variables Explained

| Variable | Purpose | Example |
|----------|---------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Public JWT key | `eyJhbG...` |
| `VITE_API_BASE_URL` | Backend API endpoint | `http://127.0.0.1:8000` or `https://api.example.com` |
| `VITE_AI_INTERVIEW_OUTPUT_MODE` | Interview voice mode | `browser_tts` (OpenAI), `realtime_voice`, or `browser_text` |

## 🔧 Development

### Available Scripts

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Lint code
npm run lint

# Run end-to-end tests
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui
```

### Live Reload
Hot module replacement (HMR) is enabled by default. Changes to components auto-reload in browser.

### Debugging
Browser DevTools:
1. Visit http://localhost:5173
2. Open DevTools (F12)
3. Check Console for errors and Network tab for API calls
4. Use React DevTools extension for component inspection

## 🔗 API Integration

### Axios Configuration

All API calls use `lib/axios.js` instance:

```javascript
import api from '../../lib/axios';

// GET request
const response = await api.get('/admin/candidates');

// POST request
const response = await api.post('/candidate/profile-upload', {
  filename: 'resume.pdf',
  ...
});
```

### Interceptors

**Request Interceptor:**
- Auto-injects Supabase bearer token if available
- Throws error if API is not configured on non-localhost

**Response Interceptor:**
- Transforms HTTP errors into readable error messages
- Handles:
  - 401/403 (auth errors)
  - 404 (not found)
  - 500 (server errors)
  - Network errors (timeouts, CORS, connection refused)
  - CORS errors

### Error Messages

Common error patterns:

```javascript
// Network error
"Network Error: Cannot connect to backend at http://127.0.0.1:8000"

// Timeout
"408 Timeout: Request took too long. Backend may not be responding."

// Auth error
"Unauthorized: 401 - Your session has expired or is invalid."

// Server error
"Server Error: 500 - The server encountered an error. Check backend logs."
```

## 🔐 Authentication

### Auth Flow

1. User signs up or logs in via Supabase Auth (email/password)
2. Supabase returns JWT access token
3. Token stored in local browser session (Supabase SDK)
4. `AuthContext` provides token to entire app
5. API requests include token in `Authorization: Bearer <token>` header

### AuthContext

Located in `contexts/AuthContext.jsx`. Provides:

```javascript
const {
  user,              // Supabase user object
  role,              // 'admin' or 'candidate'
  displayName,       // Derived from user metadata
  isAdmin,           // Boolean
  isCandidate,       // Boolean
  loading,           // Auth is initializing
  login,             // (email, password) => Promise
  signup,            // (email, password, role, firstName, lastName) => Promise
  logout,            // () => Promise
  interviewLock,     // Session lock to prevent accidental page leave during interview
} = useAuth();
```

### Role Derivation

```javascript
// Priority order:
1. user.app_metadata.role (Supabase admin flag)
2. user.user_metadata.role (from signup form)
3. Email contains 'admin' -> admin role
4. Default: candidate
```

### Protected Routes

`App.jsx` wraps routes in `ProtectedRoute`:

```javascript
<Route
  path="/admin"
  element={
    <ProtectedRoute allowedRoles={['admin']}>
      <AdminDashboard />
    </ProtectedRoute>
  }
/>
```

Redirects to `/login` if not authenticated, or `/` if role mismatch.

## 📱 Key Pages

### Landing (`pages/Landing.jsx`)
- Public page
- Links to login/signup
- Project overview

### Login/Signup (`pages/auth/`)
- Email/password forms
- Password validation
- Supabase auth integration

### Candidate Dashboard (`pages/candidate/Dashboard.jsx`)
- Shows scheduled interviews
- Links to profile upload and interview schedule
- Interview history with scores

### Profile Upload (`pages/candidate/ProfileUpload.jsx`)
- Drag-and-drop resume upload
- File validation (PDF, DOCX)
- Metadata: target role, submission timestamp

### Interview Schedule (`pages/candidate/Schedule.jsx`)
- Available interview slots
- Booking UI
- Confirmation flow

### Live Interview (`pages/candidate/Interview.jsx`)
- Real-time interviewer interaction
- Question display and answer input
- Transcript recording
- Session management (resume on refresh)

### Admin Dashboard (`pages/admin/Dashboard.jsx`)
- Search candidates by name/skills
- Filter by stage or score range
- Bulk stage updates
- Stale session auto-complete
- Background job progress tracking

### Candidate Details (`pages/admin/CandidateDetails.jsx`)
- Candidate profile (name, scores, stage)
- Resume preview and AI analysis
- Interview role override
- Interview history and playback
- Video/audio review
- Manual retry scoring

## 🧪 Testing

### E2E Tests (Playwright)

```bash
npm run test:e2e
```

Tests in `tests/e2e/`:
- Candidate interview flow (start, respond, complete)
- Auth flow (signup, login, logout)
- Admin dashboard operations

### Manual Testing Checklist

1. **Auth**
   - [ ] Signup with new email
   - [ ] Login with existing user
   - [ ] Logout clears session
   - [ ] Protected route redirects if not logged in

2. **Profile Upload**
   - [ ] Upload PDF resume
   - [ ] Set target role
   - [ ] Success message and redirect

3. **Interview**
   - [ ] Start interview from candidate dashboard
   - [ ] Answer interview questions
   - [ ] Complete interview
   - [ ] View score and transcript

4. **Admin**
   - [ ] Search candidates
   - [ ] Filter by stage
   - [ ] View candidate details
   - [ ] Update candidate stage
   - [ ] Bulk update candidates
   - [ ] View interview playback

## 🐛 Troubleshooting

### "API is not configured"
- Check `VITE_API_BASE_URL` in `.env`
- On localhost: auto-filled to `http://127.0.0.1:8000`
- On Vercel: set via environment variables in project settings

### Frontend can't reach backend
- Ensure backend is running on configured port
- Check CORS headers in backend logs
- Verify `VITE_API_BASE_URL` matches backend host

### "Your session has expired"
- Token is invalid or expired
- Log in again to get fresh token
- Check Supabase credentials in `.env`

### Blank page or infinite loading
- Check browser console for errors
- Clear browser cache (Ctrl+Shift+Delete or Cmd+Shift+Delete)
- Check that `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are valid

### Network errors during interview
- Check backend is running
- Verify `VITE_API_BASE_URL` is correct
- Interview timeout: backend may be busy, retry after waiting

### Build errors
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
npm run build
```

## 📦 Dependencies

Key libraries:

| Package | Purpose |
|---------|---------|
| `react` | UI framework |
| `react-router-dom` | Client-side routing |
| `@supabase/supabase-js` | Supabase auth and DB |
| `axios` | HTTP client |
| `tailwindcss` | CSS framework |
| `framer-motion` | Animations |
| `lucide-react` | Icons |
| `react-hot-toast` | Toast notifications |
| `@playwright/test` | E2E testing |

See `package.json` for full list and versions.

## 🚀 Deployment

### Vercel

1. Push code to GitHub
2. Import project in Vercel
3. Set environment variables (same as `.env`)
4. Deploy

Vercel config in `vercel.json`:
- Build: `cd frontend && npm run build`
- Output: `frontend/dist`
- SPA rewrite: all routes → `index.html`

### Other Hosts

```bash
npm run build
# Upload `dist/` folder to static host
```

Ensure environment variables are set in host provider.
