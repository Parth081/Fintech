// Loads scenario packs from a folder. A bad pack is skipped with a clear message; it never stops the orchestrator
// (a typo in a prospect pack must not take the booth's built-in scenarios down).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioScript } from '../scenarios';
import { validatePack } from './validate';
import type { ScenarioPack } from './schema';

export const PACK_FILE_SUFFIX = '.pack.json';
const here = path.dirname(fileURLToPath(import.meta.url));
/** Packs in this folder are loaded by the orchestrator. Examples live in ./examples and are opt-in (copy one here). */
export const ACTIVE_PACKS_DIR = path.join(here, 'active');
export const EXAMPLE_PACKS_DIR = path.join(here, 'examples');

export interface LoadedPack {
  file: string;
  pack: ScenarioPack;
  script: ScenarioScript;
}
export interface PackProblem {
  file: string;
  errors: string[];
}
export interface LoadResult {
  packs: LoadedPack[];
  problems: PackProblem[];
}

export function packFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(PACK_FILE_SUFFIX))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadPackFile(file: string): { loaded?: LoadedPack; problem?: PackProblem } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problem: { file, errors: [`not valid JSON: ${(e as Error).message}`] } };
  }
  const v = validatePack(json);
  if (v.errors.length > 0 || !v.pack || !v.script) return { problem: { file, errors: v.errors } };
  const expectedName = path.basename(file, PACK_FILE_SUFFIX);
  if (v.pack.name !== expectedName) return { problem: { file, errors: [`pack.name "${v.pack.name}" must match the file name "${expectedName}${PACK_FILE_SUFFIX}"`] } };
  return { loaded: { file, pack: v.pack, script: v.script } };
}

/** Loads every valid pack in `dir`. `reservedIds` are scenario ids already taken (a pack may not shadow them). */
export function loadPacks(dir: string, reservedIds: Iterable<string> = []): LoadResult {
  const taken = new Set(reservedIds);
  const result: LoadResult = { packs: [], problems: [] };
  for (const file of packFiles(dir)) {
    const { loaded, problem } = loadPackFile(file);
    if (problem) {
      result.problems.push(problem);
      continue;
    }
    if (taken.has(loaded!.script.id)) {
      result.problems.push({ file, errors: [`scenario id "${loaded!.script.id}" is already used by another scenario`] });
      continue;
    }
    taken.add(loaded!.script.id);
    result.packs.push(loaded!);
  }
  return result;
}

/**
 * The orchestrator's hook: the scenario scripts from the active packs folder (PACKS_DIR overrides it).
 * Problems are logged and the pack skipped.
 */
export function loadActivePackScripts(reservedIds: Iterable<string>, log: (line: string) => void = () => {}): ScenarioScript[] {
  const dir = process.env.PACKS_DIR ? path.resolve(process.env.PACKS_DIR) : ACTIVE_PACKS_DIR;
  const { packs, problems } = loadPacks(dir, reservedIds);
  for (const p of problems) log(`[orchestrator] scenario pack skipped: ${path.basename(p.file)}: ${p.errors.join('; ')}`);
  for (const p of packs) log(`[orchestrator] scenario pack loaded: ${p.script.id} (${p.pack.audience})`);
  return packs.map((p) => p.script);
}
