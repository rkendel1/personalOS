/**
 * The conversation. Messages are FeltDB records, so a reply appears through the live query the
 * moment its mutation commits; there is no client-side copy to drift from the truth.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAction, useMutation, useOwnActions, useQuery } from "@feltdb/feltkit/react";
import type { OwnAction } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api";
import { ago, dayLabel, Evidence, Icon, Markdown, StatusBadge, timeLabel, type Action } from "./ui";

type Proposal = { taskId: string; actionId: string; capability: string; effect: string; state: string; input: Record<string, unknown> };

/** What a proposal would do, in words. */
function describe(p: Proposal): { title: string; detail?: string } {
  const i = p.input as Record<string, any>;
  const when = [i.due ? dayLabel(i.due) : "", i.time ? timeLabel(i.time) : ""].filter(Boolean).join(", ");
  switch (p.capability) {
    case "tasks.create":
      return { title: `${i.reminder ? "Create reminder" : "Add task"}: ${i.title ?? "(untitled)"}`, ...(when ? { detail: when } : {}) };
    case "tasks.update":
      return { title: `Change task${i.title ? `: ${i.title}` : ""}`, ...(when ? { detail: when } : {}) };
    case "tasks.complete":
      return { title: "Mark a task done" };
    case "memory.add":
      return { title: `Remember: ${i.content ?? ""}` };
    default:
      return { title: p.capability };
  }
}

const DONE: Record<string, string> = { "tasks.create": "Created", "tasks.update": "Changed", "tasks.complete": "Completed", "memory.add": "Remembered" };
const STATE: Record<string, string> = { proposed: "Approval required", approved: "Approved", executing: "Running…", succeeded: "Done", failed: "Failed", rejected: "Rejected", cancelled: "Cancelled", interrupted: "Outcome unknown" };

function ProposalCard({ proposal, live, onApprove, onReject }: { proposal: Proposal; live?: OwnAction; onApprove: () => Promise<unknown>; onReject: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const state = live?.state ?? proposal.state;
  const { title, detail } = describe(proposal);
  const act = (f: () => Promise<unknown>) => () => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };
  return (
    <div className={`action-card ${state === "proposed" ? "proposed" : state === "succeeded" ? "succeeded" : state === "failed" || state === "interrupted" ? "failed" : "rejected"}`} data-testid="proposal">
      <div className="row between">
        <span className="action-summary">
          {state === "succeeded" ? `${DONE[proposal.capability] ?? "Done"}: ${title.replace(/^[^:]+: /, "")}` : title}
        </span>
        <span className={`badge ${state === "proposed" ? "proposed" : state === "succeeded" ? "succeeded" : state === "failed" || state === "interrupted" ? "failed" : "rejected"}`}>{STATE[state] ?? state}</span>
      </div>
      {detail && <div className="small muted">{detail}</div>}
      <div className="evidence">
        proposed by {live?.proposedBy?.replace(/^model:/, "") ?? "the model"}
        {live?.decidedBy ? ` · ${state === "rejected" ? "rejected" : "approved"} by ${live.decidedBy.replace(/^user:/, "")}` : ""}
        {live?.outcome?.activityId ? ` · receipt ${live.outcome.activityId.slice(0, 12)}` : ""}
      </div>
      {live?.outcome && !live.outcome.ok && <div className="error-text small">{live.outcome.error?.message}</div>}
      {state === "proposed" && (
        <div className="row end">
          <button className="secondary" disabled={busy} onClick={act(onReject)}>Reject</button>
          <button disabled={busy} onClick={act(onApprove)}>Approve</button>
        </div>
      )}
    </div>
  );
}

const newClientId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const EXAMPLES = [
  "Remind me to follow up with John tomorrow at 10am",
  "What should I focus on today?",
  "Remember that Sam is my manager",
  "Help me plan my week",
  "What am I forgetting?",
  "Add renew passport to my list, it's urgent",
];

/** Text another surface (the browser extension) asks Chat to send as a new turn. `nonce` makes the same text sendable twice. */
export type Compose = { text: string; nonce: number };

export function Chat({ conversationId, onConversation, onError, name, compose }: { conversationId: string | null; onConversation: (id: string | null) => void; onError: (e: unknown) => void; name: string | null; compose?: Compose | null }) {
  const conversations = useQuery(api.conversations.list) ?? [];
  const messages = useQuery(api.conversations.messagesOf, conversationId ? { conversationId } : "skip") ?? [];
  const actions = (useQuery(api.actions.list, { limit: 500 }) ?? []) as Action[];
  const turn = useAction(api.turn.turn);
  const own = useOwnActions({ limit: 200 });
  const live = useMemo(() => new Map((own.actions ?? []).map((a) => [a.actionId, a])), [own.actions]);
  const approve = useMutation(api.actions.approve);
  const reject = useMutation(api.actions.reject);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const byId = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending, turn.text.length]);
  // The turn's conversation, as soon as the server names it (a new conversation starts with the turn).
  const started = turn.events.find((e) => e.type === "turn") as { conversationId?: string } | undefined;
  useEffect(() => {
    if (started?.conversationId && started.conversationId !== conversationId) onConversation(started.conversationId);
  }, [started?.conversationId]);

  const submit = async (text: string) => {
    const t = text.trim();
    if (!t || pending) return;
    setPending(t);
    setDraft("");
    try {
      const r = await turn.run({ text: t, clientId: newClientId(), ...(conversationId ? { conversationId } : {}) });
      if (r.conversationId !== conversationId) onConversation(r.conversationId);
    } catch (e) {
      if ((e as { message?: string })?.message !== "Cancelled.") {
        setDraft(t);
        onError(e);
      }
    } finally {
      setPending(null);
      own.refresh();
      input.current?.focus();
    }
  };
  const sentCompose = useRef(0);
  useEffect(() => {
    if (!compose || compose.nonce === sentCompose.current) return;
    sentCompose.current = compose.nonce;
    void submit(compose.text);
  }, [compose?.nonce]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(draft);
    }
  };
  const visible = showSuperseded ? messages : messages.filter((m) => !m.supersededBy);
  const supersededCount = messages.length - messages.filter((m) => !m.supersededBy).length;
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !m.supersededBy);
  const pendingShown = pending && !messages.some((m) => m.role === "user" && m.text === pending && m.id === (started as { messageId?: string } | undefined)?.messageId);

  return (
    <div className="chat">
      <div className="chat-bar">
        <button className="ghost icon-btn" onClick={() => setShowThreads((v) => !v)} aria-expanded={showThreads} aria-label="Conversations">
          <Icon name="menu" />
        </button>
        <div className="chat-title">{conversations.find((c) => c.id === conversationId)?.title ?? "New conversation"}</div>
        <button className="ghost icon-btn" onClick={() => (onConversation(null), setShowThreads(false), input.current?.focus())} aria-label="New conversation" title="New conversation">
          <Icon name="plus" />
        </button>
      </div>

      {showThreads && (
        <div className="threads" role="dialog" aria-label="Conversations">
          {conversations.length === 0 && <p className="muted pad">No conversations yet.</p>}
          {conversations.map((c) => (
            <button key={c.id} className={`thread ${c.id === conversationId ? "on" : ""}`} onClick={() => (onConversation(c.id), setShowThreads(false))}>
              <span className="thread-title">{c.title}</span>
              <span className="muted small">{ago(c.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="messages" aria-live="polite">
        {!conversationId && !pending ? (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">◐</div>
            <h1>{name ? `Hi ${name}.` : "Hi."} What are we getting done?</h1>
            <p className="muted">I keep track of your tasks, reminders and the things you tell me, and I show my work: everything I change is in Activity, and anything destructive waits for your OK.</p>
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="chip" onClick={() => void submit(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {supersededCount > 0 && (
              <button className="link small center-text" onClick={() => setShowSuperseded((v) => !v)}>
                {showSuperseded ? "Hide" : "Show"} {supersededCount} edited-away message{supersededCount > 1 ? "s" : ""}
              </button>
            )}
            {visible.map((m) => (
              <div key={m.id} className={`msg ${m.role} ${m.supersededBy ? "superseded" : ""}`}>
                {editing?.id === m.id ? (
                  <form
                    className="edit-form"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      const text = editing.text.trim();
                      setEditing(null);
                      // An edit is asked as a new turn; the original and what it did stay in the history.
                      if (text && text !== m.text) void submit(text);
                    }}
                  >
                    <textarea value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} rows={2} autoFocus aria-label="Edit message" />
                    <div className="row end">
                      <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="submit">Send edit</button>
                    </div>
                  </form>
                ) : (
                  m.text ? (
                    <div className="bubble">
                      <Markdown text={m.text} />
                      {m.agent && (
                        <div className="provenance" title={`Recorded as ${m.agent.generations.length} generation record(s) on ${m.agent.taskId}`}>
                          {m.agent.model}
                          {m.agent.reference ? ` · ${m.agent.reference}` : ""}
                          {m.agent.cancelled ? " · stopped" : ""}
                        </div>
                      )}
                    </div>
                  ) : null
                )}
                {m.agent?.proposals
                  .filter((p) => p.effect === "consequential")
                  .map((p) => (
                    <ProposalCard key={p.actionId} proposal={p} live={live.get(p.actionId)} onApprove={() => own.approve(p).catch(onError)} onReject={() => own.reject(p).catch(onError)} />
                  ))}
                {m.agent && m.agent.proposals.some((p) => p.effect === "observation") && (
                  <div className="evidence">looked at: {[...new Set(m.agent.proposals.filter((p) => p.effect === "observation").map((p) => p.capability))].join(", ")}</div>
                )}
                {m.actionIds?.map((id) => {
                  const a = byId.get(id);
                  if (!a) return null;
                  return (
                    <div key={id} className={`action-card ${a.status}`}>
                      <div className="row between">
                        <span className="action-summary">{a.summary}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      {a.evidence && <Evidence evidence={a.evidence} />}
                      {a.error && <div className="error-text small">{a.error.message}</div>}
                      {a.status === "proposed" && (
                        <div className="row end">
                          <button className="secondary" onClick={() => void reject({ id }).catch(onError)}>Reject</button>
                          <button className="danger" onClick={() => void approve({ id }).catch(onError)}>Approve</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {m.role === "assistant" && !m.supersededBy && m.suggestions?.length ? (
                  <div className="suggestions">
                    {m.suggestions.map((s) => (
                      <button key={s} className="chip" onClick={() => void submit(s)} disabled={!!pending}>
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
                {m.role === "user" && !m.supersededBy && editing?.id !== m.id && (
                  <div className="msg-tools">
                    <button className="ghost tiny" onClick={() => setEditing({ id: m.id, text: m.text })} aria-label="Edit"><Icon name="edit" size={14} /> Edit</button>
                    {m.id === lastUser?.id && (
                      <button className="ghost tiny" onClick={() => void submit(m.text)} aria-label="Ask again"><Icon name="retry" size={14} /> Ask again</button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <>
                {pendingShown && <div className="msg user"><div className="bubble">{pending}</div></div>}
                <div className="msg assistant">
                  {turn.text ? (
                    <div className="bubble streaming" data-testid="streaming"><Markdown text={turn.text} /></div>
                  ) : (
                    <div className="bubble typing" aria-label="Working"><span /><span /><span /></div>
                  )}
                </div>
              </>
            )}
          </>
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={(e) => (e.preventDefault(), void submit(draft))}>
        <textarea ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} placeholder="Ask, tell, or remind…" rows={1} aria-label="Message" maxLength={4000} />
        {pending ? (
          <button type="button" className="send stop" onClick={() => turn.cancel()} aria-label="Stop">
            <Icon name="x" />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!draft.trim()} aria-label="Send">
            <Icon name="send" />
          </button>
        )}
      </form>
    </div>
  );
}
