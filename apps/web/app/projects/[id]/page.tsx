'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Project, Task } from '@saas/shared-types';
import { ApiRequestError, createTask, getProject, listTasks } from '../../../lib/api';
import { ErrorNotice, RequireSession, Skeleton } from '../../../components/states';

export default function ProjectPage() {
  return (
    <RequireSession>
      <ProjectDetail />
    </RequireSession>
  );
}

function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, t] = await Promise.all([getProject(id), listTasks({ projectId: id })]);
      setProject(p);
      setTasks(t.items);
    } catch (err) {
      // A project belonging to another tenant is a 404 here, indistinguishable from one
      // that never existed. That is the intended behaviour, not a gap.
      if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : 'failed to load the project');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <>
        <h1>Not found</h1>
        <p className="muted">
          No project with that id exists in this tenant. If it belongs to another tenant, this is
          exactly what you should see — the API answers 404 rather than 403, because 403 would
          confirm the resource exists somewhere.
        </p>
        <p>
          <Link className="btn" href="/projects">
            Back to projects
          </Link>
        </p>
      </>
    );
  }

  if (error) return <ErrorNotice message={error} />;
  if (!project) return <Skeleton />;

  return (
    <>
      <h1>
        <span className="mono">{project.key}</span> · {project.name}
      </h1>
      {project.description ? <p className="muted">{project.description}</p> : null}

      <NewTaskForm projectId={project.id} onCreated={load} />

      <h2>Tasks</h2>
      {tasks === null ? (
        <Skeleton rows={2} />
      ) : tasks.length === 0 ? (
        <p className="muted">No tasks in this project yet.</p>
      ) : (
        <ul className="plain">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link className="item" href={`/tasks/${t.id}`}>
                <div className="row between">
                  <strong>{t.title}</strong>
                  <span className="row">
                    <span className={`badge ${t.priority}`}>{t.priority}</span>
                    <span className={`badge ${t.status}`}>{t.status.replace('_', ' ')}</span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewTaskForm({ projectId, onCreated }: { projectId: string; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createTask({ projectId, title, status: 'todo', priority: 'medium' });
      setTitle('');
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginTop: '1.25rem' }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: '14rem' }}>
          <label htmlFor="title">New task</label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Something that needs doing"
            required
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add task'}
        </button>
      </div>
    </form>
  );
}
