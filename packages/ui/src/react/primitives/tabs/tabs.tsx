import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { controlVariants } from '@styles/recipes/control';
import { cx } from '@styles/utilities/cx';
import * as React from 'react';
// Relative type import: the dts emitter rewrites `@styles/*` type imports to a
// dangling relative path, silently degrading the variant prop types.
import type { ControlVariantProps } from '../../../styles/recipes/control';
import * as styles from './tabs.css';

/**
 * Tab looks:
 *  - `ghost` (default): flat ghost controls; the selected tab reads in full strength.
 *  - `underline`: plain words, the selected one in full strength with a 1px
 *    underline (the conductor status strip's Conductor | Raw switch).
 */
export type TabsVariant = 'ghost' | 'underline';

const TabsVariantContext = React.createContext<TabsVariant>('ghost');

// ── Root ──────────────────────────────────────────────────────────────────────

const TabsRoot = TabsPrimitive.Root;

// ── List ──────────────────────────────────────────────────────────────────────

export interface TabsListProps extends TabsPrimitive.List.Props {
  /** The look of every tab in this list. Defaults to `ghost`. */
  variant?: TabsVariant;
}

function TabsList({ className, variant = 'ghost', ...props }: TabsListProps) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cx(
          styles.tabsList,
          variant === 'underline' && styles.tabsListUnderline,
          className
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export interface TabsTabProps extends TabsPrimitive.Tab.Props {
  size?: ControlVariantProps['size'];
  tone?: ControlVariantProps['tone'];
  /** Override the list's look for this tab. */
  variant?: TabsVariant;
}

const TabsTab = React.forwardRef<HTMLButtonElement, TabsTabProps>(function TabsTab(
  { className, size = 'xs', tone = 'neutral', variant, ...props },
  ref
) {
  const listVariant = React.useContext(TabsVariantContext);
  const resolved = variant ?? listVariant;
  return (
    <TabsPrimitive.Tab
      ref={ref}
      data-slot="tabs-tab"
      className={cx(
        controlVariants({ variant: 'ghost', tone, size }),
        styles.tab,
        resolved === 'underline' && styles.tabUnderline,
        className
      )}
      {...props}
    />
  );
});

// ── Panel ─────────────────────────────────────────────────────────────────────

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cx(styles.tabsPanel, className)}
      {...props}
    />
  );
}

export const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
};
