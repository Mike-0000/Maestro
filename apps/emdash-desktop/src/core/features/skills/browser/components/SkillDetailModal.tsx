import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import { parseFrontmatter } from '@emdash/core/primitives/skills/api';
import { EmptyState, Markdown } from '@emdash/ui/react/components';
import { Button, Dialog, ModalLayout, SectionLabel } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { getCatalogClient } from '@core/features/catalog/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { SkillIconRenderer } from './SkillIconRenderer';

const sourceMeta = {
  openai: { name: 'OpenAI', icon: 'https://github.com/openai.png' },
  anthropic: { name: 'Anthropic', icon: 'https://github.com/anthropics.png' },
  skillssh: { name: 'Skills.sh', icon: 'https://skills.sh/favicon.ico' },
} as const;

export interface SkillDetailModalProps {
  skill: CatalogSkill;
  onInstall: (skillId: string) => Promise<boolean>;
  onUninstall: (skillId: string) => Promise<boolean>;
  onOpenTerminal?: (skillPath: string) => void;
}

export const SkillDetailModal: React.FC<SkillDetailModalProps> = ({
  skill,
  onInstall,
  onUninstall,
  onOpenTerminal,
}) => {
  const { dismiss } = useModalController('skillDetailModal');
  const [isProcessing, setIsProcessing] = useState(false);
  const { data: detailedSkill = skill, isFetching: isLoading } = useQuery({
    queryKey: ['skills', 'detail', skill.id],
    queryFn: async () => {
      const client = await getCatalogClient();
      const result = await client.getSkillContent({ skillId: skill.id });
      if (result.success) return result.data;
      throw new Error(result.error.message);
    },
    placeholderData: skill,
  });

  useCloseGuard(isProcessing);

  const handleInstall = useCallback(async () => {
    setIsProcessing(true);
    try {
      const success = await onInstall(detailedSkill.id);
      if (success) dismiss();
    } finally {
      setIsProcessing(false);
    }
  }, [detailedSkill.id, dismiss, onInstall]);

  const handleUninstall = useCallback(async () => {
    setIsProcessing(true);
    try {
      const success = await onUninstall(detailedSkill.id);
      if (success) dismiss();
    } finally {
      setIsProcessing(false);
    }
  }, [detailedSkill.id, dismiss, onUninstall]);

  const handleOpen = useCallback(() => {
    if (detailedSkill.localPath && onOpenTerminal) {
      onOpenTerminal(detailedSkill.localPath);
    }
  }, [detailedSkill.localPath, onOpenTerminal]);

  const openLink = useMarkdownLinkOpener();

  const body = detailedSkill.skillMdContent
    ? parseFrontmatter(detailedSkill.skillMdContent).body.trim()
    : '';
  const visibleBody = isSkillShPathBody(body) ? '' : body;
  const meta = detailedSkill.source === 'local' ? null : sourceMeta[detailedSkill.source];
  const showLoadingContent = isLoading && !detailedSkill.skillMdContent;

  // The skill's text arrives after the dialog opens and can be long: ModalLayout grows the middle
  // and scrolls it between the fixed header and footer.
  const header = (
    <Dialog.Header>
      <div className="flex min-w-0 items-center gap-3">
        <SkillIconRenderer skill={detailedSkill} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Dialog.Title className="truncate">{detailedSkill.displayName}</Dialog.Title>
          {meta ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
              {/* The library's own mark: a brand image, shown as published. */}
              <img src={meta.icon} alt="" className="size-3.5 rounded-xs" />
              From the {meta.name} skill library
            </span>
          ) : detailedSkill.installed ? (
            <span className="text-xs text-foreground-muted">Installed on this machine</span>
          ) : null}
        </div>
      </div>
    </Dialog.Header>
  );

  const footer = (
    <Dialog.Footer>
      {detailedSkill.installed ? (
        <>
          <Button
            variant="text"
            tone="destructive"
            className="sm:mr-auto"
            onClick={() => void handleUninstall()}
            disabled={isProcessing}
          >
            Uninstall…
          </Button>
          {detailedSkill.localPath && onOpenTerminal && (
            <Button variant="ghost" onClick={handleOpen}>
              <FolderOpen className="size-3.5" aria-hidden />
              Open in terminal
            </Button>
          )}
        </>
      ) : (
        <ConfirmButton
          variant="primary"
          onClick={() => void handleInstall()}
          disabled={isProcessing}
        >
          {isProcessing ? 'Installing…' : 'Install'}
        </ConfirmButton>
      )}
    </Dialog.Footer>
  );

  return (
    <ModalLayout header={header} footer={footer}>
      <Dialog.Body>
        {showLoadingContent && (
          <EmptyState bare tone="loading" label="Loading the skill…" className="min-h-32" />
        )}

        {!showLoadingContent && detailedSkill.defaultPrompt && (
          <section className="flex flex-col gap-1.5">
            <SectionLabel as="h3">Example prompt</SectionLabel>
            <p className="rounded-md bg-surface-emphasis px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-foreground-body">
              {detailedSkill.defaultPrompt}
            </p>
          </section>
        )}

        {!showLoadingContent && visibleBody && (
          <Markdown
            content={visibleBody}
            variant="compact"
            className="text-sm text-foreground-body"
            onOpenLink={openLink}
          />
        )}

        {!showLoadingContent && !detailedSkill.defaultPrompt && !visibleBody && (
          <p className="text-sm text-foreground-muted">{detailedSkill.description}</p>
        )}
      </Dialog.Body>
    </ModalLayout>
  );
};

export const skillDetailModal = defineModal<void>()({
  id: 'skillDetailModal',
  component: SkillDetailModal,
  size: 'lg',
});

function isSkillShPathBody(body: string): boolean {
  return /^\.\.\/.*\/SKILL\.md$/.test(body);
}
