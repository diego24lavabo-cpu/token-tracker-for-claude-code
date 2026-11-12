/**
 * Project names of container folders. A folder flagged as holding several projects is
 * reported per subfolder, named `<folder> › <subfolder>` (for example
 * `VS Code › Astrophotography_TM`); usage at the top of the folder keeps the folder's name.
 */

/** Between a container folder and its subfolder in a project name. */
export const PROJECT_SEPARATOR = ' › ';

/** The name a subfolder of a container folder is reported under. */
export function subfolderProject(folder: string, subfolder: string): string {
  return `${folder}${PROJECT_SEPARATOR}${subfolder}`;
}

/** The container folder of a subfolder project, or null for any other project. */
export function containerOf(project: string): string | null {
  const index = project.indexOf(PROJECT_SEPARATOR);
  return index > 0 ? project.slice(0, index) : null;
}

/** The subfolder part of a subfolder project, or the name itself for any other project. */
export function subfolderOf(project: string): string {
  const index = project.indexOf(PROJECT_SEPARATOR);
  return index > 0 ? project.slice(index + PROJECT_SEPARATOR.length) : project;
}
