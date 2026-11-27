import { isProductionRuntime } from '../aiProviders/authMiddleware';
import { getSupabaseAdmin } from './client';

export type SyncErrorCode =
  | 'SUPABASE_NOT_CONFIGURED'
  | 'SUPABASE_WRITE_FAILED'
  | 'SUPABASE_DELETE_FAILED'
  | 'SUPABASE_READ_FAILED'
  | 'SUPABASE_RPC_FAILED'
  | 'SUPABASE_NETWORK_ERROR';

export type SyncResult<T = unknown> =
  | {
      ok: true;
      data?: T;
      skippedInDev?: boolean;
    }
  | {
      ok: false;
      code: SyncErrorCode;
      message: string;
      retriable: boolean;
      statusCode: number;
      detail?: string;
    };

function classifySupabaseError(
  rawError: unknown,
  fallbackCode: SyncErrorCode,
  contextLabel: string
): Extract<SyncResult<never>, { ok: false }> {
  const errObj =
    rawError && typeof rawError === 'object'
      ? (rawError as { message?: string; code?: string; status?: number; details?: string; hint?: string })
      : null;
  const msg =
    errObj?.message ||
    (rawError instanceof Error ? rawError.message : String(rawError || 'Unknown Supabase error'));
  const lower = msg.toLowerCase();
  const isConstraint =
    errObj?.code === '23505' ||
    errObj?.code === '23503' ||
    errObj?.code === '23514' ||
    errObj?.code === '42501' ||
    errObj?.code === '42P01' ||
    lower.includes('violates') ||
    lower.includes('does not exist') ||
    lower.includes('permission denied');
  const isTransient =
    !isConstraint &&
    (lower.includes('timeout') ||
      lower.includes('econnreset') ||
      lower.includes('econnrefused') ||
      lower.includes('fetch failed') ||
      lower.includes('network') ||
      lower.includes('503') ||
      lower.includes('502') ||
      lower.includes('504') ||
      lower.includes('429'));

  return {
    ok: false,
    code: fallbackCode,
    message: `${contextLabel}: ${msg}`,
    retriable: isTransient,
    statusCode: isTransient ? 503 : 502,
    detail: [errObj?.code, errObj?.details, errObj?.hint].filter(Boolean).join(' | ') || undefined,
  };
}

export async function withTransientRetry<T>(
  op: () => Promise<SyncResult<T>>,
  maxAttempts = 3
): Promise<SyncResult<T>> {
  let last: SyncResult<T> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await op();
    if (last.ok || !last.retriable || attempt >= maxAttempts) {
      return last;
    }
    const backoffMs = attempt === 1 ? 150 : 400;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return (
    last || {
      ok: false,
      code: 'SUPABASE_NETWORK_ERROR',
      message: 'Supabase operation failed after retries.',
      retriable: false,
      statusCode: 503,
    }
  );
}

/**
 * Authoritative Supabase upsert helper.
 * - Never swallows PostgREST `{ error }` responses or network exceptions.
 * - Fails closed in production when Supabase credentials are missing.
 * - Allows non-production local dev to skip cleanly ONLY when Supabase is unconfigured.
 */
export async function syncRowsToSupabase(
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string
): Promise<SyncResult<number>> {
  if (rows.length === 0) {
    return { ok: true, data: 0 };
  }
  const client = getSupabaseAdmin();
  if (!client) {
    if (isProductionRuntime()) {
      return {
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: `Supabase must be configured in production before writing "${table}".`,
        retriable: false,
        statusCode: 503,
      };
    }
    return { ok: true, data: 0, skippedInDev: true };
  }

  return withTransientRetry(async () => {
    try {
      const { error } = await client.from(table).upsert(rows, { onConflict });
      if (error) {
        return classifySupabaseError(error, 'SUPABASE_WRITE_FAILED', `Supabase write failed (${table})`);
      }
      return { ok: true, data: rows.length };
    } catch (err) {
      return classifySupabaseError(err, 'SUPABASE_NETWORK_ERROR', `Supabase write exception (${table})`);
    }
  });
}

export async function deleteRowFromSupabase(
  table: string,
  ownerUid: string,
  id: string,
  additionalFilters?: Record<string, unknown>
): Promise<SyncResult<void>> {
  const client = getSupabaseAdmin();
  if (!client) {
    if (isProductionRuntime()) {
      return {
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: `Supabase must be configured in production before deleting from "${table}".`,
        retriable: false,
        statusCode: 503,
      };
    }
    return { ok: true, skippedInDev: true };
  }

  return withTransientRetry(async () => {
    try {
      let query = client.from(table).delete().eq('owner_uid', ownerUid).eq('id', id);
      if (additionalFilters) {
        for (const [col, val] of Object.entries(additionalFilters)) {
          query = query.eq(col, val);
        }
      }
      const { error } = await query;
      if (error) {
        return classifySupabaseError(error, 'SUPABASE_DELETE_FAILED', `Supabase delete failed (${table})`);
      }
      return { ok: true };
    } catch (err) {
      return classifySupabaseError(err, 'SUPABASE_NETWORK_ERROR', `Supabase delete exception (${table})`);
    }
  });
}

export async function fetchRowsFromSupabase<T = Record<string, unknown>>(
  table: string,
  ownerUid: string,
  orderBy?: { column: string; ascending?: boolean },
  additionalFilters?: Record<string, unknown>
): Promise<SyncResult<T[]>> {
  const client = getSupabaseAdmin();
  if (!client) {
    if (isProductionRuntime()) {
      return {
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: `Supabase must be configured in production before reading "${table}".`,
        retriable: false,
        statusCode: 503,
      };
    }
    return { ok: true, data: [], skippedInDev: true };
  }

  return withTransientRetry(async () => {
    try {
      let q = client.from(table).select('*').eq('owner_uid', ownerUid);
      if (additionalFilters) {
        for (const [col, val] of Object.entries(additionalFilters)) {
          q = q.eq(col, val);
        }
      }
      if (orderBy) {
        q = q.order(orderBy.column, { ascending: Boolean(orderBy.ascending) });
      }
      const { data, error } = await q;
      if (error) {
        return classifySupabaseError(error, 'SUPABASE_READ_FAILED', `Supabase read failed (${table})`);
      }
      return { ok: true, data: Array.isArray(data) ? (data as T[]) : [] };
    } catch (err) {
      return classifySupabaseError(err, 'SUPABASE_NETWORK_ERROR', `Supabase read exception (${table})`);
    }
  });
}

export async function callSupabaseRpc<T = Record<string, unknown>>(
  fnName: string,
  params: Record<string, unknown>
): Promise<SyncResult<T>> {
  const client = getSupabaseAdmin();
  if (!client) {
    return {
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      message: `Supabase is not configured; cannot execute RPC "${fnName}".`,
      retriable: false,
      statusCode: 503,
    };
  }

  return withTransientRetry(async () => {
    try {
      const { data, error } = await client.rpc(fnName, params);
      if (error) {
        return classifySupabaseError(error, 'SUPABASE_RPC_FAILED', `Supabase RPC "${fnName}" failed`);
      }
      return { ok: true, data: data as T };
    } catch (err) {
      return classifySupabaseError(err, 'SUPABASE_NETWORK_ERROR', `Supabase RPC "${fnName}" exception`);
    }
  }, 2);
}

export class SupabasePersistenceError extends Error {
  readonly code: SyncErrorCode;
  readonly statusCode: number;
  readonly retriable: boolean;

  constructor(failure: Extract<SyncResult<never>, { ok: false }>) {
    super(failure.message);
    this.name = 'SupabasePersistenceError';
    this.code = failure.code;
    this.statusCode = failure.statusCode;
    this.retriable = failure.retriable;
  }
}

export function assertSyncOk<T>(res: SyncResult<T>): T | undefined {
  if (!res.ok) {
    throw new SupabasePersistenceError(res);
  }
  return res.data;
}
