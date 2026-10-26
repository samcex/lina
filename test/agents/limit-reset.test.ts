import {describe,it,expect} from 'vitest';
import {usageResetAt, usageResetHint} from '../../src/server/agents/limit-reset.js';
const now=Date.parse('2026-10-25T18:00:00Z');
describe('usage reset timestamps',()=>{
 it('reads explicit timezone wall times from the actual Claude session-limit format',()=>{
  expect(usageResetAt("You've hit your session limit · resets 9:20pm (Europe/Zurich)",now)).toBe(Date.parse('2026-10-25T20:20:00Z'));
 });
 it('handles midnight rollover and unambiguous dates',()=>{
  expect(usageResetAt('resets 12:15am (Europe/Zurich)',now)).toBe(Date.parse('2026-10-25T23:15:00Z'));
  expect(usageResetAt('resets Oct 28, 3pm (Europe/Zurich)',now)).toBe(Date.parse('2026-10-28T14:00:00Z'));
 });
 it('handles daylight-saving offsets and the repeated hour',()=>{
  expect(usageResetAt('resets 9:20pm (Europe/Zurich)',Date.parse('2026-07-01T15:00:00Z'))).toBe(Date.parse('2026-07-01T19:20:00Z'));
  expect(usageResetAt('resets 2:30am (Europe/Zurich)',Date.parse('2026-10-25T00:45:00Z'))).toBe(Date.parse('2026-10-25T01:30:00Z'));
 });
 it('supports ISO, epoch seconds and relative reset hints',()=>{
  expect(usageResetAt('resets at 2026-10-25T20:30:00Z',now)).toBe(Date.parse('2026-10-25T20:30:00Z'));
  expect(usageResetAt('usage limit|'+String((now+3600000)/1000),now)).toBe(now+3600000);
  expect(usageResetAt('Try again in 3 hours.',now)).toBe(now+10800000);
 });
 it('retains a just-elapsed Codex reset without rolling it over to tomorrow',()=>{
  const at=Date.parse('2026-10-26T16:58:20Z');
  expect(usageResetHint('Usage limit; try again at 5:58 PM (Europe/Zurich)',at)).toBe(Date.parse('2026-10-26T16:58:00Z'));
  expect(usageResetAt('Usage limit; try again at 5:58 PM (Europe/Zurich)',at)).toBeUndefined();
  expect(usageResetHint('Usage limit; try again at 5:58 PM (Europe/Zurich)',at+18*60000)).toBe(Date.parse('2026-10-26T16:58:00Z'));
  expect(usageResetHint('resets at 2026-10-26T16:58:00Z',at)).toBe(Date.parse('2026-10-26T16:58:00Z'));
  expect(usageResetHint('resets at 2026-10-26T16:00:00Z',at)).toBeUndefined();
 });
 it('does not turn a stale reset into repeated immediate requests',()=>{
  expect(usageResetAt('resets at 2026-10-25T17:59:00Z',now)).toBeUndefined();
  expect(usageResetAt('resets 6:59pm (Europe/Zurich)',now)).toBeUndefined();
  expect(usageResetAt('resets 99:99pm (Europe/Zurich)',now)).toBeUndefined();
  expect(usageResetAt('resets 9:20pm (not/a/zone)',now)).toBeUndefined();
 });
});
