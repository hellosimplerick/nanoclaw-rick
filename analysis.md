# NanoClaw Anchor Summary (Recon Pass, No Code Changes)

## Executive Summary

1. NanoClaw is a TypeScript/Node single-process orchestrator that ingests WhatsApp messages, stores state in SQLite, and runs Claude in isolated containers.  
2. Runtime entry in dev is `tsx src/index.ts`; production is `node dist/index.js`.  
3. First-run flow is explicitly “run `claude` then `/setup`,” with setup expected to handle auth/runtime/service config.  
4. Core host loop: poll DB for new messages, group them, then either stream into active group container or enqueue a new run.  
5. Data model is centralized in `store/messages.db` with chats/messages/tasks/task logs/router state/sessions/registered groups.  
6. Group isolation is mount-based: main gets project root; non-main gets only own group dir (+ optional read-only global dir + validated extra mounts).  
7. Additional mounts are gated by an external allowlist at `~/.config/nanoclaw/mount-allowlist.json` and blocked-pattern checks.  
8. Scheduling is host-side polling every minute, with execution delegated to containerized agent runs and controlled through per-group IPC JSON files.  
9. Agent runner uses Claude Agent SDK + MCP stdio server (`nanoclaw`) to expose tools like `send_message`, task CRUD, and `register_group`.  
10. Biggest reality gap: README claims Docker/macOS+Linux support, but this branch’s host runtime path is hardwired to Apple `container` CLI calls.

---

## A) How to run it (README + code reality)

### Supported OS/runtime (documented)
- README says macOS or Linux, Node 20+, Claude Code, and Apple Container (macOS) or Docker (macOS/Linux).
- `package.json` enforces Node `>=20`.

### Supported OS/runtime (code reality)
- Host process checks and starts Apple Container with `container system status/start`, and runs agents with `container run`.
- `container/build.sh` also uses `container build` directly.
- Conclusion: macOS + Apple Container is concretely implemented in inspected code. Linux/Docker path may be skill-based or out-of-tree.

### Expected first-run flow
- README quick-start is clone -> `claude` -> run `/setup`.
- `CLAUDE.md` reinforces `/setup` handles installation/auth/service configuration.
- WhatsApp auth script exists (`npm run auth` -> `src/whatsapp-auth.ts`) for QR linking into `store/auth`.

### External credentials/integrations implied
- Claude credentials: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` filtered from `.env` and mounted into container env-dir.
- WhatsApp via Baileys with persisted auth state under `store/auth`.
- Optional web search/fetch via SDK allowed tools.
- Optional browser automation via `agent-browser` installed in container + bundled skill docs.

---

## B) Architecture map (high-level but concrete)

### Primary language/frameworks
- Host: TypeScript on Node.js (`type: module`, `tsc`, `tsx`).
- Agent runtime: TypeScript + `@anthropic-ai/claude-agent-sdk` in container-side runner.
- Persistence: SQLite via `better-sqlite3`.

### Main process start + execution path
- Start commands: `npm run dev` -> `tsx src/index.ts`; prod -> `node dist/index.js`.
- `main()` does container-system check, DB init, state load, WA connect, scheduler start, IPC watcher start, queue wiring, recovery, message loop.
- Message loop polls DB, dedupes by group, applies trigger logic, and either pipes to active container or enqueues work.

### Key modules in `src/`
- `index.ts`: orchestrator, lifecycle, state cursors, per-group agent invocation.
- `channels/whatsapp.ts`: Baileys connect/reconnect, inbound parsing, outbound queue, metadata sync.
- `db.ts`: schema + all CRUD for messages/groups/tasks/sessions/router state.
- `container-runner.ts`: mount construction, env filtering, process spawn/timeout/logging, group/task snapshots.
- `ipc.ts`: scans per-group IPC dirs and authorizes message/task/group-management actions.
- `task-scheduler.ts`: due-task polling/execution + next-run calculation.
- `group-queue.ts`: per-group serialization + global concurrency + retry/backoff.
- `mount-security.ts`: allowlist enforcement + readonly policy for non-main groups.

### Where groups live + isolation
- Group memory dirs under `groups/{folder}` plus global shared memory under `groups/global`.
- Mount model: main gets `/workspace/project` + `/workspace/group`; non-main gets only `/workspace/group` (+ optional `/workspace/global` ro if exists).
- Per-group session dir mounted as `/home/node/.claude`; per-group IPC namespace mounted at `/workspace/ipc`.
- Additional mounts are validated and mapped under `/workspace/extra/*`.

### Scheduling subsystem
- Task definitions stored in `scheduled_tasks`; run history in `task_run_logs`.
- Scheduler checks due tasks every `SCHEDULER_POLL_INTERVAL` (60s default), enqueues per-group execution.
- MCP `schedule_task/list/pause/resume/cancel` generates IPC JSON consumed by host watcher.

### Memory subsystem
- Persistent DB state: messages/chats/tasks/sessions/router state/registered groups.
- Per-group Claude session files in `data/sessions/{group}/.claude` (mounted into container).
- Global memory text in `groups/global/CLAUDE.md`, read for non-main via system prompt append in runner.

### Channel/provider integration points
- WhatsApp ingress/egress lives in `src/channels/whatsapp.ts`; only registered groups’ full content is persisted.
- Main-channel control is represented by `folder === "main"` privilege checks throughout index/ipc/scheduler.

---

## C) Dependency + integration summary

### Major npm deps and usage
- `@whiskeysockets/baileys`: WhatsApp Web socket/auth/events.
- `better-sqlite3`: persistent local DB.
- `cron-parser`: cron parsing for task schedules.
- `pino`/`pino-pretty`: structured logging.
- `qrcode-terminal`: WhatsApp auth QR flow.
- `zod`: MCP tool argument schemas.

### External services/APIs
- WhatsApp network via Baileys connection.
- Anthropic Claude Agent SDK runtime in container.
- Web fetch/search capability via allowed SDK tools.
- Optional browser automation through installed `agent-browser`.

### Security-critical surfaces
- Container execution + mount list construction (primary sandbox boundary).
- Additional mount allowlist and blocked-pattern enforcement.
- Credential filtering from `.env` into mounted env-dir.
- IPC file processing and authorization logic.
- Broad tool permissions in container query (`allowDangerouslySkipPermissions`, Bash/Web/File tools).

---

## D) Risk + leverage points

### Top 5 change leverage points
1. `src/config.ts` constants/env vars (timeouts, concurrency, trigger, paths) alter behavior globally.
2. `src/index.ts` message loop + trigger gating + cursor handling controls responsiveness/replay semantics.
3. `src/container-runner.ts` mount policy/env projection determines isolation and available capability.
4. `container/agent-runner/src/index.ts` allowed toolset + permission mode strongly changes agent power/risk.
5. `src/ipc.ts` auth checks for tasks/messages/register_group define privilege boundaries.

### Top 5 risk hotspots
1. Credential exposure tradeoff: Anthropic creds mounted into container.
2. Container permission mode bypass + Bash/Web tools can widen blast radius if mount policy regresses.
3. Additional mount validation logic is security-critical and pattern-based.
4. IPC directory is filesystem trust boundary; malformed file handling/auth checks are sensitive.
5. Timeout/cursor coupling can cause message loss/duplication edge cases.

### Coupling smells
- Global mutable in-memory state (`sessions`, `registeredGroups`, `lastAgentTimestamp`) in `index.ts`.
- Main-channel privilege inferred by magic folder name `main` in multiple modules.
- Apple Container CLI hard-coded in host process paths.
- Docs/prompts include some legacy JSON references while DB appears canonical.

---

## E) Mental model diagram

`WhatsApp (Baileys) -> store message/chat metadata in SQLite -> host poll loop (trigger + group routing) -> GroupQueue (per-group serialize + global concurrency) -> container-runner (mounts + env + spawn container) -> agent-runner query loop (Claude SDK + nanoclaw MCP tools + IPC follow-ups) -> results streamed back -> format outbound -> WhatsApp send; in parallel: scheduler loop polls due tasks -> enqueues container runs.`

---

## F) Clarifying questions before implementing changes

1. Do you want this fork to remain Apple-Container-first, or should Docker be the default runtime path in code?
2. Is Linux support currently expected to work on this exact branch, or is that roadmap-only?
3. Should main-channel privileges stay tied to folder name `main`, or should this be explicit in DB?
4. Do you want to keep `allowDangerouslySkipPermissions` in runner, or tighten tool permissions?
5. For non-main groups, should global memory append remain default or become per-group configurable?
6. Is external mount allowlist path fixed (`~/.config/nanoclaw/mount-allowlist.json`) or should it be configurable?
7. Should scheduled tasks default to `context_mode=group` or `isolated`?
8. Should DB be sole source of truth (removing JSON-config references in docs/prompts)?
9. Should trigger behavior for solo chats (`requiresTrigger=false`) be auto-detected or always explicit?
10. Is macOS launchd still primary target deploy path, or do you want Linux service artifacts in-repo?
11. Should stronger credential isolation be the first hardening project?
12. For your fork: preserve “skills over features” philosophy, or accept direct feature additions?
