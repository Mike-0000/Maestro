import { describe, expect, it } from 'vitest';
import { fixTranscriptNames } from './name-fixups';

describe('fixTranscriptNames', () => {
  it.each([
    ['open Cloud Code please', 'open Claude Code please'],
    ['ask clawed code', 'ask Claude Code'],
    ['start claud code', 'start Claude Code'],
    ['use the codec agent', 'use the Codex agent'],
    ['restart Mdash', 'restart Emdash'],
    ['open OMyPy now', 'open oh-my-pi now'],
    ['open oh my pie now', 'open oh-my-pi now'],
    ['cloud  code', 'Claude Code'],
  ])('fixes %s', (heard, expected) => {
    expect(fixTranscriptNames(heard)).toBe(expected);
  });

  it.each([
    'the cloud is down',
    'open Google Cloud Code',
    'use google  cloud code here',
    'a video codec',
    'cloudcode',
    'the codec agents',
    'my mdashes',
    'move to the cloud, code later',
  ])('leaves %s alone', (text) => {
    expect(fixTranscriptNames(text)).toBe(text);
  });
});
