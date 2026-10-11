import source from './mirror-agent.cjs?raw';

/**
 * The agent program as text. It is started from text on both sides: as a worker thread here,
 * and as a file written into the distro there.
 */
export const MIRROR_AGENT_SOURCE: string = source;
