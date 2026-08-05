'use client';

import { useEffect, useState } from 'react';
import { listMembers, type MemberView } from '../../lib/api';
import { ErrorNotice, RequireSession, Skeleton } from '../../components/states';
import { useSession } from '../session-provider';

export default function MembersPage() {
  return (
    <RequireSession>
      <Members />
    </RequireSession>
  );
}

function Members() {
  const { session } = useSession();
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMembers()
      .then(({ items }) => setMembers(items))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'failed to load members'),
      );
  }, [session?.tenant.id]);

  return (
    <>
      <h1>Members</h1>
      <p className="muted small">
        Only members of {session?.tenant.name}. The <code className="mono">memberships</code> table
        is row-level-secured precisely so one tenant cannot enumerate another&apos;s people — that
        would be a cross-customer user-enumeration oracle.
      </p>

      {error ? <ErrorNotice message={error} /> : null}

      {members === null ? (
        <Skeleton rows={2} />
      ) : (
        <ul className="plain">
          {members.map((m) => (
            <li key={m.membershipId} className="item">
              <div className="row between">
                <span>
                  <strong>{m.name}</strong>{' '}
                  <span className="small muted">&lt;{m.email}&gt;</span>
                </span>
                <span className="badge">{m.role}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
