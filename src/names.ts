/**
 * Players' names. The client gives an app only the person's own display name in this chat (context().name, with the
 * `name` permission), never the contact's, so each side sends its own in its hello (n) and shows the contact's from
 * the contact's hello. The contact already sees that name in the chat, so nothing new leaves the device.
 *
 * A name is cleaned before it goes and again on receipt (cleanName, in protocol.ts), and shown with textContent only.
 * Without a name the strips say "You" and "Your contact". There is no avatar API, so a player's disc shows initials.
 */
export { cleanName } from "./protocol.ts";

/**
 * Up to two initials of a cleaned name: the first letter or digit of its first word and of its last word (a word with
 * none gives its first character, an emoji say), upper case. Whole code points, never half a surrogate pair.
 */
export function initials(name: string): string {
  const words = name.split(" ").filter(Boolean);
  const first = (word = "") => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? [...word][0] ?? "";
  return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : "")).toLocaleUpperCase();
}
