/**
 * Splits a command's text into words, keeping a quoted phrase together:
 * `"Ark DAO" ARK 1000 5000` -> ["Ark DAO", "ARK", "1000", "5000"].
 * Straight and curly quotes both work (phones often turn " into “ ”).
 * An unmatched quote is left in the word as typed.
 */
export function splitArgs(text) {
  const words = [];
  for (const m of (text ?? "").matchAll(/["“”]([^"“”]*)["“”]|(\S+)/g)) {
    const word = m[1] !== undefined ? m[1].trim() : m[2];
    if (word) words.push(word);
  }
  return words;
}
