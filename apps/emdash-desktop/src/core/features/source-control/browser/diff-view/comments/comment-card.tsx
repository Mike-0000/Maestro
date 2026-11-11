import { Textarea, type TextareaProps } from '@emdash/ui/react/primitives';
import React, { forwardRef, useEffect } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

export function useTextareaAutoFocus(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  active: boolean
) {
  useEffect(() => {
    if (!active) return;

    const focusTextarea = () => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.select();
    };

    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        focusTextarea();
      });
    });
    const timer = setTimeout(() => {
      focusTextarea();
    }, 80);

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [active, ref]);
}

const CommentRoot = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Fixed height: the Monaco view zone that hosts it is sized to match
        // (COMMENT_ZONE_HEIGHT_PX). An elevated card with one hairline, no shadow.
        'surface-elevated flex h-[140px] w-full flex-col rounded-lg border border-border-subtle bg-surface text-foreground',
        className
      )}
      {...props}
    />
  )
);
CommentRoot.displayName = 'CommentRoot';

const CommentHeader = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-row items-center justify-between gap-2 pt-2 pr-2 pb-1 pl-4',
        className
      )}
      {...props}
    />
  )
);
CommentHeader.displayName = 'CommentHeader';

const CommentTitle = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex min-w-0 items-baseline gap-2 text-xs font-medium text-foreground',
        className
      )}
      {...props}
    />
  )
);
CommentTitle.displayName = 'CommentTitle';

const CommentMeta = forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('text-tiny font-normal text-foreground-passive tabular-nums', className)}
      {...props}
    />
  )
);
CommentMeta.displayName = 'CommentMeta';

const CommentActions = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-0.5', className)} {...props} />
  )
);
CommentActions.displayName = 'CommentActions';

const CommentBody = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('min-h-0 flex-1 overflow-hidden px-3 pb-3', className)}
      {...props}
    />
  )
);
CommentBody.displayName = 'CommentBody';

const CommentTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    // The kit textarea grows with its text; here it fills the fixed-height card instead.
    <Textarea ref={ref} className={cn('h-full resize-none text-sm', className)} {...props} />
  )
);
CommentTextarea.displayName = 'CommentTextarea';

export const Comment = {
  Root: CommentRoot,
  Header: CommentHeader,
  Title: CommentTitle,
  Meta: CommentMeta,
  Actions: CommentActions,
  Body: CommentBody,
  Textarea: CommentTextarea,
};
