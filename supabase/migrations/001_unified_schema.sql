-- ============================================================================
-- 74 STUDIO SOCIAL HUB & BEHIND THE RELEASE — AUTHORITATIVE SUPABASE SCHEMA
-- Preserves Firebase Authentication UID (`owner_uid TEXT`) for user isolation
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Business Workspaces & Brand Profiles
CREATE TABLE IF NOT EXISTS public.workspaces (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  business_workspace TEXT NOT NULL CHECK (business_workspace IN ('behind-the-release', '74-studio-sales')),
  name TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  aesthetic_style TEXT DEFAULT '',
  brand_voice TEXT DEFAULT '',
  watermark_text TEXT DEFAULT '',
  default_theme_id TEXT DEFAULT '',
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 2. Encrypted OAuth Connections (Server-side TOKEN_ENCRYPTION_KEY encrypted blobs only)
CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube')),
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_handle TEXT,
  encrypted_access_token_json JSONB NOT NULL,
  encrypted_refresh_token_json JSONB,
  token_type TEXT,
  expires_at BIGINT,
  last_error TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id),
  UNIQUE (owner_uid, workspace_id, platform)
);

-- 3. Scheduled Publishing Jobs & History
CREATE TABLE IF NOT EXISTS public.scheduled_jobs (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  platforms_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  destinations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  caption TEXT NOT NULL DEFAULT '',
  hashtags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  youtube_privacy_status TEXT,
  scheduled_iso TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  campaign_id TEXT,
  media_asset_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ,
  platform_post_id TEXT,
  result_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.publish_history (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  job_id TEXT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  platform_post_id TEXT,
  result_url TEXT,
  error TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 4. Behind The Release Creative Studio & Hub Assets
CREATE TABLE IF NOT EXISTS public.creative_projects (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  project_type TEXT NOT NULL,
  theme_id TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.media_assets (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_bucket TEXT,
  storage_path TEXT,
  public_url TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_export_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 5. 74 STUDIO Marketing Content Studio (Workspace A)
CREATE TABLE IF NOT EXISTS public.marketing_knowledge_bases (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.marketing_research_sources (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  category TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  access_method TEXT NOT NULL,
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.marketing_drafts (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  draft_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 6. Multi-Provider AI Manager Profiles & Quota Usage
CREATE TABLE IF NOT EXISTS public.ai_provider_profiles (
  workspace_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, workspace_id)
);

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  bucket_period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  fallbacks_triggered INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 7. 74 STUDIO Sales Intelligence — Chat-First Assistant + Archived Legacy Records
CREATE TABLE IF NOT EXISTS public.sales_knowledge_bases (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  config_json JSONB NOT NULL,
  settings_json JSONB NOT NULL DEFAULT '{"promoEnabled": true, "promoPercentage": 10, "promoLabel": "10% off all orders", "promoScope": "all orders including custom quotes", "enforceLowercase": true}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.sales_conversations (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  title TEXT NOT NULL,
  artist_name TEXT,
  last_message_preview TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.sales_messages (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  role TEXT NOT NULL CHECK (role IN ('artist', 'assistant')),
  content TEXT NOT NULL,
  artist_note TEXT,
  attachment_name TEXT,
  attachment_url TEXT,
  provider_id TEXT,
  model TEXT,
  was_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- Archived legacy CRM records (preserved permanently without deletion)
CREATE TABLE IF NOT EXISTS public.sales_legacy_leads (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'archived',
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.sales_legacy_outputs (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  lead_id TEXT NOT NULL,
  output_type TEXT NOT NULL,
  title TEXT NOT NULL,
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.sales_legacy_activities (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-74-studio-sales',
  activity_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  record_json JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- 8. Behind The Release Video Studio Module (Workspace A)
CREATE TABLE IF NOT EXISTS public.video_projects (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws-behind-the-release',
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  audience TEXT DEFAULT '',
  visual_style TEXT NOT NULL CHECK (visual_style IN ('stickman', 'cartoon-2d', 'motion-graphics', 'hybrid')),
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  target_duration_sec INTEGER NOT NULL DEFAULT 75,
  fps INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft',
  script_approved BOOLEAN NOT NULL DEFAULT FALSE,
  storyboard_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  audio_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_scripts (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  project_id TEXT NOT NULL,
  hook_line TEXT NOT NULL DEFAULT '',
  full_script TEXT NOT NULL DEFAULT '',
  closing_cta TEXT NOT NULL DEFAULT '',
  provider_id TEXT,
  model TEXT,
  was_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_scenes (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scene_order INTEGER NOT NULL,
  visual_style TEXT NOT NULL,
  duration_sec NUMERIC(6,2) NOT NULL DEFAULT 6.0,
  narration_text TEXT NOT NULL DEFAULT '',
  on_screen_text TEXT NOT NULL DEFAULT '',
  stickman_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cartoon_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  motion_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  subtitle_words_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  transition_type TEXT NOT NULL DEFAULT 'crossfade',
  background_preset TEXT NOT NULL DEFAULT 'obsidian-grid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_assets (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('audio', 'bgm', 'sfx', 'image', 'character', 'prop', 'render')),
  mime_type TEXT NOT NULL,
  storage_path TEXT,
  public_url TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_renders (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  project_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'mp4',
  width INTEGER NOT NULL DEFAULT 1080,
  height INTEGER NOT NULL DEFAULT 1920,
  fps INTEGER NOT NULL DEFAULT 30,
  duration_sec NUMERIC(6,2) NOT NULL DEFAULT 75,
  status TEXT NOT NULL DEFAULT 'queued',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_path TEXT,
  output_url TEXT,
  file_size_bytes BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_templates (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  visual_style TEXT NOT NULL,
  category TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

CREATE TABLE IF NOT EXISTS public.video_provider_usage (
  id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  requests_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_uid, id)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_sales_conv_owner_updated ON public.sales_conversations (owner_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_msg_conv ON public.sales_messages (owner_uid, conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_mkt_drafts_owner_updated ON public.marketing_drafts (owner_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_jobs_owner_due ON public.scheduled_jobs (owner_uid, workspace_id, scheduled_iso);
CREATE INDEX IF NOT EXISTS idx_video_projects_owner_updated ON public.video_projects (owner_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_scenes_proj ON public.video_scenes (owner_uid, project_id, scene_order ASC);
CREATE INDEX IF NOT EXISTS idx_video_renders_proj ON public.video_renders (owner_uid, project_id, created_at DESC);

-- Enable Row Level Security (Compatible with Firebase Auth JWT sub claim & Service Role)
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publish_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_legacy_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_legacy_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_legacy_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_provider_usage ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'workspaces',
    'oauth_connections',
    'scheduled_jobs',
    'publish_history',
    'creative_projects',
    'media_assets',
    'marketing_knowledge_bases',
    'marketing_research_sources',
    'marketing_drafts',
    'ai_provider_profiles',
    'ai_usage_logs',
    'sales_knowledge_bases',
    'sales_conversations',
    'sales_messages',
    'sales_legacy_leads',
    'sales_legacy_outputs',
    'sales_legacy_activities',
    'video_projects',
    'video_scripts',
    'video_scenes',
    'video_assets',
    'video_renders',
    'video_templates',
    'video_provider_usage'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_isolation_policy ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_isolation_policy ON public.%I FOR ALL USING ((auth.jwt() ->> ''sub'') = owner_uid) WITH CHECK ((auth.jwt() ->> ''sub'') = owner_uid)',
      tbl
    );
  END LOOP;
END $$;

-- Provision Storage Buckets Idempotently
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('social-media', 'social-media', false),
  ('marketing-assets', 'marketing-assets', false),
  ('sales-attachments', 'sales-attachments', false),
  ('generated-content', 'generated-content', false),
  ('user-uploads', 'user-uploads', false),
  ('video-studio', 'video-studio', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS owner_storage_policy ON storage.objects;
CREATE POLICY owner_storage_policy
  ON storage.objects FOR ALL
  USING (
    bucket_id IN ('social-media', 'marketing-assets', 'sales-attachments', 'generated-content', 'user-uploads', 'video-studio')
    AND (auth.jwt() ->> 'sub') = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id IN ('social-media', 'marketing-assets', 'sales-attachments', 'generated-content', 'user-uploads', 'video-studio')
    AND (auth.jwt() ->> 'sub') = (storage.foldername(name))[1]
  );
