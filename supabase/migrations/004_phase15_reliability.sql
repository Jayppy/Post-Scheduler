-- ============================================================================
-- 74 STUDIO SOCIAL HUB & BEHIND THE RELEASE — PHASE 1.5 RELIABILITY MIGRATION
-- Strictly additive schema, RPCs, indexes, and permissions for multi-instance
-- Cloud Run durability, upload chunk integrity, and publishing idempotency.
-- Zero destructive DDL: safe for Phase 1 code compatibility & revision rollback.
-- ============================================================================

-- 1. Additive columns on existing tables (preserving all existing columns & rows)
ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS preserved_media_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS media_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS public_base_url TEXT;

ALTER TABLE public.video_projects
  ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS workflow_stage TEXT NOT NULL DEFAULT 'script';

ALTER TABLE public.video_scripts
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.video_renders
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT DEFAULT 'video-studio',
  ADD COLUMN IF NOT EXISTS sha256 TEXT;

-- Verified index on existing publish_history.timestamp column (defined in 001_unified_schema.sql)
CREATE INDEX IF NOT EXISTS idx_publish_history_owner_ts
  ON public.publish_history (owner_uid, workspace_id, timestamp DESC);

-- ============================================================================
-- 2. Durable Video Upload Sessions (cross-instance chunked upload + SHA-256)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.video_upload_sessions (
  upload_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  project_id TEXT NOT NULL,
  render_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('mp4', 'webm')),
  mime_type TEXT NOT NULL,
  total_chunks INTEGER NOT NULL CHECK (total_chunks >= 1 AND total_chunks <= 256),
  total_bytes BIGINT NOT NULL CHECK (total_bytes > 0),
  expected_sha256 TEXT,
  assembled_sha256 TEXT,
  storage_bucket TEXT NOT NULL DEFAULT 'video-studio',
  storage_path TEXT,
  bytes_uploaded BIGINT,
  received_chunks_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('active', 'completing', 'completed', 'expired', 'failed')),
  completion_lease_token TEXT,
  completion_lease_expires_at TIMESTAMPTZ,
  chunks_cleaned_at TIMESTAMPTZ,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_owner_status
  ON public.video_upload_sessions (owner_uid, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_project
  ON public.video_upload_sessions (owner_uid, project_id, render_id);

ALTER TABLE public.video_upload_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_isolation_policy ON public.video_upload_sessions;
CREATE POLICY owner_isolation_policy
  ON public.video_upload_sessions
  FOR ALL
  USING ((auth.jwt() ->> 'sub') = owner_uid)
  WITH CHECK ((auth.jwt() ->> 'sub') = owner_uid);

-- ============================================================================
-- 3. Distributed Publishing Idempotency & Lease Lock Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.publish_idempotency (
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube')),
  job_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('publishing', 'published', 'failed', 'needs_reconciliation')
  ),
  lock_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  in_flight_id TEXT,
  platform_post_id TEXT,
  result_url TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, workspace_id, post_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_publish_idempotency_status_lease
  ON public.publish_idempotency (status, lease_expires_at);

ALTER TABLE public.publish_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_isolation_policy ON public.publish_idempotency;
CREATE POLICY owner_isolation_policy
  ON public.publish_idempotency
  FOR ALL
  USING ((auth.jwt() ->> 'sub') = owner_uid)
  WITH CHECK ((auth.jwt() ->> 'sub') = owner_uid);

-- ============================================================================
-- 4. Video Upload Session Atomic RPCs
-- ============================================================================

-- 4A. Atomically enforce max active/completing upload sessions per owner + create session
CREATE OR REPLACE FUNCTION public.create_video_upload_session(
  p_upload_id TEXT,
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_project_id TEXT,
  p_render_id TEXT,
  p_format TEXT,
  p_mime_type TEXT,
  p_total_chunks INTEGER,
  p_total_bytes BIGINT,
  p_expected_sha256 TEXT DEFAULT NULL,
  p_max_concurrent INTEGER DEFAULT 3,
  p_ttl_seconds INTEGER DEFAULT 1800
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_active_count INTEGER := 0;
  v_ttl INTEGER := GREATEST(60, LEAST(86400, COALESCE(p_ttl_seconds, 1800)));
  v_max INTEGER := GREATEST(1, LEAST(10, COALESCE(p_max_concurrent, 3)));
BEGIN
  IF COALESCE(trim(p_upload_id), '') = ''
     OR COALESCE(trim(p_owner_uid), '') = ''
     OR COALESCE(trim(p_project_id), '') = ''
     OR COALESCE(trim(p_render_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'error', 'Missing required upload session fields.');
  END IF;

  IF p_format NOT IN ('mp4', 'webm') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_FORMAT', 'error', 'Format must be mp4 or webm.');
  END IF;

  -- Owner-level advisory lock guarantees atomic concurrency checks across instances
  PERFORM pg_advisory_xact_lock(hashtext('video_upload_owner:' || p_owner_uid));

  -- Mark genuinely overdue active sessions expired without touching active/completed ones
  UPDATE public.video_upload_sessions
  SET status = 'expired',
      updated_at = v_now
  WHERE owner_uid = p_owner_uid
    AND status = 'active'
    AND expires_at <= v_now;

  SELECT COUNT(*)::INTEGER
  INTO v_active_count
  FROM public.video_upload_sessions
  WHERE owner_uid = p_owner_uid
    AND (
      (status = 'active' AND expires_at > v_now)
      OR (
        status = 'completing'
        AND (
          completion_lease_expires_at IS NULL
          OR completion_lease_expires_at > v_now
          OR expires_at > v_now
        )
      )
    );

  IF v_active_count >= v_max THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UPLOAD_CONCURRENCY_LIMIT',
      'active_count', v_active_count,
      'max_concurrent', v_max
    );
  END IF;

  INSERT INTO public.video_upload_sessions (
    upload_id,
    owner_uid,
    workspace_id,
    project_id,
    render_id,
    format,
    mime_type,
    total_chunks,
    total_bytes,
    expected_sha256,
    storage_bucket,
    status,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    p_upload_id,
    p_owner_uid,
    COALESCE(NULLIF(trim(p_workspace_id), ''), 'ws-behind-the-release'),
    p_project_id,
    p_render_id,
    p_format,
    p_mime_type,
    p_total_chunks,
    p_total_bytes,
    NULLIF(trim(COALESCE(p_expected_sha256, '')), ''),
    'video-studio',
    'active',
    v_now + make_interval(secs => v_ttl),
    v_now,
    v_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'upload_id', p_upload_id,
    'active_count', v_active_count + 1,
    'expires_at', v_now + make_interval(secs => v_ttl)
  );
END;
$$;

-- 4B. Atomically record chunk metadata + SHA-256 with idempotent retry & conflict rejection
CREATE OR REPLACE FUNCTION public.record_video_upload_chunk(
  p_upload_id TEXT,
  p_owner_uid TEXT,
  p_project_id TEXT,
  p_chunk_index INTEGER,
  p_chunk_size BIGINT,
  p_chunk_sha256 TEXT,
  p_object_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_sess public.video_upload_sessions%ROWTYPE;
  v_idx_key TEXT := p_chunk_index::TEXT;
  v_existing JSONB;
  v_existing_bytes BIGINT := 0;
  v_next_chunks JSONB;
  v_received_count INTEGER := 0;
BEGIN
  IF COALESCE(trim(p_chunk_sha256), '') = '' OR length(trim(p_chunk_sha256)) <> 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CHUNK_SHA256', 'error', 'Valid 64-hex SHA-256 digest required.');
  END IF;

  SELECT *
  INTO v_sess
  FROM public.video_upload_sessions
  WHERE upload_id = p_upload_id
    AND owner_uid = p_owner_uid
    AND project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_NOT_FOUND', 'error', 'Upload session not found.');
  END IF;

  IF v_sess.status IN ('completing', 'completed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UPLOAD_LOCKED',
      'status', v_sess.status,
      'error', 'Upload session is locked (' || v_sess.status || ').'
    );
  END IF;

  IF v_sess.status = 'expired' OR v_sess.expires_at <= v_now THEN
    UPDATE public.video_upload_sessions
    SET status = 'expired', updated_at = v_now
    WHERE upload_id = p_upload_id;
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_EXPIRED', 'error', 'Upload session has expired.');
  END IF;

  IF p_chunk_index < 0 OR p_chunk_index >= v_sess.total_chunks THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CHUNK_INDEX', 'error', 'Chunk index out of bounds.');
  END IF;

  IF p_chunk_size <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CHUNK_SIZE', 'error', 'Chunk size must be positive.');
  END IF;

  v_existing := v_sess.received_chunks_json -> v_idx_key;
  IF v_existing IS NOT NULL THEN
    IF COALESCE((v_existing ->> 'size')::BIGINT, -1) = p_chunk_size
       AND lower(COALESCE(v_existing ->> 'sha256', '')) = lower(p_chunk_sha256) THEN
      SELECT COUNT(*)::INTEGER INTO v_received_count
      FROM jsonb_object_keys(v_sess.received_chunks_json);
      UPDATE public.video_upload_sessions
      SET updated_at = v_now
      WHERE upload_id = p_upload_id;
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'chunk_index', p_chunk_index,
        'received_count', v_received_count,
        'total_chunks', v_sess.total_chunks
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'CHUNK_CONFLICT',
        'error', 'Conflicting chunk payload supplied for already-recorded chunk index.'
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM((kv.val ->> 'size')::BIGINT), 0)
  INTO v_existing_bytes
  FROM jsonb_each(v_sess.received_chunks_json) AS kv(key, val)
  WHERE kv.key <> v_idx_key;

  IF v_existing_bytes + p_chunk_size > v_sess.total_bytes THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CHUNK_OVERFLOW',
      'error', 'Cumulative chunk bytes exceed declared total_bytes.'
    );
  END IF;

  v_next_chunks := jsonb_set(
    v_sess.received_chunks_json,
    ARRAY[v_idx_key],
    jsonb_build_object(
      'size', p_chunk_size,
      'sha256', lower(p_chunk_sha256),
      'objectPath', p_object_path,
      'uploadedAt', v_now
    ),
    true
  );

  UPDATE public.video_upload_sessions
  SET received_chunks_json = v_next_chunks,
      status = 'active',
      updated_at = v_now
  WHERE upload_id = p_upload_id;

  SELECT COUNT(*)::INTEGER INTO v_received_count
  FROM jsonb_object_keys(v_next_chunks);

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'chunk_index', p_chunk_index,
    'received_count', v_received_count,
    'total_chunks', v_sess.total_chunks
  );
END;
$$;

-- 4C. Acquire distributed completion lease for video upload assembly
CREATE OR REPLACE FUNCTION public.acquire_video_upload_completion_lease(
  p_upload_id TEXT,
  p_owner_uid TEXT,
  p_project_id TEXT,
  p_lease_token TEXT,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_lease_sec INTEGER := GREATEST(30, LEAST(900, COALESCE(p_lease_seconds, 120)));
  v_sess public.video_upload_sessions%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_lease_token), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'invalid', 'error', 'Completion lease token is required.');
  END IF;

  SELECT *
  INTO v_sess
  FROM public.video_upload_sessions
  WHERE upload_id = p_upload_id
    AND owner_uid = p_owner_uid
    AND project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_found', 'error', 'Upload session not found.');
  END IF;

  IF v_sess.status = 'completed' AND v_sess.storage_path IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'already_completed',
      'session', to_jsonb(v_sess)
    );
  END IF;

  IF v_sess.status = 'completing'
     AND v_sess.completion_lease_expires_at IS NOT NULL
     AND v_sess.completion_lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'ok', false,
      'outcome', 'in_progress',
      'lease_expires_at', v_sess.completion_lease_expires_at
    );
  END IF;

  IF v_sess.status = 'expired' OR (v_sess.status = 'active' AND v_sess.expires_at <= v_now) THEN
    UPDATE public.video_upload_sessions
    SET status = 'expired',
        completion_lease_token = NULL,
        completion_lease_expires_at = NULL,
        updated_at = v_now
    WHERE upload_id = p_upload_id;
    RETURN jsonb_build_object('ok', false, 'outcome', 'expired', 'error', 'Upload session expired before completion.');
  END IF;

  UPDATE public.video_upload_sessions
  SET status = 'completing',
      completion_lease_token = p_lease_token,
      completion_lease_expires_at = v_now + make_interval(secs => v_lease_sec),
      updated_at = v_now
  WHERE upload_id = p_upload_id
  RETURNING * INTO v_sess;

  RETURN jsonb_build_object(
    'ok', true,
    'outcome', 'acquired',
    'lease_token', p_lease_token,
    'session', to_jsonb(v_sess)
  );
END;
$$;

-- 4D. Finalize upload completion (verify completion lease token; preserve chunks on failure)
CREATE OR REPLACE FUNCTION public.finalize_video_upload_session(
  p_upload_id TEXT,
  p_owner_uid TEXT,
  p_lease_token TEXT,
  p_success BOOLEAN,
  p_storage_path TEXT DEFAULT NULL,
  p_bytes_uploaded BIGINT DEFAULT NULL,
  p_assembled_sha256 TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_sess public.video_upload_sessions%ROWTYPE;
BEGIN
  SELECT *
  INTO v_sess
  FROM public.video_upload_sessions
  WHERE upload_id = p_upload_id
    AND owner_uid = p_owner_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_NOT_FOUND');
  END IF;

  IF v_sess.status = 'completed' AND p_success THEN
    RETURN jsonb_build_object('ok', true, 'status', 'completed', 'session', to_jsonb(v_sess));
  END IF;

  IF v_sess.status <> 'completing' OR COALESCE(v_sess.completion_lease_token, '') <> COALESCE(p_lease_token, '') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LEASE_TOKEN_MISMATCH',
      'error', 'Completion lease token missing or superseded.'
    );
  END IF;

  IF p_success THEN
    UPDATE public.video_upload_sessions
    SET status = 'completed',
        storage_path = p_storage_path,
        bytes_uploaded = p_bytes_uploaded,
        assembled_sha256 = p_assembled_sha256,
        error_message = NULL,
        completion_lease_token = NULL,
        completion_lease_expires_at = NULL,
        updated_at = v_now
    WHERE upload_id = p_upload_id
    RETURNING * INTO v_sess;

    RETURN jsonb_build_object('ok', true, 'status', 'completed', 'session', to_jsonb(v_sess));
  ELSE
    UPDATE public.video_upload_sessions
    SET status = CASE WHEN expires_at > v_now THEN 'active' ELSE 'failed' END,
        error_message = p_error_message,
        completion_lease_token = NULL,
        completion_lease_expires_at = NULL,
        updated_at = v_now
    WHERE upload_id = p_upload_id
    RETURNING * INTO v_sess;

    RETURN jsonb_build_object('ok', true, 'status', v_sess.status, 'session', to_jsonb(v_sess));
  END IF;
END;
$$;

-- 4E. Idempotently record cloud chunk deletion after storage + DB persistence verification
CREATE OR REPLACE FUNCTION public.mark_video_upload_chunks_cleaned(
  p_upload_id TEXT,
  p_owner_uid TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  UPDATE public.video_upload_sessions
  SET chunks_cleaned_at = COALESCE(chunks_cleaned_at, v_now),
      updated_at = v_now
  WHERE upload_id = p_upload_id
    AND owner_uid = p_owner_uid
    AND status = 'completed';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_COMPLETED');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 5. Complete Distributed Publishing Idempotency Lifecycle RPCs
-- ============================================================================

-- 5A. Acquire atomic destination publish lock (expired lease with in_flight_id -> needs_reconciliation)
CREATE OR REPLACE FUNCTION public.acquire_publish_destination_lock(
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_post_id TEXT,
  p_platform TEXT,
  p_job_id TEXT,
  p_lock_token TEXT,
  p_lease_seconds INTEGER DEFAULT 600
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_lease_sec INTEGER := GREATEST(60, LEAST(1800, COALESCE(p_lease_seconds, 600)));
  v_row public.publish_idempotency%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_owner_uid), '') = ''
     OR COALESCE(trim(p_workspace_id), '') = ''
     OR COALESCE(trim(p_post_id), '') = ''
     OR COALESCE(trim(p_lock_token), '') = ''
     OR p_platform NOT IN ('instagram', 'youtube') THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'invalid', 'error', 'Invalid publish lock parameters.');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('pub:' || p_owner_uid || ':' || p_workspace_id || ':' || p_post_id || ':' || p_platform)
  );

  SELECT *
  INTO v_row
  FROM public.publish_idempotency
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.publish_idempotency (
      owner_uid,
      workspace_id,
      post_id,
      platform,
      job_id,
      status,
      lock_token,
      lease_expires_at,
      in_flight_id,
      attempts,
      created_at,
      updated_at
    )
    VALUES (
      p_owner_uid,
      p_workspace_id,
      p_post_id,
      p_platform,
      NULLIF(trim(COALESCE(p_job_id, '')), ''),
      'publishing',
      p_lock_token,
      v_now + make_interval(secs => v_lease_sec),
      NULL,
      1,
      v_now,
      v_now
    )
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'acquired',
      'lock_token', p_lock_token,
      'lease_expires_at', v_row.lease_expires_at,
      'attempts', v_row.attempts
    );
  END IF;

  IF v_row.status = 'published' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'outcome', 'already_published',
      'platform_post_id', v_row.platform_post_id,
      'result_url', v_row.result_url,
      'published_at', v_row.published_at
    );
  END IF;

  IF v_row.status = 'needs_reconciliation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'outcome', 'needs_reconciliation',
      'in_flight_id', v_row.in_flight_id,
      'last_error', v_row.last_error
    );
  END IF;

  IF v_row.status = 'publishing' THEN
    IF v_row.lease_expires_at IS NOT NULL AND v_row.lease_expires_at > v_now THEN
      RETURN jsonb_build_object(
        'ok', false,
        'outcome', 'in_progress',
        'lease_expires_at', v_row.lease_expires_at,
        'in_flight_id', v_row.in_flight_id
      );
    END IF;

    -- Expired lease with an existing in_flight_id MUST require reconciliation before retry
    IF COALESCE(trim(v_row.in_flight_id), '') <> '' THEN
      UPDATE public.publish_idempotency
      SET status = 'needs_reconciliation',
          lock_token = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(
            NULLIF(v_row.last_error, ''),
            'Publishing lease expired after recording an in-flight platform upload ID; reconciliation required before retry.'
          ),
          updated_at = v_now
      WHERE owner_uid = p_owner_uid
        AND workspace_id = p_workspace_id
        AND post_id = p_post_id
        AND platform = p_platform
      RETURNING * INTO v_row;

      RETURN jsonb_build_object(
        'ok', false,
        'outcome', 'needs_reconciliation',
        'in_flight_id', v_row.in_flight_id,
        'last_error', v_row.last_error
      );
    END IF;
  END IF;

  -- Status is either 'failed' or expired 'publishing' with NULL in_flight_id: safe to acquire
  IF v_row.status = 'failed' AND COALESCE(trim(v_row.in_flight_id), '') <> '' THEN
    UPDATE public.publish_idempotency
    SET status = 'needs_reconciliation',
        lock_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE owner_uid = p_owner_uid
      AND workspace_id = p_workspace_id
      AND post_id = p_post_id
      AND platform = p_platform
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'ok', false,
      'outcome', 'needs_reconciliation',
      'in_flight_id', v_row.in_flight_id,
      'last_error', v_row.last_error
    );
  END IF;

  UPDATE public.publish_idempotency
  SET status = 'publishing',
      job_id = COALESCE(NULLIF(trim(COALESCE(p_job_id, '')), ''), v_row.job_id),
      lock_token = p_lock_token,
      lease_expires_at = v_now + make_interval(secs => v_lease_sec),
      in_flight_id = NULL,
      last_error = NULL,
      attempts = v_row.attempts + 1,
      updated_at = v_now
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'outcome', 'acquired',
    'lock_token', p_lock_token,
    'lease_expires_at', v_row.lease_expires_at,
    'attempts', v_row.attempts
  );
END;
$$;

-- 5B. Atomically record in_flight_id ONLY when caller presents valid active lock_token
CREATE OR REPLACE FUNCTION public.record_publish_in_flight_id(
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_post_id TEXT,
  p_platform TEXT,
  p_lock_token TEXT,
  p_in_flight_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row public.publish_idempotency%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_in_flight_id), '') = '' OR COALESCE(trim(p_lock_token), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'error', 'Lock token and in_flight_id are required.');
  END IF;

  UPDATE public.publish_idempotency
  SET in_flight_id = p_in_flight_id,
      updated_at = v_now
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
    AND status = 'publishing'
    AND lock_token = p_lock_token
    AND (lease_expires_at IS NULL OR lease_expires_at > v_now)
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LOCK_TOKEN_MISMATCH',
      'error', 'Cannot record in_flight_id: publish lock expired, already finalized, or token mismatch.'
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'in_flight_id', v_row.in_flight_id);
END;
$$;

-- 5C. Atomically complete publishing success (requires matching lock_token)
CREATE OR REPLACE FUNCTION public.complete_publish_destination_success(
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_post_id TEXT,
  p_platform TEXT,
  p_lock_token TEXT,
  p_platform_post_id TEXT,
  p_result_url TEXT DEFAULT NULL,
  p_published_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row public.publish_idempotency%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_lock_token), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LOCK_TOKEN_MISMATCH', 'error', 'Lock token is required.');
  END IF;

  UPDATE public.publish_idempotency
  SET status = 'published',
      lock_token = NULL,
      lease_expires_at = NULL,
      platform_post_id = p_platform_post_id,
      result_url = p_result_url,
      last_error = NULL,
      published_at = COALESCE(p_published_at, v_now),
      updated_at = v_now
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
    AND status = 'publishing'
    AND lock_token = p_lock_token
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LOCK_TOKEN_MISMATCH',
      'error', 'Cannot complete publish: lock token mismatch or state changed.'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'published',
    'platform_post_id', v_row.platform_post_id,
    'result_url', v_row.result_url,
    'published_at', v_row.published_at
  );
END;
$$;

-- 5D. Atomically record publishing failure (or transition to needs_reconciliation when ambiguous)
CREATE OR REPLACE FUNCTION public.fail_publish_destination(
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_post_id TEXT,
  p_platform TEXT,
  p_lock_token TEXT,
  p_error TEXT,
  p_requires_reconciliation BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row public.publish_idempotency%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF COALESCE(trim(p_lock_token), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LOCK_TOKEN_MISMATCH', 'error', 'Lock token is required.');
  END IF;

  SELECT *
  INTO v_row
  FROM public.publish_idempotency
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'publishing' OR COALESCE(v_row.lock_token, '') <> p_lock_token THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LOCK_TOKEN_MISMATCH',
      'error', 'Cannot record failure: lock token mismatch or state changed.'
    );
  END IF;

  IF p_requires_reconciliation AND COALESCE(trim(v_row.in_flight_id), '') <> '' THEN
    v_next_status := 'needs_reconciliation';
  ELSE
    v_next_status := 'failed';
  END IF;

  UPDATE public.publish_idempotency
  SET status = v_next_status,
      lock_token = NULL,
      lease_expires_at = NULL,
      in_flight_id = CASE WHEN v_next_status = 'needs_reconciliation' THEN v_row.in_flight_id ELSE NULL END,
      last_error = p_error,
      updated_at = v_now
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_row.status,
    'in_flight_id', v_row.in_flight_id,
    'last_error', v_row.last_error
  );
END;
$$;

-- 5E. Reconcile an interrupted / ambiguous operation safely
CREATE OR REPLACE FUNCTION public.reconcile_publish_destination(
  p_owner_uid TEXT,
  p_workspace_id TEXT,
  p_post_id TEXT,
  p_platform TEXT,
  p_reconciled_published BOOLEAN,
  p_platform_post_id TEXT DEFAULT NULL,
  p_result_url TEXT DEFAULT NULL,
  p_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_row public.publish_idempotency%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('pub:' || p_owner_uid || ':' || p_workspace_id || ':' || p_post_id || ':' || p_platform)
  );

  SELECT *
  INTO v_row
  FROM public.publish_idempotency
  WHERE owner_uid = p_owner_uid
    AND workspace_id = p_workspace_id
    AND post_id = p_post_id
    AND platform = p_platform
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_reconciled_published THEN
      INSERT INTO public.publish_idempotency (
        owner_uid,
        workspace_id,
        post_id,
        platform,
        status,
        platform_post_id,
        result_url,
        published_at,
        created_at,
        updated_at
      )
      VALUES (
        p_owner_uid,
        p_workspace_id,
        p_post_id,
        p_platform,
        'published',
        p_platform_post_id,
        p_result_url,
        v_now,
        v_now,
        v_now
      )
      RETURNING * INTO v_row;
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'published',
        'platform_post_id', v_row.platform_post_id,
        'result_url', v_row.result_url,
        'published_at', v_row.published_at
      );
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;

  IF v_row.status = 'published' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'published',
      'platform_post_id', v_row.platform_post_id,
      'result_url', v_row.result_url,
      'published_at', v_row.published_at
    );
  END IF;

  IF v_row.status = 'publishing' AND v_row.lease_expires_at IS NOT NULL AND v_row.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ACTIVE_LEASE_IN_PROGRESS',
      'error', 'Cannot reconcile while an active publish lease is still running.'
    );
  END IF;

  IF p_reconciled_published THEN
    UPDATE public.publish_idempotency
    SET status = 'published',
        lock_token = NULL,
        lease_expires_at = NULL,
        platform_post_id = COALESCE(NULLIF(trim(COALESCE(p_platform_post_id, '')), ''), v_row.in_flight_id),
        result_url = COALESCE(p_result_url, v_row.result_url),
        last_error = NULL,
        published_at = COALESCE(v_row.published_at, v_now),
        updated_at = v_now
    WHERE owner_uid = p_owner_uid
      AND workspace_id = p_workspace_id
      AND post_id = p_post_id
      AND platform = p_platform
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.publish_idempotency
    SET status = 'failed',
        lock_token = NULL,
        lease_expires_at = NULL,
        in_flight_id = NULL,
        last_error = p_detail,
        updated_at = v_now
    WHERE owner_uid = p_owner_uid
      AND workspace_id = p_workspace_id
      AND post_id = p_post_id
      AND platform = p_platform
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_row.status,
    'platform_post_id', v_row.platform_post_id,
    'result_url', v_row.result_url,
    'published_at', v_row.published_at,
    'last_error', v_row.last_error
  );
END;
$$;

-- ============================================================================
-- 6. Restrictive RPC Execution Permissions (service_role only)
-- ============================================================================
REVOKE ALL ON FUNCTION public.create_video_upload_session(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_video_upload_session(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT, INTEGER, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.record_video_upload_chunk(TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_video_upload_chunk(TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.acquire_video_upload_completion_lease(TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_video_upload_completion_lease(TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_video_upload_session(TEXT, TEXT, TEXT, BOOLEAN, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_video_upload_session(TEXT, TEXT, TEXT, BOOLEAN, TEXT, BIGINT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.mark_video_upload_chunks_cleaned(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_video_upload_chunks_cleaned(TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.acquire_publish_destination_lock(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_publish_destination_lock(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.record_publish_in_flight_id(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_publish_in_flight_id(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_publish_destination_success(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_publish_destination_success(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION public.fail_publish_destination(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_publish_destination(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_publish_destination(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_publish_destination(TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;
