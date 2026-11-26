# Client Mode

Client mode runs the Maestro desktop UI on one computer against a Maestro host on another (for
example a Linux VM): the window, menu, embedded browser and updater are local, and everything
else (projects, tasks, agents, terminals, files, settings, the database) is the host's. The two
sides talk over the **owner link**, a full-access tier of the host's
[remote access](remote-access.md) listener. User setup is in
[`docs/chorus/remote-rig.md`](../../docs/chorus/remote-rig.md).

```
client computer                                   host computer
Maestro --maestro-client                          Maestro (owner access on)
├ renderer (ordinary UI, ?maestroClient=1)        ├ /api/owner/pair, /api/owner/pairing-code
├ thin main: window, menu, browser, updater       ├ /owner/wire    session.* bridge.* desktop.*
└ host link ── WebSocket, V8 frames ────────────► │               (desktop.* filtered by routing)
  loopback proxy / mirrors ── one WS per TCP ───► └ /owner/tunnel  host 127.0.0.1 / ::1 only
```

## Launch Mode

`src/main/client/launch-mode.ts` decides the mode from `--maestro-client[=<profile>]` or, in
development builds only, `MAESTRO_CLIENT` (`1`/`true` or a profile slug); the switch wins. A packaged
build ignores the variable (the caller passes `app.isPackaged`), so a stray environment variable
never starts the installed app as a client. `src/entry/main.ts` reads it
before any bootstrap module loads and dynamically imports `@main/client/bootstrap` only in client
mode, so the local app never loads client code. Keep `launch-mode.ts` free of Electron and side
effects.

Each profile has its own user-data directory beside the local app's (`<base>-client` or
`<base>-client-<profile>`), its own Windows AppUserModelID, a window titled `Maestro Client`, and
telemetry off (`client-config.ts`).

## Thin Client Bootstrap

`src/main/client/bootstrap.ts` (`clientMain`) runs boot preflight (single instance per profile),
the app protocol, menu, desktop Wire gateway and window, then builds the host link. There is no
database, no runtime worker, no scheduler and no local recovery; `coupling.test.ts` boots it with
the database and worker host rigged to throw.

| File | Role |
| --- | --- |
| `host-link.ts` | One Wire connection over a reconnecting transport; each physical connection is a fresh `/owner/wire` socket that passed `session.attach`. Calls queue while down. Unrepairable refusals block instead of failing (`retryNow`, `takeOver` release them). Reloads the window when `hostBootId` or `brainEpoch` changes. |
| `client-controllers.ts` | The client's desktop Wire bundle, built from the routing table: `forward` domains become forwarders, `local`/`custom` domains get the client's own controllers. |
| `client-session-controller.ts` | The client-only `clientSession` domain (status live model, `pair`, `retryNow`, `takeOver`, `forget`, `relaunch`, `requestHostUpdate`, `createShortcut`). Deliberately not in `desktopDomainContracts`. |
| `connection-store.ts` | The one paired host in `<userData>/client-connection.json`; token and Cloudflare Access secret encrypted with `safeStorage`, nothing stored when encryption is unavailable. |
| `owner-pairing.ts` | Redeems an owner pairing code at `POST /api/owner/pair`. |
| `client-shutdown.ts` | Quit without confirmation (agents keep running on the host); closing the window quits. |
| `adapters/` | `custom` domains and bridges: app settings side effects, rule P attachment upload, host operations, notifications, external open, rule U updates, dev-perf stub. |
| `loopback/` | `localhost` means the host: a Chromium session proxy and a credentialed loopback proxy for the embedded browser, and idle-closing loopback mirrors for this computer's own browser (previews, OAuth callbacks), all over `/owner/tunnel`. |

Rule P (`adapters/attachments.ts`): `attachments.prepareLocalFiles` reads paths that exist on the
client and uploads them to the host; other paths are the host's and are forwarded. Rule U
(`adapters/updates.ts`): the client shares the local app's installation, so it refuses to
download or install while a local Maestro main process from the same executable runs.

## Routing Table

`src/core/manifests/shared/client-mode-routing.ts` (`clientModeRouting`) is the single source of
truth. Each desktop domain has a `host` side (`'all'`, `'none'`, or a list of endpoint paths the
host serves an owner) and a `client` side (`'forward'`, `'local'`, or `'custom'` through an
adapter in `src/main/client/`). The host uses it as an allowlist (`owner-desktop-filter.ts`
answers `NOT_FOUND` for anything else); the client builds its controller bundle from it.

**Every new desktop Wire domain must be classified here.** The table `satisfies
Record<DesktopDomain, ClientModeRoute>`, so an unclassified domain fails typecheck. Choose
`FORWARD` unless the domain touches the client computer's window, OS, or browser. Endpoint
additions show up in the `desktop wire surface` snapshot
(`__snapshots__/client-mode-routing.test.ts.snap`); update it with `-u` and review the diff.

Domains that are not plain `forward`:

| Domain | Route | Why |
| --- | --- | --- |
| `browser` | local | Webviews live in the client window. |
| `logging` | local | Renderer logs go to the client's log file. |
| `devPerf` | local | Stub with safe defaults. |
| `updates` | local | The client's own updater, under rule U. `localUpdates` is forwarded. |
| `host` | custom; host serves `persistDroppedBlob`, `getPlatform` | Window, shell, dialogs and clipboard are the client's; dropped blobs land where agents run. |
| `appSettings` | custom | Forwarded; theme, keyboard and browser changes also apply locally. |
| `terminals`, `conversations` | custom | Forwarded except rule P. |
| `voice` | custom | Forwarded except `openMicrophoneSettings`. |

`client-mode-routing.test.ts` also checks that both sides agree, that listed endpoints exist,
that `clientSession` stays out of the desktop contract, and the import boundaries below.

## Owner Link

Shared by both ends in `src/main/owner-link/`:

- `endpoints.ts`: `OWNER_PATHS` (`/api/owner/pair`, `/api/owner/pairing-code`, `/owner/wire`,
  `/owner/tunnel`) and dial options with the bearer token and Cloudflare Access headers.
- `v8-transport.ts`: one `v8.serialize`d Wire message per WebSocket message, so the desktop
  contract keeps its MessagePort structured-clone semantics (`Uint8Array`, `Date`, `Map`,
  `undefined`). Oversized or unserializable sends fail that call with `SERIALIZATION`; an
  oversized or undecodable receive closes the pipe. Frames are only decoded after the host's
  owner gate.
- `tunnel-protocol.ts`: `/owner/tunnel?port=&family=4|6`, raw bytes per binary message with TCP
  flow control kept end to end. The host answers `101` only once its loopback connection is open
  (`TUNNEL_STATUS`: 400 bad target, 403 the listener's own port, 409 not attached, 502
  unreachable, 503 over `MAX_CONCURRENT_TUNNELS`).
- `build-identity.ts`: see below.

`ownerHostWireContract` (`src/core/features/client-mode/api/owner-contract.ts`) mounts
`session` (`attach`, `ping`, `events`, `hostUpdateState`, `requestHostUpdate`), `bridge` (OS
notifications and external-open requests the client carries out), and `desktop`
(`desktopWireContract`, filtered by the routing table).

## Host Owner Tier

`src/main/host/remote-access/owner/`, created by `RemoteAccessService.attach`. It is inert until
owner access is turned on (`ownerAccess` in `remote-access.json`, off by default): routes answer
404, and the window, notification sink and external opener are touched only on attach.

| File | Role |
| --- | --- |
| `owner-access.ts` | Tier composition, settings operations, device and tunnel bookkeeping, `hostBootId`. |
| `owner-auth.ts` | Network rule: no `Origin`; with `tailscaleOnly` (default) only `tailscale serve` or direct loopback, optionally limited to `allowedLogins`. |
| `owner-upgrade.ts` | Gate for both owner sockets: no Origin, network rule, owner bearer token. 404 off, 403 network rule, 401 bad credential. |
| `owner-session.ts` | One controller per connection; nothing under `bridge.*`/`desktop.*` answers before `attach`. One attached owner across all devices (`busy`, or `takeover` sends `superseded`). Host-update verbs answer before attach. |
| `owner-desktop-filter.ts` | Maps `desktop.<domain>.<path>` to the host's desktop controller when host-served. |
| `owner-pairing-route.ts` | Owner-only pairing codes (never the ordinary ones). A headless host issues its first code through `POST /api/owner/pairing-code` over direct loopback with the token in `<userData>/owner-setup.token`. |
| `owner-bridge.ts` | Redirects OS banners and browser opens to the attached client; restored on detach. |
| `host-window-suspension.ts` | "The brain follows the client": the host window is destroyed while an owner is attached and restored 60 s after the last detaches, bumping `brainEpoch`. |
| `tunnel-endpoint.ts` | Loopback tunnels for the attached owner only, never to the listener's own port, closed on revoke, detach, or access change. |
| `electron-host-ports.ts` | Electron side of the tier, kept out so the rest tests without Electron. |

Owner devices (`kind: 'owner'`) pair only through the owner route and are refused on the ordinary
`/wire`. Treat this tier as security-sensitive: an owner credential reaches terminals and files.

## Build Identity

Client and host must run the same build. `resolveBuildIdentity` (`src/main/owner-link/`) reads
the commit from `<resources>/build-provenance.json` in packaged builds; dev runs have no commit.
`buildsCompatible` (`src/core/features/client-mode/api/build-identity.ts`) compares commits when
both know one, otherwise versions. A mismatch makes `session.attach` fail with `build-mismatch`
and blocks the link; the client can still call `requestHostUpdate` to bring the host forward
(see [unattended host updates](remote-access.md#unattended-host-updates)). Unpackaged runs may
set `MAESTRO_SKIP_BUILD_CHECK=1`.

## Renderer

The client main process loads the renderer with `?maestroClient=1`
(`core/primitives/client-mode/api/client-mode-search.ts`). `isClientMode()`
(`core/primitives/client-mode/browser/client-mode.ts`) reads it once; `useHostPlatform()` gives
the host's platform for decisions about where projects and terminals live. `renderer/main.tsx`
awaits `runClientGate` (pairing, connecting, blocked panels) before booting the UI, and
`App.tsx` mounts `ConnectionOverlay`. Features hide or swap client-irrelevant controls behind
`isClientMode()` (tray icon, open-in menus, local directory pickers, drop handling).

**Local mode stays inert.** Without the search parameter every client branch is off and the
local app behaves exactly as before. Boundary tests enforce it:

- `client-mode/browser/local-mode-guard.test.ts`: client-mode UI is imported only from
  `renderer/main.tsx` and `renderer/App.tsx`, every mount site (including the title bars'
  `ClientTitlebarStatus`) is guarded by `isClientMode()`, and nothing reads the client session at
  import time.
- `client-mode-routing.test.ts`: `src/main/client/` is imported only by `entry/main.ts`, and
  `primitives/client-mode/browser` only from renderer code.
- `entry/main.test.ts`: the client bootstrap never loads without the switch.

When adding a client-only branch, guard it with `isClientMode()` and keep the local path
unchanged; add a mount site to the guard test only when the feature UI must be imported elsewhere.

## Key Files

| Path | Role |
| --- | --- |
| `src/main/client/` | Thin client main process |
| `src/main/owner-link/` | Endpoints, V8 transport, tunnel protocol, build identity |
| `src/main/host/remote-access/owner/` | Host owner tier |
| `src/core/manifests/shared/client-mode-routing.ts` | Per-domain routing table |
| `src/core/features/client-mode/api/` | Owner and client-session contracts, build identity, host update schemas |
| `src/core/features/client-mode/browser/` | Gate, overlay, connection pill, session store |
| `src/core/primitives/client-mode/` | `isClientMode()`, host platform, title-bar slot |
| `src/core/features/remote-access/browser/components/owner-access-card.tsx` | Host-side owner access settings |
