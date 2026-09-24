import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { Context } from "../core/context.js";
import type { ScopeInfo } from "./scope-analysis.js";
import { confusingName, minifiedName } from "../utils/names.js";

type FnClone = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

/**
 * Function cloning/scattering: duplicate internal-only functions into seeded
 * variant clones (params/locals renamed via scope-aware rename) and distribute
 * call sites across original + clones.
 *
 * Clones are emitted as FunctionDeclarations inserted next to the original
 * binding so the CFF pass (which runs after scatter) hoists them ahead of its
 * dispatcher and they are initialized before any flattened case runs.
 */
export function scatterFunctions(ast: t.File, ctx: Context, info: ScopeInfo): void {
  if (ctx.options.scatter <= 0) return;
  void ast;

  let nameCounter = 0;
  const freshName = (): string =>
    ctx.options.identifiers >= 2
      ? confusingName(ctx.rng, ctx.usedNames, 2)
      : minifiedName(10000 + nameCounter++, ctx.usedNames);

  for (const [fn, callInfo] of [...info.internalCalls.entries()]) {
    if (ctx.vmEligible.has(fn)) continue;
    if (!ctx.rng.chance(0.6)) continue;
    const cloneCount = ctx.rng.range(1, 2);
    const bindingPath = callInfo.bindingPath;

    const cloneNames: string[] = [];
    for (let c = 0; c < cloneCount; c++) {
      const cloneName = freshName();
      const cloned = t.cloneNode(fn, true) as FnClone;
      const decl = toFunctionDeclaration(cloneName, cloned);

      const stmt = bindingPath.isFunctionDeclaration()
        ? bindingPath
        : bindingPath.getStatementParent();
      if (!stmt) continue;

      const insertedPaths = stmt.insertAfter(decl) as NodePath[];
      const inserted = insertedPaths[0];
      if (!inserted?.isFunctionDeclaration()) continue;

      cloneNames.push(cloneName);
      inserted.scope.crawl();
      const paramNames = decl.params.filter(t.isIdentifier).map((p) => p.name);
      const fnScope = inserted.scope;
      for (const oldName of paramNames) {
        try {
          fnScope.rename(oldName, freshName());
        } catch {
          // rename collision — leave as-is
        }
      }
    }

    if (cloneNames.length === 0) continue;

    let currentName = callInfo.bindingName;
    const bpNode = callInfo.bindingPath.node;
    if (t.isFunctionDeclaration(bpNode) && bpNode.id) currentName = bpNode.id.name;
    else if (t.isVariableDeclarator(bpNode) && t.isIdentifier(bpNode.id)) currentName = bpNode.id.name;

    const all = [currentName, ...cloneNames];
    for (const site of callInfo.callSites) {
      if (!site.node || !t.isCallExpression(site.node)) continue;
      site.node.callee = t.identifier(ctx.rng.pick(all));
    }
    ctx.stats.functionsScattered++;
  }
}

function toFunctionDeclaration(name: string, fn: FnClone): t.FunctionDeclaration {
  if (t.isFunctionDeclaration(fn)) {
    fn.id = t.identifier(name);
    return fn;
  }
  const body = t.isBlockStatement(fn.body)
    ? fn.body
    : t.blockStatement([t.returnStatement(fn.body as t.Expression)]);
  return t.functionDeclaration(
    t.identifier(name),
    fn.params as t.FunctionDeclaration["params"],
    body,
    fn.async,
    fn.generator,
  );
}
