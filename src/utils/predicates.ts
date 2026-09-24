import * as t from "@babel/types";
import { RNG } from "./rng.js";

export type PredicateFlavor = "mba" | "parity" | "exception" | "float" | "coercion" | "runtime" | "bitwise" | "stringlen" | "regexlit" | "local-identity" | "local-typeof" | "local-cmp" | "local-ternary";

export interface PredicateResult {
  expr: t.Expression;
  flavor: PredicateFlavor;
}

/** Allowed opaque-predicate flavors by CFF level (higher = harder static fold). */
export function flavorsForCff(level: number): PredicateFlavor[] {
  if (level <= 0) return ["mba"];
  if (level === 1) return ["mba", "coercion", "stringlen"];
  if (level === 2) return ["mba", "coercion", "exception", "bitwise", "regexlit", "local-identity", "local-typeof"];
  return ["mba", "coercion", "exception", "runtime", "bitwise", "stringlen", "regexlit", "local-identity", "local-typeof", "local-cmp"];
}

/**
 * Build an opaque predicate over one of the caller's own locals (`e`).
 * All flavors are ALWAYS TRUE for every possible value of `e` (including NaN),
 * but they reference a real runtime variable, so a constant folder cannot
 * collapse them without tracking the variable's value through the data flow.
 */
function localPredicate(rng: RNG, wantTrue: boolean, e: string): PredicateResult {
  const id = () => t.identifier(e);
  const eqSelf = () => t.binaryExpression("===", id(), t.cloneNode(id()));
  const neSelf = () => t.binaryExpression("!==", id(), t.cloneNode(id()));
  const flavor = rng.pick<PredicateFlavor>(["local-identity", "local-typeof", "local-cmp", "local-ternary"] as PredicateFlavor[]);
  let inner: t.Expression;
  switch (flavor) {
    case "local-identity":
      // A || !A
      inner = t.logicalExpression("||", eqSelf(), neSelf());
      break;
    case "local-typeof":
      inner = t.binaryExpression("===", t.unaryExpression("typeof", id()), t.unaryExpression("typeof", id()));
      break;
    case "local-cmp":
      // (e===e) === (e===e)
      inner = t.binaryExpression("===", t.parenthesizedExpression(eqSelf()), t.parenthesizedExpression(eqSelf()));
      break;
    case "local-ternary":
      // e===e ? e===e : !(e===e)
      inner = t.conditionalExpression(t.parenthesizedExpression(eqSelf()), t.parenthesizedExpression(eqSelf()), t.unaryExpression("!", t.parenthesizedExpression(eqSelf())));
      break;
    default:
      inner = t.logicalExpression("||", eqSelf(), neSelf());
  }
  return { expr: wantTrue ? inner : t.unaryExpression("!", t.parenthesizedExpression(inner)), flavor };
}

/**
 * Opaque predicate engine. Returns an expression that deterministically
 * evaluates to `wantTrue`, but whose truth value is hard to derive statically.
 */
export function opaquePredicate(
  rng: RNG,
  wantTrue: boolean,
  flavors?: PredicateFlavor[],
  locals?: string[],
): PredicateResult {
  let pool: PredicateFlavor[] = flavors ?? ["mba", "parity", "exception", "float", "coercion", "bitwise", "stringlen", "regexlit"];
  if (locals && locals.length > 0) {
    pool = [...pool, "local-identity", "local-typeof", "local-cmp", "local-ternary"];
  }
  const flavor = rng.pick(pool);
  if (flavor === "local-identity" || flavor === "local-typeof" || flavor === "local-cmp" || flavor === "local-ternary") {
    const e = rng.pick(locals!) ?? "undefined";
    return localPredicate(rng, wantTrue, e);
  }
  switch (flavor) {
    case "mba": {
      // (n+1)*(n+2) - n*(n+3) === 2 for all integer n (quadratic cancellation)
      const n = rng.range(2, 999);
      const eq = t.binaryExpression(
        "===",
        t.binaryExpression(
          "-",
          t.binaryExpression(
            "*",
            t.binaryExpression("+", t.numericLiteral(n), t.numericLiteral(1)),
            t.binaryExpression("+", t.numericLiteral(n), t.numericLiteral(2)),
          ),
          t.binaryExpression(
            "*",
            t.numericLiteral(n),
            t.binaryExpression("+", t.numericLiteral(n), t.numericLiteral(3)),
          ),
        ),
        t.numericLiteral(2),
      );
      return { expr: wantTrue ? eq : t.unaryExpression("!", t.parenthesizedExpression(eq)), flavor };
    }
    case "parity": {
      // (n & 1) * ((n & 1) - 1) === 0  (n&1 in {0,1} for ALL integers, incl.
      // negatives; product always 0). NOTE: must use bitwise-and, not `% 2`,
      // because JS `%` keeps the sign of the dividend: for negative odd n,
      // n % 2 === -1 and (-1)*((-1)-1) === 2 !== 0, which would make this
      // "always-true" predicate false and break packer manifests / CFF branches.
      const n = rng.range(-999, 999);
      const mod = t.binaryExpression("&", t.numericLiteral(n), t.numericLiteral(1));
      const p = t.binaryExpression(
        "===",
        t.binaryExpression("*", t.cloneNode(mod), t.binaryExpression("-", t.cloneNode(mod), t.numericLiteral(1))),
        t.numericLiteral(0),
      );
      return { expr: wantTrue ? p : t.unaryExpression("!", t.parenthesizedExpression(p)), flavor };
    }
    case "exception": {
      // strings that JSON.parse always rejects; "}" deliberately excluded so the
      // resulting predicate never matches a `JSON.parse("}")` fingerprint
      const bad = rng.pick(["{", "[", "]", "\u0000", "abc", ""]);
      const retTrue = t.returnStatement(t.booleanLiteral(true));
      const retFalse = t.returnStatement(t.booleanLiteral(false));
      const body = t.blockStatement([
        t.tryStatement(
          t.blockStatement([
            t.expressionStatement(
              t.callExpression(t.memberExpression(t.identifier("JSON"), t.identifier("parse")), [t.stringLiteral(bad)]),
            ),
            wantTrue ? retFalse : retTrue,
          ]),
          t.catchClause(t.identifier(rng.ident(3)), t.blockStatement([wantTrue ? retTrue : retFalse])),
        ),
      ]);
      const iife = t.callExpression(t.parenthesizedExpression(t.functionExpression(null, [], body)), []);
      return { expr: iife, flavor };
    }
    case "float": {
      const n = rng.range(1, 50);
      const nExpr = t.binaryExpression("*", t.numericLiteral(n), t.numericLiteral(0));
      const cmp = t.binaryExpression(
        "===",
        t.binaryExpression("+", t.binaryExpression("+", t.cloneNode(nExpr), t.numericLiteral(0.1)), t.numericLiteral(0.2)),
        t.binaryExpression("+", t.cloneNode(nExpr), t.numericLiteral(0.3)),
      );
      return { expr: wantTrue ? t.unaryExpression("!", t.parenthesizedExpression(cmp)) : cmp, flavor };
    }
    case "coercion": {
      const k = rng.range(1, 1000);
      const obj = t.objectExpression([
        t.objectProperty(
          t.memberExpression(t.identifier("Symbol"), t.identifier("toPrimitive")),
          t.arrowFunctionExpression([], t.numericLiteral(k)),
          true,
        ),
      ]);
      const cmp = t.binaryExpression(
        "===",
        t.binaryExpression("-", t.parenthesizedExpression(obj), t.numericLiteral(0)),
        t.numericLiteral(k),
      );
      return { expr: wantTrue ? cmp : t.unaryExpression("!", t.parenthesizedExpression(cmp)), flavor };
    }
    case "runtime": {
      // Always-true runtime observation. Must hold in BOTH node and browser
      // targets (the packer payloads run in browsers), so it cannot depend on
      // `document` being absent. `globalThis` is an object in every ES2020+
      // realm, making this a safe always-true opaque predicate.
      const docOk = t.binaryExpression(
        "===",
        t.unaryExpression("typeof", t.identifier("globalThis")),
        t.stringLiteral("object"),
      );
      const branch = wantTrue ? docOk : t.unaryExpression("!", t.parenthesizedExpression(docOk));
      return { expr: branch, flavor };
    }
    case "bitwise": {
      // (k ^ (k >> 31)) - (k >> 31) === k for k >= 0 (int32 abs identity)
      const k = rng.range(1, 0x7fff);
      const shr = t.binaryExpression(">>", t.numericLiteral(k), t.numericLiteral(31));
      const cmp = t.binaryExpression(
        "===",
        t.binaryExpression("-", t.binaryExpression("^", t.numericLiteral(k), t.cloneNode(shr)), t.cloneNode(shr)),
        t.numericLiteral(k),
      );
      return { expr: wantTrue ? cmp : t.unaryExpression("!", t.parenthesizedExpression(cmp)), flavor };
    }
    case "stringlen": {
      const n = rng.range(1, 9);
      const cmp = t.binaryExpression(
        "===",
        t.memberExpression(t.stringLiteral("a".repeat(n)), t.identifier("length")),
        t.numericLiteral(n),
      );
      return { expr: wantTrue ? cmp : t.unaryExpression("!", t.parenthesizedExpression(cmp)), flavor };
    }
    case "regexlit": {
      const ch = rng.pick(["a", "b", "x", "z", "0", "9"]);
      const cmp = t.binaryExpression(
        "===",
        t.callExpression(t.memberExpression(t.regExpLiteral(ch, ""), t.identifier("test")), [t.stringLiteral(ch)]),
        t.booleanLiteral(true),
      );
      return { expr: wantTrue ? cmp : t.unaryExpression("!", t.parenthesizedExpression(cmp)), flavor };
    }
  }
}
