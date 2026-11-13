import { describe, expect, it } from 'vitest';
import { folderOfSelection, isFolderOpen, toggleFolder } from '../src/lib/folderAccordion';

const rows = [
  { name: 'Code-2026', children: [{ name: 'Code-2026' }, { name: 'Code-2026 › alpha' }] },
  { name: 'Games', children: [{ name: 'Games › beta' }] },
  { name: 'plain-app' },
];

const noSearch = { active: false, matchesSubfolder: false };

describe('folder accordion', () => {
  it('keeps at most one group open', () => {
    let open: string | null = null;
    open = toggleFolder(open, 'Code-2026');
    expect(open).toBe('Code-2026');
    open = toggleFolder(open, 'Games');
    expect(open).toBe('Games');
    expect(isFolderOpen('Code-2026', open, noSearch)).toBe(false);
    expect(isFolderOpen('Games', open, noSearch)).toBe(true);
  });

  it('closes the open group when its own toggle is used again', () => {
    expect(toggleFolder('Games', 'Games')).toBeNull();
  });

  it('opens every group with a matching subfolder while searching', () => {
    const search = { active: true, matchesSubfolder: true };
    expect(isFolderOpen('Code-2026', 'Games', search)).toBe(true);
    expect(isFolderOpen('Games', 'Games', search)).toBe(true);
    // A folder that matches only by its own name stays as the accordion left it.
    const nameOnly = { active: true, matchesSubfolder: false };
    expect(isFolderOpen('Code-2026', 'Games', nameOnly)).toBe(false);
    expect(isFolderOpen('Games', 'Games', nameOnly)).toBe(true);
  });

  it('goes back to the group holding the selected row when the search is cleared', () => {
    expect(folderOfSelection(rows, { project: 'Games › beta', folder: false })).toBe('Games');
    expect(folderOfSelection(rows, { project: 'Code-2026', folder: false })).toBe('Code-2026');
    expect(folderOfSelection(rows, { project: 'Games', folder: true })).toBe('Games');
    expect(folderOfSelection(rows, { project: 'plain-app', folder: false })).toBeNull();
    expect(folderOfSelection(rows, null)).toBeNull();
  });
});
