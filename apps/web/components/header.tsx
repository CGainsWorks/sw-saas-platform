'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { logout, switchTenant } from '../lib/api';
import { useSession } from '../app/session-provider';

/**
 * Top bar with the tenant switcher.
 *
 * Switching tenants is a round trip, not a client-side filter: the API re-checks
 * membership in the database and issues a *new* token scoped to the new tenant. There is
 * no client-held "current tenant" that could drift from what the server enforces — the
 * only thing that decides which tenant a request touches is the token it carries.
 */
export function Header() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  async function onSwitch(tenantId: string) {
    if (!session || tenantId === session.tenant.id) return;
    setSwitching(true);
    try {
      await switchTenant(tenantId);
      await refresh();
      // Everything on screen belongs to the previous tenant, so send the user somewhere
      // neutral rather than leaving stale rows visible while the new data loads.
      router.push('/projects');
      router.refresh();
    } finally {
      setSwitching(false);
    }
  }

  async function onLogout() {
    await logout();
    await refresh();
    router.push('/');
  }

  return (
    <header className="topbar">
      <div className="inner">
        <div className="brand">
          <Link href="/">sw-saas-platform</Link>
          {session ? <span className="sub">{session.tenant.name}</span> : null}
        </div>

        {session ? (
          <>
            <nav className="links">
              <Link href="/projects">Projects</Link>
              <Link href="/members">Members</Link>
            </nav>

            {session.availableTenants.length > 1 ? (
              <select
                aria-label="Switch tenant"
                value={session.tenant.id}
                disabled={switching}
                onChange={(e) => void onSwitch(e.target.value)}
                style={{ width: 'auto' }}
              >
                {session.availableTenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.role})
                  </option>
                ))}
              </select>
            ) : null}

            <span className="small muted">{session.user.email}</span>
            <button onClick={() => void onLogout()}>Sign out</button>
          </>
        ) : null}
      </div>
    </header>
  );
}
