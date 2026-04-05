#!/usr/bin/env python3
"""
Script to clear all interview sessions and artifacts for candidates.
This removes all interview data from the database.
"""

import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(__file__))

from app.config import settings
from app.api.routes import _supabase_request


def clear_all_interviews():
    """Delete all interview sessions and artifacts."""
    
    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("❌ Error: Supabase credentials not configured")
        return False
    
    try:
        # First, get count of sessions to be deleted
        print("📊 Checking interview data...")
        sessions_response = _supabase_request(
            "/rest/v1/interview_sessions?select=id",
            method="GET",
            bearer_token=settings.supabase_service_role_key,
            use_service_role=True,
        )
        
        session_count = len(sessions_response) if isinstance(sessions_response, list) else 0
        print(f"   Found {session_count} interview sessions")
        
        artifacts_response = _supabase_request(
            "/rest/v1/interview_artifacts?select=id",
            method="GET",
            bearer_token=settings.supabase_service_role_key,
            use_service_role=True,
        )
        
        artifact_count = len(artifacts_response) if isinstance(artifacts_response, list) else 0
        print(f"   Found {artifact_count} interview artifacts")
        
        if session_count == 0 and artifact_count == 0:
            print("✅ No interview data to clear")
            return True
        
        # Confirm before deleting
        response = input(f"\n⚠️  This will delete {session_count} sessions and {artifact_count} artifacts. Continue? (yes/no): ")
        if response.lower() != "yes":
            print("❌ Cancelled")
            return False
        
        # Delete interview artifacts first (foreign key constraint)
        if artifact_count > 0:
            print(f"\n🗑️  Deleting {artifact_count} interview artifacts...")
            # Delete all artifacts where id is not null (effectively all)
            delete_artifacts = _supabase_request(
                "/rest/v1/interview_artifacts?id=not.is.null",
                method="DELETE",
                bearer_token=settings.supabase_service_role_key,
                use_service_role=True,
            )
            print("   ✓ Artifacts deleted")
        
        # Delete interview sessions
        if session_count > 0:
            print(f"🗑️  Deleting {session_count} interview sessions...")
            # Delete all sessions where id is not null (effectively all)
            delete_sessions = _supabase_request(
                "/rest/v1/interview_sessions?id=not.is.null",
                method="DELETE",
                bearer_token=settings.supabase_service_role_key,
                use_service_role=True,
            )
            print("   ✓ Sessions deleted")
        
        print("\n✅ All interview data cleared successfully!")
        return True
        
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return False


if __name__ == "__main__":
    success = clear_all_interviews()
    sys.exit(0 if success else 1)
