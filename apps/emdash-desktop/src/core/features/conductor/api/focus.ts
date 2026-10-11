/**
 * Which agent the developer is looking at: the one "this one" means, and the default for an
 * instruction that names no agent. The canvas, its stage, and a task's own view each track focus
 * their own way, and only the surface on screen counts: an agent focused on the canvas an hour
 * ago is not "this one" while the developer reads another agent's chat in the task view. Pure:
 * the roster gathers the signals.
 */

/** What the workbench shows: the canvas, one task's view, or a view with no agent in it. */
export type WorkbenchView =
  | { readonly kind: 'canvas' }
  | {
      readonly kind: 'task';
      readonly projectId: string;
      readonly taskId: string;
      /** The chat that is the active tab of the pane the developer last used, if it is a chat. */
      readonly activeChatId: string | null;
      /** Chats that are the active tab of any pane (a split task view shows several). */
      readonly visibleChatIds: readonly string[];
    }
  | { readonly kind: 'other'; readonly viewId: string; readonly projectId?: string };

export type FocusSignals = {
  readonly view: WorkbenchView;
  /** The agent whose canvas window was focused last (clicked, or "focus Atlas"), if on the board. */
  readonly canvasAgentId: string | null;
  /** Agents on the stage when it is open (one when a window is solo), else null. */
  readonly stageAgentIds: readonly string[] | null;
  /**
   * The region the board is zoomed into, and whether the canvas-focused agent is inside it. In
   * Canvas Pro it is the desk in view (`desk`), which also holds the windows visiting it.
   */
  readonly region: {
    readonly name: string;
    readonly holdsFocused: boolean;
    readonly desk?: boolean;
  } | null;
  /** Agents of the task whose view is open. */
  readonly taskAgentIds: readonly string[];
};

/**
 * The surface a focus reading comes from; `none` when the view on screen has no agent in it.
 * `call` is not a surface on screen: the developer picked up an agent's call, and until that
 * exchange ends "it" is the caller, whatever they are looking at.
 */
export type FocusSurface = 'canvas' | 'stage' | 'task-view' | 'call' | 'none';

export type Focus = {
  /** Null when no agent is in focus and the developer has to say which one they mean. */
  readonly agentId: string | null;
  readonly surface: FocusSurface;
  /** For the context line: where the reading comes from, or why there is none. */
  readonly why: string;
};

type NameOf = (agentId: string) => string;

function listed(ids: readonly string[], nameOf: NameOf): string {
  return ids.map(nameOf).join(', ');
}

function taskViewFocus(
  view: Extract<WorkbenchView, { kind: 'task' }>,
  agents: readonly string[],
  nameOf: NameOf
): Focus {
  const surface = 'task-view';
  const showing = view.visibleChatIds.filter((id) => agents.includes(id));
  if (view.activeChatId && agents.includes(view.activeChatId)) {
    return { agentId: view.activeChatId, surface, why: 'its chat is the active tab' };
  }
  const [onlyShowing] = showing;
  if (showing.length === 1 && onlyShowing) {
    return { agentId: onlyShowing, surface, why: 'its chat is the only one showing' };
  }
  const [onlyAgent] = agents;
  if (agents.length === 1 && onlyAgent) {
    return { agentId: onlyAgent, surface, why: 'it is the only agent of the task on screen' };
  }
  if (agents.length === 0) {
    return { agentId: null, surface, why: 'the task on screen has no agent to address' };
  }
  return {
    agentId: null,
    surface,
    why:
      showing.length > 1
        ? `several chats are showing and none is in the active pane: ${listed(showing, nameOf)}`
        : `no chat is in front, and the task has several agents: ${listed(agents, nameOf)}`,
  };
}

function stageFocus(stage: readonly string[], canvasAgentId: string | null, nameOf: NameOf): Focus {
  const surface = 'stage';
  const [only] = stage;
  // The board is hidden under the stage, so a focus on a window that is not staged is stale.
  if (stage.length === 1 && only) {
    return { agentId: only, surface, why: 'it is the only agent on the stage, full screen' };
  }
  if (canvasAgentId && stage.includes(canvasAgentId)) {
    return { agentId: canvasAgentId, surface, why: 'its window is the focused one of several' };
  }
  return {
    agentId: null,
    surface,
    why:
      stage.length === 0
        ? 'no agent window is on the stage'
        : `several windows are showing and none is focused: ${listed(stage, nameOf)}`,
  };
}

function boardFocus(signals: FocusSignals): Focus {
  const surface = 'canvas';
  const { canvasAgentId, region } = signals;
  const place = region ? `${region.desk ? 'desk' : 'region'} ${region.name}` : '';
  if (!canvasAgentId) {
    return {
      agentId: null,
      surface,
      why: region
        ? `${region.desk ? 'on' : 'zoomed into'} ${place}, with no agent window focused`
        : 'no agent window is focused',
    };
  }
  if (!region) return { agentId: canvasAgentId, surface, why: 'its window is focused' };
  return {
    agentId: canvasAgentId,
    surface,
    why: region.holdsFocused
      ? `its window is focused, ${region.desk ? 'on' : 'in'} ${place}`
      : `its window is focused, but it is outside ${place}, which fills the view`,
  };
}

/**
 * The focus while the developer answers a call: the caller. When the caller has left the canvas
 * there is no focus at all: the words were for it, so they do not fall to the window in front.
 */
export function callFocus(agentId: string | null): Focus {
  return agentId
    ? { agentId, surface: 'call', why: 'the developer picked up its call' }
    : { agentId: null, surface: 'call', why: 'the agent whose call was picked up is gone' };
}

/** Reads the focus from the surface on screen. Never picks between two candidates. */
export function resolveFocus(signals: FocusSignals, nameOf: NameOf): Focus {
  const { view } = signals;
  if (view.kind === 'other') {
    return { agentId: null, surface: 'none', why: 'no agent is in front' };
  }
  if (view.kind === 'task') return taskViewFocus(view, signals.taskAgentIds, nameOf);
  if (signals.stageAgentIds)
    return stageFocus(signals.stageAgentIds, signals.canvasAgentId, nameOf);
  return boardFocus(signals);
}

function surfaceLabel(focus: Focus, view: WorkbenchView): string {
  switch (focus.surface) {
    case 'canvas':
      return 'canvas';
    case 'stage':
      return 'canvas stage';
    case 'task-view':
      return 'task view';
    case 'call':
      return 'call';
    case 'none':
      return view.kind === 'other' ? `${view.viewId} view` : 'no agent view';
  }
}

/** The context line: "Focused agent: Atlas (task view: its chat is the active tab)". */
export function focusLine(focus: Focus, view: WorkbenchView, nameOf: NameOf): string {
  const who = focus.agentId ? nameOf(focus.agentId) : 'none';
  return `Focused agent: ${who} (${surfaceLabel(focus, view)}: ${focus.why})`;
}
