# release-operator: Architecture

This document is for someone picking up this codebase cold. It explains what the system is,
why it's shaped the way it is, and where to look for each concern. Read this once, then use
`README.md` for day-to-day command reference.

## What this is

A release-orchestration tool built around one hard rule: **the release workflow is a
deterministic state machine, and nothing probabilistic (an LLM) or best-effort (an external
API call) is ever allowed to decide what state a release is in.** Everything else — real
GitHub operations, an AI writing text, Slack/Jira notifications — is bolted onto that core as
*side effects of* transitions, never as *inputs to* them.

The system automates a 13-step release pipeline: create branches → open a PR to merge the
release branch into main → cut a change ticket → QA approval → CAB approval → deploy → sanity
checks → update ticket → backmerge PR → tag repos → done. It's a local-first TypeScript CLI,
backed by SQLite, with real GitHub, Jira, Slack, and local-LLM integrations. Deploy and
sanity-test hooks are still stubbed.

## The four layers

```
                    ┌─────────────────────────────┐
                    │      TypeScript CLI          │  src/cli.ts
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │   WorkflowExecutor            │  src/workflow/
                    │   (declarative pipeline shape) │
                    └──────────────┬───────────────┘
                                   │ engine.transition()
                    ┌──────────────▼───────────────┐
                    │   ReleaseEngine (the core)    │  src/engine.ts, transitions.ts,
                    │   deterministic state machine │  guards.ts, store.ts, db.ts
                    └──────────────┬───────────────┘
                                   │ runActions() — fire-and-log side effects
                    ┌──────────────▼───────────────┐
                    │   actions.ts (ActionDeps DI)  │
                    └───┬────────────┬────────────┬─────┘
                        │            │            │            │
              ┌─────────▼────────┐ ┌─▼──────────┐ ┌─▼─────────────────┐ ┌─▼────────────┐
              │  GithubProvider  │ │JiraProvider│ │IntelligenceProvider│ │SlackProvider │
              │  src/github/     │ │ src/jira/  │ │ src/intelligence/  │ │ src/slack/    │
              │  MCP + REST      │ │ 3LO REST / │ │ HTTP → mlx_lm      │ │ Web API REST  │
              │                  │ │ MCP fallback│ │                    │ │              │
              └──────────────────┘ └────────────┘ └────────────────────┘ └──────────────┘
```

1. **CLI** (`src/cli.ts`) — commander-based, thin. Parses args, builds dependencies, calls the
   workflow/engine, prints JSON to stdout (everything else — logs, drafted text, auto-advance
   notices — goes to stderr, so stdout stays script-parseable).
2. **Workflow layer** (`src/workflow/`) — a declarative YAML description of *this specific*
   13-step pipeline, sitting on top of the generic engine. Auto-advances through steps that
   don't need a human, stops at the ones that do.
3. **Engine** (`src/engine.ts` + `transitions.ts` + `guards.ts` + `store.ts` + `db.ts`) — the
   actual state machine. This is the only layer that can change a release's state, and it's
   the only layer that's *not allowed* to know about GitHub, MCP, or LLMs.
4. **Actions + providers** (`src/actions.ts`, `src/github/`, `src/jira/`, `src/intelligence/`, `src/slack/`) — side
   effects. Dependency-injected into the engine, best-effort, never able to block or reverse a
   transition.

## Layer 1: the deterministic core

**Files:** `src/types.ts`, `src/transitions.ts`, `src/guards.ts`, `src/actions.ts`,
`src/engine.ts`, `src/store.ts`, `src/db.ts`, `src/errors.ts`

### Release record

One persistent record per release (`Release` in `types.ts`): id, version, `state`
(`ReleaseState`), repos (name/owner/branches/tag), environment, ticket, QA/CAB approvals, CI
status, deployment, sanity, backmerge, tagging, timestamps. It's stored as a JSON blob
(`releases.data` in SQLite) plus indexed columns for querying — see "Persistence" below.

### States and events

`ReleaseState` (29 values) and `ReleaseEventType` (37 values) are plain string union types in
`types.ts`. The pipeline's states, roughly in order:

```
DRAFT → BRANCH_CREATED → RELEASE_PR_OPEN → CHANGE_TICKET_CREATED → QA_APPROVAL_PENDING → QA_APPROVED
     → CAB_APPROVAL_PENDING → CAB_APPROVED → CHANGE_APPLIED → BACKMERGE_PENDING → BACKMERGE_CREATED
     → TAGGING_PENDING → TAGGED → COMPLETE
```

Side branches: `QA_REJECTED`/`CAB_REJECTED` send it back a step; `BLOCKED`/`UNBLOCKED` pause
and resume from any non-terminal state (`preBlockState` on the record remembers where to
resume); `CANCELLED`/`ROLLBACK_REQUESTED` are available from most in-flight states; the three
finalize sub-steps each have their own `*_FAILED` state and `RETRY_*` event, so retrying
tagging never redoes the backmerge PR, etc. `COMPLETE`/`ROLLED_BACK`/`CANCELLED` are terminal.

### Transitions (`transitions.ts`)

`TRANSITIONS: Partial<Record<ReleaseState, Partial<Record<ReleaseEventType, ReleaseState>>>>`
— a flat, explicit lookup table. If a `(state, event)` pair isn't in it, the event is illegal
from that state, full stop. No inheritance, no wildcards, no computed transitions (except one
sentinel, `RESUME_PREVIOUS`, used only for `BLOCKED:UNBLOCKED`). This is deliberately "boring":
anyone can read the whole ruleset in one file.

### Guards (`guards.ts`)

Preconditions checked *before* a transition is applied, keyed by `` `${state}:${event}` ``.
Most transitions have no guard (unconditionally legal). The important one:
`CAB_APPROVED:READY_CHECK_PASSED` checks branches exist, ticket exists, QA+CAB both
`"approved"`, CI is `"green"`, and all feature flags are known — the closest thing this system
has to a real go/no-go gate, and it's pure data inspection, no external calls.

### The transition function (`engine.ts`)

`ReleaseEngine.transition(releaseId, event)` is the *only* way state ever changes:

1. Load the release. If it's in a terminal state, reject + log + throw.
2. If the event is a **sidecar event** (currently just `CI_STATUS_REPORTED`), update the field
   and return — no state change, no guards, no actions. This exists so things like CI status
   can be reported at any time without needing a self-loop transition entry for every state.
3. Look up the legal target state. None → reject + log + throw (`IllegalTransitionError`).
4. Run guards. Fail → reject + log + throw (`GuardFailedError`).
5. Apply the event's payload to the record (`applyEventEffects` — one big switch statement;
   this is the only place that knows how a given event's JSON payload maps onto fields).
6. Persist the new state + append an event-log row (`outcome: "APPLIED"`).
7. Run actions registered for the *newly entered* state (best-effort — see Layer 2).

Every attempted event is logged, applied or rejected, with a reason — the `events` table is an
append-only audit trail, not just current-state tracking.

### Persistence (`store.ts`, `db.ts`)

SQLite, two tables:
- `releases` — one row per release, `data` column is the full JSON-serialized `Release`.
  Indexed columns (`state`, `version`, etc.) exist for cheap queries without deserializing.
- `events` — append-only. `seq, release_id, type, payload, actor, from_state, to_state,
  outcome, reason, created_at`.

Dates round-trip through a small reviver in `store.ts` keyed on known field names
(`createdAt`, `approvedAt`, etc.) — if you add a new `Date` field to `Release`, add its key
there or it'll deserialize as a string.

## Layer 2: actions and dependency injection

**File:** `src/actions.ts`

Actions are side effects that fire *after* a transition is already persisted — they cannot
undo it, and a thrown error inside one is caught and logged, never propagated. This is the
mechanism that keeps everything in Layer 3 (real integrations) from ever being able to
influence Layer 1 (the state machine): an action can fail completely and the release's state
is unaffected either way.

```ts
export interface ActionDeps {
  github?: GithubProvider;
  intelligence?: IntelligenceProvider;
  defaultGithubOrg?: string;
}

export function buildOnEnterRegistry(deps: ActionDeps = {}): Partial<Record<ReleaseState, Action[]>>
```

`ReleaseEngine`'s constructor takes `ActionDeps` and calls `buildOnEnterRegistry` once,
building a `ReleaseState → Action[]` map. This is the *only* dependency-injection point in the
whole system — `ActionDeps` is entirely optional (defaults to `{}`), so the engine works
standalone with zero external services (everything just logs a stub message).

Where the real integrations actually fire:

| State entered | Action | What it does |
|---|---|---|
| `BRANCH_CREATED` | `createReleaseBranchesAction` | Cut the release branch, then commit and push a package.json version bump (`app/package.json` first) onto that branch |
| `RELEASE_PR_PENDING` | `createReleasePrAction` | Open PR: release branch → targetBranch (default main); persist `repos[].releasePrUrl` so `RELEASE_PR_CREATED` auto-advances without a payload |
| `TICKET_CREATE_PENDING` | `createChangeTicketAction` | Create PCM Change with computed reason, Prod - US/MX, repo as systems impacted, PR in implementation plan, prompted change window, reporter/assignee = Jira login |
| `CHANGE_TICKET_CREATED` | `updateReleasePrsWithTicketAction` | Patch each release PR body with the PCM ticket key |
| `QA_APPROVAL_PENDING` | `requestApproval(qa)` | Post QA request to Slack; store `slackTs` on `approvals.qa` |
| `CAB_APPROVAL_PENDING` | `requestApproval(cab)` | Same for CAB |
| `BACKMERGE_PENDING` | `createBackmergePrAction` | Real GitHub PR creation |
| `TAGGING_PENDING` | `tagRepositories` | Still a stub — see "Why tagging is split across two states" below |
| `FINALIZING` | `updateTicketOnFinalize`, `generateReleaseNotesAction` | Real Jira comment + SLM release-notes draft |
| `TAGGED` | `tagRepositoriesOnGithubAction` | Real git tag creation (REST) |
| failure / complete / blocked | `notifySlack` | Channel post when Slack is configured |

**Why tagging is split across `TAGGING_PENDING` and `TAGGED`:** the action that fires on
entering `TAGGING_PENDING` runs *before* the operator has said what tag name to use (that
comes later, in the `REPOS_TAGGED` event's payload). So the real tagging call has to happen
one state later, on `TAGGED`, once `release.repos[].tag` is actually populated. This is a
general pattern worth remembering: **an action can only use data that's already on the record
by the time it fires** — check what event populated what field, and when, before wiring a real
call into an `ON_ENTER` hook.

**Why GitHub actions still ask the operator to manually confirm** (e.g.
`createBackmergePrAction` prints the real PR URL *and* the exact next CLI command to run,
rather than auto-firing `BACKMERGE_CREATED` itself): the state machine's shape assumes a human
reports results back in explicitly. Since the actions now do real work and get real answers
immediately, they *could* self-report — but that would mean actions calling
`engine.transition()`, which breaks the layering (side effects would become transition
triggers). Not done, deliberately. If you want to close that loop, it's a real design decision,
not a bug fix — see "Ideas for next steps."

## Layer 3: the workflow config (declarative pipeline shape)

**Files:** `config/pipeline.yaml`, `src/workflow/schema.ts`, `src/workflow/loader.ts`,
`src/workflow/executor.ts`

The engine only knows *rules* (what's legal). It has no concept of "the 13-step pipeline" as a
named sequence. That's what this layer adds: `config/pipeline.yaml` lists ~19 hops, each one
`{ id, step, name, fromState, event, resultState, wait, onFailure? }`.

- **`wait: false`** ("kickoff") — our own automation triggering something; the executor
  auto-fires it.
- **`wait: true`** ("result") — a real-world outcome only a human/external system can report;
  the executor stops and waits for an explicit CLI `event` call.

`loader.ts` validates every hop against the **real** `legalTarget()` from `transitions.ts` at
load time — a YAML step referencing a state/event that doesn't exist in code fails immediately
with a clear error, so the config and the engine can never silently drift apart.

`executor.ts`'s `WorkflowExecutor.advance(releaseId, event)` is what `cli.ts`'s `event` command
actually calls (not `engine.transition()` directly): it applies the given event, then loops —
find the hop whose `fromState` matches the new state; if it's a kickoff, fire it and repeat; if
it's a wait or there's no matching hop, stop. This is why firing one event can cascade through
several real state transitions and print `auto-advanced: X -> Y` for each.

Sidecar events (`CI_STATUS_REPORTED`) are special-cased in `advance()` to *never* trigger this
loop — reporting CI status is a passive fact update, not a "step done, continue" signal.

## Layer 4: real integrations

### GitHub (`src/github/`)

```
GithubProvider (interface)          ← actions.ts depends on this, not a concrete class
   └── GithubMcpProvider (impl)
          ├── createReleaseBranch()         → MCP tool "create_branch"
          ├── commitFile() / readFileMeta() → REST Contents GET+PUT (version bump on the release branch)
          ├── createBackmergePullRequest()  → MCP tool "create_pull_request"
          └── tagReleaseBranch()            → direct REST (see below)
```

**MCP connection** (`mcpClient.ts`): connects to **GitHub's own hosted remote MCP server**
(`https://api.githubcopilot.com/mcp/`) over `StreamableHTTPClientTransport` from
`@modelcontextprotocol/client`, authenticated with `Authorization: Bearer <PAT>`. There is
**no local server process** — this was a real design correction made mid-build; the first
version spawned a downloaded `github-mcp-server` binary over stdio, which turned out to be
unnecessary once we confirmed the hosted endpoint accepts plain PAT auth.

**Why tagging bypasses MCP:** the GitHub MCP server's full tool list (checked exhaustively —
95 tools) has no tool to create a git tag or GitHub release, only read-only
`get_tag`/`list_tags`/`get_release_by_tag`. `tagReleaseBranch()` is the one deliberate
exception: it looks up the release branch's HEAD commit via REST
(`GET /repos/{owner}/{repo}/branches/{branch}`), then creates the tag ref via REST
(`POST /repos/{owner}/{repo}/git/refs`), using the same token. If GitHub ever ships a
tag-creation MCP tool, this is the one method to swap.

**Testing pattern:** `GithubMcpProvider` takes an injected `McpToolCaller` (a two-method
duck-typed interface `{ callTool }` that the real `Client` satisfies structurally) and an
injected `fetchImpl`. Tests never touch the network or spawn anything — see `test/github.test.ts`.

**Repo catalog:** `github sync-repos` pages the org via MCP (`list_org_repositories`, then
`search_repositories`) and falls back to REST `GET /orgs/{org}/repos`. The result is a
gitignored `.github-repos.json` name→URL table. `github repos add --from-dir` / `--url` writes
`source: "manual"` rows (test clones) that are not wiped on the next sync. `create` takes bump
type + repo name, then always reads `package.json` from GitHub Contents REST (not the engine,
never the local filesystem). It tries `app/package.json` then root `package.json`.
Source branch defaults to `main` unless `--branch` is passed. Catalog lookup is local-file only.

### Jira (`src/jira/`)

```
JiraProvider (interface)            ← actions.ts depends on this, not a concrete class
   ├── JiraRestProvider             → Atlassian 3LO Bearer token
   │      createIssue / addComment  → POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...
   └── JiraMcpProvider (fallback)   → email + API token → mcp.atlassian.com
```

**Setup flow:** `jira login` starts a loopback HTTP server on the registered redirect URI
(default `http://localhost:8080/callback`; `mlx_lm.server` listens on 8081 via `npm run mlx:serve`),
opens the Atlassian authorize URL with
`offline_access` so a refresh token is issued, exchanges the code, resolves `cloudId` via
`/oauth/token/accessible-resources`, and writes tokens to `./.jira-oauth.json` (gitignored).
The engine never sees the token; `connectConfiguredJira()` injects a `JiraProvider` into
`ActionDeps`. User-supplied app credentials may live in a gitignored `.env`; `jira login`
still writes access/refresh tokens to `.jira-oauth.json`, not into `.env`.

**Why REST instead of MCP for 3LO:** Atlassian's hosted MCP path in this repo is verified for
Basic `email:api_token` auth. 3LO access tokens are the documented auth for
`api.atlassian.com/ex/jira/{cloudId}`. Same `JiraProvider` interface either way.

**Testing pattern:** `test/jira-oauth.test.ts` uses a fake `fetch`; `test/jira.test.ts` fakes MCP.

### Slack (`src/slack/`)

```
SlackProvider (interface)
   └── SlackRestProvider            → Bearer bot token
          postMessage               → POST https://slack.com/api/chat.postMessage
          listThreadReplies         → GET  https://slack.com/api/conversations.replies
          getUser / authTest        → users.info / auth.test
```

Entering `QA_APPROVAL_PENDING` / `CAB_APPROVAL_PENDING` posts to `RELEASE_OPERATOR_SLACK_CHANNEL`
and stores the thread. Pre-prod also posts a Slack notice, but **approval is GitHub PR reviews**
(`GET .../pulls/{n}/reviews`: `APPROVED` / `CHANGES_REQUESTED`). `github watch`
`github watch --status` reads `.github-watch.lock` and reports whether that pid is still
alive, so you do not start a second poller. A second `github watch` exits if one is running.
A verdict calls `WorkflowExecutor.advance`. After pre-prod merge it *posts* Slack thread replies
that the PR is merged and the build is progressing, then that the build succeeded.
`mlx_lm.server` is not involved. Actions never call `engine.transition()`.

Bot scopes: `chat:write`, `channels:history` or `groups:history`, `users:read`. The bot must
be invited to the channel (`not_in_channel` otherwise).

**Testing pattern:** `test/slack.test.ts` fakes `fetch`; `test/actions-slack.test.ts` uses a fake `SlackProvider`.

### Intelligence / local SLM (`src/intelligence/`)

```
IntelligenceProvider (interface)   ← purely advisory: every method returns text/string[]
   └── LocalQwenProvider (impl)
          → HTTP POST /v1/chat/completions
          → mlx_lm.server (separate OS process, started with `npm run mlx:serve`)
          → mlx-community/Qwen3-4B-Instruct-2507-4bit (4-bit, ~2.26GB, Apache-2.0)
```

**The hard boundary:** nothing in `engine.ts`, `guards.ts`, or `transitions.ts` imports from
`src/intelligence/` at all. It cannot participate in a transition decision even by accident —
this isn't enforced by a runtime check, it's enforced by the module dependency graph. If you
ever find yourself importing `IntelligenceProvider` into `guards.ts`, stop — that's the one
thing this system is built to prevent.

**Seven tasks** (`IntelligenceProvider` interface): ticket-key extraction from commit messages,
ticket description, commit/PR summary, release notes, affected components, suggested sanity
tests, failure summary. Each has a CLI command under `intelligence <task>` for ad-hoc use
except `extractTicketKeys`, which runs automatically when the change ticket is created.
`generateTicketDescription` and `generateReleaseNotes` are also wired into actions (see Layer 2).

**Anti-hallucination guardrail:** with no real change context, the 4B model confabulates
plausible specifics. Ticket create now passes commit compare + Jira titles into the prompt.
The prompts still instruct the model not to invent tickets or metrics, and output is labeled
"SLM-drafted ... — VERIFY before use". Treat this as a mitigation, not a guarantee.

**Testing pattern:** `LocalQwenProvider` takes an injected `fetchImpl`. Tests cover request
shape, timeout/connection-failure error messages, non-OK HTTP handling, and the JSON-array
parsing with a bullet-list fallback (a small model won't always return strict JSON when asked).

## Configuration reference

All env vars are optional; the tool works with zero configuration (SQLite file in cwd, no
GitHub, no SLM — everything logs stubs). The CLI loads `./.env` on startup via `src/env.ts`
(missing file is ignored; existing `process.env` values are not overwritten).

| Variable | Default | Used by |
|---|---|---|
| `RELEASE_OPERATOR_ENV_FILE` | `./.env` | Optional dotenv file loaded by the CLI |
| `RELEASE_OPERATOR_DB` | `./release-operator.db` | SQLite file location |
| `RELEASE_OPERATOR_WORKFLOW` | `./config/pipeline.yaml` | Pipeline config path |
| `RELEASE_OPERATOR_GITHUB_TOKEN` | *(unset = GitHub actions no-op)* | GitHub PAT, sent as `Authorization: Bearer` |
| `RELEASE_OPERATOR_GITHUB_MCP_URL` | `https://api.githubcopilot.com/mcp/` | Override for GH Enterprise/different toolset |
| `RELEASE_OPERATOR_GITHUB_ORG` | *(none)* | Org for `github sync-repos` and default owner |
| `RELEASE_OPERATOR_GITHUB_REPO_CATALOG` | `./.github-repos.json` | Local name→URL table |
| `RELEASE_OPERATOR_MLX_URL` | `http://127.0.0.1:8081` | MLX-LM server address |
| `RELEASE_OPERATOR_MLX_MODEL` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | Model name sent in requests |
| `RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID` | *(unset)* | Atlassian 3LO app client id |
| `RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET` | *(unset)* | Atlassian 3LO app secret (env only, never committed) |
| `RELEASE_OPERATOR_JIRA_OAUTH_REDIRECT_URI` | `http://localhost:8080/callback` | Must match the Atlassian app callback |
| `RELEASE_OPERATOR_JIRA_OAUTH_STORE` | `./.jira-oauth.json` | Gitignored token file |
| `RELEASE_OPERATOR_JIRA_SITE` | *(unset)* | Jira Cloud site URL, used to pick cloudId |
| `RELEASE_OPERATOR_JIRA_CLOUD_ID` | *(unset)* | Override cloudId if accessible-resources is ambiguous |
| `RELEASE_OPERATOR_JIRA_PROJECT_KEY` | *(unset = create ticket no-ops)* | Jira project for change tickets |
| `RELEASE_OPERATOR_JIRA_ISSUE_TYPE` | `Task` | Issue type name |
| `RELEASE_OPERATOR_JIRA_PARENT_KEY` | *(unset)* | Parent Epic key (`parent` on create) |
| `RELEASE_OPERATOR_JIRA_EXTRA_FIELDS` | `{}` | JSON object merged into Jira `fields` |
| `RELEASE_OPERATOR_JIRA_EMAIL` / `RELEASE_OPERATOR_JIRA_TOKEN` | *(unset)* | API-token MCP fallback |
| `RELEASE_OPERATOR_SLACK_BOT_TOKEN` | *(unset = Slack actions no-op)* | Slack bot token (`xoxb-…`) |
| `RELEASE_OPERATOR_SLACK_CHANNEL` | *(unset = posts skipped)* | Channel id `C…` or `#name` |

## CLI command map (`src/cli.ts`)

| Command | Touches state? | Notes |
|---|---|---|
| `create [major\|minor\|patch] [repo]` | Creates in `DRAFT` | Version from repo `package.json`; prompts if args omitted |
| `event <id> <type>` | Yes — the only state-changing command | Goes through `WorkflowExecutor.advance()`, auto-advances |
| `show <id>` | No | Dumps the current record |
| `status <id>` | No | Which of the 12 steps it's on (`workflow.describeStatus`) |
| `history <id>` | No | Full event log |
| `list` | No | All releases; `--status DRAFT,CANCELLED` to filter |
| `github status` | No | Checks MCP connectivity |
| `github sync-repos` / `github repos` | No | Org catalog for `--repos` validation |
| `github repos add` / `remove` | No | Manual test URLs that survive sync |
| `jira login` / `jira logout` | No | 3LO setup; tokens go to `.jira-oauth.json` |
| `jira status` | No | Checks 3LO REST or API-token MCP |
| `slack ping` | No | Checks bot token via `auth.test` |
| `slack ingest-approvals <id>` | Yes — fires QA/CAB approve/reject if the thread says so | One-shot Slack `conversations.replies` |
| `github watch [id]` | Yes — GitHub PR reviews for pre-prod, then merge | Default 60s; `npm run watch:github` |
| `github watch --status` | No | Whether a watcher pid is already running |
| `intelligence status` | No | Checks MLX-LM connectivity |
| `intelligence <task> ...` | No | Manual invocation of any of the six advisory tasks |

## Testing strategy

68 tests, 10 files, all offline (no network, no subprocess, no real MLX/GitHub/Jira calls in CI):

- `test/engine.test.ts` — the core state machine, in-memory SQLite (`openDb(":memory:")`).
- `test/workflow.test.ts` — loader validation, auto-advance chaining, wait-point stopping,
  independent retry for the three finalize sub-steps, sidecar-event isolation.
- `test/github.test.ts` — `GithubMcpProvider` with a fake `McpToolCaller` + fake `fetch`.
- `test/github-catalog.test.ts` — org repo listing/parsing and `--repos` catalog validation.
- `test/jira.test.ts` — `JiraMcpProvider` with a fake `McpToolCaller`.
- `test/jira-oauth.test.ts` — 3LO authorize URL, token exchange/refresh, REST provider, token store.
- `test/slack.test.ts` — `SlackRestProvider` with fake `fetch`; thread approve/reject parsing.
- `test/actions-slack.test.ts` — QA Slack post + skip when Slack is unset.
- `test/actions-github.test.ts`, `test/actions-intelligence.test.ts` — integration-level:
  real `ReleaseEngine` + real `WorkflowExecutor`, fake provider injected via `ActionDeps`,
  asserting the *engine* actually calls the provider at the right point with the right
  arguments — not just that the provider class works in isolation.

Everything claimed in this document that involves an external system (the model ID, the MCP
tool schemas, the GitHub API version, the remote MCP server's auth mode) was verified against
live sources or a real running instance during development, not assumed — see git history /
conversation log for the verification trail if something looks off.

## Ideas for next steps

Roughly in order of value-to-effort, as of this writing:

1. **Deploy/sanity integration** — depends entirely on what IPSY actually deploys with
   (Kubernetes/ArgoCD/Spinnaker/etc.); needs that decision before it can be verified the way
   GitHub and MLX-LM were.
2. **Auto-advance from `create`** — currently `create` only puts a release in `DRAFT`; the
   first real step (`CREATE_BRANCH` → `BRANCHES_CREATED`) still needs an explicit `event` call even though it's
   a kickoff. Wiring `create` through `WorkflowExecutor.advance()` would close that gap; not
   done originally to keep `create`'s contract simple.
3. **Let actions self-report results** — the design tension noted in Layer 2: GitHub actions
   now get real, immediate answers (a real PR URL) but still ask a human to copy that into a
   follow-up CLI command. Closing this loop means letting an action call
   `engine.transition()`, which is a real architectural change (actions currently cannot do
   this), not a quick fix.
4. **Wire real commit/PR data into `summarizeChanges`/`affected-components`/`suggest-tests`** —
   these tasks currently require hand-crafted JSON input because no GitHub commit-fetching is
   wired in yet. Once it is, the "no context, don't invent" guardrail becomes less necessary
   for these specific tasks.
5. **CI for this repo itself** — no GitHub Actions workflow runs `npm test` on PRs yet.
