---
name: chorus-install
description: Retired. Use the push skill (/push) to ship Maestro; it publishes to the update feed and never installs locally.
compatibility: Retired
---

# Retired

Maestro is shipped with `/push` (`.claude/skills/push/SKILL.md`). It publishes a signed release to
the Azure update feed, and every machine, including this one, installs it through Download and
Restart. Do not schedule local installs or run anything in `scripts/`.
