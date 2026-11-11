import { Fragment } from 'react';
import { inlineCodeParts } from './inline-code';

/**
 * Text as the conductor wrote it, with backtick spans set as code that can be selected and
 * copied; nothing else is parsed. Long paths and commands wrap anywhere rather than push the
 * reading column wide.
 */
export function InlineText({ text }: { text: string }) {
  return inlineCodeParts(text).map((part, index) =>
    part.code ? (
      <code
        key={index}
        className="rounded-sm bg-foreground/8 box-decoration-clone px-[0.3em] py-px font-mono text-[0.86em] [overflow-wrap:anywhere] text-foreground"
      >
        {part.text}
      </code>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    )
  );
}
