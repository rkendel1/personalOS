/** Today, Tasks, Memory, Projects, Activity and Settings: each a live view of durable state. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useFeltKit, useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ago, clientDay, dayLabel, Evidence, Icon, localToday, StatusBadge, timeLabel, type Action } from "./ui";

type Err = { onError: (e: unknown) => void };

type Task = { id: string; title: string; status: "open" | "done"; priority: "low" | "normal" | "high"; due?: string; remindTime?: string; remindedAt?: number; recurrence: string; notes?: string; projectId?: string; source: { kind: string }; completedAt?: number };

function TaskItem({ task, onError, projects }: { task: Task; projects?: Map<string, string> } & Err) {
  const complete = useMutation(api.tasks.complete);
  const reopen = useMutation(api.tasks.reopen);
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const [open, setOpen] = useState(false);
  const today = localToday();
  const overdue = task.status === "open" && task.due && task.due < today;
  return (
    <li className={`task ${task.status}`}>
      <button className={`check ${task.status === "done" ? "on" : ""}`} aria-label={task.status === "done" ? "Reopen" : "Complete"} onClick={() => void (task.status === "done" ? reopen({ id: task.id }) : complete({ id: task.id })).catch(onError)}>
        {task.status === "done" && <Icon name="check" size={14} />}
      </button>
      <div className="task-body" onClick={() => setOpen((v) => !v)}>
        <div className="task-title">
          {task.priority === "high" && <span className="prio" title="High priority">!</span>}
          {task.title}
        </div>
        <div className="task-meta">
          {task.due && <span className={overdue ? "overdue" : ""}>{dayLabel(task.due, today)}{task.remindTime ? ` · ${timeLabel(task.remindTime)}` : ""}</span>}
          {task.remindTime && <span title={task.remindedAt ? "Reminder sent" : "Reminder set"}>{task.remindedAt ? "🔔 sent" : "🔔"}</span>}
          {task.recurrence !== "none" && <span>↻ {task.recurrence}</span>}
          {task.projectId && projects?.get(task.projectId) && <span>{projects.get(task.projectId)}</span>}
          {task.source.kind === "conversation" && <span className="muted">from chat</span>}
          {task.source.kind === "model" && <span className="muted">model suggestion</span>}
        </div>
        {open && (
          <div className="task-edit" onClick={(e) => e.stopPropagation()}>
            <label className="field inline">
              <span>Due</span>
              <input type="date" value={task.due ?? ""} onChange={(e) => void update({ id: task.id, ...(e.target.value ? { due: e.target.value } : { clearDue: true }), tzOffset: clientDay().tzOffset }).catch(onError)} />
            </label>
            <label className="field inline">
              <span>Remind at</span>
              <input type="time" value={task.remindTime ?? ""} onChange={(e) => e.target.value && void update({ id: task.id, time: e.target.value, reminder: true, due: task.due ?? today, tzOffset: clientDay().tzOffset }).catch(onError)} />
            </label>
            <label className="field inline">
              <span>Priority</span>
              <select value={task.priority} onChange={(e) => void update({ id: task.id, priority: e.target.value as Task["priority"] }).catch(onError)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
            {projects && projects.size > 0 && (
              <label className="field inline">
                <span>Project</span>
                <select value={task.projectId ?? ""} onChange={(e) => void update({ id: task.id, projectId: e.target.value }).catch(onError)}>
                  <option value="">None</option>
                  {[...projects].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
            )}
            <button className="ghost danger-text" onClick={() => confirm(`Delete "${task.title}"? This cannot be undone.`) && void remove({ id: task.id }).catch(onError)}>
              <Icon name="trash" size={16} /> Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function Today({ onError, onAsk }: Err & { onAsk: (text: string) => void }) {
  const today = localToday();
  const b = useQuery(api.briefing.today, { today });
  const inbox = useQuery(api.inbox.list, { unread: true }) ?? [];
  const markRead = useMutation(api.inbox.markRead);
  if (!b) return <div className="screen"><p className="muted">Loading your day…</p></div>;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const nothing = !b.focus.length && !b.overdue.length && !b.dueToday.length && !b.upcoming.length && !b.dates.length;
  return (
    <div className="screen">
      <header className="screen-head">
        <div className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
        <h1>{hello}{b.name ? `, ${b.name}` : ""}.</h1>
        {b.completedYesterday > 0 && <p className="muted">You finished {b.completedYesterday} thing{b.completedYesterday > 1 ? "s" : ""} since yesterday.</p>}
      </header>

      {inbox.length > 0 && (
        <section>
          <h2>Reminders</h2>
          <ul className="plain">
            {inbox.map((n) => (
              <li key={n.id} className="reminder">
                <span>🔔 {n.title}</span>
                <button className="ghost tiny" onClick={() => void markRead({ id: n.id }).catch(onError)}>Dismiss</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {nothing ? (
        <section className="calm">
          <p>Nothing due, nothing overdue. Enjoy it, or tell me what's next.</p>
          <button className="secondary" onClick={() => onAsk("Help me plan my week")}>Plan my week</button>
        </section>
      ) : (
        <>
          {b.focus.length > 0 && (
            <section>
              <h2>Focus</h2>
              <ul className="plain">{b.focus.map((t) => <TaskItem key={t.id} task={t as Task} onError={onError} />)}</ul>
            </section>
          )}
          {b.overdue.filter((t) => !b.focus.some((f) => f.id === t.id)).length > 0 && (
            <section>
              <h2>Also overdue</h2>
              <ul className="plain">{b.overdue.filter((t) => !b.focus.some((f) => f.id === t.id)).map((t) => <TaskItem key={t.id} task={t as Task} onError={onError} />)}</ul>
            </section>
          )}
          {b.dueToday.filter((t) => !b.focus.some((f) => f.id === t.id)).length > 0 && (
            <section>
              <h2>Also today</h2>
              <ul className="plain">{b.dueToday.filter((t) => !b.focus.some((f) => f.id === t.id)).map((t) => <TaskItem key={t.id} task={t as Task} onError={onError} />)}</ul>
            </section>
          )}
          {b.upcoming.length > 0 && (
            <section>
              <h2>Coming up</h2>
              <ul className="plain">{b.upcoming.slice(0, 6).map((t) => <TaskItem key={t.id} task={t as Task} onError={onError} />)}</ul>
            </section>
          )}
          {b.dates.length > 0 && (
            <section>
              <h2>Dates</h2>
              <ul className="plain">{b.dates.map((d) => <li key={d.memory.id} className="date-row"><span>{d.memory.content}</span><span className="muted">{dayLabel(d.on, today)}</span></li>)}</ul>
            </section>
          )}
          {b.projects.filter((p) => p.open).length > 0 && (
            <section>
              <h2>Projects</h2>
              <ul className="plain">{b.projects.filter((p) => p.open).map((p) => <li key={p.project.id} className="date-row"><span>{p.project.name}</span><span className="muted">{p.open} open{p.next ? ` · next: ${p.next.title}` : ""}</span></li>)}</ul>
            </section>
          )}
        </>
      )}

      {(b.attention.pendingApprovals > 0 || b.attention.inferredMemories > 0 || b.attention.failedActions > 0) && (
        <section className="attention">
          <h2>Needs you</h2>
          <ul className="plain">
            {b.attention.pendingApprovals > 0 && <li>{b.attention.pendingApprovals} action{b.attention.pendingApprovals > 1 ? "s" : ""} waiting for approval (Activity)</li>}
            {b.attention.inferredMemories > 0 && <li>{b.attention.inferredMemories} unconfirmed note{b.attention.inferredMemories > 1 ? "s" : ""} (Memory)</li>}
            {b.attention.failedActions > 0 && <li>{b.attention.failedActions} failed action{b.attention.failedActions > 1 ? "s" : ""} (Activity)</li>}
          </ul>
        </section>
      )}
      <button className="link" onClick={() => onAsk("What am I forgetting?")}>What am I forgetting?</button>
    </div>
  );
}

export function Tasks({ onError }: Err) {
  const [view, setView] = useState<"open" | "done">("open");
  const list = (useQuery(api.tasks.list, { status: view }) ?? []) as Task[];
  const projects = useQuery(api.projects.list) ?? [];
  const create = useMutation(api.tasks.create);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const today = localToday();
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void create({ title: title.trim(), ...(due ? { due } : {}), tzOffset: clientDay().tzOffset })
      .then(() => (setTitle(""), setDue("")))
      .catch(onError);
  };
  const sorted = view === "open" ? [...list].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority === "high" ? -1 : 0) - (b.priority === "high" ? -1 : 0)) : list;
  const groups = view === "open" ? group(sorted, today) : [["Done", sorted] as const];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <div className="screen">
      <header className="screen-head row between">
        <h1>Tasks</h1>
        <div className="seg">
          <button className={view === "open" ? "on" : ""} onClick={() => setView("open")}>Open</button>
          <button className={view === "done" ? "on" : ""} onClick={() => setView("done")}>Done</button>
        </div>
      </header>
      <form className="add-row" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" maxLength={200} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <button type="submit" disabled={!title.trim()} aria-label="Add"><Icon name="plus" /></button>
      </form>
      {list.length === 0 && <p className="muted pad">{view === "open" ? "Nothing open. Add one above, or just tell me in chat." : "Nothing finished yet."}</p>}
      {groups.map(([label, items]) =>
        items.length ? (
          <section key={label}>
            <h2>{label}</h2>
            <ul className="plain">{items.map((t) => <TaskItem key={t.id} task={t} onError={onError} projects={names} />)}</ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

function group(tasks: Task[], today: string): Array<readonly [string, Task[]]> {
  const week = (() => {
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    return localToday(new Date(y, m - 1, d + 7));
  })();
  return [
    ["Overdue", tasks.filter((t) => t.due && t.due < today)],
    ["Today", tasks.filter((t) => t.due === today)],
    ["Next 7 days", tasks.filter((t) => t.due && t.due > today && t.due <= week)],
    ["Later", tasks.filter((t) => t.due && t.due > week)],
    ["Someday", tasks.filter((t) => !t.due)],
  ] as const;
}

type Memory = { id: string; kind: string; subject: string; content: string; status: "confirmed" | "inferred"; date?: string; source: { kind: string; conversationId?: string; quote?: string }; createdAt: number; updatedAt: number; confirmedAt?: number };
const KINDS = ["preference", "person", "project", "decision", "date", "instruction", "fact"] as const;

export function MemoryScreen({ onError, onOpenConversation }: Err & { onOpenConversation: (id: string) => void }) {
  const list = (useQuery(api.memory.list) ?? []) as Memory[];
  const confirm = useMutation(api.memory.confirm);
  const update = useMutation(api.memory.update);
  const remove = useMutation(api.memory.remove);
  const add = useMutation(api.memory.add);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [draft, setDraft] = useState({ kind: "fact" as (typeof KINDS)[number], content: "" });
  const [filter, setFilter] = useState("");
  const shown = list.filter((m) => !filter || `${m.content} ${m.subject} ${m.kind}`.toLowerCase().includes(filter.toLowerCase()));
  const inferred = shown.filter((m) => m.status === "inferred");
  const confirmed = shown.filter((m) => m.status === "confirmed");
  const row = (m: Memory) => (
    <li key={m.id} className={`memory ${m.status}`}>
      {editing?.id === m.id ? (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void update({ id: m.id, content: editing.content }).then(() => setEditing(null)).catch(onError))}>
          <textarea value={editing.content} onChange={(e) => setEditing({ id: m.id, content: e.target.value })} rows={2} aria-label="Memory" autoFocus />
          <div className="row end">
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </form>
      ) : (
        <>
          <div className="memory-content">{m.content}</div>
          <div className="memory-meta">
            <span className={`kind ${m.kind}`}>{m.kind}</span>
            {m.date && <span>{dayLabel(m.date)}</span>}
            <span title={new Date(m.createdAt).toLocaleString()}>
              {m.status === "inferred" ? "inferred" : "you said"} {ago(m.confirmedAt ?? m.createdAt)}
            </span>
            {m.source.conversationId ? (
              <button className="link small" onClick={() => onOpenConversation(m.source.conversationId!)}>{m.source.kind === "model" ? "model · source" : "source"}</button>
            ) : (
              <span>{m.source.kind === "manual" ? "added by hand" : m.source.kind}</span>
            )}
          </div>
          <div className="row end tools">
            {m.status === "inferred" && <button className="secondary tiny" onClick={() => void confirm({ id: m.id }).catch(onError)}>Confirm</button>}
            <button className="ghost tiny" onClick={() => setEditing({ id: m.id, content: m.content })}>Edit</button>
            <button className="ghost tiny danger-text" onClick={() => window.confirm("Forget this permanently?") && void remove({ id: m.id }).catch(onError)}>Forget</button>
          </div>
        </>
      )}
    </li>
  );
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Memory</h1>
        <p className="muted">What I know about you. "You said" is your word; "inferred" is my reading, and I don't treat it as fact until you confirm it.</p>
      </header>
      <form className="add-row" onSubmit={(e) => (e.preventDefault(), draft.content.trim() && void add({ kind: draft.kind, subject: "", content: draft.content.trim() }).then(() => setDraft({ ...draft, content: "" })).catch(onError))}>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as (typeof KINDS)[number] })} aria-label="Kind">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Something worth remembering" aria-label="New memory" maxLength={2000} />
        <button type="submit" disabled={!draft.content.trim()} aria-label="Add"><Icon name="plus" /></button>
      </form>
      {list.length > 6 && <input className="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search memory" aria-label="Search memory" />}
      {list.length === 0 && <p className="muted pad">Nothing yet. Tell me things in chat, like "remember that my sister's name is Maya".</p>}
      {inferred.length > 0 && (
        <section>
          <h2>Unconfirmed</h2>
          <ul className="plain">{inferred.map(row)}</ul>
        </section>
      )}
      {confirmed.length > 0 && (
        <section>
          <h2>Confirmed</h2>
          <ul className="plain">{confirmed.map(row)}</ul>
        </section>
      )}
    </div>
  );
}

export function Projects({ onError, onAsk }: Err & { onAsk: (text: string) => void }) {
  const list = useQuery(api.projects.list) ?? [];
  const create = useMutation(api.projects.create);
  const update = useMutation(api.projects.update);
  const [name, setName] = useState("");
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Projects</h1>
        <p className="muted">Group tasks under a project (from a task's details on the Tasks tab), then ask me "status of …".</p>
      </header>
      <form className="add-row" onSubmit={(e) => (e.preventDefault(), name.trim() && void create({ name: name.trim() }).then(() => setName("")).catch(onError))}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project" aria-label="New project" maxLength={120} />
        <button type="submit" disabled={!name.trim()} aria-label="Add"><Icon name="plus" /></button>
      </form>
      {list.length === 0 && <p className="muted pad">No projects yet.</p>}
      <ul className="plain">
        {list.map((p) => (
          <li key={p.id} className="project">
            <div>
              <div className="task-title">{p.name}</div>
              <div className="task-meta"><span>{p.open} open</span><span>{p.done} done</span></div>
            </div>
            <div className="row">
              <select value={p.status} onChange={(e) => void update({ id: p.id, status: e.target.value as "active" | "paused" | "done" }).catch(onError)} aria-label="Status">
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="done">Done</option>
              </select>
              <button className="ghost tiny" onClick={() => onAsk(`Status of ${p.name}`)}>Ask</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Files({ onError }: Err) {
  const client = useFeltKit();
  const docs = useQuery(api.documents.list) ?? [];
  const projects = useQuery(api.projects.list) ?? [];
  const prepare = useMutation(api.documents.prepareUpload);
  const attach = useMutation(api.documents.attach);
  const update = useMutation(api.documents.update);
  const link = useMutation(api.documents.link);
  const remove = useMutation(api.documents.remove);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState("");
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const target = await prepare({ name: file.name, ...(file.type ? { contentType: file.type } : {}) });
      const stored = await client.uploadFile(target, file, { name: file.name, ...(file.type ? { contentType: file.type } : {}) });
      await attach({ fileId: stored.id, ...(projectId ? { projectId } : {}) });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const download = (id: string) =>
    void link({ id })
      .then((l) => {
        const a = document.createElement("a");
        a.href = client.fileUrl(l);
        a.click();
      })
      .catch(onError);
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Files</h1>
        <p className="muted">Documents you keep here, up to 10 MB each. They stay in this app's own database, and only you can open them.</p>
      </header>
      <div className="add-row">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Attach to project">
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className={`btn ${busy ? "disabled" : ""}`}>
          {busy ? "Uploading…" : "Add file"}
          <input type="file" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} aria-label="Add file" />
        </label>
      </div>
      {docs.length === 0 && <p className="muted pad">No files yet.</p>}
      <ul className="plain">
        {docs.map((d) => (
          <li key={d.id} className="project">
            <div>
              <div className="task-title">{d.name}</div>
              <div className="task-meta">
                <span>{size(d.size)}</span>
                <span>{ago(d.createdAt)}</span>
                {d.projectId && <span>{projectName.get(d.projectId) ?? "project"}</span>}
              </div>
            </div>
            <div className="row">
              <select value={d.projectId ?? ""} onChange={(e) => void update({ id: d.id, projectId: e.target.value || null }).catch(onError)} aria-label="Project">
                <option value="">No project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="ghost tiny" onClick={() => download(d.id)}>Download</button>
              <button className="ghost tiny" onClick={() => confirm(`Delete ${d.name}?`) && void remove({ id: d.id }).catch(onError)} aria-label={`Delete ${d.name}`}><Icon name="trash" size={16} /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIA: Record<string, string> = { chat: "from chat", ui: "by you", model: "model, approved", job: "scheduled" };

export function Activity({ onError, onOpenConversation }: Err & { onOpenConversation: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "proposed" | "failed">("all");
  const list = (useQuery(api.actions.list, filter === "all" ? { limit: 300 } : { status: filter }) ?? []) as Action[];
  const approve = useMutation(api.actions.approve);
  const reject = useMutation(api.actions.reject);
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Activity</h1>
        <p className="muted">Every change I made or proposed, with the record that proves it. Proposals do nothing until you approve them.</p>
        <div className="seg">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
          <button className={filter === "proposed" ? "on" : ""} onClick={() => setFilter("proposed")}>Needs approval</button>
          <button className={filter === "failed" ? "on" : ""} onClick={() => setFilter("failed")}>Failed</button>
        </div>
      </header>
      {list.length === 0 && <p className="muted pad">{filter === "all" ? "Nothing yet." : "Nothing here."}</p>}
      <ul className="plain">
        {list.map((a) => (
          <li key={a.id} className={`activity ${a.status}`}>
            <div className="row between">
              <span className="action-summary">{a.summary}</span>
              <StatusBadge status={a.status} />
            </div>
            <div className="task-meta">
              <span>{ago(a.decidedAt ?? a.createdAt)}</span>
              <span>{VIA[a.via] ?? a.via}</span>
              <code className="kindcode">{a.kind}</code>
              {a.approval === "required" && <span>approval required</span>}
              {a.conversationId && <button className="link small" onClick={() => onOpenConversation(a.conversationId!)}>conversation</button>}
            </div>
            {a.evidence && <Evidence evidence={a.evidence} />}
            {a.error && <div className="error-text small">{a.error.code}: {a.error.message}</div>}
            {a.status === "proposed" && (
              <div className="row end">
                <button className="secondary" onClick={() => void reject({ id: a.id }).catch(onError)}>Reject</button>
                <button className="danger" onClick={() => void approve({ id: a.id }).catch(onError)}>Approve</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Settings({ onError, dashboard, principal, onSignOut, children }: Err & { dashboard?: string | null; principal: string; onSignOut?: () => void; children?: ReactNode }) {
  const s = useQuery(api.settings.get);
  const set = useMutation(api.settings.set);
  const configure = useMutation(api.checkins.configure);
  const review = useMutation(api.weekly.configure);
  const [name, setName] = useState<string | null>(null);
  if (!s) return <div className="screen"><p className="muted">Loading…</p></div>;
  return (
    <div className="screen">
      <header className="screen-head"><h1>Settings</h1></header>
      <section>
        <h2>You</h2>
        <form className="add-row" onSubmit={(e) => (e.preventDefault(), void set({ name: (name ?? s.name ?? "").trim() || null }).then(() => setName(null)).catch(onError))}>
          <input value={name ?? s.name ?? ""} onChange={(e) => setName(e.target.value)} placeholder="What should I call you?" aria-label="Your name" maxLength={80} />
          <button type="submit" className="secondary" disabled={name === null}>Save</button>
        </form>
        <p className="muted small">Signed in as {principal}.{onSignOut && <> <button className="link small" onClick={onSignOut}>Sign out</button></>}</p>
      </section>
      <section>
        <h2>Daily check-in</h2>
        <label className="toggle">
          <input type="checkbox" checked={!!s.checkinTime} onChange={(e) => void configure({ time: e.target.checked ? "08:00" : null, tzOffset: clientDay().tzOffset }).catch(onError)} />
          <span>
            <strong>Brief me every morning</strong>
            <br />
            <span className="muted small">I post your briefing in a "Daily check-in" conversation and send a notification. It runs as a scheduled job, even when the app is closed.</span>
          </span>
        </label>
        {s.checkinTime && (
          <div className="row" style={{ marginTop: 10 }}>
            <input type="time" value={s.checkinTime} onChange={(e) => e.target.value && void configure({ time: e.target.value, tzOffset: clientDay().tzOffset }).catch(onError)} aria-label="Check-in time" />
            {s.checkinAt && <span className="muted small">Next: {new Date(s.checkinAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>}
          </div>
        )}
      </section>
      {location.protocol.startsWith("http") && (
        <section>
          <h2>Browser extension</h2>
          <p className="muted small">The PersonalOS Chrome extension puts this assistant beside any page, signed in as you, with the same chats, tasks, memory and files. When it asks for your address, enter:</p>
          <div className="row">
            <code className="kindcode">{location.origin}</code>
            <button className="ghost tiny" onClick={() => void navigator.clipboard?.writeText(location.origin)}>Copy</button>
          </div>
          {/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && <p className="muted small">This is a development address. Deploy the app (see the README) to use the extension anywhere.</p>}
        </section>
      )}
      <ConnectedSurfaces onError={onError} />
      <section>
        <h2>Weekly review</h2>
        <label className="toggle">
          <input type="checkbox" checked={s.reviewDay !== null} onChange={(e) => void review({ day: e.target.checked ? 0 : null, time: s.reviewTime ?? "18:00", tzOffset: clientDay().tzOffset }).catch(onError)} />
          <span>
            <strong>Review my week</strong>
            <br />
            <span className="muted small">Once a week I post what you finished, what is overdue, and what the next seven days hold in a "Weekly review" conversation, and send a notification.</span>
          </span>
        </label>
        {s.reviewDay !== null && (
          <div className="row" style={{ marginTop: 10 }}>
            <select value={s.reviewDay} onChange={(e) => void review({ day: Number(e.target.value), time: s.reviewTime ?? "18:00", tzOffset: clientDay().tzOffset }).catch(onError)} aria-label="Review day">
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
            <input type="time" value={s.reviewTime ?? "18:00"} onChange={(e) => e.target.value && void review({ day: s.reviewDay, time: e.target.value, tzOffset: clientDay().tzOffset }).catch(onError)} aria-label="Review time" />
            {s.reviewAt && <span className="muted small">Next: {new Date(s.reviewAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>}
          </div>
        )}
      </section>
      <section>
        <h2>Model</h2>
        <ModelStatus />
        <label className="toggle">
          <input type="checkbox" checked={s.modelAssist} disabled={!s.canUseModel} onChange={(e) => void set({ modelAssist: e.target.checked }).catch(onError)} />
          <span>
            <strong>Converse with the model</strong>
            <br />
            <span className="muted small">
              The model writes the replies and can use your tasks, memory and briefing as tools. Anything that would change something is only proposed: it waits for your approval, here in the chat. Off: the built-in assistant (tasks, reminders, memory, briefing) without a model.
            </span>
          </span>
        </label>
        <p className="muted small">
          Which model is used is the environment's setting, not the app's: {dashboard ? <a href={dashboard} target="_blank" rel="noreferrer">Studio → Models</a> : "Studio → Models"}, or a Resolver reference (<code>ref://prod/personalos/model</code> in production), changeable without a restart. Changing it never touches your conversations, memory or tasks.
        </p>
      </section>
      <section>
        <h2>What I can't do yet</h2>
        <ul className="muted small">
          <li>Email, calendar or messaging: no integration is configured, so I won't pretend to send or schedule anything.</li>
        </ul>
      </section>
      {children && <section>{children}</section>}
    </div>
  );
}

/**
 * Connected surfaces (PersonalOS Anywhere): link your account on another app (Multiplayer) so
 * mentioning @personalos there works in this account, as you. A one-time code proves this side;
 * sending it to @personalos in a direct message there proves the other. The link lives in Resolver.
 */
function ConnectedSurfaces({ onError }: Err) {
  const links = useQuery(api.links.list) ?? [];
  const recent = useQuery(api.interactions.list, { limit: 5 }) ?? [];
  const start = useMutation(api.links.start);
  const revoke = useMutation(api.links.revoke);
  const confirm = useMutation(api.links.confirm);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const active = links.filter((l) => l.status === "active" || l.status === "confirming" || l.status === "revoking");
  const presented = links.filter((l) => l.status === "presented");
  return (
    <section data-testid="connected-surfaces">
      <h2>Connected surfaces</h2>
      <p className="muted small">Mention @personalos in Multiplayer and I'll work here, in your account. In shared conversations I keep your private details out of my replies; anything destructive still waits for your approval here.</p>
      {active.map((l) => (
        <div key={l.id} className="row">
          <span><strong>Multiplayer</strong> <span className="muted small">as {l.sourceDisplayName ?? l.sourcePrincipalId}{l.status === "confirming" ? " · connecting…" : l.status === "revoking" ? " · disconnecting…" : l.lastUsedAt ? ` · last used ${new Date(l.lastUsedAt).toLocaleString()}` : ""}</span></span>
          {l.status === "active" && <button className="ghost tiny" onClick={() => void revoke({ id: l.id }).catch(onError)}>Disconnect</button>}
        </div>
      ))}
      {presented.map((l) => (
        <div key={l.id} className="row" data-testid="link-presented">
          <span className="small">Your code was sent from the Multiplayer account <strong>{l.sourceDisplayName ?? l.sourcePrincipalId}</strong> <span className="muted">({l.sourcePrincipalId})</span>. Is that you?{l.error ? <span className="muted"> {l.error}</span> : null}</span>
          <span>
            <button className="tiny" onClick={() => void confirm({ id: l.id }).then(() => setCode(null)).catch(onError)}>This is me</button>{" "}
            <button className="ghost tiny" onClick={() => void revoke({ id: l.id }).then(() => setCode(null)).catch(onError)}>Not me</button>
          </span>
        </div>
      ))}
      {code ? (
        <p className="small" data-testid="link-code">Send <code className="kindcode">link {code.code}</code> to @personalos in a <strong>direct message</strong> in Multiplayer (never in a shared channel). It works once, until {new Date(code.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.</p>
      ) : (
        <button className="secondary" onClick={() => void start({ adapter: "multiplayer" }).then((c) => setCode(c)).catch(onError)}>{active.length ? "Connect another Multiplayer account" : "Connect Multiplayer"}</button>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="small">Recent requests from connected surfaces</h3>
          <ul className="small">
            {recent.map((i) => <li key={i.id}><span className="muted">{i.where}:</span> “{i.text.slice(0, 80)}” — {i.state.replace(/_/g, " ")}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function ModelStatus() {
  const client = useFeltKit();
  const [status, setStatus] = useState<{ ready: boolean; provider: string | null; model: string | null; source: string; reference: { ref: string; revision: number | null } | null; problems: Array<{ message: string }> } | null>(null);
  useEffect(() => {
    let live = true;
    client.action(api.turn.modelStatus, {}).then((s) => live && setStatus(s as never), () => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [client]);
  if (!status) return <p className="muted small">Checking the model…</p>;
  return (
    <p className="small" data-testid="model-status">
      {status.ready ? (
        <>
          <strong>{status.provider}/{status.model}</strong> <span className="muted">via {status.source}{status.reference ? ` (${status.reference.ref} r${status.reference.revision})` : ""}</span>
        </>
      ) : (
        <span className="muted">No model is ready: {(status.problems[0]?.message ?? "not configured").replace(/\.$/, "")}. The built-in assistant is answering.</span>
      )}
    </p>
  );
}
