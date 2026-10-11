/**
 * Words that stop something, as the developer says them in the middle of something else: "No,
 * stop!", "wait, wait", "cancel that", "hang on a second". The fast grammar knows a short list of
 * exact phrases, which is right when nothing is happening: there "stop it" is a command about an
 * agent. While something is pending or a model turn runs, missing a stop lets an action through,
 * so these are read first.
 */

/** Phrases of more than one word that mean stop. */
const STOP_PHRASE =
  /\b(?:do not|don't|dont|hang on|hold on|hold it|hold up|never ?mind|forget (?:it|that)|scratch that)\b/;
const STOP_PHRASES = new RegExp(STOP_PHRASE.source, 'g');
/** Single words that mean stop, or no. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'no',
  'nope',
  'nah',
  'deny',
  'reject',
  'stop',
  'cancel',
  'wait',
  'abort',
]);
/** Of those, the ones that say more than "no": they are not an answer to a question. */
const HARD_STOPS: ReadonlySet<string> = new Set(['stop', 'cancel', 'wait', 'abort']);
/** Words that may stand beside a stop word without making the utterance anything else. */
const BESIDE_A_STOP: ReadonlySet<string> = new Set(
  (
    'please it that this these those everything all now just a an the sec second minute moment ' +
    'send sending do doing oh hey whoa uh um ok okay thanks thank you there right yet sorry ' +
    'actually one of them'
  ).split(' ')
);

function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the utterance says stop or no and nothing else: "no", "No, stop!", "stop it",
 * "cancel that", "no, don't send that", "hang on a second". False as soon as it names anything
 * ("stop Atlas", "wait for the tests", "no tests failed"): that is a command or a remark.
 */
export function isPureStop(text: string): boolean {
  let found = false;
  const rest = plain(text).replace(STOP_PHRASES, () => {
    found = true;
    return ' ';
  });
  for (const word of rest.split(' ').filter(Boolean)) {
    if (STOP_WORDS.has(word)) found = true;
    else if (!BESIDE_A_STOP.has(word)) return false;
  }
  return found;
}

/**
 * True when the words say more than "no": stop, cancel, wait, don't, never mind. A bare "no" to
 * a yes-or-no question answers that question; these end whatever is going on.
 */
export function meansStop(text: string): boolean {
  const said = plain(text);
  return STOP_PHRASE.test(said) || said.split(' ').some((word) => HARD_STOPS.has(word));
}
