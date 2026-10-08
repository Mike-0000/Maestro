import { observer } from 'mobx-react-lite';
import { useApp } from './app-context';
import { cx } from './hooks';

/** Brief messages for things that failed out of sight, such as input that could not be sent. */
export const Toasts = observer(function Toasts() {
  const app = useApp();
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed top-[calc(var(--vv-top,0px)+env(safe-area-inset-top,0px)+0.75rem)] left-1/2 z-50 flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2"
    >
      {app.toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => app.dismissToast(toast.id)}
          className={cx(
            'pointer-events-auto animate-pop-in rounded-2xl border px-4 py-3 text-left text-[14px] leading-snug shadow-xl shadow-black/25',
            toast.tone === 'error'
              ? 'border-danger-line bg-danger-soft text-fg'
              : 'border-line-strong bg-raised text-fg'
          )}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
});
