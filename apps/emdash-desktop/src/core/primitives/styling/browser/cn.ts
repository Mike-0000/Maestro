import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Font sizes the app defines in `src/renderer/index.css` `@theme` beyond Tailwind's
 * t-shirt scale. Without registering them, tailwind-merge reads `text-tiny` as a text
 * colour and drops it when a colour such as `text-foreground-passive` follows.
 */
const CUSTOM_FONT_SIZES = ['micro', 'tiny'];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: CUSTOM_FONT_SIZES }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
