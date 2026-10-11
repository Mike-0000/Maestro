import { isMarkdownPath } from '../markdown-paths';

/** The agent conversation a clicked path came from. */
export type MarkdownLinkSource = {
  readonly projectId: string;
  readonly taskId: string;
  /** A canvas window opens beside this conversation's agent. */
  readonly conversationId?: string;
};

/** Opens a Markdown file in the viewer; false when the viewer may not show it. */
export type MarkdownLinkOpener = (source: MarkdownLinkSource, path: string) => Promise<boolean>;

let opener: MarkdownLinkOpener | undefined;

/**
 * Seeded once at startup by the slice's app store. Terminals and chat transcripts route their
 * Markdown links through this seam, so they do not import the windows the viewer opens in.
 */
export function seedMarkdownLinkOpener(next: MarkdownLinkOpener | undefined): void {
  opener = next;
}

/**
 * A file-link handler for an agent's terminal or chat: a Markdown path opens in the viewer, and
 * anything else, or a Markdown file the viewer may not show, goes to `otherwise` as before.
 */
export function viaMarkdownViewer(
  source: MarkdownLinkSource,
  otherwise: (filePath: string) => void
): (filePath: string) => void {
  return (filePath) => {
    const open = opener;
    if (!open || !isMarkdownPath(filePath)) {
      otherwise(filePath);
      return;
    }
    void open(source, filePath).then(
      (opened) => {
        if (!opened) otherwise(filePath);
      },
      () => otherwise(filePath)
    );
  };
}
