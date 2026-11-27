import { z } from 'zod';
import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';

export const clientsViewDef = defineView({
  id: 'clients',
  params: z.object({}),
  layout: workbenchLayout,
  telemetryEvent: 'clients_viewed',
});
