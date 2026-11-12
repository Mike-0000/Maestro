/**
 * The developer's own words for things, which every conductor reads the same way: Maestro's
 * conductor (`CONDUCTOR_RULES`, also behind the voice line) and each task's chat conductor
 * (`CHAT_DIRECTION_KINDS`). Interpolated into cached system prompts, so it must stay a static
 * string.
 */
export const CONDUCTOR_VOCABULARY = `"Cloud agent" in the developer's words means a Claude agent, the provider claude: never Codex or another provider, nor an agent running in the cloud.`;
