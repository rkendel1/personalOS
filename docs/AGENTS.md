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

**Deleting a task is not on the list.** It stays your own act, in the Tasks screen.

## How a call works

The agent names you on each call. FeltKit asks AuthBoundry whether you granted that agent that capability, then runs PersonalOS's own function as you, with your roles.

- **Records:** the action log records the call with `via: "agent"` and the agent, capability, and AuthBoundry decision and delegation ids. FeltKit's audit record carries the same decision.
- **Reminders:** they are PersonalOS's own jobs, queued as you. They fire without the agent, while you have an active session, as for any reminder.
- **Repeats:** a repeated call with the same idempotency key does nothing twice.

## Not yet

- **No screen in Settings for agent grants.** Grants to an agent are made through `delegation.set` with `agent`; there is no screen for them yet.
- **Memory, projects, documents and research** are not available to agents yet.
