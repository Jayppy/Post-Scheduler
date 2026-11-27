-- ============================================================================
-- 74 STUDIO SOCIAL HUB — ADDITIVE OAUTH STATE TABLE (PHASE 1 SECURITY)
-- Persists single-use, owner-bound, time-limited OAuth CSRF states in Supabase
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.oauth_states (
  state_hash TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube')),
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
  ON public.oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_owner
  ON public.oauth_states (owner_uid, platform, created_at DESC);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_isolation_policy ON public.oauth_states;
CREATE POLICY owner_isolation_policy
  ON public.oauth_states
  FOR ALL
  USING ((auth.jwt() ->> 'sub') = owner_uid)
  WITH CHECK ((auth.jwt() ->> 'sub') = owner_uid);
