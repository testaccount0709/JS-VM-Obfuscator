import { RNG } from "./rng.js";

const CONFUSING = "IlO"; // homoglyph-safe confusing alphabet (no 0/1 to stay valid & unambiguous-free)
const CONFUSING_FULL = "Il1O0o";

/**
 * Generate confusing, homoglyph-style identifiers (Il1O style).
 * First char is always a letter/underscore so the name is a valid identifier.
 */
export function confusingName(rng: RNG, used: Set<string>, level: 2): string {
  const alpha = level >= 2 ? CONFUSING_FULL : CONFUSING;
  const lead = "IlO_";
  for (let attempt = 0; attempt < 100; attempt++) {
    const len = rng.range(4, 8);
    let s = lead[rng.int(lead.length)];
    for (let i = 1; i < len; i++) s += alpha[rng.int(alpha.length)];
    if (!used.has(s) && !isReserved(s)) {
      used.add(s);
      return s;
    }
  }
  // fallback uniqueness
  let i = 0;
  for (;;) {
    const s = "_$" + (i++).toString(36) + rng.ident(3);
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
}

/** Plain minified-style unique names for L1. */
export function minifiedName(index: number, used: Set<string>): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
  let n = index;
  let s = "";
  do {
    s = chars[n % chars.length] + s;
    n = Math.floor(n / chars.length) - 1;
  } while (n >= 0);
  if (used.has(s)) {
    let i = 0;
    while (used.has(s + i)) i++;
    s = s + i;
  }
  used.add(s);
  return s;
}

const RESERVED = new Set([
  "do", "if", "in", "for", "let", "new", "try", "var", "case", "else", "enum",
  "eval", "null", "this", "true", "void", "with", "await", "break", "catch",
  "class", "const", "false", "super", "throw", "while", "yield", "delete",
  "export", "import", "public", "return", "static", "switch", "typeof",
  "default", "extends", "finally", "continue", "debugger", "function",
  "arguments", "instanceof", "undefined", "async", "get", "set",
]);

export function isReserved(s: string): boolean {
  return RESERVED.has(s);
}

/** Names that look like interesting globals, used for shadow decoys.
 *  NOTE: `eval` and `arguments` are excluded — they are illegal as binding
 *  names in strict mode and would produce a SyntaxError. */
export const DECOY_GLOBAL_NAMES = [
  "Function", "fetch", "decodeURI", "unescape", "atob",
  "constructor", "prototype", "require", "module", "process",
];
