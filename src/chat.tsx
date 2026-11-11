/**
 * The conversation. Messages are FeltDB records, so a reply appears through the live query the
 * moment its mutation commits; there is no client-side copy to drift from the truth.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ago, clientDay, Evidence, Icon, Markdown, StatusBadge, type Action } from "./ui";

const EXAMPLES = [
  "Remind me to follow up with John tomorrow at 10am",
  "What should I focus on today?",
  "Remember that Sam is my manager",
  "Help me plan my week",
  "What am I forgetting?",
  "Add renew passport to my list, it's urgent",
];

export function Chat({ conversationId, onConversation, onError, name }: { conversationId: string | null; onConversation: (id: string | null) => void; onError: (e: unknown) => void; name: string | null }) {
  const conversations = useQuery(api.conversations.list) ?? [];
  const messages = useQuery(api.conversations.messagesOf, conversationId ? { conversationId } : "skip") ?? [];
  const actions = (useQuery(api.actions.list, { limit: 500 }) ?? []) as Action[];
  const send = useMutation(api.assistant.send);
  const edit = useMutation(api.assistant.edit);
  const retry = useMutation(api.assistant.retry);
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
  }, [messages.length, pending]);

  const submit = async (text: string) => {
    const t = text.trim();
    if (!t || pending) return;
    setPending(t);
    setDraft("");
    try {
      const r = await send({ text: t, ...(conversationId ? { conversationId } : {}), ...clientDay() });
      if (r.conversationId !== conversationId) onConversation(r.conversationId);
    } catch (e) {
      setDraft(t);
      onError(e);
    } finally {
      setPending(null);
      input.current?.focus();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(draft);
    }
  };
  const visible = showSuperseded ? messages : messages.filter((m) => !m.supersededBy);
  const supersededCount = messages.length - messages.filter((m) => !m.supersededBy).length;
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !m.supersededBy);

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
                      if (text && text !== m.text) void edit({ messageId: m.id, text, ...clientDay() }).catch(onError);
                    }}
                  >
                    <textarea value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} rows={2} autoFocus aria-label="Edit message" />
                    <div className="row end">
                      <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="submit">Send edit</button>
                    </div>
                  </form>
                ) : (
                  <div className="bubble">
                    <Markdown text={m.text} />
                    {m.interpretation?.source === "model" && <div className="provenance">From a model suggestion you approved</div>}
                  </div>
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
                      <button className="ghost tiny" onClick={() => void retry({ messageId: m.id, ...clientDay() }).catch(onError)} aria-label="Ask again"><Icon name="retry" size={14} /> Ask again</button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <>
                <div className="msg user"><div className="bubble">{pending}</div></div>
                <div className="msg assistant"><div className="bubble typing" aria-label="Working"><span /><span /><span /></div></div>
              </>
            )}
          </>
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={(e) => (e.preventDefault(), void submit(draft))}>
        <textarea ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} placeholder="Ask, tell, or remind…" rows={1} aria-label="Message" maxLength={4000} />
        <button type="submit" className="send" disabled={!draft.trim() || !!pending} aria-label="Send">
          <Icon name="send" />
        </button>
      </form>
    </div>
  );
}
