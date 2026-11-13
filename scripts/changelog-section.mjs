// Prints the CHANGELOG.md section of a version, for the release notes. Fails when the
// section is missing or empty, so a release never goes out without notes.
//
// Usage: node scripts/changelog-section.mjs <version>   (for example 0.1.0 or v0.1.0)
import fs from 'node:fs';
import path from 'node:path';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/changelog-section.mjs <version>');
  process.exit(1);
}

const file = path.join(import.meta.dirname, '..', 'CHANGELOG.md');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const heading = (line) => /^## \[/.test(line);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}
let end = lines.findIndex((line, index) => index > start && heading(line));
if (end === -1) end = lines.length;
// Link references at the end of the file ("[0.1.0]: https://…") are not part of the notes.
const body = lines
  .slice(start + 1, end)
  .filter((line) => !/^\[[^\]]+\]: /.test(line))
  .join('\n')
  .trim();
if (!body) {
  console.error(`The "## [${version}]" section of CHANGELOG.md is empty.`);
  process.exit(1);
}
console.log(body);
