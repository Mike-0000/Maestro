/** Short, speakable labels for agent providers ("Claude", not "Claude Code"). */
const SPOKEN_PROVIDER_LABELS: Record<string, string> = {
  amp: 'Amp',
  antigravity: 'Antigravity',
  auggie: 'Auggie',
  claude: 'Claude',
  cline: 'Cline',
  codex: 'Codex',
  copilot: 'Copilot',
  cursor: 'Cursor',
  devin: 'Devin',
  droid: 'Droid',
  gemini: 'Gemini',
  goose: 'Goose',
  grok: 'Grok',
  jules: 'Jules',
  junie: 'Junie',
  kilocode: 'Kilo',
  kimi: 'Kimi',
  kiro: 'Kiro',
  mistral: 'Mistral',
  opencode: 'OpenCode',
  qwen: 'Qwen',
};

export function spokenProviderLabel(providerId: string): string {
  const known = SPOKEN_PROVIDER_LABELS[providerId];
  if (known) return known;
  const cleaned = providerId.replace(/[-_]+/g, ' ').trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Agent';
}
