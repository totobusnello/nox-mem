// Query-string parsing for the HTTP API.
//
// The hand-rolled split("&") / split("=") parser this replaces had three defects:
// "+" stayed a literal plus (URLSearchParams, and so most JS clients, encode a
// space as "+", which turned `salience formula` into a search for
// `salience+formula`); a value containing "=" was truncated at it; and keys went
// into a plain object, so `__proto__` / `hasOwnProperty` could collide with
// Object.prototype. URLSearchParams handles the first two and never throws on a
// malformed "%" escape. For the third, the prototype-reaching keys are dropped
// (no route reads them) and the object has no prototype as a second layer.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  const pairs = idx === -1 ? [] : [...new URLSearchParams(url.substring(idx + 1))];
  // fromEntries defines own data properties (a later duplicate key wins, as
  // before) instead of assigning through a computed key.
  const params = Object.fromEntries(pairs.filter(([k]) => k && !RESERVED_KEYS.has(k)));
  return Object.setPrototypeOf(params, null) as Record<string, string>;
}
