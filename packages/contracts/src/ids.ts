import { createHash, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/**
 * Deterministic UUID-shaped id from parts. Stages derive the id of the event they produce from
 * (causation eventId + stage + type), so a redelivered trigger yields the same eventId and the
 * state machine drops the duplicate.
 */
export function deterministicId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Stable 0..1 number from a string. Used by stubs so outcomes are deterministic. */
export function unitHash(value: string): number {
  const h = createHash('sha256').update(value).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}
