// Small pure-JS hashes (browser-safe, deterministic across platforms: integer ops only).

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser: avalanche a 32-bit integer. */
export function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash a 32-bit key together with an integer index (any safe integer, negative allowed). */
export function hashIndex(key: number, index: number): number {
  const lo = index >>> 0; // ToUint32 = index mod 2^32
  const hi = Math.floor(index / 4294967296) >>> 0;
  return fmix32(fmix32(key ^ lo) ^ Math.imul(hi + 0x9e3779b9, 0x27d4eb2f));
}

/** Uniform in [-1, 1] from a 32-bit hash. Exact dyadic arithmetic, so identical everywhere. */
export function signedUnit(h: number): number {
  return (h / 4294967295) * 2 - 1;
}
