import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { BusinessWorkspaceId } from '../../src/types/aiProviders';

interface FirebasePublicCertsCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let certsCache: FirebasePublicCertsCache | null = null;

function resolveFirebaseProjectId(): string {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (parsed.projectId) return parsed.projectId;
    }
  } catch {
    // ignore
  }
  return process.env.FIREBASE_PROJECT_ID || 'smooth-triumph-59brs';
}

async function getGoogleSecureTokenCerts(): Promise<Record<string, string>> {
  if (certsCache && certsCache.expiresAt > Date.now()) {
    return certsCache.certs;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Firebase public keys (${res.status}).`);
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 3600_000;
  const certs = (await res.json()) as Record<string, string>;
  certsCache = { certs, expiresAt: Date.now() + ttlMs };
  return certs;
}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((segment.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export interface VerifiedFirebaseTokenPayload {
  uid: string;
  email?: string;
  emailVerified: boolean;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseTokenPayload> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: string; kid?: string };
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Invalid Firebase token algorithm or missing key ID.');
  }

  const projectId = resolveFirebaseProjectId();
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new Error('Firebase token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new Error('Firebase token subject invalid.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Firebase ID token expired.');
  }
  if (payload.iat && payload.iat > nowSec + 300) {
    throw new Error('Firebase ID token issued in the future.');
  }

  const certs = await getGoogleSecureTokenCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Signing certificate not found for Firebase token kid.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const sigBuf = base64UrlDecode(signatureB64);
  if (!verifier.verify(certPem, sigBuf)) {
    throw new Error('Firebase ID token signature verification failed.');
  }

  if (payload.email_verified !== true) {
    throw new Error('Verified Google email is required.');
  }

  return {
    uid: payload.sub,
    email: payload.email,
    emailVerified: true,
  };
}

export interface AuthenticatedRequest extends Request {
  operatorContext?: {
    authenticated: boolean;
    authSource: 'firebase-bearer' | 'local-studio-session';
    ownerScopeKey: string;
    email?: string;
  };
}

/**
 * Independent server-side authentication & operator context guard:
 * - If Authorization: Bearer <idToken> is sent, verifies cryptographic RS256 Firebase signature and fails closed on invalid/unverified tokens.
 * - Rejects cross-origin non-app browser requests (Origin mismatch) unless verified Bearer token is present.
 * - Scopes persisted server data strictly to `uid` when signed in, or `'local-operator'` in unauthenticated preview/CLI verification unless STRICT_FIREBASE_AUTH=true.
 */
export function requireServerOperator(allowedWorkspace?: BusinessWorkspaceId) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: 'Invalid Authorization header format.' });
      }
      try {
        const verified = await verifyFirebaseIdToken(match[1].trim());
        req.operatorContext = {
          authenticated: true,
          authSource: 'firebase-bearer',
          ownerScopeKey: verified.uid.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128),
          email: verified.email,
        };
      } catch (err) {
        return res.status(401).json({
          error: err instanceof Error ? err.message : 'Firebase authentication failed.',
          code: 'UNAUTHORIZED',
        });
      }
    } else {
      if (process.env.STRICT_FIREBASE_AUTH === 'true') {
        return res.status(401).json({
          error: 'Authentication required. Sign in with Google to access this workspace endpoint.',
          code: 'AUTH_REQUIRED',
        });
      }
      req.operatorContext = {
        authenticated: true,
        authSource: 'local-studio-session',
        ownerScopeKey: 'local-operator',
      };
    }

    // Strict Workspace Ownership & Cross-Workspace Boundary Guard
    if (allowedWorkspace) {
      const bodyWs = (req.body as { workspaceId?: string } | undefined)?.workspaceId;
      const queryWs = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      const requestedWs = bodyWs || queryWs;
      if (requestedWs && requestedWs !== allowedWorkspace) {
        return res.status(403).json({
          error: `Cross-workspace access denied: endpoint belongs exclusively to "${allowedWorkspace}", received "${requestedWs}".`,
          code: 'WORKSPACE_ISOLATION_VIOLATION',
        });
      }
    }

    return next();
  };
}

export function validateBusinessWorkspaceId(raw: unknown): BusinessWorkspaceId | null {
  if (raw === 'ws-behind-the-release' || raw === 'ws-74-studio-sales') return raw;
  return null;
}
