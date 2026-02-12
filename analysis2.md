# Runtime + Security Verification (nanoclaw-rick)

**Question:** Is Docker truly supported by code on this branch?  
**Answer:** **No**  
**Confidence:** **High (0.94)**

Host runtime execution paths are hardcoded to Apple `container` CLI. Docker is referenced in docs, but not wired into host runtime code paths. `docs/REQUIREMENTS.md` also still frames Docker as a conversion target.

---

## Runtime portability verification

### a) Files/functions that call the container runtime

- `src/container-runner.ts`
  - `buildContainerArgs(...)` builds Apple Container `run` args.
  - `runContainerAgent(...)` launches `spawn('container', ...)`.
  - `killOnTimeout` uses `exec('container stop ...')`.
- `src/index.ts`
  - `ensureContainerSystemRunning(...)` checks/starts Apple Container and cleans up orphan containers.
- `container/build.sh` (helper script)
  - Uses Apple Container CLI for image build and test run.

### b) Exact command strings (or composition)

- In `src/container-runner.ts`:
  - Base args: `['run', '-i', '--rm', '--name', containerName]`
  - Read-only mounts: `--mount type=bind,source=...,target=...,readonly`
  - Read-write mounts: `-v hostPath:containerPath`
  - Runtime invocation: `spawn('container', containerArgs, ...)`
  - Stop on timeout: ``exec(`container stop ${containerName}`)``

- In `src/index.ts`:
  - `execSync('container system status', ...)`
  - `execSync('container system start', ...)`
  - `execSync('container ls --format json', ...)`
  - ``execSync(`container stop ${name}`, ...)``

- In `container/build.sh`:
  - `container build -t ...`
  - `container run -i ...`

### c) Docker support status in code

- **In-code host runtime support:** **Not implemented**.
- **References to Docker:** present in docs/requirements text, not host runtime execution paths.
- Net: Docker is currently **referenced in docs** rather than truly supported in branch code.

### d) Minimum-change dual-runtime design (no implementation)

- Introduce a thin runtime adapter abstraction (e.g., `ContainerRuntime`) with methods:
  - `run(...)`, `stop(...)`, `systemStatus()`, `systemStart()`, `listRunning()`.
- Keep existing mount policy and IPC/security logic unchanged.
- Move only CLI rendering/parsing into `AppleContainerRuntime` and `DockerRuntime`.
- Select runtime once (config/env) and inject into:
  - `runContainerAgent(...)`
  - `ensureContainerSystemRunning(...)`

### If we change X, what breaks? (Runtime)

- Replacing command strings ad hoc (without adapter boundaries) risks breaking:
  - mount flag semantics,
  - startup checks (`system status/start` are Apple-specific),
  - orphan-list parsing assumptions (`container ls --format json`).

---

## Security boundary verification

### a) Main-vs-non-main privilege checks

**Enforcement points:**

- `src/index.ts`
  - `processGroupMessages(...)`: non-main groups require trigger unless opted out.
  - `startMessageLoop(...)`: non-main groups only act on trigger messages.
  - `runAgent(...)`: computes `isMain` from group folder and passes it to runner.

- `src/container-runner.ts`
  - `buildVolumeMounts(...)`: different mount scopes for main vs non-main.
  - `writeTasksSnapshot(...)`: main sees all tasks; non-main sees own tasks only.
  - `writeGroupsSnapshot(...)`: main sees available groups; non-main gets empty list.

- `src/ipc.ts`
  - Source identity is taken from IPC directory (`sourceGroup`), with `isMain` from folder name.
  - Message/task operations enforce main-only or same-group-only rules.

### b) Mount allowlist path handling and blocked-pattern checks

**Enforcement points in `src/mount-security.ts`:**

- `loadMountAllowlist()`
  - Reads allowlist from external path (`MOUNT_ALLOWLIST_PATH`), caches result.
  - Missing/invalid allowlist blocks additional mounts.
  - Merges default blocked patterns with user patterns.

- `isValidContainerPath(...)`
  - Rejects absolute paths, empty paths, and traversal (`..`).

- `validateMount(...)`
  - Expands host path (`~`), resolves real path (symlink-aware), rejects non-existent paths.
  - Rejects blocked pattern matches.
  - Rejects paths outside configured allowed roots.
  - Enforces effective read-only when needed (non-main or root policy).

- `validateAdditionalMounts(...)`
  - Only accepted mounts are returned.
  - Container destination is always `/workspace/extra/<resolvedContainerPath>`.

### c) IPC file intake, parsing, authorization rules

**Enforcement points in `src/ipc.ts`:**

- `startIpcWatcher(...)`
  - Polls per-group IPC dirs under `${DATA_DIR}/ipc`.
  - Processes only `.json` files from `messages` and `tasks` subdirs.
  - Parses with `JSON.parse`; on error, moves file to `ipc/errors`.
  - Message send authorization:
    - allow if `isMain`, or if target chat maps to same `sourceGroup`.

- `processTaskIpc(...)`
  - `schedule_task`: non-main can schedule only for own group.
  - `pause_task` / `resume_task` / `cancel_task`: non-main only for own group's tasks.
  - `refresh_groups` and `register_group`: main only.

### d) Agent permission mode flags and where/how set

**In-container setting point:**

- `container/agent-runner/src/index.ts` (`runQuery(...)`):
  - `permissionMode: 'bypassPermissions'`
  - `allowDangerouslySkipPermissions: true`

**Main/non-main propagation to in-container tools:**

- `container/agent-runner/src/index.ts` sets MCP server env:
  - `NANOCLAW_IS_MAIN` from `containerInput.isMain`.
- `src/index.ts` determines `isMain` and passes it into `runContainerAgent(...)` input.

### If we change X, what breaks? (Security)

- If IPC identity stops being directory-derived (`sourceGroup`), cross-group spoofing risk increases.
- If mount validation checks are bypassed, sensitive path exposure/traversal risk rises.
- If permission mode flags are altered, agent tool-execution behavior changes materially.

---

## Evidence inspected (commands)

- `rg -n "spawn\('container'|execSync\('container|container stop" src container`
- `rg -n "docker" src container`
- `nl -ba src/container-runner.ts | sed -n '1,760p'`
- `nl -ba src/index.ts | sed -n '1,560p'`
- `nl -ba src/mount-security.ts | sed -n '1,460p'`
- `nl -ba src/ipc.ts | sed -n '1,620p'`
- `nl -ba container/agent-runner/src/index.ts | sed -n '330,460p'`
- `nl -ba container/agent-runner/src/ipc-mcp-stdio.ts | sed -n '1,320p'`
- `nl -ba README.md | sed -n '100,170p'`
- `nl -ba docs/REQUIREMENTS.md | sed -n '50,75p'`
