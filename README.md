# Chorus

Chorus is a local-first desktop app for running AI coding agents in parallel. Each task can
run in its own Git worktree; a canvas and voice-driven conductor help coordinate agents.
It is based on [Emdash](https://github.com/generalaction/emdash) and retains its Apache-2.0
license and attribution in [NOTICE](NOTICE).

This is an independent Chorus checkout, not the Emdash project or its download channel.
There is no Chorus GitHub remote or public release link configured yet. Do not use Emdash
installers or upstream documentation as if they were Chorus releases or support channels.
The package names and portions of the underlying implementation still use `emdash` for
compatibility; that does not imply this repository publishes to Emdash.

## Getting started

From the repository root, with `pnpm` on PATH:

```bash
pnpm install
pnpm run dev
```

Use `pnpm run doctor` to check your environment. Run `pnpm run check` for the local
format, lint, typecheck, and test gate. The Electron app lives in
`apps/emdash-desktop/`; shared workspace packages live under `packages/`.
See [AGENTS.md](AGENTS.md) for architecture and development workflows and
[docs/chorus/PLAN.md](docs/chorus/PLAN.md) for Chorus-specific direction.

## Project isolation

The repository's local primary branch is `chorus/main`; new task branches default to
`chorus/...` (configurable in app settings). Existing branches from before the split may
still use `emdash/...`. A fetch-only promisor remote may exist in partial clones to
hydrate missing historical Git objects. Do not push to Emdash; create a Chorus remote
only after choosing its repository and owner.

## Privacy and licensing

The app stores its state locally. Agent CLIs and optional integrations may send data to
the providers you configure. Telemetry is optional; disable it in Settings or set
`TELEMETRY_ENABLED=false`.

Chorus is licensed under [Apache-2.0](LICENSE.md). See [NOTICE](NOTICE) for the
Emdash attribution.
