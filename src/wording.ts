/** Numbers written by a model must be the numbers the tools already computed. */

function numericText(text: string): string {
  return text.replace(/[\u00A0\u202F]/g, "");
}

export function extractNumbers(text: string): number[] {
  const matches = numericText(text).match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  const values: number[] = [];
  for (const raw of matches) {
    const normalized = raw.replace(/,/g, "");
    if (normalized === "-" || normalized === "." || normalized === "-.") continue;
    const value = Number(normalized);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function sameNumber(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * 1e-9;
}

function sameAbsolute(left: number, right: number): boolean {
  return sameNumber(Math.abs(left), Math.abs(right));
}

/** A model may cite the absolute gap between two figures the tools already computed. */
function knownDifferences(values: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      gaps.push(Math.abs((values[i] ?? 0) - (values[j] ?? 0)));
    }
  }
  return gaps;
}

/** Numbers in the model text that do not appear in the computed wording. */
export function mismatchedNumbers(modelText: string, computedText: string): number[] {
  const allowed = extractNumbers(computedText);
  const accepted = [...allowed, ...knownDifferences(allowed)];
  const bad: number[] = [];
  for (const value of extractNumbers(modelText)) {
    if (accepted.some((candidate) => sameAbsolute(value, candidate))) continue;
    if (bad.some((existing) => sameNumber(existing, value))) continue;
    bad.push(value);
  }
  return bad;
}

export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceParts(text: string): string[] {
  return plainText(text)
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter((part) => /[A-Za-z0-9]/u.test(part));
}

export function isTwoPlainSentences(text: string): boolean {
  return sentenceParts(text).length === 2;
}

/** At most two sentences, with markdown and list markers removed. */
export function limitToTwoPlainSentences(text: string): string {
  const parts = sentenceParts(text).slice(0, 2);
  return parts.map((part) => /[.!?]$/u.test(part) ? part : `${part}.`).join(" ");
}
