import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import type { ScopeInfo } from "./scope-analysis.js";

/**
 * Signature reshaping: permute parameter order of provably-internal functions
 * and adapt every (direct) call site. Conservative gates keep this semantics-
 * preserving: no defaults/rest/destructuring, no spread at call sites, no
 * `arguments` usage, never virtualized.
 */
export function reshapeFunctions(ast: t.File, ctx: Context, info: ScopeInfo): void {
  if (ctx.options.reshape <= 0) return;
  void ast;

  for (const [fn, callInfo] of [...info.internalCalls.entries()]) {
    if (ctx.vmEligible.has(fn)) continue;
    const n = fn.params.length;
    if (n < 2) continue;
    if (!ctx.rng.chance(0.6)) continue;
    if (fn.params.some((p) => !t.isIdentifier(p))) continue;
    // all call sites must be plain (no spread)
    if (callInfo.callSites.some((s) => s.node.arguments.some((a) => t.isSpreadElement(a)))) continue;

    // perm[i] = new position of original param i
    let perm = ctx.rng.shuffle(Array.from({ length: n }, (_, i) => i));
    if (perm.every((v, i) => v === i)) {
      perm = [...perm];
      const tmp = perm[0];
      perm[0] = perm[1];
      perm[1] = tmp;
    }

    const oldParams = fn.params.slice() as t.Identifier[];
    const newParams: t.Identifier[] = new Array(n);
    for (let i = 0; i < n; i++) newParams[perm[i]] = oldParams[i];
    fn.params = newParams;

    // resolve the function's current name (may have been renamed by the
    // identifiers pass); call sites redirected to scatter clones must be
    // skipped because the clones' params were not permuted.
    let currentName = callInfo.bindingName;
    const bpNode = callInfo.bindingPath.node;
    if (t.isFunctionDeclaration(bpNode) && bpNode.id) currentName = bpNode.id.name;
    else if (t.isVariableDeclarator(bpNode) && t.isIdentifier(bpNode.id)) currentName = bpNode.id.name;

    for (const site of callInfo.callSites) {
      const call = site.node;
      if (!t.isCallExpression(call)) continue;
      if (t.isIdentifier(call.callee) && call.callee.name !== currentName) continue;
      const oldArgs = call.arguments.slice() as (t.Expression | t.SpreadElement)[];
      const newArgs: (t.Expression | t.SpreadElement)[] = new Array(Math.max(n, oldArgs.length)).fill(undefined);
      for (let i = 0; i < oldArgs.length; i++) {
        if (i < n) newArgs[perm[i]] = oldArgs[i];
        else newArgs[i] = oldArgs[i];
      }
      for (let i = 0; i < newArgs.length; i++) {
        if (newArgs[i] === undefined) newArgs[i] = t.identifier("undefined");
      }
      call.arguments = newArgs;
    }
    ctx.stats.functionsReshaped++;
  }
}
