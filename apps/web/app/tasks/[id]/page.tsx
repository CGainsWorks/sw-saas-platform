'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Comment, Task, TaskStatus } from '@saas/shared-types';
import { ApiRequestError, addComment, getTask, listComments, updateTask } from '../../../lib/api';
import { ErrorNotice, RequireSession, Skeleton } from '../../../components/states';

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

export default function TaskPage() {
  return (
    <RequireSession>
      <TaskDetail />
    </RequireSession>
  );
}

function TaskDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, c] = await Promise.all([getTask(id), listComments(id)]);
      setTask(t);
      setComments(c.items);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : 'failed to load the task');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(status: TaskStatus) {
    if (!task) return;
    const previous = task;
    setTask({ ...task, status }); // optimistic
    try {
      const updated = await updateTask(task.id, { status });
      setTask(updated);
    } catch {
      setTask(previous);
      setError('could not update the task');
    }
  }

  if (notFound) {
    return (
      <>
        <h1>Not found</h1>
        <p className="muted">
          No task with that id exists in this tenant. Try pasting a task id from the other
          tenant&apos;s data — you will land here rather than seeing it.
        </p>
        <p>
          <Link className="btn" href="/projects">
            Back to projects
          </Link>
        </p>
      </>
    );
  }

  if (error && !task) return <ErrorNotice message={error} />;
  if (!task) return <Skeleton />;

  return (
    <>
      <h1>{task.title}</h1>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <span className={`badge ${task.priority}`}>{task.priority}</span>
        <Link className="small muted" href={`/projects/${task.projectId}`}>
          back to project
        </Link>
      </div>

      {task.description ? <p>{task.description}</p> : null}

      <div className="card" style={{ marginTop: '1rem' }}>
        <label htmlFor="status">Status</label>
        <div className="row">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => void setStatus(s)}
              className={task.status === s ? 'primary' : ''}
              aria-pressed={task.status === s}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorNotice message={error} /> : null}

      <h2>Comments</h2>
      {comments === null ? (
        <Skeleton rows={2} />
      ) : comments.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul className="plain">
          {comments.map((c) => (
            <li key={c.id} className="item">
              <div>{c.body}</div>
              <div className="small muted">{new Date(c.createdAt).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      )}

      <CommentForm taskId={task.id} onAdded={load} />
    </>
  );
}

function CommentForm({ taskId, onAdded }: { taskId: string; onAdded: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await addComment(taskId, body);
      setBody('');
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginTop: '1rem' }}>
      <label htmlFor="body">Add a comment</label>
      <textarea id="body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row" style={{ marginTop: '0.6rem' }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </form>
  );
}
