/**
 * What is said aloud to ask for a yes. Reading a whole message out ("Send to Quartz: Yes, I can
 * proceed with…") took ten seconds; saying only the action ("Send to Quartz?") had the developer
 * approve a message they never heard. So it says the action, whom it is for, and the first few
 * words of what it carries; the HUD shows all of it. The yes counts from the end of what was
 * said, so it answers what the developer heard.
 */

/** Longer than this, the spoken action is cut between words. */
const MAX_ACTION_CHARS = 80;
/** Words of the message or brief said as its preview. */
const PREVIEW_WORDS = 7;
/** A preview never ends on a word that leads into the part left out. */
const DANGLING =
  /^(?:and|or|but|the|a|an|to|of|for|with|in|on|at|by|from|that|then|so|if|is|are|be|your|my|its|their|this)$/i;

function flat(text: string): string {
  return text
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first words of what an action carries, cut so the last word said is not a lead-in. */
export function spokenPreview(text: string, maxWords = PREVIEW_WORDS): string {
  const words = flat(text).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  if (words.length <= maxWords + 1) return words.join(' ').replace(/[.?!,;:]+$/, '');
  const head = words.slice(0, maxWords);
  while (head.length > 1 && DANGLING.test(head[head.length - 1]!.replace(/[^\p{L}]/gu, ''))) {
    head.pop();
  }
  return `${head.join(' ').replace(/[.?!,;:]+$/, '')}…`;
}

/**
 * `Send to Quartz: “run the tests again and then report”` said as
 * `Send to Quartz "run the tests again and then report"? Say yes.`; `detail`, when given, is
 * what the action carries in full (a message, a brief) and is previewed in place of the label's
 * quoted part.
 */
export function spokenConfirmation(label: string, detail?: string): string {
  const main = label.split(/\s+·\s+/)[0] ?? label;
  const colon = main.search(/:\s*“/);
  const quoted = colon >= 0 ? main.slice(colon).replace(/^:\s*/, '') : '';
  const action = flat(colon >= 0 ? main.slice(0, colon) : main).replace(/[\s.?!:,;…]+$/, '');
  const cut = action.lastIndexOf(' ', MAX_ACTION_CHARS);
  const short =
    action.length <= MAX_ACTION_CHARS ? action : action.slice(0, cut > 0 ? cut : MAX_ACTION_CHARS);
  const preview = spokenPreview(detail?.trim() ? detail : quoted);
  return `${short || 'Go ahead'}${preview ? ` "${preview}"` : ''}? Say yes.`;
}
