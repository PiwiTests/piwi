/** FNV-1a 32-bit of a string's UTF-16 code units, as 8 hex characters: stable and dependency-free. */
export function fnv1a32(input: string, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
