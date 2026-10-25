import { describe, expect, it } from 'vitest';
import { chooseNewWorkProject } from './new-work-project';

const MAESTRO = { id: 'p-maestro', name: 'Maestro' };
const ZOO = { id: 'p-zoo', name: 'Planet Zoo 2 Mods' };
const SITE = { id: 'p-site', name: 'Website' };

describe('chooseNewWorkProject', () => {
  it("uses Jev's settled project even when the model named none", () => {
    expect(
      chooseNewWorkProject({
        named: undefined,
        settled: ZOO,
        open: [MAESTRO, ZOO],
        tool: 'spawn_agent',
      })
    ).toEqual({ kind: 'settled', project: ZOO, overrode: null });
  });

  it("puts Jev's settled project over a different one the model named", () => {
    expect(
      chooseNewWorkProject({
        named: 'Maestro',
        settled: ZOO,
        open: [MAESTRO, ZOO],
        tool: 'spawn_agent',
      })
    ).toEqual({ kind: 'settled', project: ZOO, overrode: 'Maestro' });
  });

  it('uses the named project when Jev settled none', () => {
    expect(
      chooseNewWorkProject({
        named: 'zoo',
        settled: null,
        open: [MAESTRO, ZOO],
        tool: 'spawn_agent',
      })
    ).toEqual({ kind: 'named', reference: 'zoo' });
  });

  it('uses the only open project without asking', () => {
    expect(
      chooseNewWorkProject({ named: undefined, settled: null, open: [ZOO], tool: 'spawn_agent' })
    ).toEqual({ kind: 'only', project: ZOO });
  });

  it('asks which project, conversationally, when several are open and none is named', () => {
    const choice = chooseNewWorkProject({
      named: '  ',
      settled: null,
      open: [MAESTRO, ZOO, SITE],
      tool: 'spawn_agent',
    });
    expect(choice.kind).toBe('ask');
    const text = choice.kind === 'ask' ? choice.text : '';
    expect(text).toContain('"Which project, Maestro, Planet Zoo 2 Mods or Website?"');
    expect(text).toContain('call spawn_agent again with project set');
    expect(text).toContain('Do not say anything failed');
  });

  it('ignores a settled project that is no longer open', () => {
    expect(
      chooseNewWorkProject({
        named: undefined,
        settled: SITE,
        open: [MAESTRO, ZOO],
        tool: 'propose_plan',
      }).kind
    ).toBe('ask');
  });
});
