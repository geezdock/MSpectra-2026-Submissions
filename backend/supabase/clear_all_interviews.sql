-- Clear all interviews and candidates from Supabase
-- WARNING: This deletes all candidate data, uploads, interview sessions, and artifacts
-- Run this in the Supabase SQL editor if you need to reset everything for testing

-- Delete in dependency order (respecting foreign key constraints)
-- Delete logs first
DELETE FROM public.interview_artifact_deletion_log;

-- Delete artifacts and upload nonces (reference interview_sessions and candidates)
DELETE FROM public.interview_artifacts;
DELETE FROM public.interview_upload_nonces;

-- Delete interview sessions and slots (reference candidates)
DELETE FROM public.interview_sessions;
DELETE FROM public.interview_slots;

-- Delete files and specifications (reference candidates)
DELETE FROM public.job_specifications;
DELETE FROM public.profile_uploads;

-- Delete candidates last
DELETE FROM public.candidates;

-- Confirm deletion
SELECT 'All interview and candidate data cleared' as status;
