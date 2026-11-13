// Generates a synthetic Claude Code `projects` folder (see scripts/demo-data.mjs): fake
// projects, sessions and subagents of every kind. Everything is invented.
//
// Usage: node scripts/gen-demo-data.mjs <output-projects-folder> [end-day YYYY-MM-DD]
//
// The data covers the 35 days that end with `end-day` (default: today). To look at it in
// the app, `npm run dev:demo` is simpler: it generates its own sample data. To scan this
// folder instead, point the home folder at a fake one, for example on Windows:
//   node scripts/gen-demo-data.mjs <fake-home>/.claude/projects
//   $env:USERPROFILE = '<fake-home>'; electron . --user-data-dir=<scratch folder>
//
// The output folder must be new, empty, or one this script wrote before (it holds a
// marker file); the script never deletes anything else.
import path from 'node:path';
import { generateDemoData } from './demo-data.mjs';

const [output, endDay] = process.argv.slice(2);
if (!output) {
  console.error('Usage: node scripts/gen-demo-data.mjs <output-projects-folder> [YYYY-MM-DD]');
  process.exit(1);
}
try {
  const root = path.resolve(output);
  const sessions = generateDemoData(root, { endDay });
  console.log(`${sessions} synthetic sessions written to ${root}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
