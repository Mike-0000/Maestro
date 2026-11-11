import { describe, expect, it } from 'vitest';
import { hudClearancePx, type HudBox } from './hud-clearance';

/** A view whose bottom edge sits on the layout's 74px reserve, 1000px wide. */
const view = { left: 300, right: 1300, bottomGap: 74 };
/** The resting bar: 16px off the window's bottom edge and 50px tall, centered. */
const restingBar: HudBox = { left: 360, right: 1240, rise: 66 };
const GAP = 8;

describe('hudClearancePx', () => {
  it('asks for nothing while only the resting bar stands under the view', () => {
    expect(hudClearancePx(view, [restingBar], GAP)).toBe(0);
    expect(hudClearancePx(view, [], GAP)).toBe(0);
  });

  it('ignores the sub-pixel rounding of the reserve', () => {
    expect(hudClearancePx(view, [{ ...restingBar, rise: 74.6 }], GAP)).toBe(0);
  });

  it('clears a card raised above the bar, plus the gap', () => {
    const card: HudBox = { left: 520, right: 1080, rise: 66 + 8 + 120 };
    // The card's top stands 120px into the view.
    expect(hudClearancePx(view, [card, restingBar], GAP)).toBe(128);
  });

  it('follows the tallest piece that reaches the view', () => {
    const plan: HudBox = { left: 520, right: 1080, rise: 400 };
    const card: HudBox = { left: 520, right: 1080, rise: 200 };
    expect(hudClearancePx(view, [plan, card, restingBar], GAP)).toBe(400 - 74 + GAP);
  });

  it('clears a bar that grew with what is open inside it', () => {
    expect(hudClearancePx(view, [{ ...restingBar, rise: 66 + 40 }], GAP)).toBe(40);
  });

  it('rounds up to whole pixels', () => {
    expect(hudClearancePx(view, [{ ...restingBar, rise: 100.2 }], GAP)).toBe(35);
  });

  it('ignores pieces beside the view', () => {
    const narrow = { left: 0, right: 360, bottomGap: 74 };
    expect(hudClearancePx(narrow, [{ ...restingBar, rise: 300 }], GAP)).toBe(0);
    expect(hudClearancePx({ ...narrow, right: 361 }, [{ ...restingBar, rise: 300 }], GAP)).toBe(
      300 - 74 + GAP
    );
  });

  it('asks for nothing when the view ends above the HUD', () => {
    // A terminal drawer under the view keeps its bottom edge 320px up.
    const raised = { ...view, bottomGap: 320 };
    expect(hudClearancePx(raised, [{ ...restingBar, rise: 300 }], GAP)).toBe(0);
  });

  it('asks for nothing for a view that is not laid out', () => {
    expect(hudClearancePx({ left: 0, right: 0, bottomGap: 900 }, [restingBar], GAP)).toBe(0);
  });
});
