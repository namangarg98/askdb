/**
 * Checks that the numbers in an answer actually come from the query results.
 *
 * Models are unreliable at mental arithmetic: an answer once said "the 12
 * months total about 597,094.42" when the real sum was 617,085.20. Every
 * number in the answer text must match (allowing for the answer's own
 * rounding) a value in the results, the question, or the row count.
 *
 * Small whole numbers (0-10) are not checked: they are usually counts or
 * ordinals in the wording ("top 5", "3 products") and checking them causes
 * false alarms. A wrong small number is therefore not caught.
 */

const SMALL_INTEGER_LIMIT = 10;

/** Numbers as written: optional sign/currency, thousands separators, decimals, K/M/B suffix, percent. */
const NUMBER_PATTERN = /(?<![\w.])[-−]?\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?([kKmMbB](?![a-zA-Z]))?(%)?/g;

interface WrittenNumber {
  readonly text: string;
  readonly value: number;
  /** Half of the smallest unit the writer used: "110K" -> 500, "4.5" -> 0.05. */
  readonly tolerance: number;
  readonly percent: boolean;
}

const SUFFIX_SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

export function extractNumbers(text: string): WrittenNumber[] {
  const numbers: WrittenNumber[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const [whole, integerPart = '', fraction = '', suffix, percentSign] = match;
    const sign = whole.trimStart().startsWith('-') || whole.trimStart().startsWith('−') ? -1 : 1;
    const scale = suffix ? (SUFFIX_SCALE[suffix.toLowerCase()] ?? 1) : 1;
    const decimals = fraction ? fraction.length - 1 : 0;
    numbers.push({
      text: whole.trim(),
      value: sign * Number(`${integerPart.replace(/,/g, '')}${fraction}`) * scale,
      tolerance: 0.5 * 10 ** -decimals * scale + 1e-9,
      percent: Boolean(percentSign),
    });
  }
  return numbers;
}

/** Every number that appears in the given values, including numbers inside text such as dates. */
export function numbersIn(values: readonly unknown[]): number[] {
  const found: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') {
      found.push(value);
    } else if (typeof value === 'string') {
      const asNumber = Number(value);
      if (value.trim() !== '' && Number.isFinite(asNumber)) found.push(asNumber);
      for (const token of value.match(/\d+(\.\d+)?/g) ?? []) found.push(Number(token));
    }
  }
  return found;
}

/**
 * Returns the numbers written in `answer` that match nothing in `sources`.
 * A percentage also matches its fraction form (4.46% ~ 0.0446).
 */
export function ungroundedNumbers(answer: string, sources: readonly number[]): string[] {
  const matches = (written: WrittenNumber) =>
    sources.some((source) => {
      const candidates = written.percent ? [source, source * 100] : [source];
      return candidates.some((candidate) => Math.abs(candidate - written.value) <= written.tolerance);
    });

  return extractNumbers(answer)
    .filter((n) => !(Number.isInteger(n.value) && Math.abs(n.value) <= SMALL_INTEGER_LIMIT && !n.percent))
    .filter((n) => !matches(n))
    .map((n) => n.text);
}
