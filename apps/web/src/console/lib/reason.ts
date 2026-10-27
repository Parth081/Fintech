// Operator reason validation (pure): trimmed, at least `min` characters. Returns an error text or null.
export function reasonError(reason: string, min = 5): string | null {
  const r = reason.trim();
  if (r.length === 0) return 'A reason is required';
  if (r.length < min) return `Give a little more detail (at least ${min} characters)`;
  return null;
}
