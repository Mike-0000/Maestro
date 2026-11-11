# UI Styling Conventions

This guide covers the rules and patterns for authoring styles in `packages/ui`.
The system uses [vanilla-extract](https://vanilla-extract.style/) (VE) with CSS `@layer`
ordering, shared recipes, and composition over inheritance.

## Palette and type

The default dark theme (id `dark`, class `.emdark`) is one deep, low-chroma slate ground with
almost no lines: separate things with a surface step before reaching for a border, and let text
do the work.

- **Source of truth:** `packages/theme/src/themes/dark.theme.ts`. The app's hand-written `.emdark`
  palette in `apps/emdash-desktop/src/renderer/index.css` aliases the generated `--em-*` values
  (`--neutral-N: var(--em-neutral-N)`, accent roles, primary button, status), so a change there
  reaches both kits. Run `pnpm --filter @emdash/theme build:theme` after editing it.
- **Neutral ramp** (OKLCH, hue 230, chroma 0.004 to 0.016): 1 `0.21` background, 2 `0.23`,
  3 `0.25` component fill and active row, 4 `0.27` hover, 5 `0.29` subtle border, 6 `0.31`
  hairline `border`, 7 `0.45` control border, 8 `0.515` strong border, 9 `0.60` passive text
  (4.5:1), 10 `0.66`, 11 `0.75` muted text, 12 `0.95` text.
- **Surfaces** (dark): sunken `0.18` (sidebar, title bar, tab strip), base and paper `0.21`
  (content), base-emphasis `0.23` (cards, composer), elevated `0.255` (menus, popovers),
  elevated-emphasis `0.29`.
- **Accent:** one jade-teal, OKLCH `0.718 0.10 176` (step 9), only for the focus ring, the primary
  button, links and the working pulse; never panels or resting borders. App utilities:
  `bg-accent`, `text-accent-foreground`, `text-link`, `ring-ring` / `outline-ring`.
- **Type** (Inter; same values in `packages/ui/src/theme/tokens.css.ts` and the app's Tailwind
  `text-*`): micro 10, tiny 11, xs 12/1.5, sm 13/1.55 (UI default), base 14/1.6 (reading),
  lg 16/1.55, xl 21/1.4 weight 500 tracking -0.01em, 2xl 26/1.3. Body 400, headlines 600,
  nothing bolder. Use `text-foreground-body` for running text a step below `foreground`.
- **Radii** (`packages/theme/src/core/define-density.ts`; the app's `rounded-*` map to them): xs 4,
  sm 6, md 8 (buttons, inputs, rows), lg 12 (cards, composer, menus), xl 16 (floating panels),
  2xl 20, pills full.
- **Borders and shadows:** one hairline (`border`) where a surface step does not already separate
  things; `border-1` and up only for controls that must be findable by their edge. Shadows only
  on floating layers.

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

`@styles/recipes/menu-item.css` — structural recipe for all list item rows
(DropdownMenu, Select, Combobox, ComboboxPopup).

```ts
import { menuItemBase } from '@styles/recipes/menu-item.css';

export const myItem = style([
  menuItemBase({ trailingIndicator: true, fullWidth: true }),
  { selectors: { '&:focus': { backgroundColor: vars.surfaceHover } } },
]);
```

Variants: `trailingIndicator`, `fullWidth`, `inset`, `muted`.

### popupSurface + popupShadow*

`@styles/recipes/popup-surface.css` — base style for floating popup containers with
the animation keyframe selectors and visual properties already wired up.

```ts
import { popupSurface, popupShadowMd } from '@styles/recipes/popup-surface.css';

export const myMenu = style([
  popupSurface,
  popupShadowMd,
  { minWidth: '12rem', padding: '0.25rem' },
]);
```

Shadow variants: `popupShadowSm` (tooltips, comboboxes), `popupShadowMd` (menus, selects).

### InputGroup variant prop

`InputGroup` accepts a `variant` prop:

- `default` — standalone field with border, shadow, and focus ring
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
- `recipes` — component `style()` and `recipe()` output (target destination)
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
