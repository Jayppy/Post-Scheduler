import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_BUCKETS = [
  'social-media',
  'marketing-assets',
  'sales-attachments',
  'generated-content',
  'user-uploads',
  'video-studio',
] as const;

export type SupabaseBucketId = (typeof SUPABASE_BUCKETS)[number];

let adminClient: SupabaseClient | null = null;
let lastUrl = '';
let lastKey = '';

function resolveServerSupabaseKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    ''
  );
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = resolveServerSupabaseKey();
  return Boolean(url && serviceKey && url.startsWith('http'));
}

export function getSupabaseConfigDiagnostics(): {
  configured: boolean;
  missingEnvVars: string[];
  urlSet: boolean;
  urlValid: boolean;
  anonKeySet: boolean;
  serviceRoleSet: boolean;
  secretKeyNamePresent: 'SUPABASE_SERVICE_ROLE_KEY' | 'SUPABASE_SECRET_KEY' | null;
} {
  const url = process.env.SUPABASE_URL?.trim() || '';
  const anon = process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || '';
  const legacyServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  const modernSecretKey = process.env.SUPABASE_SECRET_KEY?.trim() || '';
  const serviceKey = legacyServiceKey || modernSecretKey;
  const missingEnvVars: string[] = [];
  const urlValid = Boolean(url && /^https?:\/\//i.test(url));
  if (!urlValid) missingEnvVars.push('SUPABASE_URL');
  if (!serviceKey) missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)');
  return {
    configured: Boolean(urlValid && serviceKey),
    missingEnvVars,
    urlSet: Boolean(url),
    urlValid,
    anonKeySet: Boolean(anon),
    serviceRoleSet: Boolean(serviceKey),
    secretKeyNamePresent: legacyServiceKey
      ? 'SUPABASE_SERVICE_ROLE_KEY'
      : modernSecretKey
        ? 'SUPABASE_SECRET_KEY'
        : null,
  };
}

/**
 * Strictly server-side Supabase Service Role / Secret Key client.
 * Never expose SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY to browser bundles or API responses.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim() || '';
  const serviceKey = resolveServerSupabaseKey();
  if (!url || !serviceKey || !/^https?:\/\//i.test(url)) {
    return null;
  }
  if (!adminClient || lastUrl !== url || lastKey !== serviceKey) {
    lastUrl = url;
    lastKey = serviceKey;
    adminClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient;
}

export async function ensureSupabaseStorageBuckets(): Promise<{
  ok: boolean;
  createdOrVerified: string[];
  errors: string[];
}> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, createdOrVerified: [], errors: ['Supabase credentials not configured'] };
  }
  const createdOrVerified: string[] = [];
  const errors: string[] = [];

  for (const bucket of SUPABASE_BUCKETS) {
    try {
      const { data: existing, error: getErr } = await client.storage.getBucket(bucket);
      if (!getErr && existing) {
        createdOrVerified.push(bucket);
        continue;
      }
      const { error: createErr } = await client.storage.createBucket(bucket, {
        public: false,
        fileSizeLimit: 100 * 1024 * 1024,
      });
      if (createErr && !String(createErr.message).toLowerCase().includes('already exists')) {
        errors.push(`${bucket}: ${createErr.message}`);
      } else {
        createdOrVerified.push(bucket);
      }
    } catch (err) {
      errors.push(`${bucket}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: errors.length === 0,
    createdOrVerified,
    errors,
  };
}

export async function uploadToSupabaseBucket(opts: {
  bucket: SupabaseBucketId;
  ownerUid: string;
  relativePath: string;
  buffer: Buffer;
  contentType: string;
}): Promise<{ ok: true; path: string; signedUrl?: string } | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  const safeOwner = opts.ownerUid.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128) || 'local-operator';
  const cleanRel = opts.relativePath.replace(/^\/+/, '').replace(/\.\./g, '');
  const objectPath = `${safeOwner}/${cleanRel}`;
  const { error } = await client.storage.from(opts.bucket).upload(objectPath, opts.buffer, {
    contentType: opts.contentType,
    upsert: true,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  const { data: signed } = await client.storage.from(opts.bucket).createSignedUrl(objectPath, 3600);
  return {
    ok: true,
    path: objectPath,
    signedUrl: signed?.signedUrl,
  };
}
