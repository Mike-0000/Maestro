import type { Monaco } from '@monaco-editor/react';
import { cssColorToHex } from '@core/primitives/styling/browser/cssVars';

type MonacoColors = Record<string, string>;

/** Editor colours from the app's `--monaco-*` tokens (renderer/index.css). */
const MONACO_TOKENS: Array<[string, string]> = [
  ['--monaco-bg', 'editor.background'],
  ['--monaco-fg', 'editor.foreground'],
  ['--monaco-line-highlight', 'editor.lineHighlightBackground'],
  ['--monaco-line-number', 'editorLineNumber.foreground'],
  ['--monaco-gutter', 'editorGutter.background'],
  ['--monaco-inserted-text-bg', 'diffEditor.insertedTextBackground'],
  ['--monaco-inserted-line-bg', 'diffEditor.insertedLineBackground'],
  ['--monaco-inserted-text-border', 'diffEditor.insertedTextBorder'],
  ['--monaco-removed-text-bg', 'diffEditor.removedTextBackground'],
  ['--monaco-removed-line-bg', 'diffEditor.removedLineBackground'],
  ['--monaco-removed-text-border', 'diffEditor.removedTextBorder'],
  ['--monaco-unchanged-region-bg', 'diffEditor.unchangedRegionBackground'],
  ['--monaco-diff-border', 'diffEditor.border'],
  ['--monaco-diff-diagonal-fill', 'diffEditor.diagonalFill'],
  ['--monaco-selection-bg', 'editor.selectionBackground'],
  ['--monaco-selection-fg', 'editor.selectionForeground'],
  ['--monaco-inactive-selection-bg', 'editor.inactiveSelectionBackground'],
  // Chrome around the text follows the app's surfaces so the editor sits on the same paper:
  // the minimap and sticky scroll on the editor ground, quiet guides and scrollbars, and the
  // find / suggest / hover widgets on the elevated surface with one hairline.
  ['--monaco-bg', 'minimap.background'],
  ['--monaco-bg', 'editorStickyScroll.background'],
  ['--monaco-line-highlight', 'editorStickyScrollHover.background'],
  ['--foreground-muted', 'editorLineNumber.activeForeground'],
  ['--foreground', 'editorCursor.foreground'],
  ['--border-subtle', 'editorIndentGuide.background1'],
  ['--border', 'editorIndentGuide.activeBackground1'],
  // Translucent, so the diff overview ruler's viewport slider never hides the change marks
  // under it.
  ['--monaco-scrollbar-slider', 'scrollbarSlider.background'],
  ['--monaco-scrollbar-slider-hover', 'scrollbarSlider.hoverBackground'],
  ['--monaco-scrollbar-slider-active', 'scrollbarSlider.activeBackground'],
  ['--em-surface-elevated', 'editorWidget.background'],
  ['--border-subtle', 'editorWidget.border'],
  ['--em-surface-elevated', 'editorSuggestWidget.background'],
  ['--border-subtle', 'editorSuggestWidget.border'],
  ['--em-surface-elevated', 'editorHoverWidget.background'],
  ['--border-subtle', 'editorHoverWidget.border'],
  ['--em-surface-elevated-emphasis', 'input.background'],
  ['--focus-ring', 'focusBorder'],
];

/**
 * Lines drawn by Monaco that the app's chrome does not draw: the overview ruler's edge and the
 * scroll shadow. Dark draws no shadows at all (the widgets separate by surface and hairline).
 */
const TRANSPARENT = '#00000000';
const QUIET_LINES: Record<'emlight' | 'emdark', string[]> = {
  emlight: ['editorOverviewRuler.border', 'scrollbar.shadow'],
  emdark: ['editorOverviewRuler.border', 'scrollbar.shadow', 'widget.shadow'],
};

/**
 * Reads the CSS custom properties above from an element bearing the given
 * theme class, converts each value to a hex string, and returns a Monaco color
 * token map. Entries where the variable is not defined for that theme are
 * omitted.
 */
function readMonacoVarsForTheme(cssClass: 'emlight' | 'emdark'): MonacoColors {
  const el = document.createElement('div');
  el.className = cssClass;
  el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  document.body.appendChild(el);
  const style = getComputedStyle(el);

  const get = (v: string) => style.getPropertyValue(v).trim();

  const colors: MonacoColors = {};
  for (const [cssVar, monacoToken] of MONACO_TOKENS) {
    const value = get(cssVar);
    if (value) {
      colors[monacoToken] = cssColorToHex(value);
    }
  }
  for (const monacoToken of QUIET_LINES[cssClass]) colors[monacoToken] = TRANSPARENT;

  el.remove();
  return colors;
}

export function defineMonacoThemes(monaco: Monaco): void {
  monaco.editor.defineTheme('custom-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: readMonacoVarsForTheme('emdark'),
  });

  monaco.editor.defineTheme('custom-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: readMonacoVarsForTheme('emlight'),
  });
}

export function getMonacoTheme(effectiveTheme: string): string {
  return effectiveTheme === 'emlight' ? 'custom-light' : 'custom-dark';
}
