import { Button, DropdownMenu, Switch, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowUp, Ellipsis, ImagePlus, Trash2, X } from 'lucide-react';
import {
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { MAX_CONDUCTOR_IMAGES, type ConductorImage } from '../../../api/chat-conductor/images';
import { filesOf, readConductorImage } from './composer-images';

export interface ConductorComposerProps {
  textareaRef: Ref<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  /** The conductor cannot run: the field is read-only. */
  disabled: boolean;
  canSend: boolean;
  onChange: (text: string) => void;
  onSend: () => void;
  /** Images that go with the next message. */
  images?: readonly ConductorImage[];
  /** Pasted or dropped images, read and ready to send. */
  onAddImages?: (images: ConductorImage[]) => void;
  onRemoveImage?: (id: string) => void;
}

/** A drag that carries files from outside the app (the desktop, a file manager). */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * The one field the developer writes to the conductor in. It starts as one line and grows with
 * what is typed; Enter sends, Shift+Enter starts a new line, and the send button sits inside the
 * field. Focus shows as an accent ring around the whole field.
 */
export function ConductorComposer({
  textareaRef,
  value,
  placeholder,
  disabled,
  canSend,
  onChange,
  onSend,
  images = [],
  onAddImages,
  onRemoveImage,
}: ConductorComposerProps) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const takesImages = !disabled && onAddImages !== undefined;

  const addFiles = async (files: File[]) => {
    if (!onAddImages || files.length === 0) return;
    const room = MAX_CONDUCTOR_IMAGES - images.length;
    const read = await Promise.all(files.slice(0, Math.max(0, room)).map(readConductorImage));
    const added = read.flatMap((result) => ('image' in result ? [result.image] : []));
    const problems = read.flatMap((result) => ('error' in result ? [result.error] : []));
    if (files.length > room)
      problems.push(`Up to ${MAX_CONDUCTOR_IMAGES} images go with one message.`);
    setNotice(problems.length > 0 ? problems.join(' ') : null);
    if (added.length > 0) onAddImages(added);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!takesImages) return;
    const files = filesOf(event.clipboardData.items);
    if (files.length === 0) return;
    // Text pasted with an image (an office app's copy) still goes into the field.
    if (!event.clipboardData.types.some((type) => type.startsWith('text/'))) {
      event.preventDefault();
    }
    void addFiles(files);
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!takesImages || !carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!takesImages || !carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!takesImages || !carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!takesImages || !carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(filesOf(event.dataTransfer.files));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  };
  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={cn(
          'relative flex flex-col rounded-lg border border-border bg-surface-emphasis transition-[border-color,box-shadow] duration-150',
          'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25',
          disabled && 'opacity-60',
          dragging && 'border-ring ring-3 ring-ring/25'
        )}
      >
        {images.length > 0 && (
          <ul aria-label="Images to send" className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((image) => (
              <li key={image.id} className="group relative">
                <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={image.name}
                  title={image.name}
                  className="size-14 rounded-md border border-border object-cover"
                />
                {onRemoveImage && (
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => onRemoveImage(image.id)}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg bg-surface-emphasis/90 text-sm text-foreground">
            <ImagePlus className="size-4 text-foreground-muted" aria-hidden />
            Drop an image to send it to the conductor
          </div>
        )}
        <div className="flex items-end gap-1 pr-1.5 pl-4">
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            disabled={disabled}
            aria-label="Message the conductor"
            placeholder={placeholder}
            className="field-sizing-content max-h-60 min-w-0 flex-1 resize-none bg-transparent py-3 text-sm leading-normal text-foreground outline-none placeholder:text-foreground-passive disabled:cursor-not-allowed"
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <span className="flex shrink-0 py-2">
            <Button
              type="button"
              variant={canSend ? 'primary' : 'ghost'}
              size="sm"
              icon
              aria-label="Send"
              disabled={!canSend}
              onClick={onSend}
            >
              <ArrowUp aria-hidden />
            </Button>
          </span>
        </div>
      </div>
      {notice && (
        <p role="status" className="mt-1 text-tiny text-foreground-warning">
          {notice}
        </p>
      )}
    </div>
  );
}

export interface ComposerToolsProps {
  ready: boolean;
  autonomy: boolean;
  onAutonomyChange: (on: boolean) => void;
  /** YOLO mode: the conductor makes every decision and asks only when blocked. */
  yolo: boolean;
  onYoloChange: (on: boolean) => void;
  onCatchUp: () => void;
  canClear: boolean;
  onClear: () => void;
}

/**
 * The small controls under the composer: acting on the developer's behalf, YOLO mode, catch-up,
 * the menu.
 */
export function ComposerTools({
  ready,
  autonomy,
  onAutonomyChange,
  yolo,
  onYoloChange,
  onCatchUp,
  canClear,
  onClear,
}: ComposerToolsProps) {
  return (
    <div className="mt-1.5 flex h-7 items-center gap-1 text-xs text-foreground-muted">
      <Tooltip.Root>
        <Tooltip.Trigger
          render={<span className="flex h-6 items-center gap-2 rounded-md pr-1 pl-0.5" />}
        >
          <Switch
            size="sm"
            checked={autonomy}
            onCheckedChange={(on) => onAutonomyChange(on)}
            aria-label="Act on my behalf"
          />
          <span className="cursor-pointer select-none" onClick={() => onAutonomyChange(!autonomy)}>
            Act on my behalf
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" align="start" className="max-w-xs">
          On: when the agent finishes or asks something while you are away, the conductor may prompt
          it, answer it or interrupt it, within what you asked for. Off: it only tells you what
          happened and what it would do. What you ask for directly is always done.
        </Tooltip.Content>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={<span className="flex h-6 items-center gap-2 rounded-md pr-1 pl-0.5" />}
        >
          <Switch
            size="sm"
            checked={yolo}
            onCheckedChange={(on) => onYoloChange(on)}
            aria-label="YOLO"
          />
          <span
            className={cn(
              'cursor-pointer select-none',
              yolo && 'font-medium text-foreground-warning'
            )}
            onClick={() => onYoloChange(!yolo)}
          >
            YOLO
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" align="start" className="max-w-xs">
          On: give the conductor a goal and it carries it through to the end, making every decision
          itself, answering the agents and their permission prompts, and telling you when it is
          done. It asks only when truly blocked: a sign-in or secret, a payment, a step that cannot
          be undone, or one that reaches beyond this project, such as a push to a shared branch.
          Turns on acting for you.
        </Tooltip.Content>
      </Tooltip.Root>
      <Button type="button" variant="ghost" size="xs" disabled={!ready} onClick={onCatchUp}>
        Catch me up
      </Button>
      <span className="flex-1" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <Button type="button" variant="ghost" size="xs" icon aria-label="Thread options" />
          }
        >
          <Ellipsis aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" side="top" width="content">
          <DropdownMenu.Item variant="destructive" disabled={!canClear} onClick={onClear}>
            <Trash2 aria-hidden />
            Clear thread
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}
