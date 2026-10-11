import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedMarkdownLinkOpener, viaMarkdownViewer } from './markdown-link-seam';

const source = { projectId: 'p1', taskId: 't1', conversationId: 'c1' };

afterEach(() => seedMarkdownLinkOpener(undefined));

describe('viaMarkdownViewer', () => {
  it('sends a Markdown path to the viewer and nothing to the fallback', async () => {
    const opener = vi.fn(async () => true);
    const otherwise = vi.fn();
    seedMarkdownLinkOpener(opener);

    viaMarkdownViewer(source, otherwise)('docs\\plan.md');
    await vi.waitFor(() => expect(opener).toHaveBeenCalledWith(source, 'docs\\plan.md'));
    expect(otherwise).not.toHaveBeenCalled();
  });

  it('falls back when the viewer may not show the file', async () => {
    const otherwise = vi.fn();
    seedMarkdownLinkOpener(async () => false);

    viaMarkdownViewer(source, otherwise)('../outside/secret.md');
    await vi.waitFor(() => expect(otherwise).toHaveBeenCalledWith('../outside/secret.md'));
  });

  it('falls back when opening throws', async () => {
    const otherwise = vi.fn();
    seedMarkdownLinkOpener(async () => {
      throw new Error('window gone');
    });

    viaMarkdownViewer(source, otherwise)('plan.md');
    await vi.waitFor(() => expect(otherwise).toHaveBeenCalledWith('plan.md'));
  });

  it('never asks the viewer about a file that is not Markdown', () => {
    const opener = vi.fn(async () => true);
    const otherwise = vi.fn();
    seedMarkdownLinkOpener(opener);

    viaMarkdownViewer(source, otherwise)('src/app.ts');
    expect(otherwise).toHaveBeenCalledWith('src/app.ts');
    expect(opener).not.toHaveBeenCalled();
  });

  it('behaves as before until the viewer is seeded', () => {
    const otherwise = vi.fn();
    viaMarkdownViewer(source, otherwise)('plan.md');
    expect(otherwise).toHaveBeenCalledWith('plan.md');
  });
});
