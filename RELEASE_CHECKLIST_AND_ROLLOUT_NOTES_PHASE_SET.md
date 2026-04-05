# Release Checklist and Rollout Notes (Interview Reliability Phase Set)

Date: 2026-04-05

## Scope Included

- Admin dashboard action to trigger stale in-progress interview auto-complete.
- Backend stale-session auto-complete endpoint (sync and background queue).
- Candidate interview reconnect continuity (transcript turn/version restore).
- Server-side interview auto-complete on sentinel/question-limit with scoring status propagation.

## Code Changes in This Release

- Frontend admin action and job/result visibility:
  - `frontend/src/pages/admin/Dashboard.jsx`
- Backend stale-session endpoint and finalization hardening:
  - `backend/app/api/routes.py`
- Runtime config for Groq turn mode token cap:
  - `backend/app/config.py`
  - `backend/.env.example`
- Reliability tests:
  - `backend/tests/test_routes.py`
- Backend operations docs:
  - `backend/README.md`

## Pre-Release Checklist

1. Confirm backend environment variables are set:
   - `INTERVIEW_TURN_PROVIDER=groq` (or `heuristic` if intentionally disabled)
   - `GROQ_INTERVIEW_MAX_TOKENS=300`
   - Provider keys configured for Groq and OpenRouter chain.
2. Confirm frontend API target:
   - `VITE_API_BASE_URL` points to backend.
3. Confirm DB schema/tables are present and accessible:
   - `interview_sessions`, `interview_artifacts`, `admin_background_jobs`, `admin_audit_logs`.
4. Confirm admin users have role metadata recognized by backend.
5. Confirm stale session policy for ops:
   - Idle window (default 30 minutes) and batch size (default 100).

## Automated Smoke Evidence Executed

Executed in workspace during this release preparation:

1. Backend full regression:
   - Command: `python -m pytest -q`
   - Result: `26 passed`
2. Focused reliability smoke for reconnect/auto-complete:
   - Command: `python -m pytest -q tests/test_routes.py::test_candidate_next_question_returns_transcript_version tests/test_routes.py::test_candidate_next_question_groq_mode_enforces_token_limit_and_auto_completes tests/test_routes.py::test_admin_autocomplete_stale_interview_sessions_completes_sessions tests/test_routes.py::test_admin_autocomplete_stale_interview_sessions_can_queue_background_job`
   - Result: `4 passed`
3. Frontend build validation:
   - Command: `npm run build`
   - Result: successful production build.
4. Runtime availability checks:
   - `GET /health` returned `{\"status\":\"ok\"}`.
   - Frontend dev server responded with HTTP 200.

## Manual End-to-End Smoke Script (Ops)

Run this once in staging before production rollout.

1. Candidate reconnect continuity
   - Start an interview as a candidate.
   - Answer at least one question.
   - Force reconnect path (refresh browser tab or close/reopen interview page).
   - Expected:
     - Previous transcript turns reappear.
     - Question count resumes from persisted state.
     - No duplicate or reset turn history.
2. Server auto-complete behavior
   - Continue interview until either:
     - backend returns sentinel completion, or
     - question limit is reached.
   - Expected:
     - Session transitions to `completed`.
     - Candidate receives completion UX message.
     - Scoring status returned as `completed` or `pending`.
3. Admin stale-session recovery action
   - In Admin Dashboard, use `Interview Reliability` panel.
   - Trigger `Auto-Complete Stale` in:
     - `Background` mode first, then
     - `Sync` mode for a small batch.
   - Expected:
     - Background mode returns a job id and visible status.
     - Completed run shows evaluated/completed/pending/error counts.
     - Target stale sessions exit `in_progress` status.
4. Auditability and observability
   - Verify audit entries are created for queued/completed stale auto-complete runs.
   - Verify background job status endpoint returns final state and result payload.

## Rollout Plan

1. Deploy backend first.
2. Run `/health` and one admin stale-session sync dry run with small `limit` (for example 5).
3. Deploy frontend.
4. Verify new Admin Dashboard action appears and can queue a background run.
5. Run staged manual smoke script above.
6. Increase stale-session cleanup run limit to normal operational value.

## Monitoring and Alerts (First 24 Hours)

1. Track stale-session auto-complete outcomes:
   - completed vs pending ratio.
2. Watch errors from:
   - interview finalization,
   - scoring provider unavailability,
   - background job failures.
3. Track candidate interview completion latency.
4. Review admin audit logs for action frequency and anomalies.

## Rollback Plan

1. Frontend rollback:
   - Revert `frontend/src/pages/admin/Dashboard.jsx` to previous release tag.
2. Backend rollback:
   - Revert `backend/app/api/routes.py` and `backend/app/config.py` to previous release tag.
3. Config rollback (safe mode):
   - Set `INTERVIEW_TURN_PROVIDER=heuristic` if Groq turn path instability appears.
4. Operational fallback:
   - Keep stale-session completion manual via API scripts until issue is resolved.

## Post-Release Follow-Ups

1. Add dashboard inline history for last N stale-session runs.
2. Add alert thresholds for pending scoring backlog growth.
3. Add explicit E2E browser automation for reconnect + auto-complete path (Playwright/Cypress).
