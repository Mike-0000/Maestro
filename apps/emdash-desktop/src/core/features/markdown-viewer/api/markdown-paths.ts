/**
 * What counts as a Markdown document, and how a reference inside one (an image source, a link) is
 * read as a path. Pure: whether a path may be shown is decided in the main process, by
 * `node/markdown-access.ts`.
 */

const MARKDOWN_EXTENSION_RE = /\.(?:md|mdx|markdown)$/iu;
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/iu;
/** Two or more characters before the colon, so a Windows drive letter is not taken for a scheme. */
const URL_SCHEME_RE = /^[a-z][a-z\d+.-]+:/iu;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION_RE.test(path.trim());
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION_RE.test(path.trim());
}

/** The file name of a path written with either separator. */
export function fileNameOf(path: string): string {
  return (
    path
      .split(/[\\/]/u)
      .filter((segment) => segment.length > 0)
      .at(-1) ?? path
  );
}

/**
 * A reference inside a document as a file path: without its query and fragment, percent-decoded.
 * Null for anything that is not a file path (a URL, a protocol-relative URL, a bare anchor).
 */
export function localReferencePath(reference: string): string | null {
  const cleaned = reference.trim().split('#')[0]?.split('?')[0] ?? '';
  if (!cleaned) return null;
  if (/^[/\\]{2}/u.test(cleaned) || URL_SCHEME_RE.test(cleaned)) return null;
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}
