import crypto from 'crypto';
import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
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
let testAdminOverride: SupabaseClient | null = null;
let lastUrl = '';
let lastKey = '';

function resolveServerSupabaseKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    ''
  );
}

/**
 * Test-only hook for injecting a mocked/stateful Supabase client in unit/integration suites.
 * Never active in normal runtime unless explicitly called by automated tests.
 */
export function setSupabaseAdminForTesting(client: SupabaseClient | null): void {
  testAdminOverride = client;
}

export function isSupabaseConfigured(): boolean {
  if (testAdminOverride) return true;
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
  if (testAdminOverride) {
    return {
      configured: true,
      missingEnvVars: [],
      urlSet: true,
      urlValid: true,
      anonKeySet: true,
      serviceRoleSet: true,
      secretKeyNamePresent: 'SUPABASE_SERVICE_ROLE_KEY',
    };
  }
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
 * Collision-resistant storage folder prefix keyed by SHA-256 of raw ownerUid.
 * Avoids normalization/truncation collisions (e.g. "a.b" vs "a_b" or >128 char UIDs)
 * while keeping raw Firebase UID unchanged in PostgreSQL `owner_uid` columns.
 */
export function getSafeStorageOwnerPrefix(ownerUid: string): string {
  const trimmed = String(ownerUid || '').trim() || 'local-operator';
  const slug = trimmed.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'op';
  const digest = crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 24);
  return `${slug}-${digest}`;
}

/**
 * Legacy pre-Phase-1.5 storage prefix retained strictly for read-only backward compatibility
 * when ownerUid itself was lossless (`^[a-zA-Z0-9_-]{1,128}$`) or backed by an explicit DB row.
 */
export function getLegacySafeStorageOwnerPrefix(ownerUid: string): string {
  return String(ownerUid || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128) || 'local-operator';
}

export function isLosslessLegacyPrefixOwner(ownerUid: string): boolean {
  const trimmed = String(ownerUid || '').trim();
  return /^[a-zA-Z0-9_-]{1,128}$/.test(trimmed);
}

/**
 * Strictly server-side Supabase Service Role / Secret Key client.
 * Never expose SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY to browser bundles or API responses.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (testAdminOverride) {
    return testAdminOverride;
  }
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
  buffer?: Buffer;
  filePath?: string;
  contentType: string;
  signedUrlTtlSeconds?: number;
  upsert?: boolean;
}): Promise<{ ok: true; path: string; signedUrl?: string } | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  if (!opts.buffer && !opts.filePath) {
    return { ok: false, error: 'Upload payload buffer or filePath is required.' };
  }

  const safeOwner = getSafeStorageOwnerPrefix(opts.ownerUid);
  const cleanRel = opts.relativePath.replace(/^\/+/, '').replace(/\.\./g, '');
  const objectPath = `${safeOwner}/${cleanRel}`;
  const upsert = opts.upsert !== false;

  let stream: fs.ReadStream | null = null;
  let streamError: Error | null = null;
  try {
    if (opts.filePath) {
      stream = fs.createReadStream(opts.filePath);
      stream.on('error', (err) => {
        streamError = err;
      });
    }
    const body = stream || (opts.buffer as Buffer);

    const { error } = await client.storage.from(opts.bucket).upload(objectPath, body, {
      contentType: opts.contentType,
      upsert,
      ...(opts.filePath ? { duplex: 'half' as const } : {}),
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    if (streamError) {
      return { ok: false, error: (streamError as Error).message };
    }

    const ttl = Math.max(60, opts.signedUrlTtlSeconds ?? 3600);
    const { data: signed } = await client.storage.from(opts.bucket).createSignedUrl(objectPath, ttl);
    return {
      ok: true,
      path: objectPath,
      signedUrl: signed?.signedUrl,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (stream && !stream.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        stream!.once('close', done);
        stream!.once('error', done);
        if (!stream!.destroyed) {
          stream!.destroy();
        }
      });
    }
  }
}

export async function createSignedStorageUrl(
  bucket: SupabaseBucketId,
  objectPath: string,
  expiresInSeconds = 3600
): Promise<{ ok: true; signedUrl: string } | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(objectPath, Math.max(60, expiresInSeconds));
  if (error || !data?.signedUrl) {
    return { ok: false, error: error?.message || 'Unable to generate signed Storage URL.' };
  }
  return { ok: true, signedUrl: data.signedUrl };
}

export async function downloadStorageObjectToFile(opts: {
  bucket: SupabaseBucketId;
  objectPath: string;
  destinationPath: string;
}): Promise<{ ok: true; bytes: number; sha256: string } | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }

  let bytes = 0;
  const hasher = crypto.createHash('sha256');
  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    // Prefer signed URL streaming fetch so large objects never buffer inside a Blob in Node
    const signed = await client.storage.from(opts.bucket).createSignedUrl(opts.objectPath, 300);
    if (!signed.error && signed.data?.signedUrl && /^https?:\/\//i.test(signed.data.signedUrl)) {
      const resp = await fetch(signed.data.signedUrl);
      if (resp.ok && resp.body) {
        await pipeline(
          Readable.fromWeb(resp.body as unknown as import('stream/web').ReadableStream<Uint8Array>),
          inspector,
          fs.createWriteStream(opts.destinationPath)
        );
        return { ok: true, bytes, sha256: hasher.digest('hex') };
      }
    }

    // Fallback to SDK download stream (used when signedUrl is relative or in unit mocks)
    const { data, error } = await client.storage.from(opts.bucket).download(opts.objectPath);
    if (error || !data) {
      return { ok: false, error: error?.message || `Failed to download ${opts.objectPath}` };
    }
    const webStream = typeof data.stream === 'function' ? data.stream() : null;
    if (webStream) {
      await pipeline(
        Readable.fromWeb(webStream as unknown as import('stream/web').ReadableStream<Uint8Array>),
        inspector,
        fs.createWriteStream(opts.destinationPath)
      );
      return { ok: true, bytes, sha256: hasher.digest('hex') };
    }
    const buf = Buffer.from(await data.arrayBuffer());
    bytes = buf.length;
    hasher.update(buf);
    await fs.promises.writeFile(opts.destinationPath, buf);
    return { ok: true, bytes, sha256: hasher.digest('hex') };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function downloadStorageObjectToBuffer(
  bucket: SupabaseBucketId,
  objectPath: string
): Promise<{ ok: true; buffer: Buffer; mimeType?: string } | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  try {
    const { data, error } = await client.storage.from(bucket).download(objectPath);
    if (error || !data) {
      return { ok: false, error: error?.message || `Storage object "${objectPath}" not found.` };
    }
    const ab = await data.arrayBuffer();
    return {
      ok: true,
      buffer: Buffer.from(ab),
      mimeType: data.type || undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function inspectStorageObjectMetadata(
  bucket: SupabaseBucketId,
  objectPath: string
): Promise<{ exists: boolean; size?: number; error?: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { exists: false, error: 'Supabase not configured' };
  }
  const clean = objectPath.replace(/^\/+/, '');
  const lastSlash = clean.lastIndexOf('/');
  const folder = lastSlash >= 0 ? clean.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;

  const { data: listed, error: listErr } = await client.storage
    .from(bucket)
    .list(folder, { limit: 100, search: fileName });
  if (listErr) {
    return { exists: false, error: listErr.message };
  }
  const match = Array.isArray(listed) ? listed.find((item) => item.name === fileName) : undefined;
  if (!match) {
    return { exists: false };
  }
  const listedSize = Number((match.metadata as { size?: number } | undefined)?.size ?? 0);
  if (listedSize > 0) {
    return { exists: true, size: listedSize };
  }

  // Some storage adapters omit metadata.size on list(); verify via signed HEAD when HTTP URL is available
  const signed = await client.storage.from(bucket).createSignedUrl(clean, 120);
  if (!signed.error && signed.data?.signedUrl && /^https?:\/\//i.test(signed.data.signedUrl)) {
    try {
      const head = await fetch(signed.data.signedUrl, { method: 'HEAD' });
      if (head.ok) {
        const len = Number(head.headers.get('content-length') || 0);
        return { exists: true, size: len > 0 ? len : undefined };
      }
    } catch {
      // Ignore HEAD failure, existence already confirmed in folder listing
    }
  }
  return { exists: true, size: listedSize > 0 ? listedSize : undefined };
}

export async function removeStorageObjects(
  bucket: SupabaseBucketId,
  objectPaths: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (objectPaths.length === 0) return { ok: true };
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  const { error } = await client.storage.from(bucket).remove(objectPaths);
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function listStorageObjects(
  bucket: SupabaseBucketId,
  folderPath: string,
  limit = 100
): Promise<{
  ok: true;
  items: Array<{ name: string; id?: string | null; created_at?: string | null; updated_at?: string | null; metadata?: Record<string, unknown> | null }>;
} | { ok: false; error: string }> {
  const client = getSupabaseAdmin();
  if (!client) {
    return { ok: false, error: 'Supabase not configured' };
  }
  const { data, error } = await client.storage.from(bucket).list(folderPath, { limit });
  if (error) {
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    items: Array.isArray(data) ? data : [],
  };
}
