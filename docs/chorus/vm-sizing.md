# Sizing a Maestro host VM

Which machine to put behind a headless Maestro host (see [remote-rig.md](remote-rig.md) for the
install itself). Prices are approximate pay-as-you-go Linux rates in US East; check the Azure
pricing calculator for your region. A 1-year savings plan cuts them by roughly 30 to 40%.

## What uses the hardware

- **Maestro under xvfb:** about 0.6 to 1 GB of RAM.
- **Each Claude Code agent:** about 0.3 to 1 GB. Agents mostly wait on the Claude API, so they use
  little CPU. Subagents run inside their parent agent's process and add very little.
- **What the agents run:** `pnpm install`, `tsc`, tests, and dev servers in their worktrees. This
  is where CPU and memory go, and why a coding rig needs far more than a research operator.
- **Hard requirement:** x64. The Linux host is an x64 AppImage, so ARM machines (Raspberry Pi,
  Oracle's Ampere free tier, Azure `p` sizes) cannot run it.

## Scheduled-task operator (recommended)

One scheduled agent at a time, with subagents, running long research tasks where speed does not
matter.

| Setting | Value |
|---|---|
| Size | **`Standard_B2as_v2`**: 2 AMD vCPU, 8 GB RAM, about $55/mo |
| Image | Ubuntu Server 24.04 LTS, x64 (22.04 or later works) |
| OS disk | 64 GB Standard SSD (E6), about $5/mo |
| Swap | a 4 GB swapfile as a safety net |
| Region | the one closest to you |
| Networking | no public inbound ports; reach it over Tailscale |
| Auto-shutdown | off: the schedule lives inside Maestro, so the VM must be on when a run is due |

Burstable (B-series) sizes suit this workload: an API-bound agent is mostly idle and never uses
up its CPU credits.

**Cheaper:** `Standard_B2als_v2` (2 vCPU, 4 GB, about $28/mo) works for pure research tasks but is
tight with Electron and an agent both running. Stay on 8 GB if a task ever builds or tests a large
repo; `tsc` on a monorepo can need several GB by itself.

### Create it

```bash
az group create -n rg-maestro-host -l <region>
az vm create -g rg-maestro-host -n maestro-host \
  --image Ubuntu2404 --size Standard_B2as_v2 \
  --os-disk-size-gb 64 --storage-sku StandardSSD_LRS \
  --admin-username maestro --generate-ssh-keys --public-ip-address ""
```

With no public IP, do the first Tailscale setup through the Azure Serial Console or
`az vm run-command invoke`. Then follow the step-by-step runbook,
[scheduled-task-host.md](scheduled-task-host.md).

## Remote coding rig

Many agents in parallel, each with subagents, building and testing in their own worktrees.

| Load | Size | Specs | Approx. cost |
|---|---|---|---|
| 4 to 6 agents | `Standard_D8as_v6` | 8 vCPU, 32 GB | about $250/mo |
| 8 to 15 agents (recommended) | `Standard_D16as_v6` | 16 vCPU, 64 GB | about $500/mo |
| 15+ agents or heavy parallel tests | `Standard_D32as_v6` or `Standard_E16as_v6` | 32 vCPU / 128 GB | about $1,000/mo |

- **Avoid burstable sizes here:** sustained builds use up B-series CPU credits, and the VM then
  slows to a crawl.
- **Disk:** a 512 GB or larger Premium SSD (P20/P30, or Premium SSD v2). Worktrees and their
  `node_modules` add up quickly.

## Cheaper than Azure

Dedicated servers give two to four times the hardware for the money, and a dedicated core is a
real core, while an Azure vCPU is a hyperthread. You give up snapshots and one-click resizing,
some providers charge a setup fee or a monthly term, and hardware faults go through a support
ticket.

| Option | Typical box | Approx. cost |
|---|---|---|
| ReliableSites (dedicated, US East) | Ryzen 9, 12 to 16 cores, 64 to 128 GB, NVMe | $100 to $200/mo |
| OVH dedicated (US East and West) | Ryzen or EPYC, 64 to 128 GB | $100 to $180/mo |
| Hetzner dedicated AX52 / AX102 (Germany, Finland) | Ryzen 7 7700, 64 GB / Ryzen 9 7950X3D, 128 GB | €65 / €110 per month |
| Hetzner Cloud CCX33 / CCX43 (has US locations) | 8 to 16 dedicated vCPU, 32 to 64 GB | €50 to €100/mo |
| Hetzner Cloud CX22 / CPX21 (scheduled operator only) | 2 to 3 vCPU, 4 GB | €4 to €8/mo |
| Mini PC at home, Intel N100 class (scheduled operator only) | 4 cores, 8 to 16 GB | about $150 once |

Hetzner's dedicated servers are in Europe, which adds 100 ms or more of round trip from the US.
Previews and the UI still work, just less snappily.
