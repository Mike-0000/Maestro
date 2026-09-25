/**
 * Turns a Chrome DevTools Protocol accessibility tree (`Accessibility.getFullAXTree`) into a
 * compact outline a model can read and act on:
 *
 *   - heading "Sign up" level=1
 *   - textbox "Email" value="" [ref=e3]
 *   - button "Create account" [ref=e4]
 *
 * Interactive nodes get refs (`e<n>`) that map back to DOM nodes for clicks and typing. Pure so
 * it can be tested against recorded trees.
 */

/** The subset of CDP's `Accessibility.AXNode` this module reads. */
export type AXNodeLike = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
};

export type AXOutline = {
  text: string;
  /** ref → backend DOM node id. */
  refs: Map<string, number>;
  truncated: boolean;
  interactiveCount: number;
};

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
]);

/** Structural roles worth showing when they carry a name. */
const NAMED_STRUCTURE_ROLES: ReadonlySet<string> = new Set([
  'heading',
  'img',
  'image',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'navigation',
  'main',
  'form',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'region',
  'article',
  'list',
  'listitem',
]);

const SHOWN_PROPERTIES = [
  'disabled',
  'checked',
  'pressed',
  'expanded',
  'selected',
  'required',
  'invalid',
  'focused',
  'level',
] as const;

const DEFAULT_MAX_CHARS = 12_000;
const MAX_NAME_CHARS = 120;

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clip(text: string, max = MAX_NAME_CHARS): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

function attributes(node: AXNodeLike): string {
  const parts: string[] = [];
  for (const property of node.properties ?? []) {
    if (!(SHOWN_PROPERTIES as readonly string[]).includes(property.name)) continue;
    const value = property.value?.value;
    if (value === false || value === undefined || value === 'false') continue;
    parts.push(
      value === true || value === 'true' ? property.name : `${property.name}=${str(value)}`
    );
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function buildAXOutline(
  nodes: readonly AXNodeLike[],
  options: { maxChars?: number } = {}
): AXOutline {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  let interactiveCount = 0;
  let refSeq = 0;
  const visited = new Set<string>();

  const push = (line: string): boolean => {
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };

  const visit = (node: AXNodeLike, depth: number, parentName: string): void => {
    if (truncated || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = str(node.role?.value);
    const name = clip(str(node.name?.value));
    let shown = false;
    if (!node.ignored) {
      const indent = '  '.repeat(depth);
      if (INTERACTIVE_ROLES.has(role)) {
        let ref = '';
        if (node.backendDOMNodeId !== undefined) {
          ref = `e${++refSeq}`;
          refs.set(ref, node.backendDOMNodeId);
        }
        interactiveCount++;
        const value = str(node.value?.value);
        const valuePart =
          role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton'
            ? ` value=${quote(clip(value, 80))}`
            : '';
        shown = push(
          `${indent}- ${role}${name ? ` ${quote(name)}` : ''}${valuePart}${attributes(node)}${ref ? ` [ref=${ref}]` : ''}`
        );
      } else if (NAMED_STRUCTURE_ROLES.has(role) && name) {
        shown = push(`${indent}- ${role} ${quote(name)}${attributes(node)}`);
      } else if ((role === 'StaticText' || role === 'text') && name && name !== parentName) {
        shown = push(`${indent}- text: ${name}`);
      }
    }
    const childDepth = shown ? depth + 1 : depth;
    const childParentName = shown ? name : parentName;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, childParentName);
      if (truncated) return;
    }
  };

  for (const root of roots) visit(root, 0, '');
  return { text: lines.join('\n'), refs, truncated, interactiveCount };
}
