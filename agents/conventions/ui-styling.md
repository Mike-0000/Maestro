# UI Styling Conventions

This guide covers the rules and patterns for authoring styles in `packages/ui`.
The system uses [vanilla-extract](https://vanilla-extract.style/) (VE) with CSS `@layer`
ordering, shared recipes, and composition over inheritance.

## Palette and type

The default dark theme (id `dark`, class `.emdark`) is one deep, low-chroma slate ground with
almost no lines: separate things with a surface step before reaching for a border, and let text
do the work. The light theme (id `light`, class `.emlight`) is its polarity mirror: the same hue
family, accent, type and radii.

- **Source of truth:** `packages/theme/src/themes/dark.theme.ts` and `light.theme.ts`. The app's
  `.emdark` and `.emlight` palettes in `apps/emdash-desktop/src/renderer/index.css` alias the
  generated `--em-*` values (`--neutral-N: var(--em-neutral-N)`, accent roles, primary button,
  status), so a change there reaches both kits. Run `pnpm --filter @emdash/theme build:theme`
  after editing a theme (and `pnpm --filter @emdash/theme build` so dependants see new exports).
  `packages/theme/src/core/theme.test.ts` pins the contrast floors below; keep it green.
- **Dark neutral ramp** (OKLCH, hue 230): 1 `0.21` background, 2 `0.23`, 3 `0.25` component fill
  and active row, 4 `0.27` hover, 5 `0.29` subtle border, 6 `0.31` hairline `border`, 7 `0.45`
  control border, 8 `0.55` strong border (checkbox / radio edge, ≥ 3:1), 9 `0.635` passive text
  (≥ 4.5:1 up to the elevated menu surface), 10 `0.69`, 11 `0.75` muted text, 12 `0.95` text.
- **Light neutral ramp** (OKLCH, hue 230): 1 `0.99`, 2 `0.975`, 3 `0.958`, 4 `0.94`, 5 `0.922`,
  6 `0.90`, 7 `0.79` control border (inputs at rest), 8 `0.62` strong border (≥ 3:1), 9 `0.53`
  passive text (≥ 4.5:1 on the sunken chrome), 10 `0.48`, 11 `0.41` muted, 12 `0.205` text.
- **Surfaces** (dark / light): sunken `0.18` / `0.955` (sidebar, title bar, tab strip), base and
  paper `0.21` / `0.975`, `0.995` (content), base-emphasis `0.23` / `0.985` (cards, composer),
  elevated `0.255` / `0.995` (menus, popovers, dialogs), elevated-emphasis `0.29` / `0.978`.
- **Accent:** one jade (hue 176). Dark: sea-glass solid `0.718` with dark ink; light: deep jade
  `0.50` with white ink (5.7:1). Semantic roles: `--em-focus-ring` (accent 8, ≥ 3:1 on every
  surface), `--em-link` (accent 11, ≥ 4.5:1), `--em-accent` (accent 9, the working pulse). Only
  for focus, the primary button, links and the working pulse; never panels or resting borders.
  App utilities: `bg-accent`, `text-link`, `ring-ring` / `outline-ring`.
- **Type** (Inter; same values in `packages/ui/src/theme/tokens.css.ts` and the app's Tailwind
  `text-*`): micro 10, tiny 11, xs 12/1.5, sm 13/1.55 (UI default), base 14/1.6 (reading),
  lg 16/1.55, xl 21/1.4 weight 500 tracking -0.01em, 2xl 26/1.3. Body 400, headlines 600,
  nothing bolder. Use `text-foreground-body` for running text a step below `foreground`.
- **Radii** (`packages/theme/src/core/define-density.ts`; the app's `rounded-*` map to them): xs 4,
  sm 6, md 8, lg 12, xl 16, 2xl 20, pills full.
- **Elevation:** dark shadows sm / md / lg draw nothing (`0 0 0 0 transparent`, so they still
  compose in a list); only `--em-shadow-overlay` (dialogs, sheets) keeps a soft black shadow.
  Light keeps soft ink shadows on floating layers. `--em-backdrop` is the modal scrim (black 55%
  dark, ink 30% light, no blur); app utility `bg-overlay`.

## Design rules (the house style)

These are the rules every screen follows; the kit implements them, so composing kit pieces is
usually enough. The reference renderings are the conductor screen
(`src/core/features/conductor/browser/chat-conductor/view/*`) and the workbench shell
(`src/core/features/workbench/browser/sidebar/*`).

### Surfaces and elevation

| Layer | Use | App class | Kit |
|---|---|---|---|
| sunken | window chrome: sidebar, title bar, tab strip, terminal drawer strip | `surface-sunken bg-surface` | `.surface-sunken` |
| paper | content: views, panes, settings page bodies, threads | `surface-paper bg-surface` or `bg-background` | `.surface-paper` |
| emphasis | cards, the composer, settings cards, inline code wells | `bg-surface-emphasis` | `vars.surfaceEmphasis` |
| elevated | menus, popovers, selects, tooltips, toasts, dialogs, sheets | `surface-elevated bg-surface` | `popupSurface` |
| hover / selected | rows and quiet buttons on any surface | `hover:bg-surface-hover`, `data-[active=true]:bg-surface-selected` | `vars.surfaceHover` / `vars.surfaceSelected` |

`bg-surface*` utilities follow the surface cascade: they resolve against the nearest
`surface-*` scope class. Never put a tinted panel behind content to signal state (no
`bg-red-500/10` rooms); state is a glyph plus words. No visible shadows in dark; never
Tailwind `shadow-*` in feature code.

### Borders

- One hairline, `border-border-subtle`, around a card or floating layer where a surface step
  alone does not separate it. `border` (neutral 6) only between two regions that must read as
  separate (a resizable split). Never a rule under a title bar, page header, section heading,
  toolbar or tab strip: use space.
- `border-border-1` and up only on controls that must be findable by their edge: checkbox,
  radio, switch track (`border-2` for checkbox and radio edges), inputs at rest in light.
- No `border-b` row dividers in lists; rows separate by hover fill and rhythm. Dense tables may
  use `divide-y divide-border-subtle`. No coloured borders; an invalid input's edge turns
  `border-destructive` and the message under it carries the words.

### Radii

`rounded-xs` 4 (kbd, inline code, tiny badges), `rounded-sm` 6 (mini icon buttons, focus on
text actions), `rounded-md` 8 (buttons, inputs, selects, rows, tabs), `rounded-lg` 12 (cards, the
composer, menus, popovers, toasts, settings cards), `rounded-xl` 16 (dialogs, sheets, floating
panels), `rounded-2xl` 20 (the voice bar only), `rounded-full` (glyphs, pills, switch, avatar).

### Type roles

| Role | Classes | Kit |
|---|---|---|
| Hero line / page-level empty title (one per screen) | `text-2xl font-medium text-balance` | `Text variant="title"`, `EmptyState size="page"` |
| Page title | `text-xl text-foreground` | `PageLayout.Header`, `Heading level={1}` |
| Dialog title | `text-lg font-semibold` | `Dialog.Title`, `Heading level={2}` |
| Section title / card headline | `text-sm font-semibold` (reading: `text-base font-semibold`) | `SettingsSection title`, `Heading level={3}` |
| Group label | `text-tiny text-foreground-passive`, sentence case | `SectionLabel`, `Text variant="label"` |
| Field / row label | `text-sm text-foreground` | `Label`, `Field.Label`, `SettingsRow` |
| Key / value label | `text-xs text-foreground-muted` | `FactGrid` |
| Helper text | `text-xs text-foreground-muted` (settings), `text-sm` (dialogs, empty states) | `Field.Description` |
| UI body | `text-sm text-foreground` | — |
| Reading body | `text-base text-foreground-body` | `Markdown variant="full"`, `FactGrid size="reading"` |
| Caption / meta | `text-tiny text-foreground-passive tabular-nums` | `MetaLine`, `Text variant="meta"` |
| Code | `font-mono text-xs`; inline `rounded-xs bg-surface-emphasis px-1` | — |

Banned in feature code: `text-[Npx]`, `font-bold`, `uppercase` labels, `tracking-wide/wider`,
`text-foreground-tertiary-*` for labels.

### Spacing rhythm

- Page: `PageLayout` + `PageLayout.Header` (40px above the title, 32px below, no rule). Reading
  views use the `reading-column` utility (45rem measure with a fluid gutter).
- Sections: `gap-10` between sections on a page; `gap-3` from a section title to its card; `mt-5`
  between groups inside a card or report.
- Form rows: settings rows separate by space inside the card (`SettingsSection` gap 20px);
  dialog form fields `gap-5`, label to control `gap-1.5`.
- List rows: compact `h-8` (menus, sidebar one-line rows, palette), trees `h-7`, two-line rows
  `py-1.5`, table rows `h-10`.
- Strips: title bar and sidebar header `h-10`; toolbars `h-9`; composer tools `h-7`.
- Inline: icon to text `gap-2`; text actions `gap-x-5`; button groups `gap-2`.

### State language

One glyph set everywhere state shows: the kit `StateGlyph`.

| State | Mark | Words |
|---|---|---|
| `needs-you` | filled near-white dot | Needs you |
| `working` | small accent dot, pulsing (not under reduced motion) | Working |
| `unread` | bright ring | Finished, not looked at yet |
| `done` | passive ring | Finished |
| `idle` | dimmer passive ring | Idle |
| `error` | filled error dot | Stopped on an error |
| `setting-up` | braille wave, passive | Setting up |

Other status (CI checks, PR state, machine connection, run results) uses the same marks or the
kit `StatusIcon` in passive / foreground / error tones. The only colour allowed: diff stats, the
error dot, the accent pulse, syntax highlighting, and warning text or glyphs (never a fill).

### Buttons and actions

- One `variant="primary"` per view or dialog: the move (Done, Create, Save). Everything else is
  `variant="text"` (underlined muted text action) or `variant="ghost"`.
- `variant="secondary"` (quiet filled) only where a second solid action is genuinely needed.
- Icon buttons: `variant="ghost" size="sm" icon` (passive glyph, full strength on hover). Row
  actions hide until hover or focus (`opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100`).
- Destructive: last in menus, separated, `variant="destructive"` item; `Button variant="destructive"`
  only inside its confirm dialog.
- In a narrow container, text actions collapse into a `…` `DropdownMenu`.

### Forms and settings

- Settings pages: `PageLayout.Header` (title + one sentence), then a `gap-10` stack of
  `SettingsSection`s, each one `SettingsCard` of `SettingsRow`s.
- Controls from the kit only. Widths: switch as-is; select / combobox `w-56`; short text input
  `w-64`; long values (URLs, paths, keys, env values) use `SettingsRow layout="stacked"`.
- Inputs `h-8 rounded-md`; textareas grow with content. Validation: `text-xs
  text-foreground-error` under the field (`Field.Error`); no red boxes. Reset-to-default and
  provenance are text actions / captions.

### Dialogs and sheets

- Elevated surface, `rounded-xl`, subtle hairline, the overlay shadow; scrim `bg-overlay`.
- Widths (`size` on the modal definition or `Dialog.Content`): `sm` 400 (confirm), `md` 520
  (default form), `lg` 680 (create task, integrate, add project), `xl` 880 in the app host
  (pickers with previews). Padding 24px.
- Header: dialog title, optional one sentence, close `X` top right; no rule. Body `gap-5`.
  Footer: right-aligned, no rule; Cancel as `ghost`, the primary rightmost; extra links on the
  left as text actions. Use `ModalLayout` (its `title` / `description` / `actions` / `leading`
  shorthand) so no feature hand-rolls one.
- Sheets share the anatomy, 34rem wide from the right, 200ms.

### Menus, popovers, lists

- Menus, selects, comboboxes, popovers, hover cards: elevated, `rounded-lg`, `p-1`, hairline.
  Items 32px `rounded-md px-2 text-sm text-foreground-muted`, highlighted one step up in full
  strength; icons 16px passive; shortcut hints right in the caption role; separators `my-1 h-px
  bg-border-subtle`; section labels in the group-label role.
- Tooltips: elevated-emphasis, `rounded-md`, `text-xs`, `px-2 py-1`, no arrow, ~400ms delay.
- Toasts: elevated, `rounded-lg`, title `text-sm font-medium`, body `text-xs` muted, at most one
  text action, no coloured stripes.
- Page-level lists: `CollectionView` (flat, no outer card, rounded hover / selected steps).
  Trees: rows `h-7`, indent 12px, guide lines only on hover.

### Focus, motion, accessibility

- Focus: kit controls draw a 2px accent outline (`--em-focus-ring`) 1–2px outside; fields turn
  their edge accent plus a 1px accent ring; rows draw an inset 1px ring. App code:
  `focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none` on rows, tabs and mini
  buttons (`ring-inset` against a container edge), `ring-2` on text actions and standalone
  controls. Never remove focus without a replacement.
- Motion: colour transitions 150ms; new content `motion-safe:animate-in motion-safe:fade-in
  motion-safe:duration-300`; popups 120ms with a 0.98 zoom; only the working glyph pulses; every
  animation respects `prefers-reduced-motion`.
- Contrast: text ≥ 4.5:1 on its surface (passive text is the floor), focus indicators and
  control edges ≥ 3:1, in both themes. `theme.test.ts` checks the token floors.

### Empty, loading, error

One pattern, the kit `EmptyState`: centred, a quiet title, one sentence, one action.
`size="page"` for a whole view or pane, `size="panel"` (default) inside a list or card (pass
`bare` inside a card). `tone="loading"` shows a passive spinner after 400ms; `tone="error"` adds
the error dot, a "Try again" text action and technical detail behind "Show details". No red
panels, no tinted `Alert`s (the kit `Alert` is a neutral notice where only the glyph carries
error / warning).

## Core Principle: One Owner Per Property

Every CSS property on an element should have exactly **one authoritative source** of truth.
When two rules set the same property at the same specificity, source order decides —
which is fragile and hard to reason about.

**Anti-pattern (two owners fighting):**
```ts
// primitive: always sets padding 0.25rem
export const comboboxList = style({ padding: '0.25rem' });
// consumer: also sets padding → source-order roulette
export const list = style({ padding: '0.25rem' });
```

**Correct (single owner):**
```ts
// primitive owns padding; consumer just composes it
// consumer delegates to primitive, no override
<ComboboxList> {/* no extra className needed */}
```

## State = Variant, Not Higher-Specificity Selector

Express component state through `data-*` attributes handled inside the owning
`style()` or `recipe()`, not by adding specificity from the outside.

**Anti-pattern (state via higher specificity):**
```ts
// parent component pushing state into child via specificity escalation
globalStyle(`${someParent} ${childClass}`, { padding: 0 });
```

**Correct (state-owned selector inside the primitive):**
```ts
export const comboboxList = style({
  padding: '0.25rem',
  selectors: {
    '&[data-empty]': { padding: 0 },  // library-owned state drives own style
  },
});
```

## No globalStyle Across Component Boundaries

`globalStyle` with a multi-segment selector that crosses a component boundary
(e.g. `${parentClass} [data-slot="child"]`) creates invisible coupling.
If the child's class changes, the parent silently breaks.

**Anti-pattern (cross-boundary globalStyle):**
```ts
// combobox.css.ts reaching into input-group internals
globalStyle(`${comboboxContent} [data-slot="input-group"]`, {
  borderRadius: 0,
  boxShadow: 'none',
});
```

**Correct (variant prop on the child):**
```ts
// input-group.css.ts adds an "embedded" variant
export const inputGroup = recipe({
  variants: {
    variant: {
      embedded: { borderRadius: 0, boxShadow: 'none' },
    },
  },
});
// consumer passes the variant explicitly
<InputGroup variant="embedded" />
```

## Prefer Composition Over Inheritance

Reuse styles by **composing** `style()` arrays rather than inheriting through
class hierarchies or overrides.

```ts
// compose shared base into component-specific style
export const menuItem = style([
  menuItemBase(),          // shared structural recipe
  {
    selectors: { '&:focus': { backgroundColor: vars.surfaceHover } },
  },
]);
```

VE's `style([...])` merges multiple style objects/classes into one atomic class at
build time. The `recipe()` base also accepts an array:
```ts
recipe({ base: [sharedBase, { componentSpecific: '...' }] })
```

## SVG Sizing: Use svg-helpers

Use the shared helpers from `@styles/effects/svg-helpers.css` instead of hand-rolling
`globalStyle` for SVG sizing.

| Helper | Effect |
|--------|--------|
| `svgContainer` | `svg { pointer-events: none; flex-shrink: 0 }` |
| `svgDefaultSize` | `svg:not([class*='size-']) { width: 1rem; height: 1rem }` |
| `svgSmSize` | `svg:not([class*='size-']) { width: 0.75rem; height: 0.75rem }` |
| `svgTextSize` | same as default (alias for inline text contexts) |

```ts
export const menuItem = style([svgContainer, svgDefaultSize, { /* ... */ }]);
```

## Shared Recipes for Common Patterns

### menuItemBase

`@styles/recipes/menu-item.css` — the recipe for every row in a floating list (DropdownMenu,
ContextMenu, Select, Combobox; ComboboxPopup mirrors it): 32px min-height, `rounded-md`, 8px
side padding, 13px muted text that comes to full strength on highlight (`:focus`,
`[data-highlighted]`, hover), passive 16px leading icons. The same file exports
`menuGroupLabel` (group-label role), `menuSeparatorLine` and `menuShortcutHint`.

```ts
import { menuItemBase } from '@styles/recipes/menu-item.css';

export const myItem = style([
  menuItemBase({ trailingIndicator: true, fullWidth: true }),
  { selectors: { '&[data-selected]': { color: vars.foreground } } },
]);
```

Variants: `trailingIndicator`, `fullWidth`, `inset`, `muted` (rows are muted by default now).

### popupSurface + popupShadow*

`@styles/recipes/popup-surface.css` — the floating layer: the surface it sits in (the component
adds the `surface-elevated` scope class), `rounded-lg`, one `border-subtle` hairline drawn as a
box-shadow ring (`popupHairline`), the theme shadow (none in dark), and 120ms entry / exit motion
keyed to base-ui's `data-open` / `data-closed` / `data-side` (`popupMotion`, off under
reduced motion).

```ts
import { popupSurface, popupShadowMd } from '@styles/recipes/popup-surface.css';

export const myMenu = style([
  popupSurface,
  popupShadowMd,
  { minWidth: '12rem', padding: '0.25rem' },
]);
```

Shadow variants (each includes the hairline): `popupShadowSm` (tooltips, comboboxes, hover cards),
`popupShadowMd` (menus, selects, popovers, toasts).

### InputGroup variant prop

`InputGroup` accepts a `variant` prop:

- `default` — standalone field: the field-shell look (fill, edge, accent focus ring)
- `embedded` — bottom-border-only divider for use inside popup containers

```tsx
// ComboboxInput uses "embedded" automatically
<InputGroup variant="embedded" />
```

### Input bare prop

`Input` accepts a `bare` boolean that strips its standalone border/shadow/focus ring.
`InputGroupInput` passes `bare` automatically; consumers should not need it directly.

## CSS @layer Discipline

The layer order is: `reset < tokens < base < recipes < utilities`.

- `reset` / `base` — `globalStyle` rules in `reset.css.ts` and `base.css.ts`
- `recipes` — component `style()` and `recipe()` output (target destination). The control
  recipe (`controlVariants`: Button, SplitButton, TriggerButton, Toggle, Tabs) lives here, so the
  app's Tailwind utilities override a kit Button without `!`. So do the layout groups of
  `Input` (size, padding, type), `Textarea`, `Collapsible.Trigger`, `Dialog.Body`,
  `Popover.Content`, the shared menu row (`menuItemBase`: Select, DropdownMenu, ContextMenu and
  Combobox items), `Select.Trigger appearance="input"` and the scroll-fade viewport's overflow.
  Field edges, fills and focus rings stay unlayered. The app's Tailwind `utilities`
  layer merges into the kit's `utilities` layer, after `recipes`.
- `utilities` — `sx()` sprinkles; always overrides component styles

**Migration path:** To place a style in the `recipes` layer, wrap properties inside
`'@layer': { recipes: { ... } }`:

```ts
export const foo = style({
  '@layer': {
    recipes: {
      color: vars.foreground,
      selectors: { '&:hover': { backgroundColor: vars.surfaceHover } },
    },
  },
});
```

> **Important:** Unlayered styles always beat ALL layered styles. The migration must
> be coordinated — mixing layered and unlayered styles for the same property on the
> same element will make the unlayered one always win regardless of intent.
> Migrate an entire property-ownership group at once.

## Overrides Go Through utilities Layer

If a consumer genuinely needs to override a component style (rare), use the
`utilities` layer rather than adding specificity:

```ts
// Correct: opt into utilities layer to predictably win
export const myOverride = style({
  '@layer': {
    utilities: { padding: '0.5rem' },
  },
});
```

Avoid using `!important`. If you find yourself reaching for it, the owning
component should expose a variant or `data-*` hook instead.

## Checklist for New Component Styles

- [ ] One style definition owns each property on the element
- [ ] Interactive states expressed as `data-*`-keyed selectors inside the owning style
- [ ] No `globalStyle` with multi-segment selectors crossing component boundaries
- [ ] SVG sizing via `svgContainer`/`svgDefaultSize`/`svgSmSize` composition
- [ ] Popup containers compose `popupSurface` + a `popupShadow*`
- [ ] List-item rows compose `menuItemBase()`
- [ ] InputGroup inside a popup uses `variant="embedded"`
- [ ] No `!important` — expose a variant or compound variant instead
