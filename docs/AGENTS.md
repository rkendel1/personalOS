# Agents acting for you

An agent outside PersonalOS (for example an eve agent) can manage your tasks for you, through PersonalOS's own
capabilities on `/appport`, only as far as you allow it, one capability at a time.

This needs a FeltKit with delegated `/appport` (after 0.3.32) and `@authboundry/local` 0.1.1 or later.

## Setting it up

1. **An administrator registers the agent** with PersonalOS's authority. It can do nothing yet.

   ```ts
   delegation.registerAgent({ id: "appport-agent" })
   ```

2. **The agent gets a FeltKit agent session.** For example: `feltkit session create --id appport-agent --type agent --role agent --ttl <hours>`. The `agent` role holds no permissions: the agent can do nothing as itself.
3. **You grant it what it may do for you**, separately from what PersonalOS itself may do. Changing one never revokes the other.

   ```ts
   delegation.set({ agent: "appport-agent", capabilities: ["tasks.list", "tasks.create"] })
   ```

   `delegation.list({ agent: "appport-agent" })` shows what you allowed. Setting an empty list revokes everything.

## What can be granted

| Capability | Lets the agent |
| --- | --- |
| `tasks.list` | See your tasks |
| `tasks.create` | Add tasks and reminders |
| `tasks.update` | Change your tasks (title, notes, dates, reminders) |
| `tasks.complete` | Mark your tasks done |
| `tasks.reopen` | Reopen your done tasks |
| `briefing.today` | Read your daily briefing |
| `memory.list` | See what PersonalOS remembers about you, confirmed and unconfirmed |
| `memory.propose` | Suggest things to remember: stored as unconfirmed until you confirm them |
| `projects.list` | See your projects (with their open and done task counts) |
| `projects.create` | Start projects |
| `projects.update` | Rename or describe your projects, or mark them active, paused or done |
| `documents.list` | See your saved documents' names, sizes and notes, and what they are attached to; not their contents |
| `documents.update` | Change a document's note, or attach it to one of your projects or tasks |
| `research.start` | Start research for you, within the research budget you set for it |
| `research.list`, `research.get` | See your research runs, and a run's sources and results |
| `research.cancel` | Stop your research runs |
| `research.retry` | Resume research it started (never completed research), within budget |

**Deleting a task is not on the list.** It stays your own act, in the Tasks screen.

**Project and document grants are separate.** Seeing your projects never shows an agent your documents; `documents.list` is needed for that.

**Your documents' contents never pass through an agent.** An agent cannot upload a document, get a download link, or remove one. Saving and removing documents stay yours, in the Documents screen.

## Memory an agent suggests

An agent can only *suggest*. A suggestion is stored as an **inferred** memory, which PersonalOS never uses as fact:
- the Memory screen shows it as "suggested by" the agent;
- your briefing counts it among the unconfirmed notes.

**Only you make a memory trusted, or drop it**, in the Memory screen or by answering in a conversation:
- **Confirm** marks it confirmed.
- **Edit** saves your words as confirmed.
- **Forget** drops it; the action log keeps what was dropped and when.

This is enforced in PersonalOS itself, not only by what an agent is offered. While an agent is acting for you, confirming, editing, forgetting, or recording anything as confirmed is refused, whichever function is called and whatever was granted. `memory.add` stores what you state as confirmed, so it is never offered to an agent.

Suggesting the same sentence again changes nothing, and nothing an agent writes counts as your confirmation, however it is worded.

## Research costs money: you set what it may spend

A grant to start research is not a budget. Research makes billable calls (a model generation, a web search),
so an agent may start research for you only within a **research budget you set for it**, in calls:

```ts
delegation.setResearchBudget({ agent: "appport-agent", calls: 20 })
delegation.researchBudget({ agent: "appport-agent" })   // calls, reserved, left
```

- **With no budget, nothing starts.** Each start names how many calls that run may make, and those are reserved from what is left.
- **Each call is charged before it is made.** A run that has used its calls stops (blocked: "research budget"), and keeps what it found.
- **Unused calls come back** when a run finishes or is stopped. Resuming one (`research.retry`) can add calls, from what is still left.
- **Only you set or raise the budget.** It is never something an agent can be given, and PersonalOS refuses a change made while an agent acts for you.
- **Page reads are not counted.** Reading a company's pages is a plain web request, at most two pages per company.

**Stopping research** (`research.cancel`) means no further step and no further billable call. A search already in flight finishes; its result is not kept. A stopped run stays stopped after a restart. An agent can resume research it stopped, but never research you stopped.

**Revoking `research.start`** stops a running run at its next step.

## How a call works

The agent names you on each call. FeltKit asks AuthBoundry whether you granted that agent that capability, then runs PersonalOS's own function as you, with your roles.

- **Records:** the action log records the call with `via: "agent"` and the agent, capability, and AuthBoundry decision and delegation ids. FeltKit's audit record carries the same decision.
- **Reminders:** they are PersonalOS's own jobs, queued as you. They fire without the agent, while you have an active session, as for any reminder.
- **Repeats:** a repeated call with the same idempotency key does nothing twice.

## Not yet

- **No screen in Settings for agent grants.** Grants to an agent are made through `delegation.set` with `agent`; there is no screen for them yet.
- **No Settings screen for research budgets.** Budgets are set through `delegation.setResearchBudget` for now.
