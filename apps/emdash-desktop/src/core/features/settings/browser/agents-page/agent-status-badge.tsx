// Agent and installation states in words (design brief 2.6): caption-sized text, no tinted
// chips. Only "Update available" carries a colour, the warning tone; everything else reads in the
// passive or muted tone so success never needs green.

const QUIET = 'shrink-0 text-xs whitespace-nowrap text-foreground-passive';

export function InstalledBadge() {
  return <span className={QUIET}>Installed</span>;
}

export function UninstalledBadge() {
  return <span className={QUIET}>Not installed</span>;
}

export function UpdateAvailableBadge() {
  return (
    <span className="shrink-0 text-xs whitespace-nowrap text-foreground-warning">
      Update available
    </span>
  );
}

export function RecommendedBadge() {
  return <span className={QUIET}>Recommended</span>;
}

export function UsedBadge() {
  return <span className="shrink-0 text-xs whitespace-nowrap text-foreground-muted">In use</span>;
}

export function InstallingBadge() {
  return <span className={QUIET}>Installing…</span>;
}

export function UpdatingBadge() {
  return <span className={QUIET}>Updating…</span>;
}
