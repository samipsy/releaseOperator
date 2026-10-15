# release-operator

A state-machine driven engine for release orchestration: create branches, open a
release PR to main, cut a change ticket, get QA and CAB approval, deploy, run sanity
checks, backmerge, tag, and finalize — with every transition logged so you can answer
"what happened" after the fact. A declarative YAML pipeline config drives the whole
thing end to end, auto-advancing through automatic steps and stopping cleanly at real
wait points.

**New here?** See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, the
reasoning behind the layering, and where to look for each concern.

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
  (branch creation, backmerge PR, tagging), Jira (ticket create/comment via 3LO), and Slack
  (channel posts + QA/CAB thread ingest) are wired for real. Deploy/test are still stubbed.
- **Event log** (`src/store.ts`, SQLite `events` table) — every attempted transition is
  recorded, applied or rejected, with the reason. `releases.data` holds the current
  record as JSON for simplicity; `events` is the append-only source of truth for history.
- **Workflow config** (`config/pipeline.yaml`, `src/workflow/`) — a declarative description
  of the 13-step release pipeline as an ordered set of hops over the state machine above.
  Loaded and validated against the *real* transition table at startup (`src/workflow/loader.ts`),
  so a step referencing a state/event that doesn't exist in the code fails loudly rather than
  drifting silently. `WorkflowExecutor.advance()` (`src/workflow/executor.ts`) applies an
  incoming event and then auto-fires consecutive non-wait ("kickoff") steps until it hits a
  wait ("result") step or a terminal state.

## State machine

```
DRAFT -> BRANCH_CREATED -> RELEASE_PR_OPEN -> CHANGE_TICKET_CREATED -> QA_APPROVAL_PENDING -> QA_APPROVED
      -> CAB_APPROVAL_PENDING -> CAB_APPROVED -> CHANGE_APPLIED -> BACKMERGE_PENDING -> BACKMERGE_CREATED
      -> TAGGING_PENDING -> TAGGED -> COMPLETE
```

Side paths: `QA_REJECTED`/`CAB_REJECTED` send it back a step; `BLOCKED`/`UNBLOCKED` pause
and resume from any non-terminal state; `CANCELLED` and `ROLLBACK_REQUESTED` are
available from most in-flight states; `DEPLOY_FAILED`/`SANITY_FAILED` land in `FAILED`,
which can still be rolled back or cancelled. Independent retry paths
(`RELEASE_PR_FAILED`, `TICKET_UPDATE_FAILED`, `BACKMERGE_FAILED`, `TAGGING_FAILED`) each retry via
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
npm run mlx:serve   # starts mlx_lm.server on http://127.0.0.1:8081, downloads the model on first run
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

**Also wired into the pipeline itself** (`src/actions.ts`), not just the manual CLI commands:
entering `TICKET_CREATE_PENDING` (after release branches exist) compares each repo's
`releaseBranch` to `sourceBranch` (usually `main`) via GitHub, parses Jira keys from those
commit messages (regex plus the SLM), fetches each ticket's title and a short description from
Jira, and drafts the change-ticket body from that list. Entering `CHANGE_TICKET_CREATED` patches
each open release PR description with that PCM ticket key. Entering `FINALIZING` drafts release
notes. Both are printed to stderr during `event` for a human to review, with no effect on
`ReleaseState` (a failed or skipped draft never blocks the transition). Drafts are labeled
"SLM-drafted ... — VERIFY before use". If GitHub is not configured, ticket keys cannot be
discovered from commits. If the compare against main is empty (branch just cut from main),
the operator falls back to commits since the latest git tag.

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
export RELEASE_OPERATOR_GITHUB_ORG=ipsy
export RELEASE_OPERATOR_GITHUB_TOKEN=github_pat_...   # fine-grained PAT: Contents (RW), Pull requests (RW)
npm run cli -- github status                          # confirms the remote server is reachable
npm run cli -- github sync-repos                      # writes .github-repos.json name→URL table
npm run cli -- github repos                           # show the local catalog
npm run cli -- github repos add --from-dir ../my-clone  # test URL from a local clone (survives sync)
# or: github repos add --name experience-main --url https://github.com/myglam/experience/blob/main/app/package.json
```

Optional: `RELEASE_OPERATOR_GITHUB_MCP_URL` for a different MCP endpoint.
`create` takes only **release type** (`major` | `minor` | `patch`) and **repo name** (prompts
if omitted). Interactive create also asks for source (default develop) and target (default
main) unless you pass `--source` / `--target`. It looks up the repo in the local catalog, then always reads `package.json` from
GitHub Contents API (never from disk): `app/package.json` first, then root `package.json`
if that path 404s. `--source` is the branch to cut from (and read package.json); `--target`
is the branch the release PR merges into. Defaults: source `develop`, target `main`.
`--branch` is a deprecated alias for `--source`. Optional `--env` (default `prod`) and `--by`.
You can pin a nested file on the catalog with a blob URL:

```bash
npm run cli -- github repos add --name experience-main --url https://github.com/myglam/experience/blob/main/app/package.json
npm run cli -- create patch experience-main
```
Re-run `github sync-repos` when the org gains repos. Manual `github repos add` rows are kept
(same short name overrides the synced URL — useful for a workspace test clone).

If `RELEASE_OPERATOR_GITHUB_TOKEN` isn't set, the branch/PR/tag actions simply log
"skipped: GitHub integration not configured" and no-op — the rest of the pipeline is
unaffected either way (this is real automation *inside* an action, same best-effort semantics
as every other action: a failure here is logged loudly but never blocks or reverses the
already-persisted state transition).

## Jira integration (Atlassian 3LO)

Ticket create/comment run through `JiraProvider`. The default path is Atlassian **3LO**
(authorization-code OAuth) talking to Jira Cloud REST. Email + API token against Atlassian's
remote MCP server remains a fallback.

Atlassian only issues a **refresh token** if the authorize request includes `offline_access`
(this CLI always adds that scope). Access tokens last about an hour.

**Setup:**

Copy [`.env.example`](./.env.example) to `.env` (gitignored) and fill in the values. The CLI
loads `.env` on startup; variables already set in your shell win.

```bash
cp .env.example .env
# edit .env:
# RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID=...
# RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET=...
# RELEASE_OPERATOR_JIRA_SITE=https://your-site.atlassian.net
# RELEASE_OPERATOR_JIRA_PROJECT_KEY=PCM

# Callback URL registered in the Atlassian app (mlx_lm uses 8081, so 8080 is free):
#   http://localhost:8080/callback
npm run cli -- jira login
npm run cli -- jira status
```

`jira login` opens the consent screen, catches the callback, and writes access/refresh tokens
to `./.jira-oauth.json` (gitignored, mode 0600). Put the OAuth **app** id/secret in `.env`;
prefer the token store for the short-lived access token.

If you already have a short-lived access token in the environment:

```bash
export RELEASE_OPERATOR_JIRA_OAUTH_ACCESS_TOKEN=...
npm run cli -- jira login --import-env
```

That import cannot refresh; run a full `jira login` (with `offline_access`) for a refresh token.

Optional: `RELEASE_OPERATOR_JIRA_CLOUD_ID`, `RELEASE_OPERATOR_JIRA_OAUTH_REDIRECT_URI`,
`RELEASE_OPERATOR_JIRA_OAUTH_STORE`. Required Jira *create* fields (Epic, custom fields) belong
in `.env` as `RELEASE_OPERATOR_JIRA_PARENT_KEY` and optional `RELEASE_OPERATOR_JIRA_EXTRA_FIELDS`
JSON — ticket create is auto-fired after branches, so CLI flags would be easy to miss.
API-token fallback:
`RELEASE_OPERATOR_JIRA_EMAIL` + `RELEASE_OPERATOR_JIRA_TOKEN` + `RELEASE_OPERATOR_JIRA_SITE`.

## Slack integration

Posts use Slack's Web API (`chat.postMessage`), not incoming webhooks, so the same bot can
read QA/CAB reply threads (`conversations.replies`).

1. Create a Slack app with bot scopes `chat:write`, `channels:history` (or `groups:history`
   for private channels), and `users:read`.
2. Install it to the workspace and invite the bot to the channel.
3. Set `RELEASE_OPERATOR_SLACK_BOT_TOKEN`, plus channel ids:
   - `RELEASE_OPERATOR_SLACK_CHANNEL_PR_REVIEW` — release PRs and pre-prod sync PRs
   - `RELEASE_OPERATOR_SLACK_CHANNEL_PCM_APPROVAL` — PCM QA / CAB approve/reject

   **Find a channel id:** open the channel in Slack → channel name → *View channel details* →
   scroll to the bottom for `Channel ID` (`C…`). Invite the bot to both channels.

```bash
npm run cli -- slack ping
npm run watch:github                # GitHub PR reviews for pre-prod (every 60s)
npm run cli -- github watch --status
npm run cli -- slack ingest-approvals <releaseId>   # one-shot Slack read (QA/CAB only)
npm run cli -- netlify deploys landings
npm run cli -- preprod create landings
# develop → pre-prod-1 PR; Approve on GitHub; watch:github merges, rebuilds develop HEAD, watches pre-prod-1
```

`mlx:serve` is only the local Qwen HTTP inference process. `watch:github` polls **GitHub PR reviews** (Approve → merge) and **Netlify pre-prod-1 deploys** about once a minute. After merge it also **triggers a Netlify build of current `develop` HEAD** on the mapped US/MX sites (`POST /sites/{id}/builds?branch=develop` — not a retry of the last deploy SHA). `RETRY_PREPROD_DEPLOY` does not retrigger `develop` for a site whose HEAD build already succeeded in this sync. CLI commands do not block on Netlify. After merge it posts Slack that the PR is merged; after Netlify `pre-prod-1` is ready it posts that the build succeeded.

Manual `event QA_APPROVED --payload '{"approvedBy":"..."}'` still works.

## Usage

```bash
npm install
npm test              # run the full test suite (engine + workflow)
npm run cli -- --help # run the CLI via tsx (no build step needed)
```

By default the CLI loads `./.env` if present (does not override existing shell variables),
stores state in `./release-operator.db`, and reads `./config/pipeline.yaml`. Override with
`RELEASE_OPERATOR_ENV_FILE`, `RELEASE_OPERATOR_DB`, and `RELEASE_OPERATOR_WORKFLOW`.

```bash
# Create a release (prompts for major|minor|patch, then repo name)
npm run cli -- create
npm run cli -- create minor blog-microfrontend --source develop --target main
# TTY also asks planned start / planned end (PCM change window)

# Drive it forward — omit the release id to use the latest non-cancelled one.
# `--by` defaults to your login. Commands are actions (create_branch), not past-tense facts.
npm run cli -- event CREATE_BRANCH
npm run cli -- event create_ticket
npm run cli -- event <releaseId> CREATE_BRANCH \
  --payload '{"branches":{"web":"release/1.0.0","api":"release/1.0.0"}}'
# ^ cuts each release branch, then commits/pushes the version bump in app/package.json
#   (or package.json) onto that branch; opens the release PR; records the PR URL;
#   auto-advances through ticket create to QA_APPROVAL_PENDING (waits there for QA)
npm run cli -- event CREATE_TICKET
# ^ only needed if a ticket already exists in Jira but the release is still TICKET_CREATE_PENDING
#   (posts a Slack QA request if RELEASE_OPERATOR_SLACK_BOT_TOKEN + CHANNEL are set)
npm run watch:github
npm run cli -- github watch --status
# ^ prints running pid / startedAt if a watcher is already up; starting a second one exits
npm run cli -- slack ingest-approvals <releaseId>
# ^ one-shot read of the same thread
npm run cli -- event APPROVE_QA --payload '{"approvedBy":"qa-lead"}'
# ^ still valid if you are not ingesting from Slack
# ^ auto-advances to CAB_APPROVAL_PENDING
npm run cli -- event APPROVE_CAB --payload '{"approvedBy":"cab-lead"}'
npm run cli -- event CHANGE_APPLIED
# ^ skips deploy/sanity; auto-opens the backmerge PR (target → source, e.g. main → develop)
# ^ auto-advances to DEPLOYING
# ...

# See which of the 13 steps a release is on right now
npm run cli -- status <releaseId>

# Inspect state and full history
npm run cli -- show <releaseId>
npm run cli -- history <releaseId>
npm run cli -- list
npm run cli -- list --status DRAFT
npm run cli -- list --status DRAFT,CANCELLED
npm run cli -- cleanup --status CANCELLED
```

## Extending

- **Add a real integration**: add a provider (see `src/slack/` or `src/github/`) and wire it
  through `ActionDeps` in `src/actions.ts`. Keep tokens in env, never in committed files.
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
