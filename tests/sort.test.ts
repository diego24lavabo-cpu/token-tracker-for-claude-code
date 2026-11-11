import { describe, expect, it } from 'vitest';
import { sortRows } from '../src/lib/sort';

const rows = [
  { name: 'app-10', tokens: 5 },
  { name: 'App-2', tokens: null },
  { name: 'beta', tokens: 9 },
  { name: 'alpha', tokens: 5 },
];

describe('sortRows', () => {
  it('sorts numbers both ways and keeps missing values last', () => {
    const desc = sortRows(rows, (row) => row.tokens, 'desc').map((row) => row.name);
    expect(desc).toEqual(['beta', 'app-10', 'alpha', 'App-2']);
    const asc = sortRows(rows, (row) => row.tokens, 'asc').map((row) => row.name);
    expect(asc).toEqual(['app-10', 'alpha', 'beta', 'App-2']);
  });

  it('sorts text naturally, ignoring case', () => {
    const names = sortRows(rows, (row) => row.name, 'asc').map((row) => row.name);
    expect(names).toEqual(['alpha', 'App-2', 'app-10', 'beta']);
  });

  it('leaves the input untouched', () => {
    const copy = [...rows];
    sortRows(rows, (row) => row.name, 'desc');
    expect(rows).toEqual(copy);
  });
});
