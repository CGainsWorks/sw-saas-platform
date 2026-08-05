'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@saas/shared-types';
import { ApiRequestError, createProject, listProjects } from '../../lib/api';
import { ErrorNotice, RequireSession, Skeleton } from '../../components/states';
import { useSession } from '../session-provider';

export default function ProjectsPage() {
  return (
    <RequireSession>
      <Projects />
    </RequireSession>
  );
}

function Projects() {
  const { session } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { items } = await listProjects();
      setProjects(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load projects');
    }
  }, []);

  useEffect(() => {
    void load();
    // Re-fetch on tenant change: the previous tenant's projects must not linger on screen.
  }, [load, session?.tenant.id]);

  const canCreate = session?.role === 'owner' || session?.role === 'admin';

  return (
    <>
      <h1>Projects</h1>
      <p className="muted small">
        Scoped to {session?.tenant.name}. Project keys are unique per tenant, not globally — both
        seeded tenants have an <code className="mono">OPS</code> project.
      </p>

      {canCreate ? <NewProjectForm onCreated={load} /> : null}

      {error ? <ErrorNotice message={error} /> : null}

      {projects === null ? (
        <Skeleton />
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : (
        <ul className="plain" style={{ marginTop: '1rem' }}>
          {projects.map((p) => (
            <li key={p.id}>
              <Link className="item" href={`/projects/${p.id}`}>
                <div className="row between">
                  <strong>
                    <span className="mono">{p.key}</span> · {p.name}
                  </strong>
                  {p.archived ? <span className="badge">archived</span> : null}
                </div>
                {p.description ? <div className="small muted">{p.description}</div> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createProject({ key: key.toUpperCase(), name });
      setKey('');
      setName('');
      await onCreated();
    } catch (err) {
      // The API returns 409 for a duplicate key. That is safe to show: keys are unique
      // per tenant, so a collision is always with one of your own projects.
      setError(
        err instanceof ApiRequestError ? err.message : 'could not create the project',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginTop: '1.25rem' }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: '8rem' }}>
          <label htmlFor="key">Key</label>
          <input
            id="key"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="OPS"
            pattern="[A-Z][A-Z0-9]{1,9}"
            title="2-10 characters, upper case, starting with a letter"
            required
          />
        </div>
        <div style={{ flex: 1, minWidth: '12rem' }}>
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Operations"
            required
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'New project'}
        </button>
      </div>
      {error ? (
        <p className="small" style={{ color: 'var(--danger)', marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
