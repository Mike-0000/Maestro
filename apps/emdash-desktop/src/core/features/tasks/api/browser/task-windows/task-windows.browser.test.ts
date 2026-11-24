import { afterEach, describe, expect, it } from 'vitest';
import { TaskWindowsStore } from './task-windows';

const stores: TaskWindowsStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    for (const entry of store.windows) store.close(entry.taskId);
  }
  document.documentElement.removeAttribute('data-probe');
});

function createStore(): TaskWindowsStore {
  const store = new TaskWindowsStore();
  stores.push(store);
  return store;
}

describe('TaskWindowsStore', () => {
  it('opens one window per task with a container in that window', () => {
    const store = createStore();
    store.open('project-1', 'task-1');
    expect(store.isOpen('task-1')).toBe(true);
    const [entry] = store.windows;
    expect(entry?.container.ownerDocument).toBe(entry?.window.document);
    expect(entry?.container.ownerDocument).not.toBe(document);

    store.open('project-1', 'task-1');
    expect(store.windows).toHaveLength(1);
  });

  it('mirrors the stylesheets and the root attributes, and keeps them current', async () => {
    const style = document.createElement('style');
    style.textContent = '.probe-a { color: red; }';
    document.head.appendChild(style);
    try {
      const store = createStore();
      store.open('project-1', 'task-2');
      const doc = store.windows[0]!.window.document;
      expect(doc.head.textContent).toContain('.probe-a');

      document.documentElement.setAttribute('data-probe', 'dark');
      style.textContent = '.probe-b { color: blue; }';
      await expect.poll(() => doc.documentElement.getAttribute('data-probe')).toBe('dark');
      await expect.poll(() => doc.head.textContent).toContain('.probe-b');
    } finally {
      style.remove();
    }
  });

  it('forgets a task whose window closed', async () => {
    const store = createStore();
    store.open('project-1', 'task-3');
    store.windows[0]!.window.close();
    await expect.poll(() => store.isOpen('task-3')).toBe(false);
  });
});
