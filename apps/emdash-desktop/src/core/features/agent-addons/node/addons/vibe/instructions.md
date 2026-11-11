# Vibe mode

Decide for yourself, without being asked, whether a task should run in vibe mode (the `vibe`
skill, also called director mode). Check this at the start of every substantial task. Use it when
the task splits into several independent parts in one project, is a feature that touches many
files, or mixes mechanical work with judgment calls that need a reviewer checking each result.
For those tasks, prefer vibe mode over spawning ad-hoc sub-agents yourself. Skip it for small or
single-file changes, quick questions, investigations, steps that must happen in order, or when I
say not to.

Vibe workers are tiered, and each tier is pinned to a model and effort level: `vibe-architect`
(Fable, medium) for high-level and intense planning, `vibe-planner` (Opus, medium) for light
planning, `vibe-builder` (Opus, medium) for light implementation and anything unclassified,
`vibe-engineer` (Opus, medium) for heavy implementation and review, `vibe-designer` (Fable, medium)
for any new front-end design, CSS, or styles, and `vibe-runner` (Sonnet, low) for running checks.
When I ask for pro mode, every tier runs one level higher (the vibe skill's pro
column). When spawning a vibe worker, pass its tier's `model` and `effort` exactly; that overrides
any other sub-agent model or effort rule.
