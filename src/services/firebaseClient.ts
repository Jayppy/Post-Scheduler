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
  deleteField,
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
import type {
  BusinessKnowledgeBase,
  MarketingDraft,
  ResearchSourceRecord,
} from '../types/marketing';
import type { WorkspaceAiProfileConfig } from '../types/aiProviders';
import type {
  SalesActivityRecord,
  SalesKnowledgeBase,
  SalesLeadRecord,
  SalesOutputRecord,
} from '../types/sales';

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
      if (info.accountHandle) {
        mutableFields.accountHandle = info.accountHandle.slice(0, 120);
      } else if (snap.exists()) {
        mutableFields.accountHandle = deleteField();
      }
      if (info.connected) mutableFields.tokenType = tokenTypeNormalized;
      if (typeof info.expiresAt === 'number' && info.expiresAt >= 0) {
        mutableFields.expiresAt = info.expiresAt;
      }
      if (info.lastError) {
        mutableFields.lastError = info.lastError.slice(0, 600);
      } else if (snap.exists()) {
        mutableFields.lastError = deleteField();
      }
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

// --- 74 STUDIO Marketing Content Studio Firestore Sync (Isolated from Behind The Release) ---

export async function syncMarketingProfileToFirestore(
  user: User,
  kb: BusinessKnowledgeBase
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const profileId = sanitizeFirestoreId(kb.id || 'kb-74-studio', 80);
  const path = `users/${uid}/marketingProfiles/${profileId}`;
  const ref = doc(db, 'users', uid, 'marketingProfiles', profileId);

  try {
    const snap = await getDoc(ref);
    const mutableFields = {
      businessName: (kb.businessName || '74 STUDIO').slice(0, 160),
      websiteUrl: (kb.websiteUrl || 'https://74-studio.com').slice(0, 300),
      brandVoice: (kb.brandVoice || '').slice(0, 2000),
      positioning: (kb.positioning || '').slice(0, 3000),
      pricingSummary: (kb.pricingSummary || '').slice(0, 2000),
      contactSummary: (kb.contactSummary || '').slice(0, 2000),
      servicesJson: JSON.stringify(kb.services || []).slice(0, 24000),
      icpJson: JSON.stringify(kb.idealCustomerProfiles || []).slice(0, 20000),
      proofJson: JSON.stringify(kb.verifiedProofItems || []).slice(0, 20000),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        profileId,
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

export async function syncResearchSourcesToFirestore(
  user: User,
  sources: ResearchSourceRecord[]
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);

  for (const src of sources.slice(0, 25)) {
    const sourceId = sanitizeFirestoreId(src.id, 128);
    const path = `users/${uid}/researchSources/${sourceId}`;
    const ref = doc(db, 'users', uid, 'researchSources', sourceId);
    try {
      const snap = await getDoc(ref);
      const mutableFields = {
        sourceName: (src.sourceName || 'Research Source').slice(0, 200),
        sourceUrl: (src.sourceUrl || '').slice(0, 600),
        category: src.category,
        dataClassification: src.dataClassification,
        accessMethod: src.accessMethod,
        publicationDate: (src.publicationDate || '').slice(0, 64),
        accessedAt: (src.accessedAt || new Date().toISOString().slice(0, 10)).slice(0, 64),
        freshnessLabel: (src.freshnessLabel || '').slice(0, 80),
        primaryOrSecondary: src.primaryOrSecondary,
        confidence: src.confidence,
        usageRestrictions: (src.usageRestrictions || '').slice(0, 400),
        finding: (src.finding || 'Research finding').slice(0, 4000),
        implications: (src.implications || '').slice(0, 2000),
        updatedAt: serverTimestamp(),
      };
      if (!snap.exists()) {
        await setDoc(ref, {
          ownerId: uid,
          sourceId,
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

export async function syncMarketingDraftToFirestore(
  user: User,
  draft: MarketingDraft
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const draftId = sanitizeFirestoreId(draft.id, 128);
  const path = `users/${uid}/marketingDrafts/${draftId}`;
  const ref = doc(db, 'users', uid, 'marketingDrafts', draftId);

  try {
    const snap = await getDoc(ref);
    const mutableFields = {
      title: (draft.title || 'Marketing Draft').slice(0, 240),
      status: draft.status,
      targetAudience: (draft.targetAudience || '').slice(0, 160),
      serviceOffer: (draft.serviceOffer || '').slice(0, 200),
      objective: (draft.objective || '').slice(0, 240),
      awarenessStage: (draft.awarenessStage || '').slice(0, 120),
      contentCategory: (draft.contentCategory || '').slice(0, 120),
      topic: (draft.topic || '').slice(0, 400),
      tone: (draft.tone || '').slice(0, 120),
      ctaObjective: (draft.ctaObjective || '').slice(0, 240),
      researchDepth: draft.researchDepth,
      xTargetChars: Math.max(20, Math.min(280, Number(draft.xTargetChars) || 50)),
      blogWordTarget: Math.max(400, Math.min(3000, Number(draft.blogWordTarget) || 1100)),
      centralConceptJson: JSON.stringify(draft.centralConcept).slice(0, 16000),
      linkedinContent: (draft.platforms.linkedin || '').slice(0, 12000),
      xShortContent: (draft.platforms.x.ultraShort || '').slice(0, 1000),
      xExpandedContent: (draft.platforms.x.expanded || '').slice(0, 6000),
      threadsContent: (draft.platforms.threads || '').slice(0, 6000),
      blogJson: JSON.stringify(draft.platforms.blog).slice(0, 36000),
      evidenceClaimsJson: JSON.stringify(draft.evidenceClaims || []).slice(0, 20000),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        draftId,
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

export async function deleteMarketingDraftFromFirestore(
  user: User,
  draftId: string
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeId = sanitizeFirestoreId(draftId, 128);
  const path = `users/${uid}/marketingDrafts/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'marketingDrafts', safeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// --- Workspace B: 74 STUDIO Sales Intelligence Firestore Sync (Native Maps/Lists, Zero JSON.stringify) ---

export async function syncSalesProfileToFirestore(
  user: User,
  kb: SalesKnowledgeBase
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const profileId = sanitizeFirestoreId(kb.id || 'kb-74-studio-sales', 80);
  const path = `users/${uid}/salesProfiles/${profileId}`;
  const ref = doc(db, 'users', uid, 'salesProfiles', profileId);

  try {
    await ensureUserProfileDoc(user);
    const snap = await getDoc(ref);
    const mutableFields = {
      businessName: (kb.businessName || '74 STUDIO').slice(0, 160),
      websiteUrl: (kb.websiteUrl || 'https://74-studio.com').slice(0, 300),
      brandVoice: (kb.brandVoice || '').slice(0, 1500),
      positioning: (kb.positioning || '74 STUDIO Visual Creative Studio').slice(0, 2500),
      pricingPolicy: (kb.pricingPolicy || 'Custom quoted per project').slice(0, 1500),
      contactSummary: (kb.contactSummary || '').slice(0, 1000),
      qualificationCriteria: (kb.qualificationCriteria || '').slice(0, 2000),
      approvedMessagingNotes: (kb.approvedMessagingNotes || '').slice(0, 2000),
      serviceNames: (kb.services || []).slice(0, 20).map((s) => String(s.name).slice(0, 200)),
      knownUrls: (kb.knownUrls || []).slice(0, 25).map((u) => String(u.url).slice(0, 300)),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        workspaceId: 'ws-74-studio-sales',
        profileId,
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

export async function syncSalesLeadToFirestore(
  user: User,
  lead: SalesLeadRecord
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const leadId = sanitizeFirestoreId(lead.id, 128);
  const path = `users/${uid}/salesLeads/${leadId}`;
  const ref = doc(db, 'users', uid, 'salesLeads', leadId);

  try {
    await ensureUserProfileDoc(user);
    const snap = await getDoc(ref);
    const mutableFields: Record<string, unknown> = {
      name: (lead.name || 'Prospect').slice(0, 160),
      handleOrOrg: (lead.handleOrOrg || '').slice(0, 160),
      contactChannel: (lead.contactChannel || '').slice(0, 120),
      segment: lead.segment,
      channelSource: (lead.channelSource || '').slice(0, 120),
      releaseOrProjectContext: (lead.releaseOrProjectContext || '').slice(0, 2000),
      rawInquiryNotes: (lead.rawInquiryNotes || '').slice(0, 5000),
      researchSummary: (lead.researchSummary || '').slice(0, 4000),
      painPoints: (lead.painPoints || []).slice(0, 15).map((p) => String(p).slice(0, 300)),
      buyerIntentLevel: lead.buyerIntentLevel,
      buyerIntentSignals: (lead.buyerIntentSignals || []).slice(0, 15).map((s) => String(s).slice(0, 300)),
      qualificationScore: Math.max(0, Math.min(100, Number(lead.qualificationScore) || 0)),
      qualificationRationale: (lead.qualificationRationale || '').slice(0, 2000),
      opportunityScore: Math.max(0, Math.min(100, Number(lead.opportunityScore) || 0)),
      recommendedServices: (lead.recommendedServices || []).slice(0, 10).map((s) => String(s).slice(0, 160)),
      recommendedNextStep: (lead.recommendedNextStep || '').slice(0, 500),
      stage: lead.stage,
      updatedAt: serverTimestamp(),
    };
    if (lead.lastAiProvider) mutableFields.lastAiProvider = lead.lastAiProvider;
    if (lead.lastAiModel) mutableFields.lastAiModel = lead.lastAiModel.slice(0, 160);

    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        workspaceId: 'ws-74-studio-sales',
        leadId,
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

export async function deleteSalesLeadFromFirestore(
  user: User,
  leadId: string
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const safeId = sanitizeFirestoreId(leadId, 128);
  const path = `users/${uid}/salesLeads/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'salesLeads', safeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function syncSalesOutputToFirestore(
  user: User,
  output: SalesOutputRecord
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const outputId = sanitizeFirestoreId(output.id, 128);
  const path = `users/${uid}/salesOutputs/${outputId}`;
  const ref = doc(db, 'users', uid, 'salesOutputs', outputId);

  try {
    await ensureUserProfileDoc(user);
    const snap = await getDoc(ref);
    const mutableFields: Record<string, unknown> = {
      title: (output.title || 'Sales Output').slice(0, 240),
      contentMarkdown: (output.contentMarkdown || '').slice(0, 36000),
      providerId: output.providerId,
      model: (output.model || 'gemini').slice(0, 160),
      wasFallback: Boolean(output.wasFallback),
      updatedAt: serverTimestamp(),
    };
    if (output.manifest) {
      mutableFields.manifestStatus = output.manifest.status;
      mutableFields.totalExpectedSections = Math.max(0, Math.min(25, output.manifest.totalExpectedSections));
      mutableFields.completedSections = Math.max(0, Math.min(25, output.manifest.completedSections));
      mutableFields.duplicateHeadingsDetected = (output.manifest.duplicateHeadingsDetected || [])
        .slice(0, 20)
        .map((d) => String(d).slice(0, 200));
    }

    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        workspaceId: 'ws-74-studio-sales',
        outputId,
        leadId: sanitizeFirestoreId(output.leadId || 'pipeline-wide', 128),
        leadName: (output.leadName || '74 STUDIO Prospect').slice(0, 160),
        outputType: output.outputType,
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

export async function syncSalesActivityToFirestore(
  user: User,
  activity: SalesActivityRecord
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const activityId = sanitizeFirestoreId(activity.id, 128);
  const path = `users/${uid}/salesActivities/${activityId}`;
  const ref = doc(db, 'users', uid, 'salesActivities', activityId);

  try {
    await ensureUserProfileDoc(user);
    const snap = await getDoc(ref);
    if (snap.exists()) return; // Append-only audit log
    const payload: Record<string, unknown> = {
      ownerId: uid,
      workspaceId: 'ws-74-studio-sales',
      activityId,
      activityType: activity.activityType,
      summary: (activity.summary || 'Sales activity').slice(0, 300),
      timestamp: (activity.timestamp || new Date().toISOString()).slice(0, 64),
      createdAt: serverTimestamp(),
    };
    if (activity.leadId) payload.leadId = sanitizeFirestoreId(activity.leadId, 128);
    if (activity.leadName) payload.leadName = activity.leadName.slice(0, 160);
    if (activity.detail) payload.detail = activity.detail.slice(0, 800);
    if (activity.providerId) payload.providerId = activity.providerId;
    if (activity.model) payload.model = activity.model.slice(0, 160);
    await setDoc(ref, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// Sanitized Per-Workspace AI Config (Strictly zero API secrets, zero raw diagnostic logs)
export async function syncAiWorkspaceConfigToFirestore(
  user: User,
  cfg: WorkspaceAiProfileConfig
): Promise<void> {
  if (!user.emailVerified) return;
  const uid = sanitizeFirestoreId(user.uid, 128);
  const wsId = sanitizeFirestoreId(cfg.workspaceId, 80);
  const path = `users/${uid}/aiWorkspaceConfigs/${wsId}`;
  const ref = doc(db, 'users', uid, 'aiWorkspaceConfigs', wsId);

  try {
    await ensureUserProfileDoc(user);
    const snap = await getDoc(ref);
    const mutableFields = {
      workspaceLabel: (cfg.workspaceLabel || wsId).slice(0, 120),
      providerOrder: (cfg.providerOrder || ['gemini', 'groq', 'openrouter']).slice(0, 4).map((p) => String(p).slice(0, 30)),
      geminiEnabled: Boolean(cfg.enabledProviders?.gemini),
      groqEnabled: Boolean(cfg.enabledProviders?.groq),
      openrouterEnabled: Boolean(cfg.enabledProviders?.openrouter),
      cloudflareEnabled: Boolean(cfg.enabledProviders?.cloudflare),
      geminiModel: String(cfg.selectedModels?.gemini || '').slice(0, 120),
      groqModel: String(cfg.selectedModels?.groq || '').slice(0, 120),
      openrouterModel: String(cfg.selectedModels?.openrouter || '').slice(0, 120),
      cloudflareModel: String(cfg.selectedModels?.cloudflare || '').slice(0, 120),
      maxOutputTokens: Math.max(256, Math.min(16384, Number(cfg.maxOutputTokens) || 2048)),
      requestTimeoutMs: Math.max(3000, Math.min(120000, Number(cfg.requestTimeoutMs) || 35000)),
      streamingEnabled: Boolean(cfg.streamingEnabled),
      dailyRequestBudget: Math.max(1, Math.min(50000, Number(cfg.dailyRequestBudget) || 300)),
      dailyTokenBudget: Math.max(1000, Math.min(50000000, Number(cfg.dailyTokenBudget) || 600000)),
      warningThresholdPct: Math.max(10, Math.min(99, Number(cfg.warningThresholdPct) || 80)),
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        workspaceId: wsId,
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

