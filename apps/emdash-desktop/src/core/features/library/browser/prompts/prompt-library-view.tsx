import { EmptyState } from '@emdash/ui/react/components';
import {
  CollectionToolbar,
  CollectionView,
  PageLayout,
  useQueryListSource,
} from '@emdash/ui/react/patterns';
import { Button, DropdownMenu, toast } from '@emdash/ui/react/primitives';
import { EllipsisIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { usePromptLibrary } from '@core/features/library/api/browser/prompts/use-prompt-library';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { useSearchFocusHotkeys } from '@core/primitives/keybindings/browser';
import type { PromptLibraryPrompt } from '@core/primitives/prompt-library/api';
import {
  createPromptLibraryListView,
  type PromptLibraryListViewModel,
} from './prompt-library-list-model';

function createPromptId() {
  return globalThis.crypto?.randomUUID?.() ?? `prompt-${Date.now()}`;
}

/** Row content (two-line text + tiered actions) — the CollectionView shell owns interaction. */
function PromptRow({
  item,
  disabled,
  onEdit,
  onDelete,
}: {
  item: PromptLibraryPrompt;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex w-full min-w-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{item.title}</span>
        <span className="line-clamp-1 text-xs text-foreground-muted">{item.prompt}</span>
      </div>
      {/* Trailing actions are explicit controls — clicks must not reach the row. */}
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Button
          variant="ghost"
          size="xs"
          icon
          onClick={onEdit}
          disabled={disabled}
          aria-label={`Edit ${item.title}`}
        >
          <Pencil />
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon
                disabled={disabled}
                aria-label={`Actions for ${item.title}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onClick={onEdit}>
              <Pencil />
              Edit…
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}

export function PromptLibraryView() {
  const {
    value: promptLibrary,
    update: updatePromptLibrary,
    isLoading: isPromptLibraryLoading,
    isSaving: isPromptLibrarySaving,
  } = usePromptLibrary();
  const openPromptModal = useOpenModal('promptModal');
  const openConfirm = useOpenModal('confirmActionModal');

  const isDisabled = isPromptLibraryLoading || isPromptLibrarySaving;

  // The prompt-library hook swallows query errors (optimistic updates roll
  // back instead), so only data and loading are mirrored into the view. While
  // loading, `value` is a fresh `[]` each render — pass undefined instead so
  // the snapshot stays stable.
  const source = useQueryListSource(
    {
      data: isPromptLibraryLoading ? undefined : promptLibrary,
      isLoading: isPromptLibraryLoading,
      isError: false,
      error: null,
    },
    (rows: PromptLibraryPrompt[]) => rows
  );
  const [view] = useState(() => createPromptLibraryListView(source));

  const upsertPrompt = (prompt: PromptLibraryPrompt, successTitle: string) => {
    const exists = promptLibrary.some((item) => item.id === prompt.id);
    const nextPrompts = exists
      ? promptLibrary.map((item) => (item.id === prompt.id ? prompt : item))
      : [...promptLibrary, prompt];
    updatePromptLibrary(nextPrompts, {
      onSuccess: () => toast(successTitle),
    });
  };

  const createPrompt = () => {
    void openPromptModal().then((outcome) => {
      if (!outcome.success) return;
      upsertPrompt({ id: createPromptId(), ...outcome.data }, 'Prompt added');
    });
  };

  const editPrompt = (prompt: PromptLibraryPrompt) => {
    void openPromptModal({
      initialPrompt: prompt,
    }).then((outcome) => {
      if (!outcome.success) return;
      upsertPrompt({ ...prompt, ...outcome.data }, 'Prompt updated');
    });
  };

  const deletePrompt = (prompt: PromptLibraryPrompt) => {
    void openConfirm({
      title: 'Delete prompt?',
      description: `"${prompt.title}" will be removed from the prompt library.`,
      confirmLabel: 'Delete',
    }).then((outcome) => {
      if (!outcome.success) return;
      updatePromptLibrary(
        promptLibrary.filter((item) => item.id !== prompt.id),
        {
          onSuccess: () => toast('Prompt deleted'),
        }
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-col pb-16 text-foreground">
      <PageLayout.Header
        sticky
        title="Prompts"
        description="Reusable prompts you can send from a task's prompt menu."
      />
      <view.Root>
        <CollectionView
          view={view}
          renderRow={(prompt) => (
            <PromptRow
              item={prompt}
              disabled={isDisabled}
              onEdit={() => editPrompt(prompt)}
              onDelete={() => deletePrompt(prompt)}
            />
          )}
          toolbar={<PromptsToolbar view={view} onNewPrompt={createPrompt} disabled={isDisabled} />}
          onItemClick={(prompt) => {
            if (!isDisabled) editPrompt(prompt);
          }}
          emptySlot={<PromptsEmptyState hasPrompts={promptLibrary.length > 0} />}
        />
      </view.Root>
    </div>
  );
}

const PromptsToolbar = observer(function PromptsToolbar({
  view,
  onNewPrompt,
  disabled,
}: {
  view: PromptLibraryListViewModel;
  onNewPrompt: () => void;
  disabled: boolean;
}) {
  const search = view.useSearch();
  const searchRef = useSearchFocusHotkeys();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        ref={searchRef}
        value={search.query}
        onValueChange={search.setQuery}
        placeholder="Search prompts…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Button variant="primary" onClick={onNewPrompt} disabled={disabled} aria-label="New prompt">
          <Plus className="size-4" aria-hidden />
          <span className="[@container(max-width:520px)]:hidden">New prompt</span>
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
});

/** The list's empty state: nothing saved yet, or nothing matching the search. */
function PromptsEmptyState({ hasPrompts }: { hasPrompts: boolean }) {
  return (
    <EmptyState
      bare
      className="min-h-48"
      label={hasPrompts ? 'No prompts match' : 'No prompts yet'}
      description={
        hasPrompts
          ? 'Try a different title or words from the prompt.'
          : 'Save a prompt here to send it from any task.'
      }
    />
  );
}
