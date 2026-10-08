# Remote Access

Remote access lets other devices reach a running Maestro app: another computer's Maestro adds it
as a machine, and a phone or any browser opens a small web app to watch and steer its agents.
Agents run in the app's own workers on that computer. Nothing is started over SSH and no
workspace-server daemon is involved, so a conversation started from elsewhere is an ordinary
task in the host's window, already running when it is clicked.

```
phone browser ──┐
                ├─ HTTPS (Tailscale serve, or cloudflared) ─► 127.0.0.1:7462  Maestro main process
other Maestro ──┘                                               ├ /api/*   pairing, session
                                                                ├ /wire    Wire over WebSocket
                                                                ├ /v1/*    on-demand agent API
                                                                └ /*       web app (out/remote-web)
```

The app must be open and signed in for any of this to work. Quitting it, including for an
update, ends the agents it hosts.

## Listener

`src/main/host/remote-access/` owns one `node:http` server, off by default, started by
`remoteAccessService.attach` from the gateway boot phase.

- It binds `127.0.0.1` and speaks plain HTTP. TLS and reachability come from whatever fronts it:
  `tailscale serve` on a tailnet, or a Cloudflare tunnel. A phone needs an HTTPS origin to
  install the web app, which both provide.
- Settings and the paired-device list live in `<userData>/remote-access.json`
  (`device-store.ts`). Device and trigger tokens are stored only as SHA-256 digests.
- `GET /api/info` identifies the host. `POST /api/pair` exchanges a one-time code for a device
  credential. `GET /api/session` and `POST /api/signout` serve the web app.
- `GET /wire` upgrades to a WebSocket carrying Wire (`@emdash/wire/node`, the same framing as the
  socket and stdio transports).

### Pairing and credentials

A device pairs with an 8-character code shown under Settings → Remote access (`pairing.ts`): one
code is live at a time, it is single-use, it expires after ten minutes, and ten wrong attempts in
five minutes stop the listener answering pair requests. The counter is global because every
caller behind a tunnel arrives from loopback.

| Device kind | Credential | Served contract |
| --- | --- | --- |
| `desktop` (another Maestro) | `Authorization: Bearer <deviceId>.<token>` | `maestroHostWireContract`: every workspace runtime plus remote control |
| `browser` | HttpOnly, `SameSite=Strict` cookie; the page never sees the token | `remoteDeviceWireContract`: remote control only |

A cookie-authenticated upgrade or POST must carry an `Origin` matching the request's `Host`.
Revoking a device drops its live connections.

Do not widen what a `browser` device is served without review: a browser session is the most
exposed credential in the system, and the workspace runtimes include terminals and file access.

### Cloudflare Access

When the listener is published through a Cloudflare tunnel, put an Access application in front
with two policies: **Service Auth** for Maestro clients and an identity policy (your own email)
for browsers. A Maestro client stores the service token on its host entry and sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request. A browser cannot send those
headers; Access signs it in with a cookie instead. The device credential is still required
behind either policy.

## What a paired Maestro is served

`host-controller.ts` builds `maestroHostWireContract`: `health`, `initialize`, every entry of
`hostRuntimesDefinitions`, `portForwards`, and `remote`. Paths match `workspaceWireContract`
exactly, and each runtime is forwarded to the app's own worker client
(`DesktopRuntimeClients`), so a client reaches this computer with the code it uses for a daemon.
The protocol version and negotiation are the workspace server's.

## Remote control

`remoteControlContract` (`packages/core/src/services/remote-control/api/`) is the host's own view
of its work, mounted at `remote.*`:

- `overview`: every project and every task-linked agent, with live status, kept current from
  app-db pokes and the TUI agent-status bridge.
- `startAgent`, `openAgent`: create a task with one agent in the project directory, or make
  sure an existing agent's session is live.
- `output`, `sendInput`, `resize`: a terminal agent's retained output log and its input.
- `adoptConversation`: gives a conversation another Maestro started on this host a task in the
  host's own project.

`remote-control.ts` implements these through the same verbs the window uses (an in-process
client of the desktop Wire contract), so remote actions take the code paths local ones do.

Task membership is client-local (see [state ownership](state-ownership.md)): the Maestro that
starts a conversation on this host links it to a task in its own database only. It therefore
calls `remote.adoptConversation` after creating one, and the host creates its own task on the
workspace the conversation runs in. Adoption is idempotent per conversation and waits briefly
for the conversation and its worktree to reach the host's mirrors.

### Voice

The conductor (grammar, routing, tools) runs in the host's window, against its canvas and task
stores. A paired device is its remote microphone, speaker, and heads-up display
(`remote.voice.*`, `remote-voice.ts`):

- The window publishes the conductor's display through `remoteAccess.publishConductorState`
  (`conductor/browser/remote-voice-bridge.ts`); devices read it as `voice.state`.
- A device's words reach the window as `remoteAccess.conductorCommands` events and run through
  `handleUtterance` as typed input, so the reply is shown, not spoken, on the host, and the
  device voices it. "Yes" and "no" take the same path, so countdowns, confirmations, and plan
  approval are the conductor's own.
- Transcription and synthesis use the host's voice service; no key reaches a device. Partial
  transcripts and synthesized audio are forwarded only for streams and requests a device opened.
  When the host's spoken output is the system voice, devices use their own speech synthesis.

Voice needs the window to exist: with the app running but no window loaded, `voice.state`
reports `available: false`.

## Client side: Maestro hosts

A machine whose connection metadata has `transport: 'maestro'` is reached without SSH. Its
host service dials the WebSocket, runs the usual `initialize` handshake, and health-checks over
Wire; there is nothing to install, probe, or update on the other side. SSH-only features
(preview port forwarding, workspace-server management) are unavailable for these machines.

## Web app

`src/remote-web/` is a standalone Vite build (`remote-web.vite.config.ts`) emitted to
`out/remote-web` and served by the listener. It talks only to `remote.*` over
`webSocketTransport`. `pnpm run build` builds it; `pnpm run dev:remote-web` serves it with a
proxy to a running listener.

## On-demand agent API

The trigger routes from [cloud agents](../../apps/workspace-server/docs/cloud-agents.md)
(`POST /v1/requests`, status, cancel, `/healthz`) are mounted on the same listener by
`trigger-route.ts` and answered by the app's own automations runtime, which now delivers pull
requests itself. They use a separate bearer token and a trigger-name allowlist, both set under
Settings → Remote access, and do not exist until a token has been generated. The handler
and status mapping are shared with the daemon from
`packages/core/src/runtimes/automations/node/trigger/`, and delivery from
`packages/core/src/services/runtime-broker/node/automation-delivery/`.

## Key Files

| Path | Role |
| --- | --- |
| `packages/wire/src/node/websocket.ts` | RFC 6455 server accept and client dial, as Wire transports |
| `packages/wire/src/api/transports/websocket.ts` | Wire over a WHATWG `WebSocket` (browser side) |
| `packages/core/src/services/remote-control/api/` | Remote-control contract and schemas |
| `src/main/host/remote-access/remote-access-service.ts` | Lifecycle, settings operations, session bookkeeping |
| `src/main/host/remote-access/http-server.ts` | Routes, auth, origin checks, static serving, upgrade |
| `src/main/host/remote-access/host-controller.ts` | Contracts served to desktop and browser devices |
| `src/main/host/remote-access/remote-control.ts` | Remote-control implementation |
| `src/main/host/remote-access/remote-voice.ts` | Voice relay between devices, the voice service, and the window |
| `src/core/features/conductor/browser/remote-voice-bridge.ts` | Publishes the conductor's display and runs device commands in the window |
| `src/main/host/remote-access/trigger-route.ts` | On-demand agent API on the listener |
| `src/core/features/remote-access/` | Settings contract, controller, and page |
| `src/remote-web/` | The web app |
