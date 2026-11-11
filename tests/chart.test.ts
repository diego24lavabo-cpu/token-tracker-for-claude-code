import { describe, expect, it } from 'vitest';
import { niceCeil, tickIndexes } from '../src/lib/chart';

describe('niceCeil', () => {
  it('rounds up to a round number for the top of an axis', () => {
    expect(niceCeil(1_700_000)).toBe(2_000_000);
    expect(niceCeil(1_150_000)).toBe(1_200_000);
    expect(niceCeil(61_459)).toBe(80_000);
    expect(niceCeil(1_000)).toBe(1_000);
    expect(niceCeil(999)).toBe(1_000);
    expect(niceCeil(7)).toBe(8);
  });

  it('never returns less than the value', () => {
    for (const value of [1, 13, 149, 151, 2_501, 99_999, 123_456_789]) {
      expect(niceCeil(value)).toBeGreaterThanOrEqual(value);
      expect(niceCeil(value)).toBeLessThanOrEqual(value * 1.35);
    }
  });

  it('gives an empty chart a usable scale', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
});

describe('tickIndexes', () => {
  it('labels every position when they fit', () => {
    expect(tickIndexes(5, 6)).toEqual([0, 1, 2, 3, 4]);
    expect(tickIndexes(0, 6)).toEqual([]);
  });

  it('spreads the labels evenly and keeps both ends', () => {
    expect(tickIndexes(30, 6)).toEqual([0, 6, 12, 17, 23, 29]);
    expect(tickIndexes(365, 6)).toEqual([0, 73, 146, 218, 291, 364]);
    expect(tickIndexes(7, 6)).toEqual([0, 1, 2, 4, 5, 6]);
  });
});
