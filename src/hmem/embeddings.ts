const DIM = 64;

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 1);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function embed(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    const index = hash % DIM;
    const sign = (hash >>> 8) % 2 === 0 ? 1 : -1;
    const magnitude = 1 + ((hash >>> 16) % 8) / 8;
    vector[index] = (vector[index] ?? 0) + sign * magnitude;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export function cosine(left: number[], right: number[]): number {
  let dot = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) dot += (left[i] ?? 0) * (right[i] ?? 0);
  return dot;
}

export function jaccard(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
