# release-operator

A state-machine driven engine for release orchestration: create branches, cut a change
ticket, get QA and CAB approval, deploy, run sanity checks, backmerge, tag, and finalize —
with every transition logged so you can answer "what happened" after the fact. A declarative
YAML pipeline config drives the whole thing end to end, auto-advancing through automatic steps
and stopping cleanly at real wait points.

## Concepts

- **Release** (`src/types.ts`) — one persistent record per release: version, repos,
  environment, current state, ticket, approvals, deployment, sanity, backmerge, tagging,
  timestamps.
- **Events** — things that happen (`RELEASE_CREATED`, `QA_APPROVED`, `DEPLOY_FAILED`, ...).
- **Transitions** (`src/transitions.ts`) — an explicit table of which events are legal
  from which states. Anything not in the table is refused.
- **Guards** (`src/guards.ts`) — preconditions checked before a transition is allowed
  (e.g. before `READY_TO_DEPLOY`: branches exist, ticket exists, QA/CAB approved, CI
  green, feature flags known).
- **Actions** (`src/actions.ts`) — side effects run after entering a new state. GitHub
  (branch creation, backmerge PR, tagging) is wired for real — see "GitHub integration"
  below. Slack/Jira/deploy/test are still stubbed (logged to stderr); swap those function
  bodies for real integrations without touching the engine.
- **Event log** (`src/store.ts`, SQLite `events` table) — every attempted transition is
  recorded, applied or rejected, with the reason. `releases.data` holds the current
  record as JSON for simplicity; `events` is the append-only source of truth for history.
- **Workflow config** (`config/pipeline.yaml`, `src/workflow/`) — a declarative description
  of the 12-step release pipeline as an ordered set of hops over the state machine above.
  Loaded and validated against the *real* transition table at startup (`src/workflow/loader.ts`),
  so a step referencing a state/event that doesn't exist in the code fails loudly rather than
  drifting silently. `WorkflowExecutor.advance()` (`src/workflow/executor.ts`) applies an
  incoming event and then auto-fires consecutive non-wait ("kickoff") steps until it hits a
  wait ("result") step or a terminal state.

## State machine

```
DRAFT -> BRANCH_CREATED -> CHANGE_TICKET_CREATED -> QA_APPROVAL_PENDING -> QA_APPROVED
      -> CAB_APPROVAL_PENDING -> CAB_APPROVED -> READY_TO_DEPLOY -> DEPLOYING -> DEPLOYED
      -> SANITY_CHECKING -> SANITY_PASSED -> FINALIZING -> TICKET_UPDATED
      -> BACKMERGE_PENDING -> BACKMERGE_CREATED -> TAGGING_PENDING -> TAGGED -> COMPLETE
```

Side paths: `QA_REJECTED`/`CAB_REJECTED` send it back a step; `BLOCKED`/`UNBLOCKED` pause
and resume from any non-terminal state; `CANCELLED` and `ROLLBACK_REQUESTED` are
available from most in-flight states; `DEPLOY_FAILED`/`SANITY_FAILED` land in `FAILED`,
which can still be rolled back or cancelled. The three finalize sub-steps
(`TICKET_UPDATE_FAILED`, `BACKMERGE_FAILED`, `TAGGING_FAILED`) each retry independently via
their own `RETRY_*` event, without redoing the others. `COMPLETE`, `ROLLED_BACK`, and
`CANCELLED` are terminal. See `src/transitions.ts` for the exact table.

`CI_STATUS_REPORTED` is a sidecar event: it updates `release.ci.status` without moving
`ReleaseState` at all (CI can report in at any point) and never triggers auto-advance.

## Intelligence service (local SLM)

An optional, strictly advisory layer that drafts text using a local small language model —
it never reads guard/transition logic and nothing in `src/engine.ts`, `src/guards.ts`, or
`src/transitions.ts` calls it. **It cannot approve a release, decide QA/CAB sign-off, or gate
a deployment.** Every method just returns text or a string list for a human to review; the CLI
commands only print output, they never call `engine.transition()`.

Architecture:

```
TypeScript CLI -> IntelligenceProvider (src/intelligence/types.ts)
                       -> LocalQwenProvider (src/intelligence/localQwenProvider.ts)
                             -> HTTP (OpenAI-compatible /v1/chat/completions)
                                   -> mlx_lm.server (separate local process)
                                         -> Qwen3-4B-Instruct-2507, 4-bit
```

The model runs as its own OS process via MLX-LM's server, never embedded in Node. The
TypeScript side only ever speaks HTTP to it.

**Model**: [`mlx-community/Qwen3-4B-Instruct-2507-4bit`](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit)
— verified 2026-09-14. A text-only (non-vision-language) instruct model converted from
`Qwen/Qwen3-4B-Instruct-2507` with `mlx-lm` 0.26.2, Apache-2.0 licensed, ~2.26GB on disk
(comfortable on 24GB unified RAM alongside everything else), 262K native context, non-thinking
(plain-answer) mode. (Newer `Qwen3.5-4B` exists but is a unified vision-language model served via
`mlx-vlm`, not `mlx-lm` — this repo sticks to `mlx-lm` per the architecture above, so `Qwen3-4B-
Instruct-2507-4bit` is the correct current pick, not an outdated one.)

**Setup** (macOS, Apple Silicon):

```bash
python3 -m venv .venv && .venv/bin/pip install mlx-lm
npm run mlx:serve   # starts mlx_lm.server on http://127.0.0.1:8080, downloads the model on first run
```

(A venv is required on Homebrew Python — it's externally managed and refuses global `pip
install`. `mlx:serve` calls `.venv/bin/mlx_lm.server` directly.)

Leave that running in its own terminal/process. Override the server address or model with
`RELEASE_OPERATOR_MLX_URL` and `RELEASE_OPERATOR_MLX_MODEL` if you run it differently.

**CLI usage**:

```bash
npm run cli -- intelligence status                     # is the server reachable?

npm run cli -- intelligence ticket-description <releaseId>
npm run cli -- intelligence release-notes <releaseId> --changes-file notes.txt

npm run cli -- intelligence summarize-changes --commits-file commits.json
# commits.json: { "commits": [{ "sha": "...", "message": "...", "author": "..." }],
#                 "pullRequests": [{ "number": 42, "title": "...", "body": "..." }] }

npm run cli -- intelligence affected-components <releaseId> --changed-files src/api/x.ts,src/web/y.ts
npm run cli -- intelligence suggest-tests <releaseId> --changed-files src/api/x.ts

npm run cli -- intelligence summarize-failure --logs-file deploy-error.log --kind deployment
```

Everything prints to stdout for you to copy into Jira/Slack/PR descriptions/etc. by hand. If
the server isn't running, commands fail with a clear "could not reach the MLX-LM server"
message rather than hanging or silently falling back.

## GitHub integration

Real, not stubbed: branch creation and backmerge PRs go through GitHub's **remote** MCP
server; tagging goes through a direct REST call (see below for why).

```
TypeScript CLI -> GithubProvider (src/github/types.ts)
                       -> GithubMcpProvider (src/github/githubMcpProvider.js)
                             -> MCP over HTTP -> https://api.githubcopilot.com/mcp/ (create_branch, create_pull_request)
                             -> direct REST  -> api.github.com/.../git/refs        (tag creation only)
```

No local server process to run: GitHub hosts the MCP server itself
([docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)), reachable
over plain HTTP with `Authorization: Bearer <token>` — confirmed 2026-09-14, no OAuth flow
required for this mode. The client connects directly to it via `@modelcontextprotocol/client`'s
`StreamableHTTPClientTransport`, same as any other HTTP call, just MCP-shaped.

**Why tagging isn't MCP too:** github-mcp-server's full tool list (95 tools, checked
exhaustively) has no tool to create a git tag or GitHub release — only read-only
`get_tag`/`list_tags`/`get_release_by_tag`. `GithubMcpProvider.tagReleaseBranch()` is an
isolated exception: it looks up the release branch's HEAD commit and creates the tag ref via
a plain authenticated REST call, using the same token.

**Setup:**

```bash
export RELEASE_OPERATOR_GITHUB_TOKEN=github_pat_...   # fine-grained PAT: Contents (RW), Pull requests (RW)
npm run cli -- github status                          # confirms the remote server is reachable
```

Optional: `RELEASE_OPERATOR_GITHUB_MCP_URL` to point at a different toolset URL or a GitHub
Enterprise remote server; `RELEASE_OPERATOR_GITHUB_ORG` as the default owner/org for any repo
that doesn't specify one (`--repos owner/name:branch` on `create` sets it per-repo).

If `RELEASE_OPERATOR_GITHUB_TOKEN` isn't set, the branch/PR/tag actions simply log
"skipped: GitHub integration not configured" and no-op — the rest of the pipeline is
unaffected either way (this is real automation *inside* an action, same best-effort semantics
as every other action: a failure here is logged loudly but never blocks or reverses the
already-persisted state transition).

## Usage

```bash
npm install
npm test              # run the full test suite (engine + workflow)
npm run cli -- --help # run the CLI via tsx (no build step needed)
```

By default the CLI stores state in `./release-operator.db` (SQLite) and loads the pipeline
from `./config/pipeline.yaml`. Override with `RELEASE_OPERATOR_DB=/path/to/file.db` and
`RELEASE_OPERATOR_WORKFLOW=/path/to/pipeline.yaml`.

```bash
# Create a release
npm run cli -- create 1.0.0 --repos web:main,api:main --env prod --by sam

# Drive it forward — `event` auto-advances through non-wait steps for you
npm run cli -- event <releaseId> BRANCHES_CREATED --by sam \
  --payload '{"branches":{"web":"release/1.0.0","api":"release/1.0.0"}}'
npm run cli -- event <releaseId> TICKET_CREATED --by sam --payload '{"ticketId":"PCM-123"}'
# ^ auto-advances to QA_APPROVAL_PENDING
npm run cli -- event <releaseId> QA_APPROVED --by qa-lead --payload '{"approvedBy":"qa-lead"}'
# ^ auto-advances to CAB_APPROVAL_PENDING
npm run cli -- event <releaseId> CAB_APPROVED --by cab-lead --payload '{"approvedBy":"cab-lead"}'
npm run cli -- event <releaseId> CI_STATUS_REPORTED --by ci-bot --payload '{"status":"green"}'
npm run cli -- event <releaseId> READY_CHECK_PASSED --by sam
# ^ auto-advances to DEPLOYING
# ...

# See which of the 12 steps a release is on right now
npm run cli -- status <releaseId>

# Inspect state and full history
npm run cli -- show <releaseId>
npm run cli -- history <releaseId>
npm run cli -- list
```

## Extending

- **Add a real integration**: edit the corresponding function in `src/actions.ts`
  (e.g. `sendQaApprovalMessage`) to call Slack/Jira instead of logging — see `GithubProvider`
  in `src/github/` for the pattern already used for GitHub.
- **Add a new guard**: add a function in `src/guards.ts` and register it in the
  `GUARDS` map under `"<FROM_STATE>:<EVENT_TYPE>"`.
- **Add a new state/event**: extend the union types in `src/types.ts`, add the legal
  transition(s) in `src/transitions.ts`, add any field-mapping logic for the new event's
  payload in `applyEventEffects` in `src/engine.ts`, and add a corresponding hop to
  `config/pipeline.yaml` (the loader will reject it at startup if it doesn't match a real
  transition).
- **Change the pipeline shape** (reorder/add/remove steps, change what auto-fires vs waits):
  edit `config/pipeline.yaml` only — no code changes needed as long as every `fromState`/
  `event`/`resultState` is a transition that already exists.
- **Add a new intelligence task**: add an input type to `src/intelligence/types.ts`, a prompt
  builder to `src/intelligence/prompts.ts`, a method to `IntelligenceProvider` and
  `LocalQwenProvider`, and a CLI command under the `intelligence` group in `src/cli.ts`. Keep
  it read-only with respect to `Release` — advisory tasks should never call `engine.transition()`.
