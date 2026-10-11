# Markdown viewer

A read-only viewer for Markdown files that agents produce. An agent hands a file to the app
through an MCP tool, or the developer clicks the file's path in the agent's terminal or chat. The
viewer opens in a window that fits the view on screen and reloads when the file changes on disk.

Claude Code is the target for now. Any agent that gets the session's `maestro` MCP server (see
[agent-requests.md](agent-requests.md)) has the tool: today that is Claude and Codex in a
terminal, and ACP chat sessions. Agents on a remote machine do not get the server.

## The tool: `show_markdown`

It is a second tool on the `maestro` MCP server, next to `conductor_request`. Claude Code lists it
as `mcp__maestro__show_markdown`.

| Argument  | Type    | Meaning                                                                      |
| --------- | ------- | ---------------------------------------------------------------------------- |
| `path`    | string  | Required. Absolute, or relative to the agent's working directory.            |
| `present` | boolean | `true` opens the viewer now. Left out, the file is only offered.             |
| `title`   | string  | Optional window title. Defaults to the file name.                            |

```json
{ "path": "docs/plan.md", "present": true }
```

There is no argument for the agent or task. The caller is the conversation the session token was
issued for, so an agent can only show files from its own workspace.

Without `present`, the developer gets a toast, "Nova has a file for you", with an Open button, and
the tool returns "offered". With `present: true` the viewer opens at once and the tool returns
where it opened. It returns "opened" only once the window is on screen; otherwise it returns an
error. A refused path returns an error that says why. If no window answers within 8 seconds the
tool reports that nothing was shown.

`path` may also be written the Git Bash way on Windows (`/c/repo/docs/plan.md`).

## Where the viewer opens

`placeMarkdown` (`api/placement.ts`) decides from the view on screen. Each answer is a window in a
system the app already had.

| View on screen                    | Window                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| Canvas                            | A document window (`doc:<id>`), a canvas window kind like a note   |
| Task view (the agent, directly)   | A `markdown` tab in the pane to the right, split if there is none   |
| Home, settings and other views    | The agent's task view is opened, then the tab as above             |

On the canvas (`CanvasStore.openDoc`) the window joins the region the developer is in: the
sub-canvas or desk in view, the staged region, or the one a stage of picked windows was opened
from. On the main canvas it is placed beside the agent that sent it and joins a region like any
new window, which by default is the project's sub-canvas. In a tiled region it takes a share of
the space beside the agents, and gives it back when closed. On a stage of picked windows it joins
the picked set in place. It moves, resizes, closes by voice and persists like other windows.

Presenting also makes the window visible: a project filter that excludes it is cleared, a
collapsed sub-canvas that holds it is expanded, and a window closed by a layout command reopens.

In a task view the tab opens beside whichever task the developer is looking at, even when another
task's agent sent the file: the tab keeps the workspace the file was checked against. The first
file splits a pane to the right; later files open as tabs in that same pane.

One file has one window: showing it again brings that window forward. A file whose task is not on
the canvas (an automation run) opens in its task view instead.

## Links

- Terminals (`file-link-detection.ts`): Ctrl+click (Cmd on macOS) on a Markdown path. Detection
  now also finds Windows paths (`docs\plan.md`, `C:\repo\README.md`), bare names (`PLAN.md`) and
  a Windows path split over two rows, for `.md`, `.mdx` and `.markdown` only. This applies to
  every terminal with file links; in a plain task terminal such a link opens the editor.
- ACP chat: Markdown links, file rows and file mentions. A link with a line number and a diff
  header still open the editor.
- Inside a document: a link to another Markdown file opens that file; a web link opens outside the
  app.

A Markdown path the viewer may not show (outside the allowed folders, missing) falls back to what
the link did before: the editor pane, or the OS for an absolute POSIX path.

## What may be shown

`MarkdownAccess` (`node/markdown-access.ts`) is the only reader. A file is shown when all of
these hold:

1. Its name ends in `.md`, `.mdx` or `.markdown` (an image extension for a picture a document
   embeds).
2. Its real path, with symlinks and junctions resolved, is inside the agent's working directory or
   the project folder.
3. It is a regular file of at most 2 MB (10 MB for an image).
4. The workspace is on this computer.

The check runs in the main process on every read, including each reload and each restored window,
so the renderer never chooses what is read. Embedded HTML goes through the sanitizer of the shared
`Markdown` component.

## Where it lives

All under `apps/emdash-desktop/src/`.

| Part                              | Path                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| Slice                             | `core/features/markdown-viewer/`                                  |
| Tool definition and argument parsing | `api/show-markdown-tool.ts`                                    |
| Wire contract                     | `api/contract.ts` (domain `markdownViewer`)                       |
| Access check                      | `node/markdown-access.ts`                                         |
| Tool handler, request hub         | `node/show-markdown-handler.ts`, `node/show-markdown-hub.ts`      |
| MCP registration                  | `main/host/agent-requests/show-markdown-tool.ts`                  |
| Window choice and opening         | `api/placement.ts`, `api/browser/open-markdown-doc.ts`            |
| Requests from agents, in the window | `api/browser/show-request-bridge.ts`                            |
| Viewer component                  | `contributions/browser/markdown-doc-view.tsx`                     |
| Task tab                          | `browser/markdown-tab-provider.tsx`                               |
| Canvas window                     | `core/features/canvas/browser/tiles/doc-tile.tsx`, `CanvasStore.openDoc` |

Another tool can share the `maestro` server the same way: pass an `AgentSessionTool` to
`AgentRequestServer` in `agent-session-mcp.ts`.

## Limits

- Files in a remote (SSH) workspace are not shown.
- A path with a space or another unusual character in a folder name is not a link in the
  terminal. The agent can still show the file with the tool.
- A file over 200 KB reloads only when its size changes: the files runtime that reports changes
  stops reading content above that size.
- ACP chat tiles on the canvas have no clickable file links, as before this feature. Paths written
  as plain text or inline code in ACP chat are not links; only Markdown links, file rows and
  mentions are.
- Headings have no anchors, so `#section` links do nothing.
