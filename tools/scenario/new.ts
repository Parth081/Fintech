// `npm run scenario:new -- --name acme-recovery --audience psp|bank|marketplace [--dir <folder>] [--force]`
// Writes a runnable starter pack (all words marked TODO) into the active packs folder. Edit it, then run
// `npm run scenario:check`. Packs that still contain TODO are not loaded by the orchestrator.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVE_PACKS_DIR, NAME_RE, PACK_AUDIENCES, PACK_FILE_SUFFIX, type PackAudience } from '../../services/orchestrator/src/packs';
import { scaffold } from './templates';

export const NEW_USAGE = `Usage: npm run scenario:new -- --name <slug> --audience ${PACK_AUDIENCES.join('|')} [--dir <folder>] [--force]

  --name      lower-case slug, 3 to 40 characters; becomes the scenario id and the file name
  --audience  who the scenario is for; picks the starter story
  --dir       where to write the pack (default: services/orchestrator/src/packs/active)
  --force     overwrite an existing pack of the same name
`;

export function runNew(argv: readonly string[], out: (line: string) => void = console.log): number {
  let name = '';
  let audience = '';
  let dir = ACTIVE_PACKS_DIR;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      out(NEW_USAGE);
      return 0;
    }
    if (a === '--name') name = argv[++i] ?? '';
    else if (a === '--audience') audience = argv[++i] ?? '';
    else if (a === '--dir') dir = path.resolve(argv[++i] ?? '');
    else if (a === '--force') force = true;
    else {
      out(`Unknown option "${a}".\n${NEW_USAGE}`);
      return 2;
    }
  }
  if (!NAME_RE.test(name)) {
    out(`--name must be a lower-case slug of 3 to 40 characters (letters, digits, dashes); got "${name}".\n${NEW_USAGE}`);
    return 2;
  }
  if (!(PACK_AUDIENCES as readonly string[]).includes(audience)) {
    out(`--audience must be one of ${PACK_AUDIENCES.join(', ')}; got "${audience}".\n${NEW_USAGE}`);
    return 2;
  }
  const file = path.join(dir, `${name}${PACK_FILE_SUFFIX}`);
  if (existsSync(file) && !force) {
    out(`${file} already exists. Choose another name or pass --force.`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(scaffold(name, audience as PackAudience), null, 2)}\n`, 'utf8');
  out(`Created ${file}\nNext: replace every TODO, then run: npm run scenario:check -- ${path.relative(process.cwd(), file)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(runNew(process.argv.slice(2)));
}
