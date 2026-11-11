import type { HostRef } from '@emdash/core/primitives/host/api';
import { isValidSkillName } from '@emdash/core/primitives/skills/api';
import { Button, Dialog, Field, Input, ModalLayout, Textarea } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { captureTelemetry } from '@core/primitives/telemetry/browser/telemetry-client';
import { getSkillsClient } from '../client';

export function CreateSkillModal({ host }: { host: HostRef }) {
  const { complete, dismiss } = useModalController('createSkillModal');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useCloseGuard(isCreating);

  const handleCreateSkill = async () => {
    setCreateError(null);

    const trimmedName = name.trim();
    if (!isValidSkillName(trimmedName)) {
      setCreateError('Name must be lowercase letters, numbers, and hyphens (2-64 chars).');
      return;
    }
    if (!description.trim()) {
      setCreateError('Description is required.');
      return;
    }

    setIsCreating(true);
    try {
      const client = await getSkillsClient();
      const result = await client.create({
        host,
        name: trimmedName,
        description: description.trim(),
        content: content.trim(),
      });

      if (!result.success) {
        setCreateError(result.error.message || 'Failed to create skill');
        return;
      }

      captureTelemetry('skill_created');
      complete();
      void queryClient.invalidateQueries({ queryKey: ['skills', 'catalog'] });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to create skill');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ModalLayout
      title="New skill"
      description="Agents load a skill when a task calls for it. Write when to use it and how."
      actions={
        <>
          <Button type="button" variant="ghost" onClick={dismiss} disabled={isCreating}>
            Cancel
          </Button>
          <ConfirmButton
            variant="primary"
            type="button"
            onClick={() => void handleCreateSkill()}
            disabled={isCreating}
          >
            {isCreating ? 'Creating…' : 'Create skill'}
          </ConfirmButton>
        </>
      }
    >
      <Dialog.Body>
        <Field.Root>
          <Field.Label htmlFor="skill-name">Name</Field.Label>
          <Input
            id="skill-name"
            placeholder="my-skill"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setCreateError(null);
            }}
            className="font-mono"
          />
          <Field.Description>Lowercase letters, numbers and hyphens.</Field.Description>
        </Field.Root>

        <Field.Root>
          <Field.Label htmlFor="skill-desc">Description</Field.Label>
          <Input
            id="skill-desc"
            placeholder="What does this skill do, and when should an agent use it?"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setCreateError(null);
            }}
          />
        </Field.Root>

        <Field.Root>
          <Field.Label htmlFor="skill-content">Instructions</Field.Label>
          <Textarea
            id="skill-content"
            placeholder="Write the skill's instructions. The name and description are added as its front matter."
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setCreateError(null);
            }}
            className="field-sizing-fixed h-64 max-h-[40dvh] resize-y overflow-y-auto font-mono text-xs leading-relaxed"
          />
          <Field.Description>
            What the skill does and how agents should use it, in Markdown.
          </Field.Description>
        </Field.Root>

        {createError && <p className="text-xs text-foreground-error">{createError}</p>}
      </Dialog.Body>
    </ModalLayout>
  );
}

export const createSkillModal = defineModal<void>()({
  id: 'createSkillModal',
  component: CreateSkillModal,
});
