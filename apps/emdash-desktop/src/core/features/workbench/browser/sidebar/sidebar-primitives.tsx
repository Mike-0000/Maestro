import * as React from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

export const SidebarContainer = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('group/sidebar relative z-50 flex flex-col text-sm text-foreground', className)}
    {...props}
  />
));
SidebarContainer.displayName = 'SidebarContainer';

export const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 border-b-0', className)} {...props} />
  )
);
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-1 flex-col overflow-hidden text-sm text-muted-foreground', className)}
    {...props}
  />
));
SidebarContent.displayName = 'SidebarContent';

export const SidebarGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mb-6 grid', className)} {...props} />
  )
);
SidebarGroup.displayName = 'SidebarGroup';

export const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('grid gap-1', className)} {...props} />
));
SidebarGroupContent.displayName = 'SidebarGroupContent';

export const SidebarFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mt-auto flex flex-col px-3 py-2', className)} {...props} />
  )
);
SidebarFooter.displayName = 'SidebarFooter';

/** A quiet section heading ("Pinned", "Projects"): 11px passive text, sentence case. */
export function SidebarSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'cursor-default text-tiny font-normal text-foreground-passive select-none',
        className
      )}
    >
      {children}
    </span>
  );
}

export const SidebarMenu = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('', className)} {...props} />
);
SidebarMenu.displayName = 'SidebarMenu';

export const SidebarItemMiniButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      // A translucent step reads one level up on any row fill: rest, hover or active.
      'flex size-6 items-center justify-center rounded-sm text-foreground-passive transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none',
      className
    )}
    onMouseDown={(e) => e.preventDefault()}
    onPointerDown={(e) => e.stopPropagation()}
    {...props}
  />
));
SidebarItemMiniButton.displayName = 'SidebarItemMiniButton';

/**
 * One row of the sunken sidebar. Rest is text on the sidebar's own surface; hover lifts it one
 * surface step and the active row takes the selected step (both resolve through the
 * `surface-sunken` scope on the sidebar root, so every theme gets its own ladder). No outlines:
 * keyboard focus on the row's label draws one thin accent ring around the whole row.
 */
const sidebarMenuItemClass =
  'flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm font-normal text-foreground-muted transition-colors hover:bg-(--em-surface-hover) hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none has-[[data-row-action]:focus-visible]:ring-1 has-[[data-row-action]:focus-visible]:ring-ring data-[active=true]:bg-(--em-surface-selected) data-[active=true]:text-foreground';

interface SidebarMenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
}
export const SidebarMenuButton = React.forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(
  ({ className, isActive, ...props }, ref) => (
    <button
      ref={ref}
      data-slot="button"
      data-active={isActive || undefined}
      className={cn(sidebarMenuItemClass, className)}
      onMouseDown={(e) => e.preventDefault()}
      {...props}
    />
  )
);

// Sidebar row labels use this as the named voice-control target. Primary
// activation is handled by the parent row's click handler via bubbling.
export const SidebarMenuAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    // The row draws the focus ring (see `sidebarMenuItemClass`), so it frames the whole row.
    data-row-action=""
    className={cn(
      'flex min-w-0 flex-1 items-center self-stretch text-left text-inherit outline-none',
      className
    )}
    onMouseDown={(e) => e.preventDefault()}
    {...props}
  />
));
SidebarMenuAction.displayName = 'SidebarMenuAction';

interface SidebarMenuRowProps extends React.HTMLAttributes<HTMLDivElement> {
  isActive?: boolean;
}
export const SidebarMenuRow = React.forwardRef<HTMLDivElement, SidebarMenuRowProps>(
  ({ className, isActive, ...props }, ref) => (
    <div
      ref={ref}
      data-active={isActive || undefined}
      className={cn(sidebarMenuItemClass, className)}
      {...props}
    />
  )
);
