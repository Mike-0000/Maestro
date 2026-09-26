import { describe, expect, it } from 'vitest';
import {
  deliveryNote,
  describePrompt,
  VERBATIM_HEADING,
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
      `${VERBATIM_HEADING}\n\n"""\n${SUB_CANVAS_BRIEF}\n"""`
    );
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
