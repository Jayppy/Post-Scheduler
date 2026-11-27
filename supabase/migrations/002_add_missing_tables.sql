-- ============================================================================
-- 74 STUDIO — SUPPLEMENTAL MIGRATION: CREATIVE STUDIO TABLES (social_posts, campaigns, design_themes, editing_presets)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_posts (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  platforms_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  caption TEXT NOT NULL DEFAULT '',
  hashtags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  media_asset_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  budget NUMERIC(12,2) DEFAULT 0,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.design_themes (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  name TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.editing_presets (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  name TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_social_posts_owner_updated ON public.social_posts (owner_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_owner_updated ON public.campaigns (owner_uid, updated_at DESC);

-- RLS & Policies
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.editing_presets ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['social_posts', 'campaigns', 'design_themes', 'editing_presets']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_isolation_policy ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_isolation_policy ON public.%I FOR ALL USING ((auth.jwt() ->> ''sub'') = owner_uid) WITH CHECK ((auth.jwt() ->> ''sub'') = owner_uid)',
      tbl
    );
  END LOOP;
END $$;
