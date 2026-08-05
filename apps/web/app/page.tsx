'use client';

import Link from 'next/link';
import { RequireSession } from '../components/states';
import { useSession } from './session-provider';

export default function HomePage() {
  return (
    <RequireSession>
      <Landing />
    </RequireSession>
  );
}

function Landing() {
  const { session } = useSession();
  if (!session) return null;

  return (
    <>
      <h1>{session.tenant.name}</h1>
      <p className="muted">
        Signed in as {session.user.name} · role <span className="badge">{session.role}</span> · plan{' '}
        <span className="badge">{session.tenant.plan}</span>
      </p>

      <div className="grid cols-2" style={{ marginTop: '1.5rem' }}>
        <Link className="item" href="/projects">
          <strong>Projects</strong>
          <div className="small muted">Everything this tenant can see.</div>
        </Link>
        <Link className="item" href="/members">
          <strong>Members</strong>
          <div className="small muted">Who can act inside this tenant.</div>
        </Link>
      </div>

      <h2>What this demo is showing</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Every tenant&apos;s rows live in the same tables. Isolation is enforced by PostgreSQL
          row-level security, not by application code remembering to filter — the API connects as a
          role that cannot bypass those policies, and the tenant it acts as is a signed claim in
          your access token rather than anything the browser can set.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Your token names tenant <code className="mono">{session.tenant.id}</code>. Requesting a
          resource id belonging to another tenant returns 404 — not 403, which would confirm the
          resource exists.
        </p>
      </div>

      {session.availableTenants.length > 1 ? (
        <div className="notice info" style={{ marginTop: '1rem' }}>
          You belong to {session.availableTenants.length} tenants. Use the switcher in the header:
          it asks the API for a new token, which re-checks your membership in the database first.
        </div>
      ) : null}
    </>
  );
}
