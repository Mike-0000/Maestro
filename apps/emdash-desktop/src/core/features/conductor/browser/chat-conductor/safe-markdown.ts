/** Fenced blocks and inline code: literal text, left exactly as written. */
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;
const IMAGE_OPEN = /!\[(?=[^\]]*\](?:\(|\[|:))/g;

/**
 * A conductor message with its images turned into links. The message is written by a model that
 * read untrusted agent output, and an image loads the moment it renders: an address planted in
 * that output could carry what the conductor knows off the machine without a click. A link goes
 * nowhere until the developer opens it.
 */
export function withoutImages(markdown: string): string {
  return markdown
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(IMAGE_OPEN, '[')))
    .join('');
}
