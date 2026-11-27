import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import express, { type Express } from 'express';

process.env.TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-phase15-reliability';


import {
  getLegacySafeStorageOwnerPrefix,
  getSafeStorageOwnerPrefix,
  isLosslessLegacyPrefixOwner,
  setSupabaseAdminForTesting,
} from '../server/supabase/client';
import {
  assertSyncOk,
  SupabasePersistenceError,
  syncRowsToSupabase,
} from '../server/supabase/syncHelper';
import { encryptSecret } from '../server/tokenCrypto';
import { registerSalesIntelligence } from '../server/salesIntelligence';
import { registerSocialIntegrations } from '../server/socialIntegrations';
import { registerVideoStudio } from '../server/videoStudio';
import { probeAndValidateMp4, registerVideoTranscoder } from '../server/videoTranscoder';

const execFileAsync = promisify(execFile);

// ============================================================================
// Stateful In-Memory Mock Supabase (PostgREST + 10 RPCs + Signed HTTP Storage)
// ============================================================================

interface StorageEntry {
  buffer: Buffer;
  contentType: string;
  createdAt: string;
  updatedAt: string;
}

interface MockFaults {
  failNextUpsertTable?: { table: string; code?: string; message: string; remainingFailures: number };
  failNextReadTable?: { table: string; message: string; remainingFailures: number };
  failNextStorageUploadPathIncludes?: { substr: string; message: string; remainingFailures: number };
}

class StatefulMockSupabase {
  tables = new Map<string, Array<Record<string, any>>>();
  storage = new Map<string, StorageEntry>();
  removedStorageLog: Array<{ bucket: string; paths: string[]; at: number }> = [];
  upsertLog: Array<{ table: string; at: number; ids: string[] }> = [];
  faults: MockFaults = {};

  private httpServer: http.Server | null = null;
  private httpBaseUrl = '';
  private signedTokenSecret = crypto.randomBytes(16).toString('hex');

  async startStorageHttpServer(): Promise<string> {
    if (this.httpServer) return this.httpBaseUrl;
    this.httpServer = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        const match = parsed.pathname.match(/^\/storage\/([^/]+)\/(.+)$/);
        if (!match) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const bucket = decodeURIComponent(match[1]);
        const objectPath = decodeURIComponent(match[2]);
        const exp = Number(parsed.searchParams.get('exp') || 0);
        const sig = parsed.searchParams.get('sig') || '';
        const expectedSig = crypto
          .createHmac('sha256', this.signedTokenSecret)
          .update(`${bucket}:${objectPath}:${exp}`)
          .digest('hex')
          .slice(0, 24);
        if (!exp || Date.now() > exp || sig !== expectedSig) {
          res.statusCode = 403;
          res.end('Invalid or expired signature');
          return;
        }

        const entry = this.storage.get(`${bucket}::${objectPath}`);
        if (!entry) {
          res.statusCode = 404;
          res.end('Object not found');
          return;
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', entry.contentType || 'application/octet-stream');

        const rangeHeader = req.headers.range;
        if (rangeHeader && /^bytes=\d+-\d*$/.test(rangeHeader)) {
          const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
          const start = Number(startStr);
          const end = endStr ? Math.min(entry.buffer.length - 1, Number(endStr)) : entry.buffer.length - 1;
          if (start >= entry.buffer.length || end < start) {
            res.statusCode = 416;
            res.end();
            return;
          }
          const slice = entry.buffer.subarray(start, end + 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.buffer.length}`);
          res.setHeader('Content-Length', String(slice.length));
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          res.end(slice);
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', String(entry.buffer.length));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(entry.buffer);
      } catch {
        res.statusCode = 500;
        res.end('Mock storage server error');
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind mock storage HTTP server.');
    }
    this.httpBaseUrl = `http://127.0.0.1:${addr.port}`;
    return this.httpBaseUrl;
  }

  async stopStorageHttpServer(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = null;
    this.httpBaseUrl = '';
  }

  private getTable(name: string): Array<Record<string, any>> {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  asClient(): SupabaseClient {
    const self = this;

    const createQueryBuilder = (table: string) => {
      const filters: Array<(row: Record<string, any>) => boolean> = [];
      let orderCfg: { column: string; ascending: boolean } | null = null;
      let opType: 'select' | 'delete' | 'upsert' = 'select';
      let upsertRows: Array<Record<string, any>> = [];
      let conflictCols: string[] = [];

      const applyFilters = (rows: Array<Record<string, any>>) => {
        let out = rows.filter((r) => filters.every((fn) => fn(r)));
        if (orderCfg) {
          const { column, ascending } = orderCfg;
          out = [...out].sort((a, b) => {
            const av = a[column] ?? '';
            const bv = b[column] ?? '';
            const cmp = String(av).localeCompare(String(bv));
            return ascending ? cmp : -cmp;
          });
        }
        return out.map((r) => structuredClone(r));
      };

      const execute = async (singleMode?: 'single' | 'maybeSingle') => {
        if (opType === 'upsert') {
          if (
            self.faults.failNextUpsertTable &&
            self.faults.failNextUpsertTable.table === table &&
            self.faults.failNextUpsertTable.remainingFailures > 0
          ) {
            self.faults.failNextUpsertTable.remainingFailures -= 1;
            return {
              data: null,
              error: {
                message: self.faults.failNextUpsertTable.message,
                code: self.faults.failNextUpsertTable.code || '23505',
              },
            };
          }
          const rows = self.getTable(table);
          for (const incoming of upsertRows) {
            const copy = structuredClone(incoming);
            const matchIdx = rows.findIndex((existing) =>
              conflictCols.length > 0
                ? conflictCols.every((c) => existing[c] === copy[c])
                : existing.id !== undefined && existing.id === copy.id
            );
            if (matchIdx >= 0) {
              rows[matchIdx] = { ...rows[matchIdx], ...copy };
            } else {
              rows.push(copy);
            }
          }
          self.upsertLog.push({
            table,
            at: Date.now(),
            ids: upsertRows.map((r) => String(r.id || r.post_id || '')),
          });
          return { data: upsertRows, error: null };
        }

        if (opType === 'delete') {
          const rows = self.getTable(table);
          const kept = rows.filter((r) => !filters.every((fn) => fn(r)));
          self.tables.set(table, kept);
          return { data: null, error: null };
        }

        if (
          self.faults.failNextReadTable &&
          self.faults.failNextReadTable.table === table &&
          self.faults.failNextReadTable.remainingFailures > 0
        ) {
          self.faults.failNextReadTable.remainingFailures -= 1;
          return {
            data: null,
            error: { message: self.faults.failNextReadTable.message, code: '503' },
          };
        }

        const matched = applyFilters(self.getTable(table));
        if (singleMode === 'maybeSingle') {
          return { data: matched[0] || null, error: null };
        }
        if (singleMode === 'single') {
          if (!matched[0]) {
            return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
          }
          return { data: matched[0], error: null };
        }
        return { data: matched, error: null };
      };

      const builder: any = {
        select() {
          if (opType !== 'upsert') opType = 'select';
          return builder;
        },
        upsert(rows: Array<Record<string, any>> | Record<string, any>, opts?: { onConflict?: string }) {
          opType = 'upsert';
          upsertRows = Array.isArray(rows) ? rows : [rows];
          conflictCols = opts?.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : ['id'];
          return builder;
        },
        delete() {
          opType = 'delete';
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          orderCfg = { column, ascending: opts?.ascending !== false };
          return builder;
        },
        maybeSingle() {
          return execute('maybeSingle');
        },
        single() {
          return execute('single');
        },
        then(onFulfilled: any, onRejected: any) {
          return execute().then(onFulfilled, onRejected);
        },
      };
      return builder;
    };

    const clientMock = {
      from: (table: string) => createQueryBuilder(table),
      rpc: async (fnName: string, params: Record<string, any>) => {
        return self.executeRpc(fnName, params);
      },
      storage: {
        getBucket: async (bucket: string) => ({ data: { id: bucket, name: bucket }, error: null }),
        createBucket: async () => ({ data: null, error: null }),
        from: (bucket: string) => ({
          upload: async (objectPath: string, body: any, opts?: { contentType?: string }) => {
            if (
              self.faults.failNextStorageUploadPathIncludes &&
              objectPath.includes(self.faults.failNextStorageUploadPathIncludes.substr) &&
              self.faults.failNextStorageUploadPathIncludes.remainingFailures > 0
            ) {
              self.faults.failNextStorageUploadPathIncludes.remainingFailures -= 1;
              return {
                data: null,
                error: { message: self.faults.failNextStorageUploadPathIncludes.message },
              };
            }

            let buf: Buffer;
            if (Buffer.isBuffer(body)) {
              buf = Buffer.from(body);
            } else if (body instanceof Uint8Array) {
              buf = Buffer.from(body);
            } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
              const chunks: Buffer[] = [];
              for await (const c of body as AsyncIterable<Buffer | Uint8Array | string>) {
                chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
              }
              buf = Buffer.concat(chunks);
            } else {
              throw new Error('Unsupported mock storage upload body');
            }
            const now = new Date().toISOString();
            const existing = self.storage.get(`${bucket}::${objectPath}`);
            self.storage.set(`${bucket}::${objectPath}`, {
              buffer: buf,
              contentType: opts?.contentType || 'application/octet-stream',
              createdAt: existing?.createdAt || now,
              updatedAt: now,
            });
            return { data: { path: objectPath }, error: null };
          },
          createSignedUrl: async (objectPath: string, ttlSeconds: number) => {
            const baseUrl = self.httpBaseUrl || 'https://mock-storage.local';
            const exp = Date.now() + ttlSeconds * 1000;
            const sig = crypto
              .createHmac('sha256', self.signedTokenSecret)
              .update(`${bucket}:${objectPath}:${exp}`)
              .digest('hex')
              .slice(0, 24);
            const encodedPath = objectPath
              .split('/')
              .map((seg) => encodeURIComponent(seg))
              .join('/');
            return {
              data: {
                signedUrl: `${baseUrl}/storage/${encodeURIComponent(bucket)}/${encodedPath}?exp=${exp}&sig=${sig}`,
              },
              error: null,
            };
          },
          download: async (objectPath: string) => {
            const entry = self.storage.get(`${bucket}::${objectPath}`);
            if (!entry) {
              return { data: null, error: { message: 'Object not found' } };
            }
            const blob = new Blob([new Uint8Array(entry.buffer)], { type: entry.contentType });
            return { data: blob, error: null };
          },
          list: async (folder: string, opts?: { search?: string }) => {
            const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
            const items: Array<{
              name: string;
              created_at: string;
              updated_at: string;
              metadata: { size: number };
            }> = [];
            for (const [k, v] of self.storage.entries()) {
              if (!k.startsWith(`${bucket}::`)) continue;
              const fullPath = k.slice(`${bucket}::`.length);
              if (!fullPath.startsWith(prefix)) continue;
              const remainder = fullPath.slice(prefix.length);
              if (remainder.includes('/')) continue;
              if (opts?.search && !remainder.includes(opts.search)) continue;
              items.push({
                name: remainder,
                created_at: v.createdAt,
                updated_at: v.updatedAt,
                metadata: { size: v.buffer.length },
              });
            }
            return { data: items, error: null };
          },
          remove: async (paths: string[]) => {
            for (const p of paths) {
              self.storage.delete(`${bucket}::${p}`);
            }
            self.removedStorageLog.push({ bucket, paths: [...paths], at: Date.now() });
            return { data: paths, error: null };
          },
        }),
      },
    };

    return clientMock as unknown as SupabaseClient;
  }

  private async executeRpc(fnName: string, p: Record<string, any>) {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (fnName === 'create_video_upload_session') {
      const rows = this.getTable('video_upload_sessions');
      for (const r of rows) {
        if (r.owner_uid === p.p_owner_uid && r.status === 'active' && Date.parse(r.expires_at) <= nowMs) {
          r.status = 'expired';
          r.updated_at = nowIso;
        }
      }
      const activeCount = rows.filter(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          ((r.status === 'active' && Date.parse(r.expires_at) > nowMs) ||
            (r.status === 'completing' &&
              (!r.completion_lease_expires_at ||
                Date.parse(r.completion_lease_expires_at) > nowMs ||
                Date.parse(r.expires_at) > nowMs)))
      ).length;
      const maxConcurrent = Number(p.p_max_concurrent || 3);
      if (activeCount >= maxConcurrent) {
        return {
          data: {
            ok: false,
            code: 'UPLOAD_CONCURRENCY_LIMIT',
            active_count: activeCount,
            max_concurrent: maxConcurrent,
          },
          error: null,
        };
      }
      const expiresAt = new Date(nowMs + Number(p.p_ttl_seconds || 1800) * 1000).toISOString();
      rows.push({
        upload_id: p.p_upload_id,
        owner_uid: p.p_owner_uid,
        workspace_id: p.p_workspace_id || 'ws-behind-the-release',
        project_id: p.p_project_id,
        render_id: p.p_render_id,
        format: p.p_format,
        mime_type: p.p_mime_type,
        total_chunks: p.p_total_chunks,
        total_bytes: p.p_total_bytes,
        expected_sha256: p.p_expected_sha256 || null,
        assembled_sha256: null,
        storage_bucket: 'video-studio',
        storage_path: null,
        bytes_uploaded: null,
        received_chunks_json: {},
        status: 'active',
        completion_lease_token: null,
        completion_lease_expires_at: null,
        chunks_cleaned_at: null,
        error_message: null,
        expires_at: expiresAt,
        created_at: nowIso,
        updated_at: nowIso,
      });
      return {
        data: { ok: true, upload_id: p.p_upload_id, active_count: activeCount + 1, expires_at: expiresAt },
        error: null,
      };
    }

    if (fnName === 'record_video_upload_chunk') {
      const rows = this.getTable('video_upload_sessions');
      const sess = rows.find(
        (r) => r.upload_id === p.p_upload_id && r.owner_uid === p.p_owner_uid && r.project_id === p.p_project_id
      );
      if (!sess) return { data: { ok: false, code: 'SESSION_NOT_FOUND', error: 'Not found' }, error: null };
      if (sess.status === 'completing' || sess.status === 'completed') {
        return { data: { ok: false, code: 'UPLOAD_LOCKED', error: 'Locked' }, error: null };
      }
      if (sess.status === 'expired' || Date.parse(sess.expires_at) <= nowMs) {
        sess.status = 'expired';
        return { data: { ok: false, code: 'SESSION_EXPIRED', error: 'Expired' }, error: null };
      }
      const idxKey = String(p.p_chunk_index);
      const existing = sess.received_chunks_json[idxKey];
      if (existing) {
        if (
          Number(existing.size) === Number(p.p_chunk_size) &&
          String(existing.sha256).toLowerCase() === String(p.p_chunk_sha256).toLowerCase()
        ) {
          return {
            data: {
              ok: true,
              idempotent: true,
              chunk_index: p.p_chunk_index,
              received_count: Object.keys(sess.received_chunks_json).length,
              total_chunks: sess.total_chunks,
            },
            error: null,
          };
        }
        return {
          data: {
            ok: false,
            code: 'CHUNK_CONFLICT',
            error: 'Conflicting chunk payload supplied for already-recorded chunk index.',
          },
          error: null,
        };
      }
      let sum = 0;
      for (const [k, v] of Object.entries<any>(sess.received_chunks_json)) {
        if (k !== idxKey) sum += Number(v.size || 0);
      }
      if (sum + Number(p.p_chunk_size) > Number(sess.total_bytes)) {
        return { data: { ok: false, code: 'CHUNK_OVERFLOW', error: 'Chunk overflow' }, error: null };
      }
      sess.received_chunks_json[idxKey] = {
        size: Number(p.p_chunk_size),
        sha256: String(p.p_chunk_sha256).toLowerCase(),
        objectPath: p.p_object_path,
        uploadedAt: nowIso,
      };
      sess.updated_at = nowIso;
      return {
        data: {
          ok: true,
          idempotent: false,
          chunk_index: p.p_chunk_index,
          received_count: Object.keys(sess.received_chunks_json).length,
          total_chunks: sess.total_chunks,
        },
        error: null,
      };
    }

    if (fnName === 'acquire_video_upload_completion_lease') {
      const rows = this.getTable('video_upload_sessions');
      const sess = rows.find(
        (r) => r.upload_id === p.p_upload_id && r.owner_uid === p.p_owner_uid && r.project_id === p.p_project_id
      );
      if (!sess) return { data: { ok: false, outcome: 'not_found' }, error: null };
      if (sess.status === 'completed' && sess.storage_path) {
        return { data: { ok: true, outcome: 'already_completed', session: structuredClone(sess) }, error: null };
      }
      if (
        sess.status === 'completing' &&
        sess.completion_lease_expires_at &&
        Date.parse(sess.completion_lease_expires_at) > nowMs
      ) {
        return { data: { ok: false, outcome: 'in_progress', lease_expires_at: sess.completion_lease_expires_at }, error: null };
      }
      if (sess.status === 'expired' || (sess.status === 'active' && Date.parse(sess.expires_at) <= nowMs)) {
        sess.status = 'expired';
        return { data: { ok: false, outcome: 'expired', error: 'Upload session expired' }, error: null };
      }
      sess.status = 'completing';
      sess.completion_lease_token = p.p_lease_token;
      sess.completion_lease_expires_at = new Date(nowMs + Number(p.p_lease_seconds || 120) * 1000).toISOString();
      sess.updated_at = nowIso;
      return {
        data: { ok: true, outcome: 'acquired', lease_token: p.p_lease_token, session: structuredClone(sess) },
        error: null,
      };
    }

    if (fnName === 'finalize_video_upload_session') {
      const rows = this.getTable('video_upload_sessions');
      const sess = rows.find((r) => r.upload_id === p.p_upload_id && r.owner_uid === p.p_owner_uid);
      if (!sess) return { data: { ok: false, code: 'SESSION_NOT_FOUND' }, error: null };
      if (sess.status === 'completed' && p.p_success) {
        return { data: { ok: true, status: 'completed', session: structuredClone(sess) }, error: null };
      }
      if (sess.status !== 'completing' || (sess.completion_lease_token || '') !== (p.p_lease_token || '')) {
        return { data: { ok: false, code: 'LEASE_TOKEN_MISMATCH', error: 'Lease token mismatch.' }, error: null };
      }
      if (p.p_success) {
        sess.status = 'completed';
        sess.storage_path = p.p_storage_path;
        sess.bytes_uploaded = p.p_bytes_uploaded;
        sess.assembled_sha256 = p.p_assembled_sha256;
        sess.error_message = null;
        sess.completion_lease_token = null;
        sess.completion_lease_expires_at = null;
        sess.updated_at = nowIso;
      } else {
        sess.status = Date.parse(sess.expires_at) > nowMs ? 'active' : 'failed';
        sess.error_message = p.p_error_message;
        sess.completion_lease_token = null;
        sess.completion_lease_expires_at = null;
        sess.updated_at = nowIso;
      }
      return { data: { ok: true, status: sess.status, session: structuredClone(sess) }, error: null };
    }

    if (fnName === 'mark_video_upload_chunks_cleaned') {
      const rows = this.getTable('video_upload_sessions');
      const sess = rows.find(
        (r) => r.upload_id === p.p_upload_id && r.owner_uid === p.p_owner_uid && r.status === 'completed'
      );
      if (!sess) return { data: { ok: false, code: 'NOT_COMPLETED' }, error: null };
      sess.chunks_cleaned_at = sess.chunks_cleaned_at || nowIso;
      sess.updated_at = nowIso;
      return { data: { ok: true }, error: null };
    }

    if (fnName === 'acquire_publish_destination_lock') {
      const rows = this.getTable('publish_idempotency');
      let row = rows.find(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          r.workspace_id === p.p_workspace_id &&
          r.post_id === p.p_post_id &&
          r.platform === p.p_platform
      );
      const leaseSec = Math.max(60, Math.min(1800, Number(p.p_lease_seconds || 600)));
      if (!row) {
        row = {
          owner_uid: p.p_owner_uid,
          workspace_id: p.p_workspace_id,
          post_id: p.p_post_id,
          platform: p.p_platform,
          job_id: p.p_job_id || null,
          status: 'publishing',
          lock_token: p.p_lock_token,
          lease_expires_at: new Date(nowMs + leaseSec * 1000).toISOString(),
          in_flight_id: null,
          platform_post_id: null,
          result_url: null,
          last_error: null,
          attempts: 1,
          published_at: null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        rows.push(row);
        return {
          data: { ok: true, outcome: 'acquired', lock_token: p.p_lock_token, lease_expires_at: row.lease_expires_at, attempts: 1 },
          error: null,
        };
      }
      if (row.status === 'published') {
        return {
          data: {
            ok: false,
            outcome: 'already_published',
            platform_post_id: row.platform_post_id,
            result_url: row.result_url,
            published_at: row.published_at,
          },
          error: null,
        };
      }
      if (row.status === 'needs_reconciliation') {
        return {
          data: { ok: false, outcome: 'needs_reconciliation', in_flight_id: row.in_flight_id, last_error: row.last_error },
          error: null,
        };
      }
      if (row.status === 'publishing') {
        if (row.lease_expires_at && Date.parse(row.lease_expires_at) > nowMs) {
          return {
            data: { ok: false, outcome: 'in_progress', lease_expires_at: row.lease_expires_at, in_flight_id: row.in_flight_id },
            error: null,
          };
        }
        if (String(row.in_flight_id || '').trim() !== '') {
          row.status = 'needs_reconciliation';
          row.lock_token = null;
          row.lease_expires_at = null;
          row.last_error = row.last_error || 'Publishing lease expired with in_flight_id; reconciliation required.';
          row.updated_at = nowIso;
          return {
            data: { ok: false, outcome: 'needs_reconciliation', in_flight_id: row.in_flight_id, last_error: row.last_error },
            error: null,
          };
        }
      }
      if (row.status === 'failed' && String(row.in_flight_id || '').trim() !== '') {
        row.status = 'needs_reconciliation';
        row.lock_token = null;
        row.lease_expires_at = null;
        row.updated_at = nowIso;
        return {
          data: { ok: false, outcome: 'needs_reconciliation', in_flight_id: row.in_flight_id, last_error: row.last_error },
          error: null,
        };
      }
      row.status = 'publishing';
      row.lock_token = p.p_lock_token;
      row.lease_expires_at = new Date(nowMs + leaseSec * 1000).toISOString();
      row.in_flight_id = null;
      row.last_error = null;
      row.attempts = Number(row.attempts || 0) + 1;
      row.updated_at = nowIso;
      return {
        data: { ok: true, outcome: 'acquired', lock_token: p.p_lock_token, lease_expires_at: row.lease_expires_at, attempts: row.attempts },
        error: null,
      };
    }

    if (fnName === 'record_publish_in_flight_id') {
      const row = this.getTable('publish_idempotency').find(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          r.workspace_id === p.p_workspace_id &&
          r.post_id === p.p_post_id &&
          r.platform === p.p_platform &&
          r.status === 'publishing' &&
          r.lock_token === p.p_lock_token &&
          (!r.lease_expires_at || Date.parse(r.lease_expires_at) > nowMs)
      );
      if (!row) {
        return { data: { ok: false, code: 'LOCK_TOKEN_MISMATCH', error: 'Lock token mismatch.' }, error: null };
      }
      row.in_flight_id = p.p_in_flight_id;
      row.updated_at = nowIso;
      return { data: { ok: true, in_flight_id: row.in_flight_id }, error: null };
    }

    if (fnName === 'complete_publish_destination_success') {
      const row = this.getTable('publish_idempotency').find(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          r.workspace_id === p.p_workspace_id &&
          r.post_id === p.p_post_id &&
          r.platform === p.p_platform &&
          r.status === 'publishing' &&
          r.lock_token === p.p_lock_token
      );
      if (!row) {
        return { data: { ok: false, code: 'LOCK_TOKEN_MISMATCH', error: 'Lock token mismatch.' }, error: null };
      }
      row.status = 'published';
      row.lock_token = null;
      row.lease_expires_at = null;
      row.platform_post_id = p.p_platform_post_id;
      row.result_url = p.p_result_url;
      row.last_error = null;
      row.published_at = p.p_published_at || nowIso;
      row.updated_at = nowIso;
      return { data: { ok: true, status: 'published', platform_post_id: row.platform_post_id }, error: null };
    }

    if (fnName === 'fail_publish_destination') {
      const row = this.getTable('publish_idempotency').find(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          r.workspace_id === p.p_workspace_id &&
          r.post_id === p.p_post_id &&
          r.platform === p.p_platform
      );
      if (!row || row.status !== 'publishing' || (row.lock_token || '') !== (p.p_lock_token || '')) {
        return { data: { ok: false, code: 'LOCK_TOKEN_MISMATCH', error: 'Lock token mismatch.' }, error: null };
      }
      const nextStatus = p.p_requires_reconciliation && String(row.in_flight_id || '').trim() ? 'needs_reconciliation' : 'failed';
      row.status = nextStatus;
      row.lock_token = null;
      row.lease_expires_at = null;
      row.in_flight_id = nextStatus === 'needs_reconciliation' ? row.in_flight_id : null;
      row.last_error = p.p_error;
      row.updated_at = nowIso;
      return { data: { ok: true, status: row.status, in_flight_id: row.in_flight_id }, error: null };
    }

    if (fnName === 'reconcile_publish_destination') {
      const rows = this.getTable('publish_idempotency');
      let row = rows.find(
        (r) =>
          r.owner_uid === p.p_owner_uid &&
          r.workspace_id === p.p_workspace_id &&
          r.post_id === p.p_post_id &&
          r.platform === p.p_platform
      );
      if (!row) {
        if (p.p_reconciled_published) {
          row = {
            owner_uid: p.p_owner_uid,
            workspace_id: p.p_workspace_id,
            post_id: p.p_post_id,
            platform: p.p_platform,
            status: 'published',
            platform_post_id: p.p_platform_post_id,
            result_url: p.p_result_url,
            published_at: nowIso,
            created_at: nowIso,
            updated_at: nowIso,
          };
          rows.push(row);
          return { data: { ok: true, status: 'published', platform_post_id: row.platform_post_id }, error: null };
        }
        return { data: { ok: true, status: 'failed' }, error: null };
      }
      if (row.status === 'published') {
        return { data: { ok: true, status: 'published', platform_post_id: row.platform_post_id }, error: null };
      }
      if (row.status === 'publishing' && row.lease_expires_at && Date.parse(row.lease_expires_at) > nowMs) {
        return { data: { ok: false, code: 'ACTIVE_LEASE_IN_PROGRESS', error: 'Lease active' }, error: null };
      }
      if (p.p_reconciled_published) {
        row.status = 'published';
        row.lock_token = null;
        row.lease_expires_at = null;
        row.platform_post_id = String(p.p_platform_post_id || '').trim() || row.in_flight_id;
        row.result_url = p.p_result_url || row.result_url;
        row.last_error = null;
        row.published_at = row.published_at || nowIso;
        row.updated_at = nowIso;
      } else {
        row.status = 'failed';
        row.lock_token = null;
        row.lease_expires_at = null;
        row.in_flight_id = null;
        row.last_error = p.p_detail;
        row.updated_at = nowIso;
      }
      return { data: { ok: true, status: row.status, platform_post_id: row.platform_post_id }, error: null };
    }

    return { data: null, error: { message: `Unknown mock RPC: ${fnName}` } };
  }
}

// ============================================================================
// Test Helpers: Firebase RS256 Token Signer & Multi-Instance Express Launcher
// ============================================================================

function b64Url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const rsaKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_KID = 'test-firebase-kid-1';

function mintFirebaseToken(uid: string, email = 'operator@74-studio.com'): string {
  const header = b64Url(JSON.stringify({ alg: 'RS256', kid: TEST_KID, typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = b64Url(
    JSON.stringify({
      aud: 'smooth-triumph-59brs',
      iss: 'https://securetoken.google.com/smooth-triumph-59brs',
      sub: uid,
      exp: nowSec + 3600,
      iat: nowSec - 10,
      email,
      email_verified: true,
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(rsaKeys.privateKey);
  return `${header}.${payload}.${b64Url(sig)}`;
}

function makeTestVideoProject(title: string) {
  const now = new Date().toISOString();
  return {
    project: {
      id: `vid_${crypto.randomBytes(4).toString('hex')}`,
      workspaceId: 'ws-behind-the-release',
      title,
      topic: title,
      audience: 'Artists',
      destination: 'both',
      primaryStyle: 'hybrid',
      targetDurationSeconds: 75,
      workflowStage: 'script',
      approvedForRender: false,
      status: 'script-ready',
      script: {
        id: `scr_${crypto.randomBytes(4).toString('hex')}`,
        hook: 'Hook line',
        bodySummary: 'Summary',
        closingCta: 'Save now',
        fullNarration: 'Hook line. Summary. Save now.',
        estimatedDurationSeconds: 75,
        targetDurationSeconds: 75,
        educationalTakeaway: 'Takeaway',
        suggestedCaption: 'Caption',
        hashtags: ['#74studio'],
        providerId: 'fallback',
        model: 'local-template',
        wasFallback: true,
      },
      scenes: [],
      audio: {
        narrationVolume: 1,
        bgmVolume: 0.2,
        sfxEnabled: false,
        sfxVolume: 0.4,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 1,
        trimStartSeconds: 0,
      },
      captionStyle: {
        position: 'bottom',
        highlightColor: '#f59e0b',
        fontSize: 44,
        showProgressBar: true,
        showBrandWatermark: true,
      },
      renders: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function startTestAppInstance(): Promise<{ app: Express; baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  const largeUploadJson = express.json({ limit: '80mb' });
  const standardJson = express.json({ limit: '4mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/publish/now' || req.path.startsWith('/api/scheduled-jobs')) {
      return largeUploadJson(req, res, next);
    }
    if (req.path === '/api/video/transcode-mp4' || req.path.startsWith('/api/video-studio')) {
      return next();
    }
    return standardJson(req, res, next);
  });

  registerSalesIntelligence(app);
  registerVideoStudio(app);
  registerVideoTranscoder(app);
  registerSocialIntegrations(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind express test instance');
  return {
    app,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function countTempDirsWithPrefix(prefix: string): number {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

// ============================================================================
// Suite Execution
// ============================================================================

test('Phase 1.5 Production Persistence, Dual-Instance Reliability & FFmpeg Benchmark', async (t) => {
  const prevEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = 'phase15-unit-test-encryption-secret-key';

  const mock = new StatefulMockSupabase();
  await mock.startStorageHttpServer();
  setSupabaseAdminForTesting(mock.asClient());

  const originalFetch = globalThis.fetch;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '74studio-test-fixtures-'));

  let metaBehavior: {
    failPublishAfterContainer?: boolean;
    reconcileStatusCode?: 'PUBLISHED' | 'ERROR' | 'OUTAGE';
    lastVideoUrlSent?: string;
    lastImageUrlSent?: string;
    containerCalls: number;
    publishCalls: number;
  } = {
    containerCalls: 0,
    publishCalls: 0,
  };

  // Intercept Google Firebase public certs & Meta Graph API while passing local HTTP requests straight through
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (urlStr === 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com') {
      return new Response(JSON.stringify({ [TEST_KID]: rsaKeys.publicKey }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
      });
    }

    // Meta token health check
    if (
      urlStr.startsWith('https://graph.facebook.com/') &&
      (urlStr.includes('/me?') || urlStr.includes('fields=id,username,name'))
    ) {
      return new Response(JSON.stringify({ id: 'ig-biz-123', username: 'studio74', name: '74 Studio' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Meta container creation
    if (urlStr.startsWith('https://graph.facebook.com/') && urlStr.endsWith('/media')) {
      metaBehavior.containerCalls += 1;
      const bodyJson = init?.body ? JSON.parse(String(init.body)) : {};
      if (bodyJson.video_url) metaBehavior.lastVideoUrlSent = bodyJson.video_url;
      if (bodyJson.image_url) metaBehavior.lastImageUrlSent = bodyJson.image_url;
      return new Response(JSON.stringify({ id: `ig_cont_${metaBehavior.containerCalls}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Meta container status polling or reconcile check
    if (urlStr.startsWith('https://graph.facebook.com/') && urlStr.includes('fields=status_code,status')) {
      if (metaBehavior.reconcileStatusCode === 'OUTAGE') {
        throw new Error('Simulated Meta Graph timeout');
      }
      if (metaBehavior.reconcileStatusCode) {
        return new Response(JSON.stringify({ status_code: metaBehavior.reconcileStatusCode }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status_code: 'FINISHED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Meta media_publish
    if (urlStr.startsWith('https://graph.facebook.com/') && urlStr.endsWith('/media_publish')) {
      metaBehavior.publishCalls += 1;
      if (metaBehavior.failPublishAfterContainer) {
        return new Response(JSON.stringify({ error: { message: 'Simulated Meta outage during media_publish' } }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: `ig_media_${metaBehavior.publishCalls}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Meta permalink lookup
    if (urlStr.startsWith('https://graph.facebook.com/') && urlStr.includes('fields=id,permalink')) {
      return new Response(JSON.stringify({ permalink: 'https://www.instagram.com/reel/MOCK74/' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input as any, init);
  }) as typeof fetch;

  const appA = await startTestAppInstance();
  const appB = await startTestAppInstance();

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await appA.close();
    await appB.close();
    await mock.stopStorageHttpServer();
    setSupabaseAdminForTesting(null);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    if (prevEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prevEncryptionKey;
  });

  // Pre-generate real FFmpeg fixtures (faststart H.264/AAC MP4 + VP8/Opus WebM)
  const sampleMp4Path = path.join(fixtureDir, 'sample.mp4');
  const sampleWebmPath = path.join(fixtureDir, 'sample.webm');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '44100',
    '-movflags', '+faststart',
    sampleMp4Path,
  ]);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libvpx', '-b:v', '400k',
    '-c:a', 'libvorbis',
    sampleWebmPath,
  ]);

  const ownerUid = 'firebase-uid-owner-1';
  const ownerJwt = mintFirebaseToken(ownerUid);
  const authHeaders = {
    Authorization: `Bearer ${ownerJwt}`,
    'Content-Type': 'application/json',
  };

  // --------------------------------------------------------------------------
  // T1: Supabase write failure propagation + transient retry
  // --------------------------------------------------------------------------
  await t.test('T1: syncHelper, salesIntelligence, videoStudio, and socialIntegrations propagate DB errors and retry transients', async () => {
    // 1. Constraint failure must NOT succeed silently
    mock.faults.failNextUpsertTable = {
      table: 'video_projects',
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      remainingFailures: 1,
    };
    const createProjRes = await originalFetch(`${appA.baseUrl}/api/video-studio/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(makeTestVideoProject('Fail Test')),
    });
    assert.equal(createProjRes.status, 502);
    const errJson = (await createProjRes.json()) as { error: string; code: string };
    assert.equal(errJson.code, 'SUPABASE_WRITE_FAILED');

    // 2. Transient timeout retries automatically and succeeds on 2nd attempt
    mock.faults.failNextUpsertTable = {
      table: 'video_projects',
      code: '503',
      message: 'network timeout 503',
      remainingFailures: 1,
    };
    const retryProjRes = await originalFetch(`${appA.baseUrl}/api/video-studio/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(makeTestVideoProject('Retry Test')),
    });
    assert.equal(retryProjRes.status, 200);

    // 3. Social scheduled job DB failure propagates 502/503
    mock.faults.failNextUpsertTable = {
      table: 'scheduled_jobs',
      code: '42501',
      message: 'permission denied for table scheduled_jobs',
      remainingFailures: 1,
    };
    const schedFailRes = await originalFetch(`${appA.baseUrl}/api/scheduled-jobs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws-behind-the-release',
        postId: 'post-fail-1',
        title: 'Should Fail DB',
        platform: 'instagram-reel',
        caption: 'test',
        hashtags: ['#74studio'],
        scheduledIso: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    assert.equal(schedFailRes.status, 502);

    // 4. Sales conversation DB failure propagates 502
    mock.faults.failNextUpsertTable = {
      table: 'sales_conversations',
      code: '42501',
      message: 'permission denied for table sales_conversations',
      remainingFailures: 1,
    };
    const salesFailRes = await originalFetch(`${appA.baseUrl}/api/sales/conversations`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ workspaceId: 'ws-74-studio-sales', title: 'Blocked Lead' }),
    });
    assert.equal(salesFailRes.status, 502);

    // 5. Direct assertSyncOk throws SupabasePersistenceError
    mock.faults.failNextUpsertTable = {
      table: 'sales_settings',
      code: '23503',
      message: 'foreign key violation',
      remainingFailures: 1,
    };
    await assert.rejects(
      async () => {
        assertSyncOk(await syncRowsToSupabase('sales_settings', [{ owner_uid: ownerUid }], 'owner_uid'));
      },
      (e: unknown) => e instanceof SupabasePersistenceError && e.statusCode === 502
    );
    mock.faults = {};
  });

  // --------------------------------------------------------------------------
  // T2: Dual Express Instances Video Studio Chunked Upload + Recovery + Integrity
  // --------------------------------------------------------------------------
  await t.test('T2: Dual-instance out-of-order chunked upload, SHA-256 checks, max-3 limit, safe cleanup & tmpdir zero-leak', async () => {
    const tmpBefore = countTempDirsWithPrefix('74studio-upl-');

    const projRes = await originalFetch(`${appA.baseUrl}/api/video-studio/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(makeTestVideoProject('Upload Test')),
    });
    assert.equal(projRes.status, 200);
    const { project } = (await projRes.json()) as { project: { id: string } };

    const mp4Buf = fs.readFileSync(sampleMp4Path);
    const fullSha = crypto.createHash('sha256').update(mp4Buf).digest('hex');
    const cSize = Math.ceil(mp4Buf.length / 3);
    const chunks = [
      mp4Buf.subarray(0, cSize),
      mp4Buf.subarray(cSize, cSize * 2),
      mp4Buf.subarray(cSize * 2),
    ];
    const chunkHashes = chunks.map((b) => crypto.createHash('sha256').update(b).digest('hex'));

    // Enforce max 3 concurrent upload sessions atomically; 4th -> 429 UPLOAD_CONCURRENCY_LIMIT
    const decoyIds: string[] = [];
    for (let k = 0; k < 3; k++) {
      const decoyInit = await originalFetch(
        `${k % 2 === 0 ? appA.baseUrl : appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/init`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            renderId: `rnd_decoy_${k}`,
            format: 'mp4',
            mimeType: 'video/mp4',
            totalBytes: mp4Buf.length,
            totalChunks: 3,
          }),
        }
      );
      assert.equal(decoyInit.status, 200);
      decoyIds.push(((await decoyInit.json()) as { uploadId: string }).uploadId);
    }

    const fourthInit = await originalFetch(
      `${appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/init`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          renderId: 'rnd_blocked_4th',
          format: 'mp4',
          mimeType: 'video/mp4',
          totalBytes: mp4Buf.length,
          totalChunks: 3,
        }),
      }
    );
    assert.equal(fourthInit.status, 429);
    assert.equal(((await fourthInit.json()) as { code: string }).code, 'UPLOAD_CONCURRENCY_LIMIT');

    // Expire decoy sessions to free slots for real upload test
    const sessRows = mock.tables.get('video_upload_sessions') || [];
    for (const s of sessRows) {
      if (decoyIds.includes(s.upload_id)) {
        s.expires_at = new Date(Date.now() - 10_000).toISOString();
      }
    }

    // Init real session on Instance A
    const initRes = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/init`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          renderId: 'rnd_real_1',
          format: 'mp4',
          mimeType: 'video/mp4',
          totalBytes: mp4Buf.length,
          totalChunks: 3,
          expectedSha256: fullSha,
        }),
      }
    );
    assert.equal(initRes.status, 200);
    const { uploadId } = (await initRes.json()) as { uploadId: string };

    // Bad X-Chunk-Sha256 header rejected immediately (400)
    const badHeaderRes = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/chunk?index=0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerJwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Sha256': '0'.repeat(64),
        },
        body: new Uint8Array(chunks[0]),
      }
    );
    assert.equal(badHeaderRes.status, 400);
    assert.equal(((await badHeaderRes.json()) as { code: string }).code, 'CHUNK_DIGEST_MISMATCH');

    // Out-of-order uploads split across Instance B & Instance A: index 2 -> index 0 -> index 1
    for (const [idx, base] of [
      [2, appB.baseUrl],
      [0, appA.baseUrl],
      [1, appB.baseUrl],
    ] as Array<[number, string]>) {
      const chunkRes = await originalFetch(
        `${base}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/chunk?index=${idx}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerJwt}`,
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Sha256': chunkHashes[idx],
          },
          body: new Uint8Array(chunks[idx]),
        }
      );
      assert.equal(chunkRes.status, 200);
    }

    // Idempotent identical retry of chunk 1 -> 200
    const idemChunkRes = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/chunk?index=1`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerJwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Sha256': chunkHashes[1],
        },
        body: new Uint8Array(chunks[1]),
      }
    );
    assert.equal(idemChunkRes.status, 200);
    assert.equal(((await idemChunkRes.json()) as { idempotent: boolean }).idempotent, true);

    // Conflicting chunk payload for chunk 1 -> 409 CHUNK_CONFLICT BEFORE overwriting storage
    const conflictBuf = Buffer.from(chunks[1]);
    conflictBuf[0] ^= 0xff;
    const conflictSha = crypto.createHash('sha256').update(conflictBuf).digest('hex');
    const conflictRes = await originalFetch(
      `${appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/chunk?index=1`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerJwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Sha256': conflictSha,
        },
        body: new Uint8Array(conflictBuf),
      }
    );
    assert.equal(conflictRes.status, 409);
    assert.equal(((await conflictRes.json()) as { code: string }).code, 'CHUNK_CONFLICT');

    // Simulate Storage failure on final object upload during /complete on Instance B:
    // Cloud _chunks MUST NOT be deleted!
    mock.removedStorageLog.length = 0;
    mock.faults.failNextStorageUploadPathIncludes = {
      substr: `${project.id}/rnd_real_1.mp4`,
      message: 'Simulated Storage outage',
      remainingFailures: 1,
    };
    const failCompleteRes = await originalFetch(
      `${appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/complete`,
      { method: 'POST', headers: authHeaders }
    );
    assert.equal(failCompleteRes.status, 502);
    assert.equal(mock.removedStorageLog.length, 0, 'Cloud _chunks must remain intact after completion failure');

    // Retry /complete on Instance A -> recovers cleanly & deletes _chunks ONLY AFTER video_renders upsert
    mock.upsertLog.length = 0;
    const okCompleteRes = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/complete`,
      { method: 'POST', headers: authHeaders }
    );
    assert.equal(okCompleteRes.status, 200);
    const completeData = (await okCompleteRes.json()) as {
      uploaded: boolean;
      storagePath: string;
      sha256: string;
      bytesUploaded: number;
    };
    assert.equal(completeData.uploaded, true);
    assert.equal(completeData.sha256, fullSha);
    assert.equal(completeData.bytesUploaded, mp4Buf.length);

    const renderUpsertEntry = mock.upsertLog.find((u) => u.table === 'video_renders');
    const chunkRemovalEntry = mock.removedStorageLog.find((r) =>
      r.paths.some((p) => p.includes(`_chunks/${uploadId}/`))
    );
    assert.ok(renderUpsertEntry, 'video_renders record must be persisted');
    assert.ok(chunkRemovalEntry, 'cloud _chunks should be cleaned after completion');
    assert.ok(
      renderUpsertEntry.at <= chunkRemovalEntry.at,
      'video_renders DB persistence must occur BEFORE cloud chunk removal'
    );

    const completedSess = (mock.tables.get('video_upload_sessions') || []).find((s) => s.upload_id === uploadId);
    assert.equal(completedSess?.status, 'completed');
    assert.ok(completedSess?.chunks_cleaned_at, 'chunks_cleaned_at should be recorded');

    // Idempotent retry after completion returns recovered: true
    const idempComplete = await originalFetch(
      `${appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${uploadId}/complete`,
      { method: 'POST', headers: authHeaders }
    );
    assert.equal(idempComplete.status, 200);
    assert.equal(((await idempComplete.json()) as { recovered?: boolean }).recovered, true);

    // Invalid MP4 container (arbitrary garbage declared as mp4) rejected with 422 INVALID_MP4_CONTAINER and chunks preserved
    const badMp4 = Buffer.from('not-a-valid-mp4-container-payload-at-all');
    const badSha = crypto.createHash('sha256').update(badMp4).digest('hex');
    const badInit = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/init`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          renderId: 'rnd_bad_mp4',
          format: 'mp4',
          mimeType: 'video/mp4',
          totalBytes: badMp4.length,
          totalChunks: 1,
          expectedSha256: badSha,
        }),
      }
    );
    assert.equal(badInit.status, 200);
    const { uploadId: badUploadId } = (await badInit.json()) as { uploadId: string };
    const badChunk = await originalFetch(
      `${appA.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${badUploadId}/chunk?index=0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerJwt}`,
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Sha256': badSha,
        },
        body: new Uint8Array(badMp4),
      }
    );
    assert.equal(badChunk.status, 200);
    const badComplete = await originalFetch(
      `${appB.baseUrl}/api/video-studio/projects/${project.id}/upload-render/${badUploadId}/complete`,
      { method: 'POST', headers: authHeaders }
    );
    assert.equal(badComplete.status, 422);
    assert.equal(((await badComplete.json()) as { code: string }).code, 'INVALID_MP4_CONTAINER');

    assert.equal(countTempDirsWithPrefix('74studio-upl-'), tmpBefore, 'No leftover os.tmpdir() upload dirs');
  });

  // --------------------------------------------------------------------------
  // T3 & T4: Dual-Instance Publishing Idempotency + IG Signed Storage URLs + Cleanup
  // --------------------------------------------------------------------------
  await t.test('T3 & T4: Distributed publishing locks, lock_token verification, reconciliation & IG private signed URL staging', async () => {
    // Seed encrypted Instagram connection in mock oauth_connections
    const conns = mock.tables.get('oauth_connections') || [];
    conns.push({
      owner_uid: ownerUid,
      workspace_id: 'ws-behind-the-release',
      platform: 'instagram',
      account_id: 'ig-biz-123',
      account_name: '74 Studio Official',
      account_handle: 'studio74',
      token_type: 'META_LOGIN',
      encrypted_access_token_json: encryptSecret('mock-ig-access-token'),
      encrypted_refresh_token_json: null,
      expires_at: Date.now() + 86_400_000,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    mock.tables.set('oauth_connections', conns);

    const mp4Buf = fs.readFileSync(sampleMp4Path);
    const webmBuf = fs.readFileSync(sampleWebmPath);

    // 1. Create scheduled job on Instance A with MP4 media
    const jobCreateRes = await originalFetch(`${appA.baseUrl}/api/scheduled-jobs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws-behind-the-release',
        postId: 'post-ig-lock-1',
        title: 'Phase 1.5 Reel',
        platform: 'instagram-reel',
        caption: 'Fresh reel from Video Studio',
        hashtags: ['#74studio'],
        scheduledIso: new Date(Date.now() - 5000).toISOString(),
        mediaItems: [{ filename: 'reel.mp4', mimeType: 'video/mp4', base64Data: mp4Buf.toString('base64') }],
      }),
    });
    assert.equal(jobCreateRes.status, 200);
    const { job } = (await jobCreateRes.json()) as {
      job: {
        id: string;
        mediaPreviews: Array<{ index: number; filename: string; mimeType: string; url: string }>;
        preservedMediaCount: number;
      };
    };
    assert.equal(job.preservedMediaCount, 1);
    assert.ok(job.mediaPreviews[0].url.includes('exp='), 'Preview should use Supabase Storage signed URL');

    // /api/temp-media/* must return 404 when Supabase is configured
    const deadTempRes = await originalFetch(`${appB.baseUrl}/api/temp-media/anything`);
    assert.equal(deadTempRes.status, 404);

    // 2. Test lock_token mismatch enforcement & active lease block across Instance A/B
    const lockResA = await mock.asClient().rpc('acquire_publish_destination_lock', {
      p_owner_uid: ownerUid,
      p_workspace_id: 'ws-behind-the-release',
      p_post_id: 'post-ig-lock-1',
      p_platform: 'instagram',
      p_job_id: job.id,
      p_lock_token: 'tok-valid-1',
      p_lease_seconds: 300,
    });
    assert.equal(lockResA.data.ok, true);

    // Wrong lock_token cannot record in_flight_id or complete
    const badInFlight = await mock.asClient().rpc('record_publish_in_flight_id', {
      p_owner_uid: ownerUid,
      p_workspace_id: 'ws-behind-the-release',
      p_post_id: 'post-ig-lock-1',
      p_platform: 'instagram',
      p_lock_token: 'tok-wrong',
      p_in_flight_id: 'ig_fake',
    });
    assert.equal(badInFlight.data.code, 'LOCK_TOKEN_MISMATCH');

    // Concurrent send on Instance B must be rejected 409 PUBLISH_IN_PROGRESS
    const concurrentSendB = await originalFetch(`${appB.baseUrl}/api/scheduled-jobs/${job.id}/send`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targets: ['instagram'] }),
    });
    assert.equal(concurrentSendB.status, 409);
    assert.equal(((await concurrentSendB.json()) as { code: string }).code, 'PUBLISH_IN_PROGRESS');

    // Also direct /api/publish/now with same postId on Instance B -> 409 PUBLISH_IN_PROGRESS
    const concurrentNowB = await originalFetch(`${appB.baseUrl}/api/publish/now`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws-behind-the-release',
        postId: 'post-ig-lock-1',
        platform: 'instagram-reel',
        title: 'Dup Attempt',
        caption: 'dup',
        hashtags: [],
        mediaItems: [],
      }),
    });
    assert.equal(concurrentNowB.status, 409);
    assert.equal(((await concurrentNowB.json()) as { code: string }).code, 'PUBLISH_IN_PROGRESS');

    // 3. Record valid in_flight_id & simulate EXPIRED lease -> must force needs_reconciliation (no auto-republish)
    const goodInFlight = await mock.asClient().rpc('record_publish_in_flight_id', {
      p_owner_uid: ownerUid,
      p_workspace_id: 'ws-behind-the-release',
      p_post_id: 'post-ig-lock-1',
      p_platform: 'instagram',
      p_lock_token: 'tok-valid-1',
      p_in_flight_id: 'ig_cont_interrupted_99',
    });
    assert.equal(goodInFlight.data.ok, true);

    const idemRow = (mock.tables.get('publish_idempotency') || []).find(
      (r) => r.post_id === 'post-ig-lock-1'
    )!;
    idemRow.lease_expires_at = new Date(Date.now() - 5000).toISOString();

    const retryBlocked = await originalFetch(`${appA.baseUrl}/api/scheduled-jobs/${job.id}/retry`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targets: ['instagram'] }),
    });
    assert.equal(retryBlocked.status, 409);
    assert.equal(((await retryBlocked.json()) as { code: string }).code, 'NEEDS_RECONCILIATION');

    // 4. Reconcile during Meta outage -> indeterminate, needs_reconciliation MUST stay intact
    metaBehavior.reconcileStatusCode = 'OUTAGE';
    const recOutage = await originalFetch(`${appB.baseUrl}/api/scheduled-jobs/${job.id}/reconcile`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ platform: 'instagram' }),
    });
    assert.equal(recOutage.status, 200);
    const recOutageJson = (await recOutage.json()) as {
      outcomes: { instagram: { indeterminate?: boolean; reconciledPublished: boolean } };
      job: { destinations: Array<{ needsReconciliation?: boolean }> };
    };
    assert.equal(recOutageJson.outcomes.instagram.indeterminate, true);
    assert.equal(recOutageJson.job.destinations[0].needsReconciliation, true);

    // 5. Reconcile confirms ERROR (not published) -> clears lock safely so retry can run
    metaBehavior.reconcileStatusCode = 'ERROR';
    const recErr = await originalFetch(`${appA.baseUrl}/api/scheduled-jobs/${job.id}/reconcile`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ platform: 'instagram' }),
    });
    assert.equal(recErr.status, 200);
    metaBehavior.reconcileStatusCode = undefined;

    // 6. Retry publish on Instance B -> uploads staged video to private Storage, gives HTTPS signed URL to Meta, verifies HEAD/GET/Range, cleans temp-ig in finally
    metaBehavior = { ...metaBehavior, lastVideoUrlSent: undefined };
    mock.removedStorageLog.length = 0;
    const retryOkRes = await originalFetch(`${appB.baseUrl}/api/scheduled-jobs/${job.id}/retry`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targets: ['instagram'] }),
    });
    assert.equal(retryOkRes.status, 200);
    const retryOkData = (await retryOkRes.json()) as { ok: boolean; status: string };
    assert.equal(retryOkData.ok, true);
    assert.equal(retryOkData.status, 'published');
    const capturedVideoUrl: string | undefined = metaBehavior.lastVideoUrlSent;
    assert.ok(capturedVideoUrl && capturedVideoUrl.startsWith('http://127.0.0.1:'), 'Signed Storage URL passed to Meta');
    assert.ok(
      mock.removedStorageLog.some((r) => r.bucket === 'social-media' && r.paths.some((p) => p.includes('/temp-ig/'))),
      'temp-ig staged file cleaned up in finally after publish'
    );

    // Verify signed URL behavior against real HTTP server (verify live signed URLs in scheduled job previews support HEAD/GET/Range)
    const headPreview = await originalFetch(job.mediaPreviews[0].url, { method: 'HEAD' });
    assert.equal(headPreview.status, 200);
    assert.equal(headPreview.headers.get('content-type'), 'video/mp4');
    const rangePreview = await originalFetch(job.mediaPreviews[0].url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(rangePreview.status, 206);
    assert.equal((await rangePreview.arrayBuffer()).byteLength, 16);

    // 7. Re-sending already published job on Instance A -> blocked with 409
    const dupSend = await originalFetch(`${appA.baseUrl}/api/scheduled-jobs/${job.id}/send`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ targets: ['instagram'] }),
    });
    assert.equal(dupSend.status, 409);

    // 8. WebM explicitly rejected for Instagram
    const webmPublish = await originalFetch(`${appA.baseUrl}/api/publish/now`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: 'ws-behind-the-release',
        postId: 'post-ig-webm-reject',
        platform: 'instagram-reel',
        title: 'Bad WebM',
        caption: 'fail',
        hashtags: [],
        mediaItems: [{ filename: 'clip.webm', mimeType: 'video/webm', base64Data: webmBuf.toString('base64') }],
      }),
    });
    assert.equal(webmPublish.status, 400);
    const webmErr = (await webmPublish.json()) as { error: string };
    assert.match(webmErr.error, /MP4 file, not WebM/i);
  });

  // --------------------------------------------------------------------------
  // T5: Collision-Resistant Owner Storage Prefixes & Cross-Owner Isolation
  // --------------------------------------------------------------------------
  await t.test('T5: Collision-resistant storage owner prefixes & cross-owner isolation', async () => {
    const uidA = 'user.alpha';
    const uidB = 'user-alpha';
    assert.equal(getLegacySafeStorageOwnerPrefix(uidA), getLegacySafeStorageOwnerPrefix(uidB));
    assert.notEqual(
      getSafeStorageOwnerPrefix(uidA),
      getSafeStorageOwnerPrefix(uidB),
      'SHA-256 suffixed storage prefixes must not collide when punctuation differs'
    );
    assert.equal(isLosslessLegacyPrefixOwner(uidA), false);
    assert.equal(isLosslessLegacyPrefixOwner('abc_DEF-123'), true);

    const long1 = `${'x'.repeat(128)}-one`;
    const long2 = `${'x'.repeat(128)}-two`;
    assert.notEqual(getSafeStorageOwnerPrefix(long1), getSafeStorageOwnerPrefix(long2));

    // Owner A creates project; Owner B cannot see or access it across instances
    const tokA = mintFirebaseToken(uidA, 'a@74-studio.com');
    const tokB = mintFirebaseToken(uidB, 'b@74-studio.com');
    const createA = await originalFetch(`${appA.baseUrl}/api/video-studio/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTestVideoProject('Owner A Private')),
    });
    assert.equal(createA.status, 200);
    const { project } = (await createA.json()) as { project: { id: string } };

    const readByB = await originalFetch(`${appB.baseUrl}/api/video-studio/projects/${project.id}/renders/r1/url`, {
      headers: { Authorization: `Bearer ${tokB}` },
    });
    assert.equal(readByB.status, 404);
  });

  // --------------------------------------------------------------------------
  // T6: Real FFmpeg Streaming Transcode & Memory/CPU Benchmark (Sequential + 3x Concurrent Semaphore)
  // --------------------------------------------------------------------------
  await t.test('T6: Real FFmpeg streaming transcode & concurrent semaphore benchmark', async () => {
    const tmpBefore = countTempDirsWithPrefix('74studio-mp4-');
    const webmBuf = fs.readFileSync(sampleWebmPath);

    const runSingleTranscode = async (idx: number) => {
      const startNs = process.hrtime.bigint();
      const cpuBefore = process.cpuUsage();
      const res = await originalFetch(`${appA.baseUrl}/api/video/transcode-mp4?width=540&height=960&fps=30`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerJwt}`,
          'Content-Type': 'video/webm',
        },
        body: new Uint8Array(webmBuf),
      });
      assert.equal(res.status, 200, `Transcode #${idx} returned ${res.status}`);
      assert.equal(res.headers.get('content-type'), 'video/mp4');
      assert.equal(res.headers.get('x-faststart-verified'), 'true');
      const outBuf = Buffer.from(await res.arrayBuffer());
      const verifyPath = path.join(fixtureDir, `out-${idx}.mp4`);
      fs.writeFileSync(verifyPath, outBuf);
      const probed = await probeAndValidateMp4(verifyPath, { width: 540, height: 960, fps: 30 });
      assert.equal(probed.valid, true, `MP4 probe failed: ${probed.reason}`);
      assert.equal(probed.videoCodec, 'h264');
      assert.equal(probed.audioCodec, 'aac');
      assert.equal(probed.hasMoovBeforeMdat, true);
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const cpuDelta = process.cpuUsage(cpuBefore);
      return {
        bytesOut: outBuf.length,
        elapsedMs,
        cpuUserMs: cpuDelta.user / 1000,
        cpuSysMs: cpuDelta.system / 1000,
      };
    };

    const memBefore = process.memoryUsage();
    const seqStat = await runSingleTranscode(0);
    const memAfterSeq = process.memoryUsage();

    // Concurrent burst of 3 (MAX_CONCURRENT_TRANSCODES=2 -> 2 active + 1 cleanly queued by TranscodeSemaphore)
    const burstStart = process.hrtime.bigint();
    const burstStats = await Promise.all([runSingleTranscode(1), runSingleTranscode(2), runSingleTranscode(3)]);
    const burstTotalMs = Number(process.hrtime.bigint() - burstStart) / 1e6;
    const memAfterBurst = process.memoryUsage();

    await new Promise((r) => setTimeout(r, 80));

    const seqHeapDeltaMb = (memAfterSeq.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    const burstRssDeltaMb = (memAfterBurst.rss - memBefore.rss) / (1024 * 1024);

    assert.equal(countTempDirsWithPrefix('74studio-mp4-'), tmpBefore, 'Zero leftover transcode tmpdirs');
    console.log(
      JSON.stringify(
        {
          benchmark: 'ffmpeg-streaming-transcode',
          inputWebmBytes: webmBuf.length,
          seqElapsedMs: Math.round(seqStat.elapsedMs),
          seqOutBytes: seqStat.bytesOut,
          seqHeapDeltaMb: Number(seqHeapDeltaMb.toFixed(2)),
          burst3TotalMs: Math.round(burstTotalMs),
          burst3ItemsMs: burstStats.map((s) => Math.round(s.elapsedMs)),
          burstRssDeltaMb: Number(burstRssDeltaMb.toFixed(2)),
        },
        null,
        2
      )
    );
  });
});
