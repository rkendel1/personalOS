/**
 * Research: the outcomes PersonalOS is pursuing for you ("find me new customers for FeltKit"), what
 * it checked it could do, what it searched, and what it found. Every prospect shows what its sources
 * said (with links) apart from PersonalOS's assessment of it, so you can see what was verified.
 */
import { useState } from "react";
import { useFeltKit, useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ago } from "./ui";

type Err = { onError: (e: unknown) => void };

const titleOf = (kind: string, subject: string) => (kind === "competitors" ? `Competitors of ${subject}` : kind === "organizations" ? `Research: ${subject}` : `Prospects for ${subject}`);
const PHASE: Record<string, string> = { planning: "planning", searching: "searching", selecting: "choosing who to read", reading: "reading pages", assessing: "assessing", finishing: "finishing" };
const PAGE: Record<string, string> = { read: "read", unavailable: "could not be fetched", "extraction-failed": "no readable text", "not-allowed": "not read" };

const STATUS: Record<string, string> = {
  running: "Running",
  blocked: "Blocked",
  completed: "Done",
  partial: "Partly done",
  failed: "Failed",
  cancelled: "Stopped",
};
const NEED: Record<string, string> = {
  available: "available",
  "needs-configuration": "set up, not configured",
  "needs-authorization": "not permitted for you",
  connectable: "no provider connected",
  missing: "not available",
};

export function Research({ onError, onOpenConversation }: Err & { onOpenConversation: (id: string) => void }) {
  const runs = useQuery(api.research.list, {}) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const selected = open ?? runs[0]?.id ?? null;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Research</h1>
        <p className="muted">Ask in Chat for an outcome, like "find me new customers for FeltKit" or "who competes with us?". I check what I can use, plan, search, read the most promising sites, and keep what they say apart from my assessment. Nothing is sent to anyone without your approval.</p>
      </header>
      {runs.length === 0 && <p className="muted pad">No research yet.</p>}
      <ul className="plain">
        {runs.map((r) => (
          <li key={r.id} className={`project${r.id === selected ? " selected" : ""}`} data-testid="research-run">
            <button className="ghost" onClick={() => setOpen(r.id)} aria-label={`Open research for ${r.product}`}>
              <div className="task-title">{titleOf(r.kind, r.product)}</div>
              <div className="task-meta">
                <span>{STATUS[r.status] ?? r.status}{r.status === "running" && r.phase ? `: ${PHASE[r.phase] ?? r.phase}` : ""}</span>
                <span>{r.prospectCount} result{r.prospectCount === 1 ? "" : "s"}</span>
                <span>{ago(r.createdAt)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {selected && <RunDetail runId={selected} onError={onError} onOpenConversation={onOpenConversation} />}
    </div>
  );
}

function RunDetail({ runId, onError, onOpenConversation }: Err & { runId: string; onOpenConversation: (id: string) => void }) {
  const data = useQuery(api.research.get, { runId });
  const cancel = useMutation(api.research.cancel);
  const client = useFeltKit();
  if (!data) return null;
  const { run, sources, prospects } = data as any;
  const byId = new Map<string, any>(sources.map((s: any) => [s.id, s]));
  const canRetry = ["blocked", "failed", "partial", "cancelled"].includes(run.status);
  return (
    <section data-testid="research-detail">
      <h2>{titleOf(run.kind, run.product)}</h2>
      <p className="small">{run.objective}</p>
      {run.plan && (
        <p className="small muted" data-testid="research-plan">
          Plan by {run.plan.basis === "model" ? `a model (${run.plan.generation?.model ?? "model"}), checked by rules` : "rules"}
          {run.plan.criteria?.length ? `: ${run.plan.criteria.join("; ")}` : ""}
        </p>
      )}
      <p className="small">
        <strong>{STATUS[run.status] ?? run.status}{run.status === "running" && run.phase ? `: ${PHASE[run.phase] ?? run.phase}` : ""}</strong>
        {run.blocker ? <span> · {run.blocker.need}: {run.blocker.detail} {run.blocker.howToEnable ? <em>{run.blocker.howToEnable}</em> : null}</span> : null}
      </p>
      <div className="row">
        {(run.status === "running" || run.status === "blocked") && <button className="ghost tiny" onClick={() => void cancel({ runId }).catch(onError)}>Stop</button>}
        {canRetry && <button className="tiny" onClick={() => void client.action(api.research.retry, { runId }).catch(onError)}>Retry</button>}
        {run.conversationId && <button className="ghost tiny" onClick={() => onOpenConversation(run.conversationId)}>Conversation</button>}
      </div>

      <details>
        <summary className="small">What I checked I could use ({run.discovery?.capabilitiesSeen ?? 0} capabilities)</summary>
        <ul className="small" data-testid="research-needs">
          {(run.discovery?.needs ?? []).map((n: any) => (
            <li key={n.need}>
              <strong>{n.need}</strong>: {NEED[n.state] ?? n.state}{n.capability ? <span className="muted"> ({n.capability})</span> : null}
              {n.state !== "available" && n.howToEnable ? <div className="muted">{n.howToEnable}</div> : null}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary className="small">Searches ({run.queries.filter((q: any) => q.state === "done").length} of {run.queries.length})</summary>
        <ul className="small">
          {run.queries.map((q: any) => (
            <li key={q.text}>“{q.text}”{q.origin === "refinement" ? " (refined)" : ""}: {q.state}{q.results != null ? `, ${q.results} results` : ""}{q.provider ? <span className="muted"> via {q.provider}</span> : null}{q.error ? <span className="muted"> ({q.error})</span> : null}</li>
          ))}
        </ul>
      </details>
      {sources.some((x: any) => x.kind === "page") && (
        <details>
          <summary className="small">Pages ({sources.filter((x: any) => x.kind === "page" && x.status === "read").length} of {sources.filter((x: any) => x.kind === "page").length} read)</summary>
          <ul className="small" data-testid="research-pages">
            {sources.filter((x: any) => x.kind === "page").map((x: any) => (
              <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer noopener">{x.url}</a>: {PAGE[x.status] ?? x.status}{x.status !== "read" && x.detail ? <span className="muted"> ({x.detail})</span> : null}</li>
            ))}
          </ul>
        </details>
      )}
      {run.usage && (
        <p className="small muted" data-testid="research-usage">
          {run.usage.searches} search call(s), {run.usage.pagesRead}/{run.usage.pagesRequested} pages read, {run.usage.generations} model call(s) ({run.usage.inputTokens + run.usage.outputTokens} tokens){run.usage.quotesOffered ? `, ${run.usage.quotesVerified}/${run.usage.quotesOffered} quotes verified` : ""}.
        </p>
      )}

      {prospects.length > 0 && <h3>{run.kind === "competitors" ? "Competitors" : run.kind === "organizations" ? "Organizations" : "Prospects"}</h3>}
      <ol className="plain">
        {prospects.map((p: any) => (
          <li key={p.id} className="project" data-testid="prospect">
            <div>
              <div className="task-title">
                {p.rank}. {p.company} <a href={p.website} target="_blank" rel="noreferrer noopener" className="small">{p.domain}</a>
              </div>
              <div className="small" data-testid="assessment">
                <strong>{p.assessment.basis === "model" ? "Model assessment" : "My assessment"}</strong> <span className="muted">({p.assessment.method})</span>: {p.assessment.fit} fit, {p.assessment.confidence} confidence. {p.assessment.whyFeltKit}
                <ul>
                  {p.assessment.rationale.map((r: any, i: number) => (
                    <li key={i}>{r.text} <span className="muted">[{r.sourceIds.map((id: string) => byId.get(id)?.url ?? id).filter((v: string, j: number, all: string[]) => all.indexOf(v) === j).length} source(s)]</span></li>
                  ))}
                </ul>
              </div>
              <div className="small" data-testid="facts">
                <strong>What the sources said</strong> <span className="muted">({ago(p.researchedAt)})</span>
                <ul>
                  {p.facts.map((f: any, i: number) => (
                    <li key={`${f.sourceId}-${i}`}>{f.kind === "quote" ? "Its page: " : "Search result: "}“{f.text}” <a href={f.url} target="_blank" rel="noreferrer noopener">source</a></li>
                  ))}
                </ul>
              </div>
              <div className="small muted">Not verified: {p.openQuestions.join(" ")}</div>
              <div className="small"><strong>Next:</strong> {p.nextAction}</div>
            </div>
          </li>
        ))}
      </ol>
      {(run.candidates ?? []).some((c: any) => c.state === "rejected") && (
        <details>
          <summary className="small">Looked at and ruled out</summary>
          <ul className="small">
            {run.candidates.filter((c: any) => c.state === "rejected").map((c: any) => <li key={c.domain}>{c.name} ({c.domain}): {c.verdict}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
