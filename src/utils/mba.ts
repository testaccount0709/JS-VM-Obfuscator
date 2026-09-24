import * as t from "@babel/types";
import { RNG } from "./rng.js";

function isInt32(v: number): boolean {
  return Number.isFinite(v) && Math.floor(v) === v && v >= -2147483648 && v <= 2147483647;
}

function lit(v: number): t.NumericLiteral {
  return t.numericLiteral(Object.is(v, -0) ? 0 : v);
}

/** Always parenthesize composite sub-expressions: MBA trees mix precedence levels. */
function p(e: t.Expression): t.Expression {
  return t.parenthesizedExpression(e);
}

/**
 * Build an expression that evaluates exactly to `value`.
 * Uses MBA-style identities that are safe under IEEE754 / int32 bitwise rules.
 */
export function mbaExpr(rng: RNG, value: number, depth = 2): t.Expression {
  if (Object.is(value, -0)) {
    return t.unaryExpression("-", lit(0));
  }
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return t.binaryExpression("/", lit(0), lit(0));
    return t.binaryExpression("/", value > 0 ? lit(1) : t.unaryExpression("-", lit(1)), lit(0));
  }
  if (!isInt32(value)) {
    if (depth <= 0) return lit(value);
    // additive split with an integer keeps double precision exact
    const a = rng.range(-1000, 1000);
    const b = value - a;
    if (a + b === value) {
      return t.binaryExpression("+", p(mbaExpr(rng, a, 0)), p(mbaExpr(rng, b, 0)));
    }
    return lit(value);
  }
  if (depth <= 0) return lit(value);

  const v = value | 0;
  const choice = rng.int(5);
  switch (choice) {
    case 0: {
      // (x + k) - k
      const k = rng.range(1, 0x7fff);
      const inner = p(mbaExpr(rng, v, depth - 1));
      return t.binaryExpression("-", t.binaryExpression("+", inner, lit(k)), lit(k));
    }
    case 1: {
      // (x ^ k) ^ k  (int32-safe)
      const k = rng.int(0x7fffffff);
      const inner = p(mbaExpr(rng, v, depth - 1));
      return t.binaryExpression("^", t.binaryExpression("^", inner, lit(k)), lit(k));
    }
    case 2: {
      // (x & k) | (x & ~k) === x
      const k = rng.int(0x7fffffff) | 1;
      const inner = p(mbaExpr(rng, v, depth - 1));
      return t.binaryExpression(
        "|",
        t.binaryExpression("&", t.cloneNode(inner), lit(k)),
        t.binaryExpression("&", t.cloneNode(inner), t.unaryExpression("~", lit(k))),
      );
    }
    case 3: {
      // split: a + b  (the emitted expression is a plain double sum, so the
      // acceptance check must be exact — `(a+b)|0` would accept splits that
      // wrap around int32 and produce a wrong runtime value)
      const a = rng.range(-0x7fff, 0x7fff);
      const b = (v - a) | 0;
      if (a + b !== v) return lit(v);
      return t.binaryExpression("+", p(mbaExpr(rng, a, depth - 1)), p(mbaExpr(rng, b, depth - 1)));
    }
    default: {
      // xor-split: a ^ b
      const a = rng.int(0x7fffffff);
      const b = (v ^ a) | 0;
      return t.binaryExpression("^", p(mbaExpr(rng, a, depth - 1)), p(mbaExpr(rng, b, depth - 1)));
    }
  }
}

/**
 * MBA over one of the program's OWN locals: the result is exactly `value`, but
 * the expression references a real runtime variable so a constant folder cannot
 * collapse it without data-flow analysis. Every form is ALWAYS `value` for any
 * value of `local` (including NaN/undefined), and both branches of the ternary
 * are the same constant so semantics are preserved.
 */
export function mbaExprLocal(rng: RNG, value: number, depth: number, localName: string): t.Expression {
  const inner = mbaExpr(rng, value, Math.max(0, depth - 1));
  const id = t.identifier(localName);
  const eqSelf = t.binaryExpression("===", t.cloneNode(id), t.cloneNode(id));
  const neSelf = t.binaryExpression("!==", t.cloneNode(id), t.cloneNode(id));
  const guard = rng.chance(0.5)
    ? t.logicalExpression("||", eqSelf, neSelf) // e===e || e!==e  (always true)
    : t.binaryExpression("===", t.unaryExpression("typeof", t.cloneNode(id)), t.unaryExpression("typeof", t.cloneNode(id))); // typeof e === typeof e
  // C ? inner : inner
  return t.conditionalExpression(p(guard), p(inner), p(t.cloneNode(inner)));
}
