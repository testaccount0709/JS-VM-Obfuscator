import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";

/**
 * Regex literal encryption: /pat/flags -> new RegExp("<enc pat>", "<enc flags>").
 * The two string literals are encrypted later by the strings pass.
 * A fresh RegExp object per evaluation matches native literal semantics.
 */
export function lowerRegex(ast: t.File, ctx: Context): void {
  if (ctx.options.regex <= 0) return;

  traverse(ast, {
    RegExpLiteral(path: NodePath<t.RegExpLiteral>) {
      // if RegExp is shadowed in this scope, lowering would change semantics
      if (path.scope.getBinding("RegExp")) return;
      const replacement = t.newExpression(t.identifier("RegExp"), [
        t.stringLiteral(path.node.pattern),
        t.stringLiteral(path.node.flags),
      ]);
      path.replaceWith(replacement);
      path.skip();
      ctx.stats.loweredRegex++;
    },
  });
}
