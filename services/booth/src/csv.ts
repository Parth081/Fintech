// CSV export of leads, safe to open in a spreadsheet.
import type { Lead } from '@ct/contracts';

/**
 * One CSV cell. Cells that a spreadsheet would treat as a formula (starting with = + - @, or a tab /
 * carriage return that some apps strip first) are prefixed with an apostrophe; then RFC 4180 quoting.
 */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const CSV_COLUMNS = [
  'id', 'createdAt', 'name', 'company', 'role', 'email', 'interest', 'consentAt', 'consentText', 'scenarios', 'questions', 'dwellSeconds',
] as const;

export function leadsToCsv(leads: Lead[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const l of leads) {
    rows.push(
      [
        l.id, l.createdAt, l.name, l.company, l.role ?? '', l.email, l.interest, l.consentAt, l.consentText,
        l.engagement.scenarios.join('; '), l.engagement.questions.join('; '), l.engagement.dwellSeconds,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM so spreadsheet apps read UTF-8 names correctly.
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
