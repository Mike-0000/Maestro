import { describe, expect, it } from 'vitest';
import {
  deliveryNote,
  describePrompt,
  emptyBriefError,
  VERBATIM_HEADING,
  VERBATIM_HEADING_NO_BRIEF,
  VERBATIM_MIN_WORDS,
  withVerbatimRequest,
} from './prompt-fidelity';

// The dictated brief from the session that showed the problem: the agent got a summary without
// the quadrant, browser-size, and full-screen details.
const SUB_CANVAS_BRIEF =
  'Create a new Claude code agent and give it the task to review the Chorus sub-canvas system. ' +
  'I want to iterate on it and improve it. I want it to feel really good from a voice agent ' +
  'perspective. It already works generally well, like I can create sub-canvases and group ' +
  'windows together, but I want the window resizing and sub-canvas focus aspect to be better. ' +
  'For example, if I ask it to add four code windows to it, it should be probably four ' +
  'quadrants. If I ask it to do a browser window and a code agent, the browser window should be ' +
  'larger than the code agent. So if I create a sub-canvas, I want the window to be fully zoomed ' +
  'in and scoped, like as if that sub-canvas has become full screen.';

const SUMMARY =
  'Review the Chorus sub-canvas system and improve it for voice control.\n\nUser goals: better ' +
  'resizing and focus.';

describe('withVerbatimRequest', () => {
  it('attaches a long dictated brief verbatim after the organized prompt', () => {
    const prompt = withVerbatimRequest(SUMMARY, SUB_CANVAS_BRIEF);

    expect(prompt.startsWith(SUMMARY)).toBe(true);
    expect(prompt).toContain(VERBATIM_HEADING);
    expect(prompt).toContain(SUB_CANVAS_BRIEF);
    for (const detail of ['four quadrants', 'larger than the code agent', 'full screen']) {
      expect(prompt).toContain(detail);
    }
  });

  it('leaves short commands alone', () => {
    const utterance = 'Tell Atlas to run the tests again.';
    expect(utterance.split(' ').length).toBeLessThan(VERBATIM_MIN_WORDS);
    expect(withVerbatimRequest('Run the tests again.', utterance)).toBe('Run the tests again.');
  });

  it('does not attach the brief twice when the prompt already quotes it', () => {
    const quoted = `Do this:\n\n${SUB_CANVAS_BRIEF.toUpperCase().replaceAll(',', '')}`;
    expect(withVerbatimRequest(quoted, SUB_CANVAS_BRIEF)).toBe(quoted);
  });

  it('still delivers the brief when the model wrote no prompt', () => {
    expect(withVerbatimRequest('   ', SUB_CANVAS_BRIEF)).toBe(
      `${VERBATIM_HEADING_NO_BRIEF}\n\n"""\n${SUB_CANVAS_BRIEF}\n"""`
    );
    expect(VERBATIM_HEADING_NO_BRIEF).not.toContain('brief above');
  });

  const DETAILED =
    'Open the file src/core/features/canvas/canvas-store.ts and change retryLimit from 3 to 5 in ' +
    'the function resolveDesk. Then check https://example.com/docs/desks for the format and make ' +
    'sure the canvas desks keep their order when the developer closes a window and reopens it ' +
    'later, because right now they swap places and that is confusing for anyone using voice to ' +
    'move around the canvas, and also update the tests that cover it so they match.';

  it('does not attach an exact copy', () => {
    expect(withVerbatimRequest(`Task:\n${DETAILED}`, DETAILED)).toBe(`Task:\n${DETAILED}`);
  });

  it('does not attach a near copy with punctuation changes', () => {
    const near = DETAILED.replaceAll(',', ';').replace('Then check', '- Then, check');
    expect(withVerbatimRequest(near, DETAILED)).toBe(near);
  });

  it('attaches when a summary drops a number or a path', () => {
    const noNumber = DETAILED.replace('from 3 to 5', 'higher');
    expect(withVerbatimRequest(noNumber, DETAILED)).toContain(VERBATIM_HEADING);
    const noPath = DETAILED.replace('src/core/features/canvas/canvas-store.ts', 'the store file');
    expect(withVerbatimRequest(noPath, DETAILED)).toContain(VERBATIM_HEADING);
  });

  it('attaches when a near copy drops a negation or qualifier', () => {
    const said =
      'Please clean up the orders table in the staging database today, and do not delete the old ' +
      'rows because the finance team still needs them for the audit next month, so only touch ' +
      'rows from this year and leave the archive alone, and if anything looks odd then stop and ' +
      'write down what you found for me to read.';
    expect(withVerbatimRequest(said, said)).toBe(said);
    const withoutOnly = said.replace('so only touch', 'so touch');
    expect(withVerbatimRequest(withoutOnly, said)).toContain(VERBATIM_HEADING);
    expect(withVerbatimRequest(said.replace('do not ', ''), said)).toContain(VERBATIM_HEADING);
  });

  it('keeps contractions whole and checks them', () => {
    const said = DETAILED.replace('Then check', "Then check, and don't");
    expect(withVerbatimRequest(said, said)).toBe(said);
    expect(withVerbatimRequest(said.replace("and don't", 'and'), said)).toContain(VERBATIM_HEADING);
  });

  it('attaches when a near copy misses more than two content words', () => {
    const brief = DETAILED.replace('canvas desks keep their order', 'desks stay');
    expect(withVerbatimRequest(brief, DETAILED)).toContain(VERBATIM_HEADING);
  });

  it('attaches when the prompt is a short summary', () => {
    const out = withVerbatimRequest('Fix desk ordering and update tests.', DETAILED);
    expect(out).toContain(VERBATIM_HEADING);
    expect(out).toContain(DETAILED);
  });
});

describe('deliveryNote', () => {
  it('reports the delivered size and whether the transcript was attached', () => {
    expect(deliveryNote('Run the tests.', 'Run the tests.')).toBe('14 characters');
    const delivered = withVerbatimRequest(SUMMARY, SUB_CANVAS_BRIEF);
    expect(deliveryNote(SUMMARY, delivered)).toBe(
      `${delivered.length.toLocaleString('en-US')} characters, with the developer's verbatim request attached`
    );
  });
});

describe('describePrompt', () => {
  it('shows the size and the first line of a prompt', () => {
    expect(describePrompt(SUMMARY)).toBe(
      `${SUMMARY.length}-character prompt: “Review the Chorus sub-canvas system and improve it for voic…”`
    );
    expect(describePrompt('  ')).toBe('no prompt');
  });
});

describe('emptyBriefError', () => {
  it('rejects an empty prompt for a long request only', () => {
    expect(emptyBriefError('  ', SUB_CANVAS_BRIEF)).toContain('Write the brief');
    expect(emptyBriefError('', 'open a Claude agent in chorus')).toBeNull();
    expect(emptyBriefError('Review it.', SUB_CANVAS_BRIEF)).toBeNull();
  });
});
