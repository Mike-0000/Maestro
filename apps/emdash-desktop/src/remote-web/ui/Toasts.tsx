import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { StateMark } from './StatusIndicator';

/**
 * Brief messages for things that failed out of sight, such as input that could not be sent.
 * The desktop's toast: the elevated surface with a hairline, the error dot when it is one, no
 * tinted fill. Tapping one dismisses it.
 */
export const Toasts = observer(function Toasts() {
  const app = useApp();
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed top-[calc(var(--vv-top,0px)+env(safe-area-inset-top,0px)+0.75rem)] left-1/2 z-50 flex w-[min(calc(100vw-2rem),26rem)] -translate-x-1/2 flex-col gap-2"
    >
      {app.toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => app.dismissToast(toast.id)}
          className="surface-elevated animate-pop-in text-body shadow-float pointer-events-auto flex min-h-11 items-start gap-2.5 rounded-lg border border-border-subtle bg-surface px-4 py-3 text-left text-foreground"
        >
          {toast.tone === 'error' ? (
            <StateMark state="error" label="Error" className="mt-[3px]" />
          ) : null}
          <span className="min-w-0 break-words">{toast.text}</span>
        </button>
      ))}
    </div>
  );
});
