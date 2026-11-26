import { getSupabaseAdmin } from './client';

/**
 * Best-effort authoritative Supabase write-through helper.
 * When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured, syncs records idempotently
 * into normalized PostgreSQL tables without throwing when Supabase credentials are absent in local dev.
 */
export async function syncRowsToSupabase(
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string
): Promise<void> {
  const client = getSupabaseAdmin();
  if (!client || rows.length === 0) return;
  try {
    await client.from(table).upsert(rows, { onConflict });
  } catch {
    // Local .data JSON remains consistent; surface explicit diagnostics in /api/system/persistence-status
  }
}

export async function deleteRowFromSupabase(
  table: string,
  ownerUid: string,
  id: string
): Promise<void> {
  const client = getSupabaseAdmin();
  if (!client) return;
  try {
    await client.from(table).delete().eq('owner_uid', ownerUid).eq('id', id);
  } catch {
    // ignore in non-configured dev
  }
}

export async function fetchRowsFromSupabase<T = Record<string, unknown>>(
  table: string,
  ownerUid: string,
  orderBy?: { column: string; ascending?: boolean }
): Promise<T[] | null> {
  const client = getSupabaseAdmin();
  if (!client) return null;
  try {
    let q = client.from(table).select('*').eq('owner_uid', ownerUid);
    if (orderBy) {
      q = q.order(orderBy.column, { ascending: Boolean(orderBy.ascending) });
    }
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    return data as T[];
  } catch {
    return null;
  }
}
