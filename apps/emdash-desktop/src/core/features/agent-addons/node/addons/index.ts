import type { AddonDefinition } from '../addon-definition';
import { vibeAddon } from './vibe/vibe';

/**
 * Every add-on Maestro offers. To add one, make a folder beside `vibe/` with its files and an
 * {@link AddonDefinition}, and list it here; the settings page picks it up.
 */
export const ADDONS: readonly AddonDefinition[] = [vibeAddon];
