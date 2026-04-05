from dataclasses import replace

from fastapi.testclient import TestClient
from fastapi import HTTPException

from app.main import app
from app.api import routes


client = TestClient(app)


def test_health_endpoint_returns_ok():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_is_admin_checks_metadata_and_email():
    assert routes._is_admin({"app_metadata": {"role": "admin"}})
    assert routes._is_admin({"user_metadata": {"role": "admin"}})
    assert routes._is_admin({"email": "lead.admin@example.com"})
    assert not routes._is_admin({"email": "candidate@example.com"})


def test_candidate_profile_upload_persists_resume_analysis_when_available(monkeypatch):
    persisted = {}

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "full_name": "Alice Candidate", "role": "candidate"}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path == "/rest/v1/profile_uploads?select=*" and method == "POST":
            return [
                {
                    "id": "upload-1",
                    "candidate_id": "candidate-1",
                    "file_name": "resume.pdf",
                    "file_path": "user-1/resumes/resume.pdf",
                    "file_url": "https://example.com/resume.pdf",
                    "mime_type": "application/pdf",
                    "file_size": 12345,
                    "status": "uploaded",
                }
            ]
        if path.startswith("/rest/v1/candidates?id=eq.candidate-1") and method == "PATCH":
            return None
        raise AssertionError(f"Unexpected request: {path} {method}")

    def fake_build_resume_analysis(candidate, latest_upload):
        assert candidate["id"] == "candidate-1"
        assert latest_upload["id"] == "upload-1"
        return {
            "ai_summary": "Strong backend fundamentals",
            "ai_score": 82,
            "ai_skills": ["Python", "FastAPI"],
        }

    def fake_persist_candidate_analysis(candidate_id, analysis):
        persisted["candidate_id"] = candidate_id
        persisted["analysis"] = analysis

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "_build_resume_analysis", fake_build_resume_analysis)
    monkeypatch.setattr(routes, "_persist_candidate_analysis", fake_persist_candidate_analysis)

    response = client.post(
        "/candidate/profile-upload",
        headers={"Authorization": "Bearer test-token"},
        json={
            "filename": "resume.pdf",
            "size": 12345,
            "type": "application/pdf",
            "filePath": "user-1/resumes/resume.pdf",
            "fileUrl": "https://example.com/resume.pdf",
            "targetRole": "Backend Developer",
            "submittedAt": "2026-04-04T00:00:00Z",
        },
    )

    assert response.status_code == 200
    assert persisted["candidate_id"] == "candidate-1"
    assert persisted["analysis"]["ai_score"] == 82
    assert response.json()["candidate"]["ai_score"] == 82


def test_admin_candidates_filters_by_stage(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/candidates?select=*&order=created_at.desc"):
            return [
                {
                    "id": "candidate-1",
                    "full_name": "Alice Candidate",
                    "role": "candidate",
                    "current_stage": "profile_pending",
                    "ai_score": 72,
                    "ai_skills": ["React"],
                },
                {
                    "id": "candidate-2",
                    "full_name": "Bob Builder",
                    "role": "candidate",
                    "current_stage": "rejected",
                    "ai_score": 35,
                    "ai_skills": ["Testing"],
                },
            ]
        if path.startswith("/rest/v1/profile_uploads?select=*&order=created_at.desc"):
            return []
        if path.startswith("/rest/v1/interview_artifacts?select=*&order=created_at.desc"):
            return [
                {"candidate_id": "candidate-1", "score_payload": {"overallScore": 81, "scoringStatus": "completed"}},
                {"candidate_id": "candidate-2", "score_payload": {"overallScore": 10, "scoringStatus": "pending"}},
            ]
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    response = client.get("/admin/candidates?stage=profile_pending", headers={"Authorization": "Bearer test-token"})

    assert response.status_code == 200
    payload = response.json()["candidates"]
    assert len(payload) == 1
    assert payload[0]["id"] == "candidate-1"
    assert payload[0]["score"] == 81
    assert payload[0]["stage"] == "profile_pending"


def test_admin_update_candidate_stage_updates_existing_candidate(monkeypatch):
    state = {
        "candidate-1": {
            "id": "candidate-1",
            "full_name": "Alice Candidate",
            "role": "candidate",
            "current_stage": "profile_pending",
        }
    }
    audit_log_calls = []

    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/candidates?id=eq.candidate-1&select=*") and method == "GET":
            return [state["candidate-1"]]
        if path.startswith("/rest/v1/candidates?id=eq.candidate-1") and method == "PATCH":
            state["candidate-1"] = {**state["candidate-1"], **(body or {})}
            return None
        if path.startswith("/rest/v1/profile_uploads?candidate_id=eq.candidate-1&select=*&order=created_at.desc"):
            return []
        if path.startswith("/rest/v1/interview_slots?candidate_id=eq.candidate-1&select=*&order=slot_time.asc"):
            return []
        if path.startswith("/rest/v1/interview_artifacts?candidate_id=eq.candidate-1&select=*"):
            return []
        if path.startswith("/rest/v1/admin_audit_logs?select=*") and method == "POST":
            audit_log_calls.append(body or {})
            return None
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    response = client.patch(
        "/admin/candidates/candidate-1/stage",
        headers={"Authorization": "Bearer test-token"},
        json={"stage": "under_review"},
    )

    assert response.status_code == 200
    assert response.json()["candidate"]["stage"] == "under_review"
    assert state["candidate-1"]["current_stage"] == "under_review"
    assert audit_log_calls[0]["action"] == "candidate_stage_updated"
    assert audit_log_calls[0]["entity_type"] == "candidate"


def test_admin_analyze_resume_can_queue_background_job(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    submitted = {}

    def fake_submit_background_job(job_type, handler, **context):
        submitted["job_type"] = job_type
        submitted["context"] = context
        return {"id": "job-123", "status": "queued", "type": job_type}

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_submit_background_job", fake_submit_background_job)

    response = client.post(
        "/admin/analyze-resume/candidate-1",
        headers={"Authorization": "Bearer test-token"},
        json={"force": True, "runInBackground": True},
    )

    assert response.status_code == 200
    assert response.json() == {"jobId": "job-123", "status": "queued", "type": "resume_analysis"}
    assert submitted["job_type"] == "resume_analysis"
    assert submitted["context"]["candidateId"] == "candidate-1"


def test_admin_cleanup_expired_interview_artifacts_writes_single_audit_log(monkeypatch):
    audit_log_calls = []

    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_artifacts?select=*&expires_at=lt.") and method == "GET":
            return []
        if path.startswith("/rest/v1/admin_audit_logs?select=*") and method == "POST":
            audit_log_calls.append(body or {})
            return None
        raise AssertionError(f"Unexpected request: {path} {method}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    response = client.post(
        "/admin/interview-artifacts/cleanup",
        headers={"Authorization": "Bearer test-token"},
        json={"limit": 25, "runInBackground": False},
    )

    assert response.status_code == 200
    assert response.json()["deletedArtifacts"] == 0
    assert response.json()["errors"] == []
    assert len(audit_log_calls) == 1
    assert audit_log_calls[0]["action"] == "interview_artifacts_cleanup_completed"
    assert audit_log_calls[0]["entity_type"] == "interview_artifact"
    assert audit_log_calls[0]["metadata"]["errors"] == 0


def test_admin_candidate_details_does_not_fail_when_resume_analysis_errors(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/candidates?id=eq.candidate-1&select=*") and method == "GET":
            return [
                {
                    "id": "candidate-1",
                    "full_name": "Alice Candidate",
                    "role": "candidate",
                    "current_stage": "profile_pending",
                    "ai_summary": None,
                }
            ]
        if path.startswith("/rest/v1/profile_uploads?candidate_id=eq.candidate-1&select=*&order=created_at.desc") and method == "GET":
            return [
                {
                    "id": "upload-1",
                    "candidate_id": "candidate-1",
                    "file_name": "resume.pdf",
                    "file_url": "https://example.com/resume.pdf",
                    "mime_type": "application/pdf",
                    "file_size": 12345,
                }
            ]
        if path.startswith("/rest/v1/interview_slots?candidate_id=eq.candidate-1&select=*&order=slot_time.asc") and method == "GET":
            return []
        if path.startswith("/rest/v1/interview_sessions?candidate_id=eq.candidate-1&select=*&order=started_at.desc") and method == "GET":
            return []
        if path.startswith("/rest/v1/interview_artifacts?candidate_id=eq.candidate-1&select=*&order=created_at.desc") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path} {method}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "_build_resume_analysis", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("llm down")))

    response = client.get("/admin/candidates/candidate-1", headers={"Authorization": "Bearer test-token"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["candidate"]["id"] == "candidate-1"
    assert payload["latestUpload"]["id"] == "upload-1"


def test_admin_audit_logs_endpoint_paginates(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/admin_audit_logs?select=*&order=created_at.desc"):
            return [
                {"id": "log-1", "action": "candidate_stage_updated", "entity_type": "candidate", "entity_id": "candidate-1", "actor_user_id": "admin-1", "actor_email": "admin@example.com", "metadata": {"stage": "under_review"}, "created_at": "2026-04-04T00:00:00Z"},
                {"id": "log-2", "action": "resume_analysis_completed", "entity_type": "candidate", "entity_id": "candidate-2", "actor_user_id": "admin-1", "actor_email": "admin@example.com", "metadata": {}, "created_at": "2026-04-04T00:01:00Z"},
            ]
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    response = client.get("/admin/audit-logs?page=1&pageSize=1", headers={"Authorization": "Bearer test-token"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["pagination"]["total"] == 2
    assert payload["pagination"]["totalPages"] == 2
    assert len(payload["logs"]) == 1
    assert payload["logs"][0]["id"] == "log-1"


def test_admin_analyze_resume_can_queue_background_job(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    submitted = {}

    def fake_submit_background_job(job_type, handler, **context):
        submitted["job_type"] = job_type
        submitted["context"] = context
        return {"id": "job-123", "status": "queued", "type": job_type}

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_submit_background_job", fake_submit_background_job)

    response = client.post(
        "/admin/analyze-resume/candidate-1",
        headers={"Authorization": "Bearer test-token"},
        json={"force": True, "runInBackground": True},
    )

    assert response.status_code == 200
    assert response.json() == {"jobId": "job-123", "status": "queued", "type": "resume_analysis"}
    assert submitted["job_type"] == "resume_analysis"
    assert submitted["context"]["candidateId"] == "candidate-1"


def test_admin_background_job_status_returns_job(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(
        routes,
        "_get_background_job",
        lambda job_id: {"id": job_id, "status": "completed", "type": "resume_analysis"},
    )

    response = client.get("/admin/background-jobs/job-123", headers={"Authorization": "Bearer test-token"})

    assert response.status_code == 200
    assert response.json()["id"] == "job-123"
    assert response.json()["status"] == "completed"


def test_candidate_realtime_token_returns_client_secret(monkeypatch):
    class FakeRealtimeProvider:
        def is_configured(self):
            return True

        def create_realtime_session(self, interview_role, interview_plan, resume_summary, include_client_secret=False):
            assert include_client_secret is True
            assert interview_role == "Backend Developer"
            assert isinstance(interview_plan, dict)
            assert isinstance(resume_summary, str)
            return {
                "id": "rt_123",
                "model": "gpt-4o-realtime-preview-2024-12-17",
                "expires_at": 1735689600,
                "client_secret": {"value": "ephemeral_secret_123"},
            }

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong API design and Python experience."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "get_llm_provider_by_name", lambda _provider_name: FakeRealtimeProvider())

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/realtime-token",
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 200
    realtime = response.json()["realtime"]
    assert realtime["clientSecret"] == "ephemeral_secret_123"
    assert realtime["maxQuestions"] == 6


def test_candidate_realtime_token_requires_in_progress_session(monkeypatch):
    class FakeRealtimeProvider:
        def is_configured(self):
            return True

        def create_realtime_session(self, interview_role, interview_plan, resume_summary, include_client_secret=False):
            raise AssertionError("Should not create realtime session when session is not in progress")

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Summary"}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "completed", "interview_role": "Backend Developer"}]
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "get_llm_provider_by_name", lambda _provider_name: FakeRealtimeProvider())

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/realtime-token",
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 409
    assert "in-progress" in response.json()["detail"]


def test_candidate_start_compat_get_endpoint_calls_start_with_default_consent(monkeypatch):
    captured = {}

    def fake_start(_request_obj, payload):
        captured["consent"] = payload.consentGiven
        return {"message": "Interview session started"}

    monkeypatch.setattr(routes, "candidate_interview_session_start", fake_start)

    response = client.get(
        "/candidate/interview-session/start",
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "Interview session started"
    assert captured["consent"] is True


def test_candidate_respond_compat_endpoint_falls_back_to_placeholder_session_id(monkeypatch):
    captured = {}

    def fake_next_question(_request_obj, session_id, payload):
        captured["session_id"] = session_id
        captured["questions_asked"] = payload.questionsAsked
        captured["turn_count"] = len(payload.transcriptTurns or [])
        return {
            "completed": False,
            "question": "Q1/6: Tell me about yourself.",
            "questionNumber": 1,
            "maxQuestions": 6,
            "transcriptVersion": 1,
        }

    monkeypatch.setattr(routes, "candidate_interview_session_next_question", fake_next_question)

    response = client.post(
        "/candidate/interview-session/respond",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 0, "transcriptTurns": []},
    )

    assert response.status_code == 200
    assert captured["session_id"] == "00000000-0000-0000-0000-000000000000"
    assert captured["questions_asked"] == 0
    assert captured["turn_count"] == 0
    assert response.json()["questionNumber"] == 1


def test_candidate_end_compat_endpoint_uses_latest_in_progress_session(monkeypatch):
    captured = {}

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1"}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if (
            path.startswith("/rest/v1/interview_sessions?")
            and "candidate_id=eq.candidate-1" in path
            and "status=eq.in_progress" in path
            and method == "GET"
        ):
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress"}]
        raise AssertionError(f"Unexpected request: {path} {method}")

    def fake_terminate(_request_obj, session_id, payload):
        captured["session_id"] = session_id
        captured["reason"] = payload.reason
        return {
            "message": "Interview session terminated",
            "sessionId": session_id,
            "reason": payload.reason,
            "endedAt": "2026-04-05T00:00:00Z",
        }

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "candidate_interview_session_terminate", fake_terminate)

    response = client.get(
        "/candidate/interview-session/end",
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 200
    assert captured["session_id"] == "11111111-1111-1111-1111-111111111111"
    assert captured["reason"] == "manual_end"
    assert response.json()["sessionId"] == "11111111-1111-1111-1111-111111111111"


def test_candidate_complete_endpoint_is_idempotent_for_completed_session(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1"}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "status": "completed",
                    "consent_given": True,
                    "ended_at": "2026-04-04T10:00:00Z",
                }
            ]
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/complete",
        headers={"Authorization": "Bearer test-token"},
        json={},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["sessionId"] == "11111111-1111-1111-1111-111111111111"


def test_candidate_groq_next_question_returns_dynamic_prompt(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python and REST fundamentals."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))
    monkeypatch.setattr(routes, "get_llm_provider_by_name", lambda _provider_name: (_ for _ in ()).throw(AssertionError("LLM provider should not be called for LeetCode question selection")))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 1, "transcriptTurns": []},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["completed"] is False
    assert payload["questionNumber"] == 2
    assert payload["maxQuestions"] == 6
    assert payload["question"].startswith("Q2/6:")
    assert "Coding question:" not in payload["question"]
    assert "LeetCode" not in payload["question"]


def test_candidate_groq_next_question_avoids_repeating_same_leetcode_problem(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python and REST fundamentals."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={
            "questionsAsked": 1,
            "transcriptTurns": [
                {
                    "speaker": "ai",
                    "text": "Q1/6: LeetCode 1 - Two Sum (Easy): Describe approach.",
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["questionNumber"] == 2
    assert payload["question"].startswith("Q2/6:")
    assert "Two Sum" not in payload["question"]


def test_candidate_groq_next_question_prefers_backend_relevant_problem(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python, Redis caching, and API design fundamentals."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 1, "transcriptTurns": []},
    )

    assert response.status_code == 200
    assert response.json()["question"].startswith("Q2/6:")


def test_candidate_next_question_groq_mode_enforces_token_limit_and_auto_completes(monkeypatch):
    class FakeGroqProvider:
        def is_configured(self):
            return True

        def chat_completion(self, payload, timeout_seconds=60):
            assert payload["max_tokens"] == 300
            return {
                "choices": [
                    {
                        "message": {
                            "content": "INTERVIEW_COMPLETE",
                        }
                    }
                ]
            }

    finalized = {}

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python and REST fundamentals."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    def fake_finalize_interview_session_from_transcript(session_id, candidate, session_row, transcript_turns, completion_reason):
        finalized["session_id"] = session_id
        finalized["candidate_id"] = candidate["id"]
        finalized["completion_reason"] = completion_reason
        finalized["turn_count"] = len(transcript_turns)
        return {"sessionId": session_id, "status": "completed", "scoringStatus": "completed"}

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq", interview_turn_provider="groq", groq_interview_max_tokens=300))
    monkeypatch.setattr(routes, "get_llm_provider_by_name", lambda provider_name: FakeGroqProvider() if provider_name == "groq" else None)
    monkeypatch.setattr(routes, "_finalize_interview_session_from_transcript", fake_finalize_interview_session_from_transcript)

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 1, "transcriptTurns": [{"speaker": "candidate", "text": "answer"}]},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["completed"] is True
    assert payload["autoCompleted"] is True
    assert payload["scoringStatus"] == "completed"
    assert finalized["completion_reason"] == "interview_complete_sentinel"


def test_candidate_next_question_returns_transcript_version(monkeypatch):
    calls = []

    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python and REST fundamentals."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    def fake_upsert_interview_transcript_snapshot(session_id, candidate_id, transcript_turns, transcript_value=None, requested_version=None):
        calls.append({"session_id": session_id, "candidate_id": candidate_id, "turn_count": len(transcript_turns)})
        return True, 10 if len(calls) > 1 else 9

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "_upsert_interview_transcript_snapshot", fake_upsert_interview_transcript_snapshot)
    monkeypatch.setattr(routes, "_generate_next_interview_question_from_leetcode", lambda **_kwargs: "Q2/6: Explain API versioning strategy.")
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_turn_provider="heuristic"))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={
            "questionsAsked": 1,
            "transcriptTurns": [
                {"speaker": "ai", "text": "Q1/6: Intro question"},
                {"speaker": "candidate", "text": "My answer"},
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["completed"] is False
    assert payload["transcriptVersion"] == 10
    assert len(calls) == 2


def test_finalize_interview_session_from_transcript_is_idempotent_when_already_completed(monkeypatch):
    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?id=eq.session-1&candidate_id=eq.candidate-1") and method == "GET":
            return [{"id": "session-1", "status": "completed"}]
        if path.startswith("/rest/v1/interview_artifacts?session_id=eq.session-1&candidate_id=eq.candidate-1") and method == "GET":
            return [{"id": "artifact-1", "score_payload": {"scoringStatus": "completed"}}]
        raise AssertionError(f"Unexpected request: {path} {method}")

    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    result = routes._finalize_interview_session_from_transcript(
        session_id="session-1",
        candidate={"id": "candidate-1"},
        session_row={"id": "session-1", "status": "completed"},
        transcript_turns=[],
        completion_reason="interview_complete_sentinel",
    )

    assert result["sessionId"] == "session-1"
    assert result["status"] == "completed"
    assert result["scoringStatus"] == "completed"
    assert result["idempotent"] is True


def test_admin_autocomplete_stale_interview_sessions_completes_sessions(monkeypatch):
    finalized = []

    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_finalize_interview_session_from_transcript(session_id, candidate, session_row, transcript_turns, completion_reason):
        finalized.append(
            {
                "session_id": session_id,
                "candidate_id": candidate["id"],
                "completion_reason": completion_reason,
                "turn_count": len(transcript_turns),
            }
        )
        return {"sessionId": session_id, "status": "completed", "scoringStatus": "completed"}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?status=eq.in_progress") and method == "GET":
            return [{"id": "session-1", "candidate_id": "candidate-1", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/candidates?id=eq.candidate-1") and method == "GET":
            return [{"id": "candidate-1", "ai_score": 80}]
        if path.startswith("/rest/v1/interview_artifacts?session_id=eq.session-1&candidate_id=eq.candidate-1") and method == "GET":
            return [{"id": "artifact-1", "score_payload": {"transcriptTurns": [{"speaker": "candidate", "text": "Answer"}]}}]
        if path.startswith("/rest/v1/admin_audit_logs?select=*") and method == "POST":
            return None
        raise AssertionError(f"Unexpected request: {path} {method}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "_finalize_interview_session_from_transcript", fake_finalize_interview_session_from_transcript)

    response = client.post(
        "/admin/interview-sessions/auto-complete-stale",
        headers={"Authorization": "Bearer test-token"},
        json={"limit": 10, "idleMinutes": 30, "runInBackground": False},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["evaluated"] == 1
    assert payload["completedSessions"] == 1
    assert payload["pendingSessions"] == 0
    assert len(finalized) == 1
    assert finalized[0]["completion_reason"] == "stale_session_timeout"


def test_admin_autocomplete_stale_interview_sessions_can_queue_background_job(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "admin-1", "email": "admin@example.com", "app_metadata": {"role": "admin"}}

    def fake_submit_background_job(job_type, handler, **context):
        return {"id": "job-xyz", "status": "queued", "type": job_type, "context": context}

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_submit_background_job", fake_submit_background_job)
    monkeypatch.setattr(routes, "_record_admin_audit_log", lambda *_args, **_kwargs: None)

    response = client.post(
        "/admin/interview-sessions/auto-complete-stale",
        headers={"Authorization": "Bearer test-token"},
        json={"limit": 25, "idleMinutes": 45, "runInBackground": True},
    )

    assert response.status_code == 200
    assert response.json() == {"jobId": "job-xyz", "status": "queued", "type": "stale_interview_autocomplete"}


def test_finalize_interview_session_from_transcript_sets_pending_when_scoring_fails(monkeypatch):
    captured_post = {}
    session_get_calls = {"count": 0}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?id=eq.session-2&candidate_id=eq.candidate-2") and method == "GET":
            session_get_calls["count"] += 1
            if session_get_calls["count"] == 1:
                return [{"id": "session-2", "status": "in_progress", "interview_role": "Backend Developer"}]
            return [{"id": "session-2", "status": "completed", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/interview_artifacts?session_id=eq.session-2&candidate_id=eq.candidate-2") and method == "GET":
            return []
        if path.startswith("/rest/v1/interview_sessions?id=eq.session-2&status=eq.in_progress") and method == "PATCH":
            return None
        if path.startswith("/rest/v1/interview_artifacts?select=*") and method == "POST":
            captured_post["body"] = body or {}
            return [{"id": "artifact-new"}]
        raise AssertionError(f"Unexpected request: {path} {method}")

    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "_build_interview_scoring_rubric", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider down")))

    result = routes._finalize_interview_session_from_transcript(
        session_id="session-2",
        candidate={"id": "candidate-2", "ai_score": 77},
        session_row={"id": "session-2", "status": "in_progress", "interview_role": "Backend Developer"},
        transcript_turns=[{"speaker": "candidate", "text": "answer"}],
        completion_reason="interview_complete_sentinel",
    )

    assert result["status"] == "completed"
    assert result["scoringStatus"] == "pending"
    assert result["idempotent"] is False
    score_payload = captured_post["body"]["score_payload"]
    assert score_payload["scoringStatus"] == "pending"


def test_candidate_next_question_switches_to_role_theory_after_three_questions(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Built backend APIs for analytics workflows."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return [
                {
                    "parsed_data": {
                        "job_title": "Senior Backend Engineer",
                        "required_skills": ["Python", "System Design"],
                        "key_responsibilities": ["design scalable APIs"],
                    }
                }
            ]
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 3, "transcriptTurns": []},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["questionNumber"] == 4
    assert payload["question"].startswith("Q4/6:")
    assert "Senior Backend Engineer" in payload["question"]


def test_candidate_next_question_first_three_coding_questions_are_distinct(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Backend API and distributed systems experience."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    q1 = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 0, "transcriptTurns": []},
    )
    q2 = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 1, "transcriptTurns": []},
    )
    q3 = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 2, "transcriptTurns": []},
    )

    assert q1.status_code == 200
    assert q2.status_code == 200
    assert q3.status_code == 200

    q1_text = q1.json()["question"]
    q2_text = q2.json()["question"]
    q3_text = q3.json()["question"]

    assert q1_text != q2_text
    assert q2_text != q3_text
    assert q1_text != q3_text


def test_candidate_next_question_uses_transcript_when_client_counter_is_stale(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Backend API and distributed systems experience."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?") and method == "GET":
            return [{"id": "11111111-1111-1111-1111-111111111111", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    response = client.post(
        "/candidate/interview-session/11111111-1111-1111-1111-111111111111/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={
            "questionsAsked": 0,
            "transcriptTurns": [
                {"speaker": "ai", "text": "Q1/6: Explain your approach and complexity trade-offs."}
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["questionNumber"] == 2


def test_candidate_next_question_falls_back_to_latest_in_progress_session(monkeypatch):
    def fake_get_supabase_user(_access_token):
        return {"id": "user-1", "email": "candidate@example.com"}

    def fake_get_or_create_candidate(_user):
        return {"id": "candidate-1", "ai_summary": "Strong Python and API design."}

    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        if path.startswith("/rest/v1/interview_sessions?id=eq.") and method == "GET":
            return []
        if (
            path.startswith("/rest/v1/interview_sessions?")
            and "candidate_id=eq.candidate-1" in path
            and "status=eq.in_progress" in path
            and method == "GET"
        ):
            return [{"id": "fallback-session", "status": "in_progress", "interview_role": "Backend Developer"}]
        if path.startswith("/rest/v1/job_specifications?") and method == "GET":
            return []
        raise AssertionError(f"Unexpected request: {path}")

    monkeypatch.setattr(routes, "_get_supabase_user", fake_get_supabase_user)
    monkeypatch.setattr(routes, "_get_or_create_candidate", fake_get_or_create_candidate)
    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)
    monkeypatch.setattr(routes, "settings", replace(routes.settings, interview_realtime_provider="groq"))

    response = client.post(
        "/candidate/interview-session/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/next-question",
        headers={"Authorization": "Bearer test-token"},
        json={"questionsAsked": 0, "transcriptTurns": []},
    )

    assert response.status_code == 200
    assert response.json()["questionNumber"] == 1
    assert response.json()["question"].startswith("Q1/6:")


def test_get_supabase_user_returns_503_on_supabase_network_error(monkeypatch):
    def fake_supabase_request(path, method="GET", body=None, bearer_token=None, use_service_role=False):
        raise routes.SupabaseError("supabase_network_error: [WinError 10054] connection reset")

    monkeypatch.setattr(routes, "_supabase_request", fake_supabase_request)

    try:
        routes._get_supabase_user("token")
        assert False, "Expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 503
        assert "temporarily unavailable" in str(exc.detail).lower()