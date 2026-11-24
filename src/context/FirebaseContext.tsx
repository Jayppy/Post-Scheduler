import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  auth,
  CloudConnectionDoc,
  ensureUserProfileDoc,
  signInWithGoogleOperator,
  signOutOperator,
  subscribeWorkspaceCloudData,
  syncPublishHistoryToFirestore,
  syncScheduledJobsToFirestore,
  syncWorkspaceConnectionsToFirestore,
} from '../services/firebaseClient';
import type {
  IntegrationsStatusResponse,
  PublishHistoryEntry,
  ScheduledJobSummary,
} from '../services/integrationsClient';

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  isSigningIn: boolean;
  authError: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  cloudConnections: CloudConnectionDoc[];
  cloudJobs: ScheduledJobSummary[];
  cloudHistory: PublishHistoryEntry[];
  syncFromServerSnapshot: (
    workspaceId: string,
    status: IntegrationsStatusResponse,
    jobs: ScheduledJobSummary[],
    history: PublishHistoryEntry[]
  ) => Promise<void>;
  subscribeWorkspace: (workspaceId: string) => () => void;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export const FirebaseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [cloudConnections, setCloudConnections] = useState<CloudConnectionDoc[]>([]);
  const [cloudJobs, setCloudJobs] = useState<ScheduledJobSummary[]>([]);
  const [cloudHistory, setCloudHistory] = useState<PublishHistoryEntry[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser && nextUser.emailVerified) {
        try {
          await ensureUserProfileDoc(nextUser);
        } catch (err) {
          setAuthError(err instanceof Error ? err.message : 'Failed to initialize profile.');
        }
      } else {
        setCloudConnections([]);
        setCloudJobs([]);
        setCloudHistory([]);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const signIn = useCallback(async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const signedUser = await signInWithGoogleOperator();
      await ensureUserProfileDoc(signedUser);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutOperator();
  }, []);

  const subscribeWorkspace = useCallback(
    (workspaceId: string) => {
      if (!authReady || !user || !user.emailVerified) {
        return () => {};
      }
      return subscribeWorkspaceCloudData(user, workspaceId, {
        onConnections: setCloudConnections,
        onJobs: setCloudJobs,
        onHistory: setCloudHistory,
      });
    },
    [authReady, user]
  );

  const syncFromServerSnapshot = useCallback(
    async (
      workspaceId: string,
      status: IntegrationsStatusResponse,
      jobs: ScheduledJobSummary[],
      history: PublishHistoryEntry[]
    ) => {
      if (!user || !user.emailVerified) return;
      await syncWorkspaceConnectionsToFirestore(user, workspaceId, status);
      await syncScheduledJobsToFirestore(user, jobs);
      await syncPublishHistoryToFirestore(user, history);
    },
    [user]
  );

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        isSigningIn,
        authError,
        signIn,
        signOut,
        cloudConnections,
        cloudJobs,
        cloudHistory,
        syncFromServerSnapshot,
        subscribeWorkspace,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) throw new Error('useFirebase must be used inside FirebaseProvider');
  return ctx;
}
