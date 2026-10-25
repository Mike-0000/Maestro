import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import React from 'react';
import { AddonsPanel } from './AddonsPanel';

export const AddonsView: React.FC = () => (
  <AddonsPanel
    host={LOCAL_HOST_REF}
    header={{
      title: 'Add-ons',
      description:
        'Install skills, worker agents, and standing instructions into the coding agents on this computer',
    }}
  />
);
