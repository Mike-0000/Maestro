# Cloud Agents: On-Demand Runs Over HTTP

A workspace server can start an agent from an HTTP request, wait for it to finish, and hand the
result off as a pull request. This is how a "Request a feature" button in another app becomes a
reviewed change: nothing merges automatically.

```
our API ── HTTPS ──► Cloudflare Access ── tunnel ──► trigger gateway (127.0.0.1:7461)
                                                          │ Wire, Unix socket
                                                     workspace server daemon
                                                          └ automations runtime
                                                              queue → worktree + branch
                                                              → agent session → push → PR
```

Three processes run on the host: the daemon (`serve`), the gateway (`trigger-gateway`), and
`cloudflared`. The gateway is a subcommand of the same binary as the daemon.

## Running It From the Desktop App Instead

A Maestro desktop app can serve this same API from its own listener, with no daemon, gateway
process, or Linux host. Turn on Settings → Remote access, generate a token under **Request
triggers**, and map a trigger name to an on-demand automation of a local project. Requests then
go to `<the app's address>/v1/requests` with the same bodies and responses as below, and runs
appear in the app as tasks. The app must be open for requests to be accepted and for agents to
run. See [remote access](../../../agents/architecture/remote-access.md).

The rest of this page describes the daemon-hosted setup.

## How a Request Becomes a Pull Request

1. The caller sends `POST /v1/requests` with a `requestId` it generated.
2. The gateway maps the `trigger` name to an automation id from its config file and calls
   `automations.startRun` with the request attached.
3. The run takes the request id as its run id, so repeating a request returns the same run.
4. The scheduler queues the run. When the automation has a free slot it creates a worktree and a
   branch named `req-<title-slug>-<first 8 of the id>`.
5. The agent starts with the automation's prompt followed by the request text.
6. The run is marked `done` once the session exists, so the desktop adopts it as a task like any
   other automation run. Progress after that is recorded in the run's `delivery` field while the
   run keeps its worker slot.
7. When the agent settles, the daemon commits anything left uncommitted, pushes the branch, and
   runs `gh pr create`.

| Agent outcome | Result |
| --- | --- |
| Turn ended normally, branch has commits | Ready pull request (`pr_open`) |
| Timeout, abnormal stop, or exit, branch has commits | Draft pull request (`pr_draft`) |
| Turn ended normally, no commits | `no_changes`, no pull request |
| Anything else without commits, or push or `gh` failed twice | `failed` |

The daemon never force-pushes, never pushes the base branch, and never merges.

## HTTP API

Every route requires `Authorization: Bearer <MAESTRO_TRIGGER_TOKEN>`.

| Route | Purpose | Responses |
| --- | --- | --- |
| `POST /v1/requests` | Queue a request | `202` new, `200` repeated id, `400`, `401`, `404`, `409`, `413`, `429`, `503` |
| `GET /v1/requests/:requestId` | Status of one request | `200`, `404`, `503` |
| `POST /v1/requests/:requestId/cancel` | Cancel a queued or running request | `200`, `404`, `409` finished |
| `GET /healthz` | Gateway up and daemon reachable | `200`, `503` |

Submit body:

```json
{
  "requestId": "0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f",
  "trigger": "maestro-feature",
  "title": "Add CSV export to the runs list",
  "body": "Free-text description from the form",
  "requester": { "id": "u_123", "name": "Sam" },
  "source": { "app": "admin", "url": "https://example.com/requests/123" }
}
```

`requestId` must be a UUID. `title` is 1 to 200 characters, `body` up to 32,768, and the whole
payload up to 64 KB. `requester` and `source` are optional.

Status body, returned by all three request routes:

```json
{
  "requestId": "0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f",
  "runId": "0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f",
  "status": "pr_open",
  "branch": "req-add-csv-export-to-the-runs-list-0f3c9a52",
  "pullRequestUrl": "https://github.com/acme/app/pull/42",
  "error": null,
  "startedAt": 1790000000000,
  "finishedAt": 1790000900000
}
```

`status` is one of `queued`, `provisioning`, `agent_running`, `publishing`, `pr_open`, `pr_draft`,
`no_changes`, `failed`, `cancelled`. The last five are final. There are no callbacks: poll the
status route.

Errors are `{ "error": "<code>", "message": "<optional detail>" }`. `429 queue_full` means the
trigger already has `maxQueued` requests waiting; retry later with the same `requestId`.

Example:

```bash
curl -sS https://agents.example.com/v1/requests \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $MAESTRO_TRIGGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"'"$(uuidgen)"'","trigger":"maestro-feature","title":"Add a /version endpoint","body":"Return the package version as JSON, with a test."}'
```

## Host Setup (Linux)

Files referenced here are in `apps/workspace-server/deploy/linux/`.

1. Create the agent user. Agents run without permission prompts, so this account is the isolation
   boundary. Do not use root: Claude Code refuses to skip permissions as root.

   ```bash
   sudo useradd --create-home --shell /bin/bash maestro
   ```

2. As `maestro`, install and sign in to the tools the agent uses:

   ```bash
   claude auth login          # Claude Code, with the subscription that pays for the runs
   gh auth login              # the GitHub account that will author the pull requests
   git config --global user.name  "Maestro Agent"
   git config --global user.email "agent@example.com"
   gh auth setup-git
   ```

   Clone each target repository under `/home/maestro`.

3. Build and install the workspace server from this repository. Linux artifacts are built with
   Docker Buildx on any Docker host (see `packaging.md`):

   ```bash
   cd apps/workspace-server
   pnpm run package --target linux-x64 --verify
   ```

   Copy `dist-artifacts/` and `install.sh` to the host. The installer downloads over HTTP, so
   serve the directory locally for the one command. It expects `<base-url>/<version>/<archive>`:

   ```bash
   mkdir -p /tmp/ws/<version> && mv emdash-workspace-server-* /tmp/ws/<version>/
   (cd /tmp/ws && python3 -m http.server 8799 --bind 127.0.0.1) &
   sh install.sh --base-url http://127.0.0.1:8799 --version <version>
   kill %1
   ```

   This installs to `~/.emdash/workspace-server/versions/<version>` and points `current` at it,
   the same layout the desktop manages. The desktop leaves a running, compatible daemon alone.
   Do not accept a workspace-server update prompt for this host from a desktop build that is
   older than this change: it would install a daemon without the delivery code.

4. Install the daemon unit and start it:

   ```bash
   sudo cp maestro-workspace-server.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now maestro-workspace-server
   ```

5. In the Maestro desktop app, add the host over SSH as `maestro`, add each repository as a
   project, and create one automation per repository:

   - turn **On demand** on;
   - choose Claude Code and write the standing instructions (below) as the prompt;
   - under Workspace Settings choose a new worktree with a new branch from the base branch.

   Open the automation's settings and copy the automation id shown under **Trigger**.

6. Configure and start the gateway:

   ```bash
   sudo mkdir -p /etc/maestro
   sudo cp triggers.example.json /etc/maestro/triggers.json      # paste the automation id
   sudo sh -c 'echo "MAESTRO_TRIGGER_TOKEN=$(openssl rand -hex 32)" > /etc/maestro/trigger-gateway.env'
   sudo chmod 600 /etc/maestro/trigger-gateway.env
   sudo cp maestro-trigger-gateway.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now maestro-trigger-gateway
   curl -H "Authorization: Bearer <token>" http://127.0.0.1:7461/healthz
   ```

7. Set up the tunnel from `cloudflared-config.example.yml`, then run
   `sudo cloudflared service install`.

8. In Cloudflare Zero Trust, add a self-hosted Access application for the hostname with one
   policy: action **Service Auth**, include the service token created for our API. Without that
   policy the hostname is public.

9. On GitHub, protect the base branch and require a review, so the host's token cannot merge its
   own pull requests.

### Suggested standing instructions

```text
You are completing one feature request in this repository without supervision.
- Implement the request completely. No placeholders or TODOs.
- Nobody can answer questions. Make reasonable decisions and list your assumptions in the
  body of your final commit.
- Follow the repository's conventions and its AGENTS.md or CLAUDE.md.
- Run the focused checks for the code you changed and fix what fails.
- Commit your work with Conventional Commit messages.
- Do not push, do not open a pull request, and do not touch other branches. That is done for you.
```

## Configuration Reference

Gateway environment:

| Variable | Meaning |
| --- | --- |
| `MAESTRO_TRIGGER_TOKEN` | Bearer token, at least 32 characters. Required. |
| `MAESTRO_TRIGGER_CONFIG` | Path to the trigger config file. Required. |

Trigger config file:

| Field | Default | Meaning |
| --- | --- | --- |
| `listen.host` | `127.0.0.1` | Keep on loopback; only `cloudflared` should reach it. |
| `listen.port` | `7461` | |
| `maxQueued` | `20` | Waiting requests per trigger before `429`. |
| `triggers.<name>.automationId` | | The on-demand automation a trigger starts. |

The file is the allowlist. A caller can only name a trigger listed here, and never supplies a
path, a branch, or an automation id.

Per automation, deployed by the desktop when **On demand** is on. The desktop has no inputs for
these yet; they are the `onDemand.maxConcurrentRuns` and `onDemand.timeoutMinutes` fields of the
automation's stored trigger config:

| Setting | Default | Meaning |
| --- | --- | --- |
| Concurrent runs | 2 | Further requests wait in the queue. |
| Timeout | 60 minutes | Wall-clock budget for the agent before it is stopped. |

The daemon also caps all automations together at 4 concurrent runs.

## Operations

- Logs: `journalctl -u maestro-workspace-server` and `journalctl -u maestro-trigger-gateway`.
  The gateway writes one JSON line per request with the request id, run id, and status.
- Transcripts: open the run in the Maestro desktop app. Every run is a task with the full
  conversation, and the worktree stays in place so a reviewer can continue it.
- Cleanup: delete the task in Maestro once its pull request is merged or closed. Worktrees are
  not removed automatically.
- A daemon restart during a run marks its delivery `failed` with `interrupted_by_restart`. The
  branch and worktree are kept. Submit a new request to try again; runs are never retried
  automatically, so a request cannot produce two pull requests.
- Claude usage limits are shared with interactive use of the same subscription. A run that hits
  the limit ends as a draft pull request or `failed`.

## Security Notes

- Two independent credentials guard the entry point: the Cloudflare Access service token at the
  edge and the bearer token at the origin. The host needs no open inbound port.
- Our API must authenticate the person pressing the button. Request text is treated as trusted
  staff input: it reaches the agent as prompt content and the agent runs without permission
  prompts. Do not expose a trigger to untrusted users without adding review before the run and
  stronger isolation than a shared user account.
- Request text never reaches a shell, a path, or a ref. The branch name is a sanitized slug, and
  `git` and `gh` receive arguments as an array.
- The bearer token lives only in the gateway's environment file, so agents cannot read it from
  their own environment.
- Scope the `gh` token to contents and pull requests on the target repositories.
- Leftover changes are committed with `git add --all`, so anything in the worktree that is not
  gitignored ends up in the pull request. Keep secrets such as `.env` files gitignored,
  especially ones copied in by the project's preserve patterns.

## Not Included

Containers per run, callbacks, automatic retries, responding to review comments, automatic
worktree cleanup, and a published Linux release channel for this fork.
