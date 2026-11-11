# Which UI Kit

The desktop app has exactly one component kit: **`@emdash/ui`** (`packages/ui`). The
legacy Tailwind/cva kit that lived at `apps/emdash-desktop/src/core/primitives/ui/browser/`
was deleted by the UI-kit unification migration — do not reintroduce it or shim to its
old APIs.

## Rules

- **Components come from `@emdash/ui`.** Buttons, dialogs, fields, inputs, selects,
  menus, tooltips, toasts, tabs, markdown, time display — import them from `@emdash/ui`.
  Do not hand-build a styled equivalent in feature code.
- **Feature-local Tailwind is for layout one-offs only.** Flex/grid/gap/padding/typography
  utilities in feature `browser/` code are fine until the separate future Tailwind-removal
  effort. Do not use Tailwind to build new reusable styled components.
- **New generic primitives go in `packages/ui`,** styled with vanilla-extract recipes and
  base-ui patterns per [UI styling conventions](ui-styling.md). Storybook stories covering
  variants and states are mandatory for every new or extended component.
- **App-specific components live in their owning feature slice** under
  `src/core/features/<feature>/browser/` (or the owning service/primitive), composed from
  `@emdash/ui` primitives. Only promote to `packages/ui` when a component is genuinely
  app-agnostic.
- **`cn()` lives at `src/core/primitives/styling/browser/cn.ts`**
  (`@core/primitives/styling/browser/cn`). It is the only sanctioned class-merging helper
  app-side; `packages/ui` does not use it.

## Building blocks (compose these; do not re-invent them)

The redesign's shared pieces. Each has stories in dark and light (`pnpm --filter @emdash/ui
storybook`, port 6006) and follows the rules in [UI styling](ui-styling.md). Feature code
composes them instead of hand-rolling an equivalent with Tailwind.

| Block | Import | Use it for |
|---|---|---|
| `Button variant="text"` | `@emdash/ui/react/primitives` | quiet underlined text actions (Merge…, Open app, Learn more) |
| `StateGlyph` | `@emdash/ui/react/components` | every state mark: needs-you, working, unread, done, idle, error, setting-up |
| `EmptyState` | `@emdash/ui/react/components` | empty, loading and error states (`size`, `tone`) |
| `FactGrid` | `@emdash/ui/react/patterns` | label / value detail grids (machine, workspace, PR, agent, report) |
| `MetaLine` | `@emdash/ui/react/patterns` | caption-role footer lines (state · age … facts) |
| `SectionLabel` | `@emdash/ui/react/primitives` | the group label over a set of rows ("Pinned", "Local") |
| `ModalLayout` | `@emdash/ui/react/primitives` | every dialog's header / body / footer |
| `Tabs` `List variant="underline"` | `@emdash/ui/react/primitives` | text tabs with a 1px underline (Conductor \| Raw) |
| `PillTabs` | `@emdash/ui/react/patterns` | the segmented control |
| `Alert` | `@emdash/ui/react/primitives` | the quiet notice (neutral card, glyph carries error / warning) |
| `Badge`, `Pill`, `Kbd` | `@emdash/ui/react/primitives`, `.../components` | quiet chips and keycaps |
| `SettingsSection` / `SettingsCard` / `SettingsRow` | `@emdash/ui/react/patterns` | settings pages (`layout="stacked"` for long values) |
| `PageLayout.Header` | `@emdash/ui/react/patterns` | page title + one sentence, no rule |
| `CollectionView` | `@emdash/ui/react/patterns` | page-level lists (flat, rounded hover rows) |
| `Shortcut` / `BoundShortcut` | `@core/primitives/keybindings/browser/shortcut` (app) | shortcut hints and keycaps |
| `bg-surface*`, `bg-overlay`, `reading-column` | app Tailwind (`src/renderer/index.css`) | surface steps, the scrim, the reading measure |

```tsx
import { Button, ModalLayout, Dialog, SectionLabel, Tabs } from '@emdash/ui/react/primitives';
import { EmptyState, StateGlyph } from '@emdash/ui/react/components';
import { FactGrid, MetaLine } from '@emdash/ui/react/patterns';

// One calm primary, the rest text actions.
<div className="flex flex-wrap items-center gap-x-5 gap-y-2">
  <Button variant="primary" size="sm">Done</Button>
  <Button variant="text" onClick={merge}>Merge…</Button>
  <Button variant="text" onClick={openApp}>Open app</Button>
</div>

// The state mark. Decorative next to words; `label` announces it with a tooltip.
<StateGlyph state="working" label />                 // tooltip + aria "Working"
<StateGlyph state="error" label="Build failed" />
<StateGlyph state="done" size="sm" /> Finished · 6m ago

// Empty / loading / error.
<EmptyState size="page" label="Nothing needs you" description="Three tasks are at work."
  action={<Button variant="primary">New task</Button>} />
<EmptyState label="No servers yet" action={<Button variant="text">Add one</Button>} bare />
<EmptyState tone="loading" label="Loading branches…" />
<EmptyState tone="error" label="Could not load branches" details={String(error)}
  action={<Button variant="text" onClick={retry}>Try again</Button>} />

// Details and meta.
<FactGrid>
  <FactGrid.Row label="Branch">fix/hang-up, pushed</FactGrid.Row>
  <FactGrid.Row label="Your move" emphasis>Try it in Katana Dev</FactGrid.Row>
</FactGrid>
<MetaLine glyph={<StateGlyph state="done" size="sm" />} start={['Finished', '6m ago']}
  end={['Claude', 'work account']} />

// Group label and underline tabs.
<SectionLabel as="h3">Recent</SectionLabel>
<Tabs.Root value={view} onValueChange={setView}>
  <Tabs.List variant="underline" aria-label="Chat view">
    <Tabs.Tab value="conductor" size="sm">Conductor</Tabs.Tab>
    <Tabs.Tab value="raw" size="sm">Raw</Tabs.Tab>
  </Tabs.List>
</Tabs.Root>

// A dialog: size comes from the modal definition (sm 400, md 520, lg 680, xl 880).
<ModalLayout
  title="Rename project"
  description="The folder on disk keeps its name."
  leading={<Button variant="text">Learn more</Button>}
  actions={<>
    <Button variant="ghost" onClick={() => modal.dismiss()}>Cancel</Button>
    <ConfirmButton variant="primary" onClick={rename}>Rename</ConfirmButton>
  </>}
>
  <Dialog.Body>{/* fields, gap-5 */}</Dialog.Body>
</ModalLayout>
```

Kit behaviour feature workers should know:

- The control recipe (Button, SplitButton, TriggerButton, Toggle, Tabs) sits in `@layer recipes`,
  so Tailwind classes on a kit Button now apply (`className="h-7 px-2"` used to be ignored without
  `!`). Remove `!` overrides when you touch a call site, and check classes that were silently
  ignored before.
- Ghost icon buttons (`variant="ghost" icon`) render their glyph in the passive tone and come to
  full strength on hover; menu rows are muted until highlighted.
- `Tooltip.Content` has no arrow by default (`showArrow` to opt in) and sits on the
  elevated-emphasis surface with foreground text; do not style tooltip content for an inverted
  (dark-on-light) pill any more.
- `PageLayout.Header` draws no rule (opt in with `separator`); `SettingsSection` separates rows
  by space (opt in to hairlines with `separated`).
- `CollectionView` has no outer card; grouped layout cards read like settings cards.
- `Badge`, `Pill`, `StatusIcon` and toast icons only colour error and warning; success reads in
  full strength and info muted.

## Choosing a popup control

- **`Select`** is for a short, bounded set of mutually exclusive values. Its popup is detached
  from the trigger and sizes to at least the trigger by default. Use `width="trigger"` when a
  form control should keep an exact column width. Avoid `alignItemWithTrigger`; it makes the
  selected row overlap the trigger and is reserved for a deliberately native-select-like
  interaction.
- **`Combobox` / `ComboboxPopover`** is for searchable or potentially large collections of
  entities such as agents, branches, remotes, machines, models, and working copies. Prefer the
  composed `ComboboxPopover` when its trigger/list/footer API is sufficient. Use
  `width="content-at-least-trigger"` when rows contain useful secondary metadata that needs more
  room than the trigger.
- **`DropdownMenu`** is for commands and actions, not choosing a persisted value. Radio and
  checkbox items are appropriate when an action menu also exposes a current preference.
- **`ContextMenu`** is the right-click variant of an action menu.
- **`Popover`** is for arbitrary interactive content that is not fundamentally a list of choices
  or commands.
- **`SplitButton`** is for a primary action with a menu of alternative actions.
- **`ComboboxPopup`** is for inline text completion anchored to an editor or input caret, such as
  mentions and slash commands.

Popup width is an explicit content decision rather than a positioning side effect. `Select`,
`Combobox`, and `DropdownMenu` content support `trigger`, `content`, and
`content-at-least-trigger` widths.

## Page-level lists

A page-level list of records is a **`CollectionView`**
(`packages/ui/src/react/patterns/collection-view/`), full stop. Card grids, trees
(`TreeView`), sidebars, popup pickers, and changed-files lists are different patterns.
The reference renderings are the stories in
`packages/ui/src/react/patterns/collection-view/collection-view.stories.tsx`; the full
locked spec lives with the unify-list-views effort.

- **One shell, two row styles**: every list is the same flat surface on the page (no outer
  card, no row rules) with rounded hover/selected steps and always-on virtualization; the
  `grouped` layout puts each section in a settings-style card. Row content is either
  tabular `columns` (`CollectionViewColumn[]`, with `CollectionViewCell` for two-line
  text cells) or freeform `renderRow` — exactly one of the two. There is no header row.
- **State is opt-in**: pass `view` (a `createListView` instance, rendered inside its
  `Root`) for search/filter/sort/sections/selection/pagination, or plain `items` +
  `getItemKey` when no state layer is needed. Selection, sections, and loading/error
  status auto-wire in view mode; `renderSectionHeader` overrides the default
  label+count section header (for select-all headers and the like).
- **Density** is a two-value axis: `default` (60px estimate) or `compact` (36px).
  Taller measured content overrides via `estimateSize`; per-surface pixel tweaking is
  not a thing.
- **Toolbar and footer are slots**: compose `CollectionToolbar.Root` with
  `CollectionToolbar.Search`, `Spacer`, `Group`, and `Separator` as needed, then put it in
  `toolbar`; floating bulk bars and banners built on `ListPopoverCard` go in `footer`.
- **Sorting UI** is the shared `SortSelect` bound to `view.useSort()` — sort keys and
  labels live in the sort spec, never re-declared in the UI.
- **Multi-select mechanics are framework-given** (modifier-click toggle, shift-range);
  the default presentation is a hover-revealed leading checkbox column plus a floating
  `ListPopoverCard` bulk bar. Row click opens the item and never mutates.
- **Row actions are tiered**: context menu for the full set, trailing ellipsis menu for
  discoverability on management tables, hover buttons for at most 1–2 high-frequency
  actions. Destructive actions go last, separated, destructive-styled, with a confirm
  modal when irreversible.
- **An empty state is mandatory** (`EmptyState` is the default content; rich
  interactive empty states are allowed); `Spinner` is the loading default. Custom
  `EmptyState` slot content must pass `bare` — the card paints its own surface, so
  the component's panel background would patch over it.
- **Query-backed lists use `useQueryListSource`**: when the data comes from React
  Query, bridge the query result into the view with
  `useQueryListSource(query, buildItems)` (an `external` list source) instead of
  `observable.box` bridges or hand-rolled loading/error branches. Routing is then
  framework-owned: `loading` + no rows → `loadingSlot`; `error` + no rows →
  `errorSlot`; rows present → rows render even during refetch or on refetch failure
  (stale rows stay, silently — surfaces that must announce a refetch failure add
  their own `footer` banner); no rows and idle → `emptySlot`. The toolbar is always
  visible, including while loading. `reload()` is a no-op for these views — refetch
  through the query owner.
- **Removed**: `ColumnList` and `ListPage` no longer exist — `CollectionView` replaced
  both (its `columns`/`CollectionViewColumn`/`CollectionViewCell` vocabulary is the
  former `ColumnList` shape). Raw `ListView` chrome remains exported as an internal
  escape hatch for surfaces that cannot fit the shell (for example the workbench
  sidebar lists); it is not a pattern for new page surfaces.

## Settings pages

Settings pages follow one canonical anatomy, built from the settings pattern family in
`@emdash/ui/react/patterns`. The reference rendering is the "Page anatomy" story in
`packages/ui/src/react/patterns/settings/settings.stories.tsx`.

- **Header**: every settings page starts with `PageLayout.Header sticky` with a `title`
  (page-title role) and a one-sentence `description`; no rule under it. If the page needs an Electron window drag region, use its
  `draggable` prop; do not hand-roll `WebkitAppRegion` divs.
- **Section stack**: the page owns the spacing between sections (a vertical stack with
  `gap-10` / `space-y-10`). Sections do not space themselves.
- **Sections**: each group of settings is a `SettingsSection`. The optional `title`
  renders the inset section-title heading (13px semibold) and `description` one muted
  sentence; children are wrapped in a `SettingsCard` (the emphasis surface, rounded-lg, one
  subtle hairline) and separated by space (`gap`, default `1.25rem`; `separated` opts back
  into hairlines). Content that brings its own
  surface — a custom card component, a tile grid — uses the `bare` prop and renders its
  surface itself. Do not compose raw `h3` headings or ad-hoc bordered divs.
- **Rows**: each setting is a `SettingsRow` (label, optional description, right-aligned
  control; `layout="stacked"` puts a full-width control under the label for paths, URLs and
  keys). The desktop app's local `SettingRow` wrapper (settings feature slice) adapts
  the `title` prop name; either is fine app-side. Controls come from `@emdash/ui`
  primitives (`Switch`, `Select`, `Input`, `Button`, …).
- **Tile pickers**: a small set of visual, mutually exclusive choices rendered as tiles
  (for example the color mode switcher) uses `SelectableCard` per tile inside a `bare`
  section — not hand-rolled `<button>`s.
- **Registration**: pages are contributed with `defineSettingsPageContribution` and
  aggregated in `src/core/manifests/browser/settings-page-contributions.ts`; the anatomy
  above applies to slice-contributed settings pages too.

## Theming

- `@emdash/ui` components are themed by `--em-*` tokens generated by `@emdash/theme`
  and loaded via `@emdash/ui/style.css`.
- Theme switching keys off the shared `emlight`/`emdark` class names; the app mounts the
  `@emdash/ui` `ThemeProvider` so `useTheme` works app-wide.
- App chrome tokens (`--background`, `--foreground`, …) live in
  `apps/emdash-desktop/src/renderer/index.css` and mirror the generated palette so chrome
  and `@emdash/ui` components render identically. Extend tokens there only for app chrome;
  component-level colors belong in `packages/ui` recipes.
- Markdown math rendering requires the host to load `katex/dist/katex.min.css`; the app
  does this in `src/renderer/main.tsx`.
