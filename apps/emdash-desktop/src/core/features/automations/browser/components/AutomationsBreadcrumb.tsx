/** The title bar's place marker for the Automations view, in the breadcrumb's caption size. */
export function AutomationsBreadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center px-2 text-xs">
      <span aria-current="page" className="truncate text-foreground-muted">
        Automations
      </span>
    </nav>
  );
}
