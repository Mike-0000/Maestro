import { describe, expect, it } from 'vitest';
import { buildAXOutline, type AXNodeLike } from './ax-outline';

function node(
  nodeId: string,
  role: string,
  name: string,
  extra: Partial<AXNodeLike> = {}
): AXNodeLike {
  return { nodeId, role: { value: role }, name: { value: name }, ...extra };
}

const signupForm: AXNodeLike[] = [
  node('1', 'RootWebArea', 'Sign up', { childIds: ['2', '3', '6'] }),
  node('2', 'heading', 'Create your account', {
    parentId: '1',
    properties: [{ name: 'level', value: { value: 1 } }],
    childIds: ['2a'],
  }),
  node('2a', 'StaticText', 'Create your account', { parentId: '2' }),
  node('3', 'form', '', { parentId: '1', childIds: ['4', '5'] }),
  node('4', 'textbox', 'Email', {
    parentId: '3',
    backendDOMNodeId: 40,
    value: { value: 'a@b.co' },
    properties: [{ name: 'required', value: { value: true } }],
  }),
  node('5', 'button', 'Create account', {
    parentId: '3',
    backendDOMNodeId: 50,
    properties: [{ name: 'disabled', value: { value: false } }],
  }),
  node('6', 'generic', '', { parentId: '1', ignored: true, childIds: ['7'] }),
  node('7', 'StaticText', 'Already have one? Sign in', { parentId: '6' }),
];

describe('buildAXOutline', () => {
  it('renders interactive nodes with refs and structural nodes with names', () => {
    const outline = buildAXOutline(signupForm);
    expect(outline.text).toBe(
      [
        '- heading "Create your account" level=1',
        '- textbox "Email" value="a@b.co" required [ref=e1]',
        '- button "Create account" [ref=e2]',
        '- text: Already have one? Sign in',
      ].join('\n')
    );
    expect(outline.refs.get('e1')).toBe(40);
    expect(outline.refs.get('e2')).toBe(50);
    expect(outline.interactiveCount).toBe(2);
    expect(outline.truncated).toBe(false);
  });

  it('nests children under shown nodes', () => {
    const outline = buildAXOutline([
      node('1', 'navigation', 'Main', { childIds: ['2'] }),
      node('2', 'link', 'Home', { parentId: '1', backendDOMNodeId: 9 }),
    ]);
    expect(outline.text).toBe('- navigation "Main"\n  - link "Home" [ref=e1]');
  });

  it('truncates at the character cap and flags it', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      node(String(i + 2), 'button', `Button number ${i}`, { parentId: '1', backendDOMNodeId: i })
    );
    const outline = buildAXOutline(
      [node('1', 'RootWebArea', '', { childIds: many.map((n) => n.nodeId) }), ...many],
      { maxChars: 500 }
    );
    expect(outline.truncated).toBe(true);
    expect(outline.text.length).toBeLessThanOrEqual(500);
  });

  it('survives cycles and missing children', () => {
    const outline = buildAXOutline([
      node('1', 'button', 'A', { childIds: ['2', 'missing'], backendDOMNodeId: 1 }),
      node('2', 'button', 'B', { parentId: '1', childIds: ['1'], backendDOMNodeId: 2 }),
    ]);
    expect(outline.text).toBe('- button "A" [ref=e1]\n  - button "B" [ref=e2]');
  });

  it('quotes names without breaking the format', () => {
    const outline = buildAXOutline([node('1', 'button', 'Say "hi"', { backendDOMNodeId: 1 })]);
    expect(outline.text).toBe(`- button "Say 'hi'" [ref=e1]`);
  });
});
