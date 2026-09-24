import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { mbaExpr, mbaExprLocal } from "../utils/mba.js";
import { isReserved } from "../utils/names.js";

/**
 * Hoisted binding names visible at `path`, from the nearest enclosing function
 * AND every outer function up to the program. Only hoisted `var`/function
 * bindings are safe to reference from arbitrary positions (params and
 * block-scoped `let`/`const` can be in TDZ); outer-scope hoisted bindings are
 * always accessible, which maximizes MBA breadth even in `const`-heavy async
 * code.
 */
function localNames(path: NodePath): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let s: NodePath["scope"] | undefined = path.scope;
  while (s) {
    for (const name of Object.keys(s.bindings)) {
      if (seen.has(name)) continue;
      const b = s.bindings[name];
      // params are in TDZ until initialized (a default value cannot reference a
      // param), and block-scoped let/const can be TDZ too — only hoisted
      // var/function bindings are safe.
      if (b.kind === "param" || b.kind === "let" || b.kind === "const" || b.kind === "module") continue;
      if (isReserved(name)) continue;
      seen.add(name);
      names.push(name);
    }
    if (s.path.isProgram()) break;
    s = s.parent;
  }
  return names.slice(0, 16);
}

export function encodeNumbers(ast: t.File, ctx: Context): void {
  if (ctx.options.numbers <= 0) return;

  const encode = (path: NodePath, value: number): void => {
    // ~40% of encodings reference a real local so the MBA is not statically
    // foldable (it needs data-flow analysis to collapse)
    const locals = localNames(path);
    if (locals.length > 0 && ctx.rng.chance(0.4)) {
      path.replaceWith(mbaExprLocal(ctx.rng, value, ctx.rng.range(1, 2), ctx.rng.pick(locals)));
    } else {
      path.replaceWith(mbaExpr(ctx.rng, value, ctx.rng.range(1, 2)));
    }
    path.skip();
    ctx.stats.encodedNumbers++;
  };

  traverse(ast, {
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      // encode negative literals as a unit (preserve -0 as-is)
      if (path.node.operator !== "-") return;
      const arg = path.node.argument;
      if (!t.isNumericLiteral(arg)) return;
      if (arg.value === 0) return; // keep -0 literal form
      encode(path, -arg.value);
    },
    NumericLiteral(path: NodePath<t.NumericLiteral>) {
      const parent = path.parentPath?.node;
      const parentPath = path.parentPath;
      // skip object/class keys
      if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) return;
      if (t.isObjectMethod(parent) && parent.key === path.node) return;
      if (t.isClassMethod(parent) && parent.key === path.node) return;
      if (t.isClassProperty(parent) && parent.key === path.node) return;
      // skip unary-minus children (handled above)
      if (parentPath?.isUnaryExpression() && parentPath.node.operator === "-" && parentPath.node.argument === path.node) return;
      if (path.node.value === 0) return; // 0 is everywhere; encoding adds noise without value
      encode(path, path.node.value);
    },
  });
}
