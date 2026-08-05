'use client';

import type { ReactNode } from 'react';
import { API_URL, loginUrl } from '../lib/api';
import { useSession } from '../app/session-provider';

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="plain" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="skeleton" />
      ))}
    </ul>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}

/**
 * Wraps a page that needs a session.
 *
 * Three states, kept distinct on purpose: still loading, not logged in, and the API is
 * unreachable. Collapsing the last two into "please log in" is a small lie that sends
 * people to re-authenticate when the real problem is that the API is down.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading, error, unauthenticated } = useSession();

  if (loading) return <Skeleton />;

  if (error) {
    return (
      <>
        <h1>Cannot reach the API</h1>
        <ErrorNotice message={error} />
        <p className="muted small">
          Expected it at <code className="mono">{API_URL}</code>. If you are running the demo, check{' '}
          <code className="mono">docker compose ps</code>.
        </p>
      </>
    );
  }

  if (unauthenticated || !session) {
    const returnTo = typeof window === 'undefined' ? '/projects' : window.location.href;
    return (
      <>
        <h1>Sign in</h1>
        <p className="muted">
          Authentication runs a real OAuth2 authorization-code flow with PKCE against the
          development identity provider bundled with this repo.
        </p>
        <p style={{ marginTop: '1.25rem' }}>
          <a className="btn" href={loginUrl(returnTo)}>
            Sign in with OAuth2
          </a>
        </p>
        <div className="notice info" style={{ marginTop: '1.5rem' }}>
          <strong>Demo accounts.</strong> Pick <code className="mono">dave@globex.test</code> to see
          tenant switching — he belongs to both tenants. Pick{' '}
          <code className="mono">erin@newco.test</code> to watch a brand new tenant be provisioned
          on first login. <code className="mono">alice@acme.test</code> and{' '}
          <code className="mono">carol@globex.test</code> own two separate tenants whose data must
          never meet.
        </div>
      </>
    );
  }

  return <>{children}</>;
}
