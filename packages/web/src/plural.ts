/** `1 file`, `2 files`, `1,234 files` — for nouns that pluralise with a plain `s`. */
export function countOf(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}
