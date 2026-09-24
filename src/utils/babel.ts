import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

/**
 * Babel ships CJS; depending on the host (Node ESM, vitest, tsx) the callable
 * may sit at `mod`, `mod.default`, or deeper. Unwrap defensively so the rest of
 * the codebase can call `traverse(...)` / `generate(...)` uniformly.
 */
function unwrap(mod: unknown): any {
  let m: any = mod;
  for (let i = 0; i < 3 && m && typeof m !== "function"; i++) {
    m = m.default;
  }
  return m;
}

export const traverse = unwrap(_traverse);
export const generate = unwrap(_generate);
