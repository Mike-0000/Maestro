import { z } from 'zod';
import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';

export const canvasViewDef = defineView({
  id: 'canvas',
  params: z.object({}),
  layout: workbenchLayout,
  telemetryEvent: 'canvas_viewed',
});
