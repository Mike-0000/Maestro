import { Command } from 'cmdk';
import { Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { PALETTE_PROVIDER_CATALOG } from '@core/manifests/browser/palette-provider-catalog';
import { Shortcut } from '@core/primitives/keybindings/browser/shortcut';
import { defineModal } from '@core/primitives/modals/react';
import {
  PaletteController,
  type PaletteContext,
  type PaletteProviderCatalog,
  type PaletteProviderDef,
  type PaletteResult,
} from '@core/primitives/palette/api';
import { cn } from '@core/primitives/styling/browser/cn';

interface CommandPaletteProps {
  projectId?: string;
  taskId?: string;
  workspaceId?: string;
}

interface InputChrome {
  readonly value: string;
  readonly keyword?: string;
}

interface CommandPaletteViewProps {
  readonly context: PaletteContext;
  readonly providerCatalog: PaletteProviderCatalog<readonly PaletteProviderDef[]>;
  readonly onClose: () => void;
}

// Section headings in the group-label role: quiet 11px passive text, sentence case, with room
// above so groups separate by space rather than rules.
const GROUP_CLASS = cn(
  '[&:not(:first-child)]:mt-2',
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
  '[&_[cmdk-group-heading]]:text-tiny [&_[cmdk-group-heading]]:text-foreground-passive',
  '[&_[cmdk-group-heading]]:select-none'
);

function getInputChrome(
  input: string,
  providerCatalog: PaletteProviderCatalog<readonly PaletteProviderDef[]>
): InputChrome {
  const trimmed = input.trimStart();
  const separator = trimmed.search(/\s/);
  const token = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const provider = providerCatalog.byKeyword(token);
  if (!provider) return { value: input };
  return {
    value: separator === -1 ? '' : trimmed.slice(separator).trimStart(),
    keyword: provider.keyword,
  };
}

function PaletteResultRow({ result, onSelect }: { result: PaletteResult; onSelect: () => void }) {
  const Renderer = result.provider.render;
  return <Renderer match={result.match} value={result.identity} onSelect={onSelect} />;
}

function PaletteResults({
  results,
  onSelect,
}: {
  results: readonly PaletteResult[];
  onSelect: () => void;
}) {
  const rows: React.ReactNode[] = [];
  let index = 0;

  while (index < results.length) {
    const result = results[index];
    const section = result?.match.section;
    if (!result) break;
    if (!section) {
      rows.push(<PaletteResultRow key={result.identity} result={result} onSelect={onSelect} />);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < results.length && results[end]?.match.section === section) end += 1;
    rows.push(
      <Command.Group key={`${section}:${index}`} heading={section} className={GROUP_CLASS}>
        {results.slice(index, end).map((sectionResult) => (
          <PaletteResultRow
            key={sectionResult.identity}
            result={sectionResult}
            onSelect={onSelect}
          />
        ))}
      </Command.Group>
    );
    index = end;
  }

  return rows;
}

export function CommandPaletteView({
  context: contextInput,
  providerCatalog,
  onClose,
}: CommandPaletteViewProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useMemo(() => new PaletteController(providerCatalog), [providerCatalog]);
  const context = useMemo(
    () => ({
      projectId: contextInput.projectId,
      taskId: contextInput.taskId,
      workspaceId: contextInput.workspaceId,
    }),
    [contextInput.projectId, contextInput.taskId, contextInput.workspaceId]
  );
  const subscribe = useMemo(() => controller.subscribe.bind(controller), [controller]);
  const getSnapshot = useMemo(() => controller.getSnapshot.bind(controller), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const inputChrome = getInputChrome(input, providerCatalog);

  useEffect(() => {
    void controller.setInput(input, context, input.trim() ? 100 : 0);
  }, [context, controller, input]);

  const handleInputChange = (value: string) => {
    setInput(inputChrome.keyword ? `${inputChrome.keyword} ${value}` : value);
  };

  const clearMode = () => {
    setInput(inputChrome.value);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <Command
      className="flex flex-col overflow-hidden"
      value={snapshot.selectedIdentity ?? ''}
      onValueChange={(identity) => controller.select(identity)}
      shouldFilter={false}
      loop
    >
      {/* The search line: a passive glyph, the scope chip when a keyword narrows the search,
          then the input. No rule under it; the results start a step of space below. */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Search className="size-4 shrink-0 text-foreground-passive" aria-hidden />
        {inputChrome.keyword && (
          <button
            type="button"
            aria-label={`Clear ${inputChrome.keyword} mode`}
            className="flex h-6 shrink-0 items-center gap-1 rounded-sm bg-surface-emphasis pr-1 pl-2 text-xs text-foreground-muted transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearMode}
          >
            {inputChrome.keyword.replace(/^@/, '')}
            <X className="size-3 text-foreground-passive" aria-hidden />
          </button>
        )}
        <Command.Input
          ref={inputRef}
          value={inputChrome.value}
          onValueChange={handleInputChange}
          onKeyDown={(event) => {
            if (
              event.key === 'Backspace' &&
              inputChrome.keyword &&
              inputChrome.value.length === 0
            ) {
              event.preventDefault();
              clearMode();
            }
          }}
          placeholder="Search tasks, projects and actions…"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-foreground-passive"
          autoFocus
        />
      </div>
      <Command.List className="h-96 overflow-y-auto px-2 pb-2">
        {snapshot.query && !snapshot.pending && (
          <Command.Empty className="flex flex-col items-center gap-1 px-6 pt-16 text-center">
            <span className="text-sm font-medium text-foreground">Nothing matches</span>
            <span className="max-w-xs text-xs break-words text-foreground-muted">
              No task, project, file or action for &ldquo;{snapshot.query}&rdquo;.
            </span>
          </Command.Empty>
        )}
        <PaletteResults results={snapshot.results} onSelect={onClose} />
      </Command.List>

      {/* Key hints in the caption role, on the same surface: no rule above them. */}
      <div className="flex h-9 shrink-0 items-center gap-5 px-4 text-tiny text-foreground-passive">
        <span className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5">
            <Shortcut hotkey="ArrowUp" variant="keycaps" />
            <Shortcut hotkey="ArrowDown" variant="keycaps" />
          </span>
          Move
        </span>
        <span className="flex items-center gap-1.5">
          <Shortcut hotkey="Enter" variant="keycaps" />
          Open
        </span>
        <span className="flex items-center gap-1.5">
          <Shortcut hotkey="Escape" variant="keycaps" />
          Close
        </span>
      </div>
    </Command>
  );
}

export function CommandPaletteModal({ projectId, taskId, workspaceId }: CommandPaletteProps) {
  const { dismiss } = useModalController('commandPaletteModal');
  const context = useMemo(
    () => ({ projectId, taskId, workspaceId }),
    [projectId, taskId, workspaceId]
  );
  return (
    <CommandPaletteView
      context={context}
      providerCatalog={PALETTE_PROVIDER_CATALOG}
      onClose={dismiss}
    />
  );
}

export const commandPaletteModal = defineModal<void>()({
  id: 'commandPaletteModal',
  component: CommandPaletteModal,
  // Wide enough for a file path beside its name; hung from the upper third, where a palette
  // is expected, so its fixed-height list never makes it jump.
  size: 'lg',
  position: 'top',
});
