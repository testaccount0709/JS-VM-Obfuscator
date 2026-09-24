import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { isRuntimePath } from "../core/context.js";

type FnBody = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

/**
 * Lift provably-safe nested function expressions / arrows to block-level
 * FunctionDeclarations so scope-analysis no longer excludes the parent for
 * nested-function.
 */
export function liftNestedFunctions(ast: t.File, ctx: Context): void {
  if (ctx.options.vm < 1) return;

  let changed = true;
  while (changed) {
    changed = false;
    traverse(ast, {
      enter(path: NodePath) {
        if (isRuntimePath(path, ctx)) return;
        if (!path.isFunction()) return;
        const body = path.node.body;
        if (!t.isBlockStatement(body)) return;
        if (liftInBlock(body, path as NodePath<FnBody>, ctx)) changed = true;
      },
    });
  }
}

function liftInBlock(body: t.BlockStatement, fnPath: NodePath<FnBody>, ctx: Context): boolean {
  let lifted = false;
  const decls: t.FunctionDeclaration[] = [];

  for (let i = 0; i < body.body.length; i++) {
    const stmt = body.body[i];
    if (!t.isVariableDeclaration(stmt) || stmt.kind !== "const" && stmt.kind !== "let") continue;
    if (stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0];
    if (!t.isIdentifier(d.id) || !d.init) continue;
    const init = d.init;
    if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) continue;
    if (init.async || init.generator) continue;
    if (!t.isBlockStatement(init.body) && !t.isExpression(init.body)) continue;
    if (!isSafeToLift(d.id.name, fnPath, stmt, init)) continue;

    const liftedName = ctx.freshName("$lf");
    const fnBody = t.isBlockStatement(init.body)
      ? init.body
      : t.blockStatement([t.returnStatement(init.body as t.Expression)]);
    const liftedFn = t.functionDeclaration(t.identifier(liftedName), init.params, fnBody);
    decls.push(liftedFn);
    body.body[i] = t.variableDeclaration(stmt.kind, [
      t.variableDeclarator(d.id, t.identifier(liftedName)),
    ]);
    lifted = true;
    ctx.stats.functionsLifted = (ctx.stats.functionsLifted ?? 0) + 1;
  }

  if (decls.length > 0) {
    body.body = [...decls, ...body.body];
  }
  return lifted;
}

/** Binding must be initialized before every reference, never reassigned, and not rely on caller/lexical context. */
function isSafeToLift(
  name: string,
  fnPath: NodePath<FnBody>,
  declStmt: t.VariableDeclaration,
  init: t.FunctionExpression | t.ArrowFunctionExpression,
): boolean {
  const binding = fnPath.scope.getBinding(name);
  if (!binding) return false;
  if (!binding.constant) return false;
  const declStart = declStmt.start ?? 0;
  for (const ref of binding.referencePaths) {
    if ((ref.node.start ?? 0) < declStart) return false;
  }
  if (hasUnsafeEnvAccess(init)) return false;
  return true;
}

function hasUnsafeEnvAccess(fn: t.FunctionExpression | t.ArrowFunctionExpression): boolean {
  const isArrow = t.isArrowFunctionExpression(fn);
  let found = false;

  function walk(node: t.Node | null | undefined, shieldThis: boolean, shieldArgs: boolean): void {
    if (found || !node || typeof node !== "object") return;
    if (t.isThisExpression(node)) {
      if (!shieldThis) { found = true; return; }
    }
    if (t.isIdentifier(node, { name: "arguments" })) {
      if (!shieldArgs) { found = true; return; }
    }
    if (t.isSuper(node)) { found = true; return; }
    if (t.isMetaProperty(node) && node.meta.name === "new" && node.property.name === "target") {
      if (!shieldArgs) { found = true; return; }
    }

    const nextShieldThis = shieldThis || (t.isFunction(node) && !t.isArrowFunctionExpression(node)) || t.isClass(node);
    const nextShieldArgs = shieldArgs || (t.isFunction(node) && !t.isArrowFunctionExpression(node));

    const keys = t.VISITOR_KEYS[node.type] ?? [];
    for (const key of keys) {
      if (node.type === "MemberExpression" && !node.computed && key === "property") continue;
      if (node.type === "ObjectProperty" && !node.computed && key === "key") continue;
      if (node.type === "ClassMethod" && !node.computed && key === "key") continue;
      if (node.type === "ClassProperty" && !node.computed && key === "key") continue;
      const val = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(val)) {
        for (const child of val) walk(child as t.Node, nextShieldThis, nextShieldArgs);
      } else if (val && typeof val === "object") {
        walk(val as t.Node, nextShieldThis, nextShieldArgs);
      }
    }
  }

  walk(fn.body, false, isArrow ? false : true);
  for (const p of fn.params) walk(p, false, isArrow ? false : true);
  return found;
}
