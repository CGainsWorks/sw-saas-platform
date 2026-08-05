'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@saas/shared-types';
import { ApiRequestError, getSession } from '../lib/api';

/**
 * Session state, fetched from the API rather than decoded from a token in the browser.
 *
 * The access token lives in an httpOnly cookie, so JavaScript cannot read it — which is
 * the point. That means the client cannot inspect its own claims, and asking the server
 * "who am I, and in which tenant" is the only way to know. It is also the more honest
 * answer: a token is a snapshot from up to 15 minutes ago, and membership may have been
 * revoked since it was issued.
 */
interface SessionState {
  session: SessionInfo | null;
  loading: boolean;
  error: string | null;
  /** True when the API says we are not logged in, as opposed to being unreachable. */
  unauthenticated: boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await getSession();
      setSession(info);
      setUnauthenticated(false);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) {
        setSession(null);
        setUnauthenticated(true);
      } else {
        // A network failure is a different situation from "not logged in", and showing a
        // login prompt for an unreachable API sends people down the wrong path.
        setError(err instanceof Error ? err.message : 'could not reach the API');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ session, loading, error, unauthenticated, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}
