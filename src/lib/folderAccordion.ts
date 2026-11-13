// Container folder groups on the Projects page behave as an accordion: at most one group
// is open, except while the search box has text, when every group with a matching
// subfolder is open as well.

interface GroupRow {
  name: string;
  children?: readonly { name: string }[];
}

interface GroupSelection {
  project: string;
  /** True when the folder row itself (the whole folder) is selected. */
  folder: boolean;
}

/** The open group after a click on `folder`'s toggle: it opens (closing the other), or closes. */
export function toggleFolder(open: string | null, folder: string): string | null {
  return open === folder ? null : folder;
}

/** Whether a folder's subfolders are shown. A search forces open the groups it matches inside. */
export function isFolderOpen(
  folder: string,
  open: string | null,
  search: { active: boolean; matchesSubfolder: boolean },
): boolean {
  return (search.active && search.matchesSubfolder) || open === folder;
}

/**
 * The group to leave open once the search is cleared: the one holding the selected row
 * (a subfolder, the folder's own top-level usage, or the folder row itself), else none.
 */
export function folderOfSelection(
  rows: readonly GroupRow[],
  selection: GroupSelection | null,
): string | null {
  if (!selection) return null;
  const group = rows.find(
    (row) =>
      row.children !== undefined &&
      ((selection.folder && row.name === selection.project) ||
        (!selection.folder && row.children.some((child) => child.name === selection.project))),
  );
  return group?.name ?? null;
}
