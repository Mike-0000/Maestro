import {
  Button,
  Checkbox,
  Dialog,
  Input,
  ModalLayout,
  Spinner,
  Textarea,
} from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ImagePlus, Paperclip, XIcon } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useAccounts } from '@core/features/integrations/api/browser/use-provider-accounts';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { useModalController } from '@core/manifests/browser/modal-api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useAttachments } from '@core/primitives/react-hooks/browser/use-attachments';
import { cn } from '@core/primitives/styling/browser/cn';
import { EMDASH_ISSUES_NEW_URL } from '@core/primitives/urls/api/urls';
import { useFeedbackSubmit } from './use-feedback-submit';

type FeedbackModalArgs = {
  blurb?: string;
};

/** An attached image: a small tile with a remove glyph that shows on hover or focus. */
function AttachmentThumbnail({
  name,
  previewUrl,
  onRemove,
  disabled,
}: {
  name: string;
  previewUrl: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="group/thumb relative size-14 shrink-0 overflow-hidden rounded-md bg-surface-emphasis ring-1 ring-border-subtle">
      <img src={previewUrl} alt={name} className="size-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        disabled={disabled}
        className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-sm bg-surface-elevated text-foreground-muted opacity-0 ring-1 ring-border-subtle transition-opacity group-hover/thumb:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-0"
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </div>
  );
}

export function FeedbackModal({ blurb }: FeedbackModalArgs) {
  const controller = useModalController('feedbackModal');
  const [includeDiagnosticLogs, setIncludeDiagnosticLogs] = useState(false);
  const { data: githubAccounts } = useAccounts('github');
  const githubLogin = githubAccounts?.find((account) => account.isDefault)?.login;
  const appVersion = getUpdateStore().currentVersion;
  const { data: platformDisplayName } = useQuery({
    queryKey: ['app', 'platformDisplayName'],
    queryFn: async () => (await getHostClient()).getPlatformDisplayName(),
    staleTime: Infinity,
  });
  const {
    attachments,
    isDraggingOver,
    fileInputRef,
    removeAttachment,
    openFilePicker,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    reset: resetAttachments,
  } = useAttachments();

  const {
    feedbackDetails,
    setFeedbackDetails,
    contactEmail,
    setContactEmail,
    submitting,
    errorMessage,
    contactEmailError,
    clearError,
    clearContactEmailError,
    handleSubmit,
    canSubmit,
  } = useFeedbackSubmit({
    githubLogin,
    appVersion,
    platformDisplayName,
    onSuccess: () => {
      resetAttachments();
      setIncludeDiagnosticLogs(false);
      controller.complete();
    },
  });

  const handleFormSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const loadDiagnosticLog = includeDiagnosticLogs
        ? async () => {
            const attachment = await (await getHostClient()).getDiagnosticLogAttachment();
            return new File([attachment.content], attachment.filename, {
              type: attachment.mimeType,
            });
          }
        : undefined;
      await handleSubmit(
        attachments.map((attachment) => attachment.file),
        loadDiagnosticLog
      );
    },
    [handleSubmit, attachments, includeDiagnosticLogs]
  );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
    >
      {isDraggingOver && (
        // The same drop language as the sidebar: the dialog's own surface dims over its content
        // and a thin accent edge says where the image will go.
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface/90 ring-1 ring-ring ring-inset">
          <ImagePlus className="size-6 text-foreground-muted" aria-hidden />
          <span className="text-sm text-foreground">Drop an image to attach it</span>
        </div>
      )}
      <ModalLayout
        title="Send feedback"
        description={blurb ?? 'What works, what gets in your way, what you would change.'}
        leading={
          <>
            <Button type="button" variant="text" onClick={openFilePicker} disabled={submitting}>
              <Paperclip className="size-3.5" aria-hidden />
              Attach image
            </Button>
            <a
              href={EMDASH_ISSUES_NEW_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-sm text-foreground-muted underline decoration-foreground-passive/60 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Open a GitHub issue
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          </>
        }
        actions={
          <ConfirmButton
            variant="primary"
            type="submit"
            form="feedback-form"
            disabled={!canSubmit}
            aria-busy={submitting}
          >
            {submitting ? (
              <>
                <Spinner size="sm" />
                <span>Sending…</span>
              </>
            ) : (
              <span>Send</span>
            )}
          </ConfirmButton>
        }
      >
        <Dialog.Body>
          <form id="feedback-form" className="flex flex-col gap-5" onSubmit={handleFormSubmit}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="feedback-details" className="text-sm text-foreground">
                Your feedback
              </label>
              <Textarea
                id="feedback-details"
                autoFocus
                rows={5}
                placeholder="What do you like? What should change?"
                className="resize-none"
                value={feedbackDetails}
                onChange={(event) => {
                  setFeedbackDetails(event.target.value);
                  if (errorMessage) clearError();
                }}
                onPaste={handlePaste}
              />
              {attachments.length > 0 ? (
                <div className={cn('mt-1.5 flex flex-wrap gap-2', submitting && 'opacity-50')}>
                  {attachments.map((attachment, index) => (
                    <AttachmentThumbnail
                      key={attachment.id}
                      name={attachment.file.name}
                      previewUrl={attachment.previewUrl}
                      onRemove={() => removeAttachment(index)}
                      disabled={submitting}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-foreground-passive">
                  Paste or drop a screenshot to attach it.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="feedback-contact" className="text-sm text-foreground">
                Email <span className="text-foreground-passive">(optional, for a reply)</span>
              </label>
              <Input
                id="feedback-contact"
                type="text"
                placeholder="you@example.com"
                value={contactEmail}
                aria-invalid={contactEmailError ? 'true' : undefined}
                aria-describedby={contactEmailError ? 'feedback-contact-error' : undefined}
                onChange={(event) => {
                  setContactEmail(event.target.value);
                  if (errorMessage) clearError();
                  if (contactEmailError) clearContactEmailError();
                }}
              />
              {contactEmailError ? (
                <p
                  id="feedback-contact-error"
                  className="text-xs text-foreground-error"
                  role="alert"
                >
                  {contactEmailError}
                </p>
              ) : null}
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                className="mt-0.5"
                checked={includeDiagnosticLogs}
                onCheckedChange={(checked) => setIncludeDiagnosticLogs(Boolean(checked))}
                disabled={submitting}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">Include diagnostic logs</span>
                <span className="text-xs text-foreground-muted">
                  Recent app logs, with sensitive details removed.
                </span>
              </span>
            </label>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              multiple
              onChange={handleFileInputChange}
              disabled={submitting}
            />

            {errorMessage ? (
              <p className="flex items-start gap-2 text-xs text-foreground-error" role="alert">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" />
                {errorMessage}
              </p>
            ) : null}
          </form>
        </Dialog.Body>
      </ModalLayout>
    </div>
  );
}

export const feedbackModal = defineModal<void>()({
  id: 'feedbackModal',
  component: FeedbackModal,
});
