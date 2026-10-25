import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { days, defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';
import { MAX_PANES } from '../api/canvas-panes';
import { REGION_COLORS } from '../api/canvas-regions';
import type { SplitNode } from '../api/stage-layout';

const tileRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const noteSchema = z.object({
  text: z.string(),
  color: z.enum(['yellow', 'blue', 'green', 'pink', 'gray']).optional(),
});

const canvasBoardV1Schema = z.object({
  version: z.literal('1'),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  /** Tile geometry keyed by tile id (`agent:<conversationId>` or `note:<noteId>`). */
  tiles: z.record(z.string(), tileRectSchema),
  notes: z.record(z.string(), noteSchema),
  /** User-visible, speakable agent names keyed by conversation id. */
  spokenNames: z.record(z.string(), z.string()),
  /** Conversation ids the user removed from the board (the conversation itself is kept). */
  hiddenConversationIds: z.array(z.string()),
  /** Optional project filter; null shows every project. */
  projectFilter: z.string().nullable(),
});

const canvasBoardV2Schema = canvasBoardV1Schema.extend({
  version: z.literal('2'),
  /** Open the canvas when the app starts instead of the last view. */
  openOnLaunch: z.boolean(),
  /** Draw a frame around each task's agents with its diff stats. */
  showTaskFrames: z.boolean(),
});

const canvasBrowserSchema = z.object({
  projectId: z.string(),
  workspaceId: z.string(),
  /** Last page shown, restored when the tile comes back. */
  url: z.string(),
  /** `agents` lets the conductor and the task's agents drive it; `user` keeps it manual. */
  control: z.enum(['user', 'agents']),
  title: z.string().optional(),
});

const canvasBoardV3Schema = canvasBoardV2Schema.extend({
  version: z.literal('3'),
  /** One app browser per task, keyed by task id; geometry lives in `tiles` (`browser:<taskId>`). */
  browsers: z.record(z.string(), canvasBrowserSchema),
});

const regionSchema = z.object({
  name: z.string(),
  parentId: z.string().nullable(),
  rect: tileRectSchema,
  collapsed: z.boolean(),
  color: z.enum(REGION_COLORS).optional(),
  createdAt: z.number(),
  auto: z.boolean().optional(),
  projectId: z.string().optional(),
  arrangement: z.enum(['tiled', 'free']).optional(),
  weights: z.record(z.string(), z.number()).optional(),
  screenSized: z.boolean().optional(),
});

const splitNodeSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), tileId: z.string() }),
    z.object({
      type: z.literal('split'),
      axis: z.enum(['row', 'column']),
      ratios: z.array(z.number()),
      children: z.array(splitNodeSchema),
    }),
  ])
);

const stageSavedSchema = z.object({
  order: z.array(z.string()),
  trees: z.record(z.string(), splitNodeSchema),
  soloTileId: z.string().nullable(),
});

const stageTargetSchema = z.union([
  z.object({ kind: z.literal('region'), regionId: z.string() }),
  z.object({ kind: z.literal('selection'), tileIds: z.array(z.string()), label: z.string() }),
  z.object({ kind: z.literal('solo'), tileId: z.string() }),
]);

const locationSchema = z.union([
  z.object({ kind: z.literal('board'), regionScope: z.string().nullable() }),
  z.object({
    kind: z.literal('stage'),
    target: stageTargetSchema,
    page: z.number(),
    immersive: z.boolean(),
  }),
]);

const layoutSettingsSchema = z.object({
  /** Large name badges on every window and region while push-to-talk is held. */
  showNamesWhileListening: z.boolean(),
  /** Speak layout results aloud (off: a short tick and the HUD line). */
  speakLayoutConfirmations: z.boolean(),
  /** A plan's agents arrive together in a region named after the plan. */
  groupPlanAgents: z.boolean(),
  /** New agents join the region the user is looking at. */
  placeNewAgentsInCurrentRegion: z.boolean(),
  /** New agents and app browsers open in that project's main sub-canvas. */
  placeNewWindowsInProjectRegion: z.boolean().default(true),
  /**
   * Canvas Pro: new agents and app browsers go to their project's desk (made when missing), not
   * the desk in view, unless the developer said where.
   */
  placeNewWindowsOnProjectDesk: z.boolean().default(true),
});

const panesSchema = z.object({
  /** How many views of the board share the screen (1: the single canvas). */
  count: z.number().int().min(1).max(MAX_PANES),
  /** The view commands, the toolbar, and the conductor act on. */
  active: z.number().int().min(0),
  /** Each view's camera and the sub-canvas it is in; empty for the single canvas. */
  views: z.array(
    z.object({
      viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
      regionScope: z.string().nullable(),
    })
  ),
});

const canvasBoardV4Schema = canvasBoardV3Schema.extend({
  version: z.literal('4'),
  /** Named, nestable regions keyed by `region:<uuid>`. */
  regions: z.record(z.string(), regionSchema),
  /** Region of each tile not at the board root. */
  membership: z.record(z.string(), z.string()),
  /** Closed windows that are not agents (app browsers); agents use `hiddenConversationIds`. */
  hiddenTiles: z.array(z.string()),
  /** Stage arrangements keyed by region id (selection stages are not kept). */
  stageLayouts: z.record(z.string(), stageSavedSchema),
  /** Where the user was: reopened on launch. */
  location: locationSchema,
  layoutSettings: layoutSettingsSchema,
  /** Multi-canvas: several views of the board side by side. Absent on the single canvas. */
  panes: panesSchema.optional(),
});

const WINDOW_STATUSES = ['needs-you', 'working', 'idle', 'done', 'error'] as const;

const canvasDocSchema = z.object({
  projectId: z.string(),
  /** The workspace the file was checked against: the folder of the agent that showed it. */
  workspaceId: z.string(),
  taskId: z.string(),
  /** Absolute path of the Markdown file; the viewer has it checked again on every read. */
  path: z.string(),
  title: z.string(),
});

const canvasBoardV5Schema = canvasBoardV4Schema.extend({
  version: z.literal('5'),
  regions: z.record(
    z.string(),
    regionSchema.extend({
      /** Place among desks (top-level regions) in Canvas Pro. */
      order: z.number().optional(),
      /** A gathering desk: windows with this status visit it while it shows. */
      gather: z.enum(WINDOW_STATUSES).optional(),
    })
  ),
  /** `pro`: top-level regions are desks, shown one at a time. */
  mode: z.enum(['classic', 'pro']),
  /**
   * Document windows keyed by document id; geometry lives in `tiles` (`doc:<docId>`). Absent
   * until a document is opened.
   */
  docs: z.record(z.string(), canvasDocSchema).optional(),
});

export const DEFAULT_LAYOUT_SETTINGS = {
  showNamesWhileListening: true,
  speakLayoutConfirmations: false,
  groupPlanAgents: true,
  placeNewAgentsInCurrentRegion: true,
  placeNewWindowsInProjectRegion: true,
  placeNewWindowsOnProjectDesk: true,
};

export const canvasBoardSchema = defineVersionedSchema()
  .initial('1', canvasBoardV1Schema)
  .version('2', canvasBoardV2Schema, (v1) => ({
    ...v1,
    version: '2' as const,
    openOnLaunch: false,
    showTaskFrames: true,
  }))
  .version('3', canvasBoardV3Schema, (v2) => ({ ...v2, version: '3' as const, browsers: {} }))
  .version('4', canvasBoardV4Schema, (v3) => ({
    ...v3,
    version: '4' as const,
    regions: {},
    membership: {},
    hiddenTiles: [],
    stageLayouts: {},
    location: { kind: 'board' as const, regionScope: null },
    layoutSettings: DEFAULT_LAYOUT_SETTINGS,
  }))
  .version('5', canvasBoardV5Schema, (v4) => ({
    ...v4,
    version: '5' as const,
    mode: 'classic' as const,
  }))
  .build();

export type CanvasRegionState = CanvasBoardState['regions'][string];
export type CanvasStageTarget = z.infer<typeof stageTargetSchema>;
export type CanvasLocationState = z.infer<typeof locationSchema>;
export type CanvasLayoutSettings = z.infer<typeof layoutSettingsSchema>;

export type CanvasBrowserState = z.infer<typeof canvasBrowserSchema>;
export type CanvasDocState = z.infer<typeof canvasDocSchema>;

export type CanvasBoardState = typeof canvasBoardSchema.Type;

export const canvasBoardMemento = defineMemento({
  id: 'canvas.board',
  subject: appSubject,
  schema: canvasBoardSchema,
  default: {
    version: '5' as const,
    mode: 'classic' as const,
    viewport: { x: 80, y: 80, zoom: 0.6 },
    tiles: {},
    notes: {},
    spokenNames: {},
    hiddenConversationIds: [],
    projectFilter: null,
    openOnLaunch: false,
    showTaskFrames: true,
    browsers: {},
    regions: {},
    membership: {},
    hiddenTiles: [],
    stageLayouts: {},
    location: { kind: 'board' as const, regionScope: null },
    layoutSettings: DEFAULT_LAYOUT_SETTINGS,
  },
  retention: { tier: 'persisted', maxAge: days(365), maxEntries: 4 },
});
