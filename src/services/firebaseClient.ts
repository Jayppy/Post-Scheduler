import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  IntegrationsStatusResponse,
  PublishHistoryEntry,
  ScheduledJobSummary,
} from './integrationsClient';
import type { SocialPlatform } from '../types/studio';

const app = initializeApp(firebaseConfig);
export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

// Run startup connectivity probe immediately as mandated
testConnection();

export function sanitizeFirestoreId(raw: string, maxLen = 128): string {
  const cleaned = (raw || 'doc').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, maxLen);
  return cleaned || 'doc';
}

export async function signInWithGoogleOperator(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutOperator(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserProfileDoc(user: User): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);

  try {
    const snap = await getDoc(ref);
    const displayName = (user.displayName || user.email || 'Studio Operator').slice(0, 120);
    const email = user.email ? user.email.slice(0, 200) : undefined;

    if (!snap.exists()) {
      const payload: Record<string, unknown> = {
        uid,
        displayName,
        role: 'operator',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (email) payload.email = email;
      await setDoc(ref, payload);
    } else {
      const payload: Record<string, unknown> = {
        displayName,
        updatedAt: serverTimestamp(),
      };
      if (email) payload.email = email;
      await updateDoc(ref, payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export interface CloudConnectionDoc {
  id: string;
  ownerId: string;
  workspaceId: string;
  platform: 'instagram' | 'youtube';
  connected: boolean;
  accountId: string;
  accountName: string;
  accountHandle?: string;
  tokenType?: 'SYSTEM_USER' | 'USER' | 'GOOGLE_OAUTH';
  expiresAt?: number;
  lastError?: string;
  connectedAt?: string;
}

export async function syncWorkspaceConnectionsToFirestore(
  user: User,
  workspaceId: string,
  status: IntegrationsStatusResponse
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeWsId = sanitizeFirestoreId(workspaceId, 80);

  const platforms: Array<'instagram' | 'youtube'> = ['youtube', 'instagram'];

  for (const platform of platforms) {
    const info = status[platform];
    const connDocId = sanitizeFirestoreId(`${safeWsId}__${platform}`, 128);
    const path = `users/${uid}/workspaceConnections/${connDocId}`;
    const ref = doc(db, 'users', uid, 'workspaceConnections', connDocId);

    const tokenTypeNormalized =
      info.tokenType === 'SYSTEM_USER' || info.tokenType === 'USER' || info.tokenType === 'GOOGLE_OAUTH'
        ? info.tokenType
        : platform === 'youtube'
          ? 'GOOGLE_OAUTH'
          : 'SYSTEM_USER';

    try {
      const snap = await getDoc(ref);
      const mutableFields: Record<string, unknown> = {
        connected: Boolean(info.connected),
        accountId: (info.accountId || '').slice(0, 128),
        accountName: (info.accountName || '').slice(0, 160),
        updatedAt: serverTimestamp(),
      };
      if (info.accountHandle) mutableFields.accountHandle = info.accountHandle.slice(0, 120);
      if (info.connected) mutableFields.tokenType = tokenTypeNormalized;
      if (typeof info.expiresAt === 'number' && info.expiresAt >= 0) {
        mutableFields.expiresAt = info.expiresAt;
      }
      if (info.lastError) mutableFields.lastError = info.lastError.slice(0, 600);
      if (info.connectedAt) mutableFields.connectedAt = info.connectedAt.slice(0, 64);

      if (!snap.exists()) {
        await setDoc(ref, {
          ownerId: uid,
          workspaceId: safeWsId,
          platform,
          ...mutableFields,
          createdAt: serverTimestamp(),
        });
      } else {
        await updateDoc(ref, mutableFields);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export async function syncScheduledJobsToFirestore(
  user: User,
  jobs: ScheduledJobSummary[]
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);

  for (const job of jobs) {
    const jobId = sanitizeFirestoreId(job.id, 128);
    const safeWsId = sanitizeFirestoreId(job.workspaceId, 80);
    const safePostId = sanitizeFirestoreId(job.postId, 128);
    const path = `users/${uid}/scheduledJobs/${jobId}`;
    const ref = doc(db, 'users', uid, 'scheduledJobs', jobId);

    const safeHashtags = (job.hashtags || [])
      .slice(0, 30)
      .map((h) => String(h).slice(0, 80));

    const igDest = job.destinations?.find((d) => d.platform === 'instagram');
    const ytDest = job.destinations?.find((d) => d.platform === 'youtube');

    const destFields: Record<string, unknown> = {};
    if (igDest) {
      destFields.igStatus = igDest.status;
      if (igDest.platformPostId) destFields.igPostId = igDest.platformPostId.slice(0, 160);
      if (igDest.resultUrl) destFields.igResultUrl = igDest.resultUrl.slice(0, 500);
      if (igDest.publishedAt) destFields.igPublishedAt = igDest.publishedAt.slice(0, 64);
      if (igDest.error) destFields.igError = igDest.error.slice(0, 1000);
    }
    if (ytDest) {
      destFields.ytStatus = ytDest.status;
      if (ytDest.platformPostId) destFields.ytPostId = ytDest.platformPostId.slice(0, 160);
      if (ytDest.resultUrl) destFields.ytResultUrl = ytDest.resultUrl.slice(0, 500);
      if (ytDest.publishedAt) destFields.ytPublishedAt = ytDest.publishedAt.slice(0, 64);
      if (ytDest.error) destFields.ytError = ytDest.error.slice(0, 1000);
    }

    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const createPayload: Record<string, unknown> = {
          ownerId: uid,
          workspaceId: safeWsId,
          postId: safePostId,
          title: (job.title || 'Scheduled Post').slice(0, 200),
          platform: job.platform,
          caption: (job.caption || '').slice(0, 2500),
          hashtags: safeHashtags,
          scheduledIso: (job.scheduledIso || new Date().toISOString()).slice(0, 64),
          timezone: (job.timezone || 'Africa/Lagos').slice(0, 64),
          mediaCount: Math.max(0, Math.min(20, Number(job.mediaCount) || 0)),
          status: job.status,
          attempts: Math.max(0, Math.min(500, Number(job.attempts) || 0)),
          ...destFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (job.youtubePrivacyStatus) createPayload.youtubePrivacyStatus = job.youtubePrivacyStatus;
        if (job.publishedAt) createPayload.publishedAt = job.publishedAt.slice(0, 64);
        if (job.platformPostId) createPayload.platformPostId = job.platformPostId.slice(0, 160);
        if (job.resultUrl) createPayload.resultUrl = job.resultUrl.slice(0, 500);
        if (job.error) createPayload.error = job.error.slice(0, 1000);
        await setDoc(ref, createPayload);
      } else {
        const existingData = snap.data();
        if (existingData.status === 'published') continue; // Terminal lock respected

        const metadataChanged =
          existingData.title !== (job.title || 'Scheduled Post').slice(0, 200) ||
          existingData.caption !== (job.caption || '').slice(0, 2500) ||
          existingData.scheduledIso !== (job.scheduledIso || '').slice(0, 64) ||
          existingData.timezone !== (job.timezone || 'Africa/Lagos').slice(0, 64) ||
          existingData.youtubePrivacyStatus !== job.youtubePrivacyStatus ||
          existingData.mediaCount !== Math.max(0, Math.min(20, Number(job.mediaCount) || 0));

        if (metadataChanged) {
          const metaPayload: Record<string, unknown> = {
            title: (job.title || 'Scheduled Post').slice(0, 200),
            platform: job.platform,
            caption: (job.caption || '').slice(0, 2500),
            hashtags: safeHashtags,
            scheduledIso: (job.scheduledIso || new Date().toISOString()).slice(0, 64),
            timezone: (job.timezone || 'Africa/Lagos').slice(0, 64),
            mediaCount: Math.max(0, Math.min(20, Number(job.mediaCount) || 0)),
            status: job.status,
            updatedAt: serverTimestamp(),
          };
          if (job.youtubePrivacyStatus) metaPayload.youtubePrivacyStatus = job.youtubePrivacyStatus;
          if (job.error) metaPayload.error = job.error.slice(0, 1000);
          if (igDest) {
            metaPayload.igStatus = igDest.status;
            if (igDest.error) metaPayload.igError = igDest.error.slice(0, 1000);
          }
          if (ytDest) {
            metaPayload.ytStatus = ytDest.status;
            if (ytDest.error) metaPayload.ytError = ytDest.error.slice(0, 1000);
          }
          await updateDoc(ref, metaPayload);
        } else {
          const updatePayload: Record<string, unknown> = {
            status: job.status,
            attempts: Math.max(0, Math.min(500, Number(job.attempts) || 0)),
            ...destFields,
            updatedAt: serverTimestamp(),
          };
          if (job.publishedAt) updatePayload.publishedAt = job.publishedAt.slice(0, 64);
          if (job.platformPostId) updatePayload.platformPostId = job.platformPostId.slice(0, 160);
          if (job.resultUrl) updatePayload.resultUrl = job.resultUrl.slice(0, 500);
          if (job.error) updatePayload.error = job.error.slice(0, 1000);
          await updateDoc(ref, updatePayload);
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export async function deleteScheduledJobFromFirestore(user: User, jobId: string): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeId = sanitizeFirestoreId(jobId, 128);
  const path = `users/${uid}/scheduledJobs/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'scheduledJobs', safeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncPublishHistoryToFirestore(
  user: User,
  entries: PublishHistoryEntry[]
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);

  for (const entry of entries.slice(0, 40)) {
    const historyId = sanitizeFirestoreId(entry.id, 128);
    const path = `users/${uid}/publishHistory/${historyId}`;
    const ref = doc(db, 'users', uid, 'publishHistory', historyId);

    try {
      const snap = await getDoc(ref);
      if (snap.exists()) continue; // Append-only audit log

      const payload: Record<string, unknown> = {
        ownerId: uid,
        workspaceId: sanitizeFirestoreId(entry.workspaceId, 80),
        postId: sanitizeFirestoreId(entry.postId, 128),
        title: (entry.title || 'Publish Event').slice(0, 200),
        platform: entry.platform,
        mode: entry.mode,
        status: entry.status,
        timestamp: (entry.timestamp || new Date().toISOString()).slice(0, 64),
        createdAt: serverTimestamp(),
      };
      if (entry.jobId) payload.jobId = sanitizeFirestoreId(entry.jobId, 128);
      if (entry.platformPostId) payload.platformPostId = entry.platformPostId.slice(0, 160);
      if (entry.resultUrl) payload.resultUrl = entry.resultUrl.slice(0, 500);
      if (entry.error) payload.error = entry.error.slice(0, 1000);

      await setDoc(ref, payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}

export function subscribeWorkspaceCloudData(
  user: User,
  workspaceId: string,
  callbacks: {
    onConnections: (items: CloudConnectionDoc[]) => void;
    onJobs: (items: ScheduledJobSummary[]) => void;
    onHistory: (items: PublishHistoryEntry[]) => void;
  }
): () => void {
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeWsId = sanitizeFirestoreId(workspaceId, 80);

  const unsubs: Unsubscribe[] = [];

  const connPath = `users/${uid}/workspaceConnections`;
  const connQ = query(
    collection(db, 'users', uid, 'workspaceConnections'),
    where('ownerId', '==', uid),
    where('workspaceId', '==', safeWsId)
  );
  unsubs.push(
    onSnapshot(
      connQ,
      (snap) => {
        const items: CloudConnectionDoc[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<CloudConnectionDoc, 'id'>),
        }));
        callbacks.onConnections(items);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, connPath)
    )
  );

  const jobsPath = `users/${uid}/scheduledJobs`;
  const jobsQ = query(
    collection(db, 'users', uid, 'scheduledJobs'),
    where('ownerId', '==', uid),
    where('workspaceId', '==', safeWsId)
  );
  unsubs.push(
    onSnapshot(
      jobsQ,
      (snap) => {
        const items: ScheduledJobSummary[] = snap.docs.map((d) => {
          const data = d.data();
          const reconstructedDests: ScheduledJobSummary['destinations'] = [];
          if (data.igStatus) {
            reconstructedDests.push({
              platform: 'instagram',
              format: data.platform !== 'youtube-shorts' ? data.platform : 'instagram-reel',
              status: data.igStatus,
              attempts: Number(data.attempts || 0),
              platformPostId: data.igPostId,
              resultUrl: data.igResultUrl,
              publishedAt: data.igPublishedAt,
              error: data.igError,
            });
          }
          if (data.ytStatus) {
            reconstructedDests.push({
              platform: 'youtube',
              format: 'youtube-shorts',
              status: data.ytStatus,
              attempts: Number(data.attempts || 0),
              platformPostId: data.ytPostId,
              resultUrl: data.ytResultUrl,
              publishedAt: data.ytPublishedAt,
              error: data.ytError,
              youtubePrivacyStatus: data.youtubePrivacyStatus,
            });
          }
          return {
            id: d.id,
            workspaceId: String(data.workspaceId || safeWsId),
            postId: String(data.postId || ''),
            title: String(data.title || ''),
            platform: data.platform as SocialPlatform,
            platforms:
              reconstructedDests.length > 0
                ? reconstructedDests.map((dest) => dest.platform)
                : [data.platform === 'youtube-shorts' ? 'youtube' : 'instagram'],
            destinations: reconstructedDests.length > 0 ? reconstructedDests : undefined,
            caption: String(data.caption || ''),
            hashtags: Array.isArray(data.hashtags) ? data.hashtags : [],
            youtubePrivacyStatus: data.youtubePrivacyStatus,
            scheduledIso: String(data.scheduledIso || ''),
            timezone: String(data.timezone || 'Africa/Lagos'),
            status: data.status,
            attempts: Number(data.attempts || 0),
            publishedAt: data.publishedAt,
            platformPostId: data.platformPostId,
            resultUrl: data.resultUrl,
            error: data.error,
            mediaCount: Number(data.mediaCount || 0),
            createdAt: '',
            updatedAt: '',
          };
        });
        callbacks.onJobs(items);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, jobsPath)
    )
  );

  const histPath = `users/${uid}/publishHistory`;
  const histQ = query(
    collection(db, 'users', uid, 'publishHistory'),
    where('ownerId', '==', uid),
    where('workspaceId', '==', safeWsId)
  );
  unsubs.push(
    onSnapshot(
      histQ,
      (snap) => {
        const items: PublishHistoryEntry[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            workspaceId: String(data.workspaceId || safeWsId),
            postId: String(data.postId || ''),
            jobId: data.jobId,
            title: String(data.title || ''),
            platform: data.platform as SocialPlatform,
            mode: data.mode,
            status: data.status,
            resultUrl: data.resultUrl,
            error: data.error,
            timestamp: String(data.timestamp || ''),
          };
        });
        callbacks.onHistory(items);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, histPath)
    )
  );

  return () => {
    unsubs.forEach((u) => u());
  };
}

export async function fetchAllCloudScheduledJobs(user: User, workspaceId: string) {
  if (!user.emailVerified) return [];
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeWsId = sanitizeFirestoreId(workspaceId, 80);
  const path = `users/${uid}/scheduledJobs`;
  try {
    const q = query(
      collection(db, 'users', uid, 'scheduledJobs'),
      where('ownerId', '==', uid),
      where('workspaceId', '==', safeWsId)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}
