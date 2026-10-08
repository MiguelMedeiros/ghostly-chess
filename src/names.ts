/**
 * Players' names. The client gives an app only the person's own display name in this chat (context().name, with the
 * `name` permission), never the contact's, so each side sends its own in its hello (n) and shows the contact's from
 * the contact's hello. Chess sends what the client gives it: the client is to give the name the contact already sees
 * in this chat (and none when the person shares none), so that nothing new leaves the device.
 *
 * A name is cleaned before it goes and again on receipt (cleanName, in protocol.ts), and shown with textContent only.
 * Without a name the strips say "You" and "Your contact". There is no avatar API, so a player's disc shows initials.
 */
export { cleanName } from "./protocol.ts";

/**
 * Up to two initials of a cleaned name, to fit the disc: the first letter or digit of its first word and of its last
 * word, one code point each. The name is put in upper case first (the same on every device, whatever its language), so
 * a letter that grows there ("ß" to "SS") still gives one. A word with no letter or digit gives its first character
 * as it is drawn (an emoji, a whole flag); two such words give only the first, as two emoji do not fit.
 */
export function initials(name: string): string {
  const words = name.toUpperCase().split(" ").filter(Boolean);
  const drawn = (word: string) => ("Segmenter" in Intl ? [...new Intl.Segmenter().segment(word)][0]?.segment : [...word][0]) ?? "";
  const first = (word = "") => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? drawn(word);
  const a = first(words[0]);
  const b = words.length > 1 ? first(words[words.length - 1]) : "";
  return /[\p{L}\p{N}]/u.test(a + b) ? a + b : a;
}
