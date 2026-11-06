// One entry point for "is this pack fit to run?": structure (schema.ts), copy policy (ADR 0018), draft markers,
// and the orchestrator's own script rules (validateScript, via compilePack).
import { BRAND_NAMES, FORBIDDEN_CLAIMS } from '../../../../tools/booth/copy-check';
import type { ScenarioScript } from '../scenarios';
import { compilePack } from './compile';
import { parsePack, type ScenarioPack } from './schema';

export interface PackValidation {
  pack?: ScenarioPack;
  script?: ScenarioScript;
  errors: string[];
}

/** Words that make a claim a denial ("not certified"); same idea as the booth copy check, kept deliberately simple. */
const NEGATION = /\b(not|never|no|isn't|aren't|doesn't|don't|cannot|can't|without|neither|nor|avoid)\b|n't\b/i;

/** All text a visitor or presenter can read, with the path it came from. */
export function packTexts(pack: ScenarioPack): { path: string; text: string }[] {
  const out = [
    { path: 'title', text: pack.title },
    { path: 'description', text: pack.description },
  ];
  pack.steps.forEach((s, i) => {
    out.push({ path: `steps[${i}].title`, text: s.title }, { path: `steps[${i}].narration`, text: s.narration });
    s.events?.forEach((e, j) => {
      if (e.type === 'provider_outage' || e.type === 'fx_shock') out.push({ path: `steps[${i}].events[${j}].reason`, text: e.reason });
    });
  });
  pack.expected.forEach((x, i) => out.push({ path: `expected[${i}].text`, text: x.text }));
  return out;
}

/** Copy-policy findings (ADR 0018) for a pack's text: forbidden claims and real brand names. */
export function copyProblems(pack: ScenarioPack): string[] {
  const problems: string[] = [];
  for (const { path, text } of packTexts(pack)) {
    for (const c of FORBIDDEN_CLAIMS) {
      const re = new RegExp(c.pattern.source, c.pattern.flags.includes('g') ? c.pattern.flags : `${c.pattern.flags}g`);
      for (const m of text.matchAll(re)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
        if (NEGATION.test(before)) continue;
        problems.push(`${path}: copy policy - "${m[0]}" (${c.reason}); ${c.hint}`);
        break;
      }
    }
    for (const b of BRAND_NAMES) if (b.pattern.test(text)) problems.push(`${path}: copy policy - real brand "${b.name}"; use a fictional name (Orion, Lyra, Vega) or a generic term`);
  }
  return problems;
}

/** Scaffolded packs carry TODO markers; a pack with any is a draft and is never loaded into the orchestrator. */
export function draftProblems(pack: ScenarioPack): string[] {
  return packTexts(pack)
    .filter(({ text }) => /\bTODO\b/.test(text))
    .map(({ path }) => `${path}: still contains a TODO marker (draft packs are not loaded)`);
}

export function validatePack(input: unknown): PackValidation {
  const parsed = parsePack(input);
  if (!parsed.pack) return { errors: parsed.errors };
  const errors = [...copyProblems(parsed.pack), ...draftProblems(parsed.pack)];
  let script: ScenarioScript | undefined;
  try {
    script = compilePack(parsed.pack);
  } catch (e) {
    errors.push(`script: ${(e as Error).message}`);
  }
  // Expectation checks must refer to something the pack can actually produce; the dry run proves it, but a
  // typo in a corridor id is better reported here.
  return { pack: parsed.pack, ...(script ? { script } : {}), errors };
}
