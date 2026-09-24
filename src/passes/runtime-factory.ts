import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { isRuntimePath } from "../core/context.js";
import { confusingName } from "../utils/names.js";

/**
 * Runtime-Generated Functions (factory pass).
 *
 * Static function declarations are dissolved: the function body is wrapped in
 * a closure factory and the original binding becomes the result of an
 * immediately-invoked factory call, so no `function f(...)` declaration
 * survives. This removes the function graph anchors that static analyzers and
 * simple renamers rely on, and (L2) attaches decoy metadata to the produced
 * function object.
 *
 * Gates: the binding must only ever be referenced as the callee of a call, no
 * call may precede the declaration (preserves var-hoisting semantics), the
 * function must not be VM-virtualized, and the body must not call into the
 * runtime (VM stubs stay put).
 */
export function factoryFunctions(ast: t.File, ctx: Context): void {
  const level = ctx.options.rfactory;
  if (level <= 0) return;

  const targets: NodePath[] = [];

  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (isRuntimePath(path, ctx)) return;
      if (!path.node.id) return;
      maybeTarget(path);
    },
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (isRuntimePath(path, ctx)) return;
      const init = path.node.init;
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      if (!init) return;
      if (t.isFunctionExpression(init) || (level >= 2 && t.isArrowFunctionExpression(init))) {
        maybeTarget(path);
      }
    },
  });

  function maybeTarget(holder: NodePath): void {
    let name: string | undefined;
    if (holder.isFunctionDeclaration()) name = holder.node.id?.name;
    else if (holder.isVariableDeclarator() && t.isIdentifier(holder.node.id)) name = holder.node.id.name;
    if (!name) return;

    const binding = holder.scope.getBinding(name);
    if (!binding) return;
    if (binding.constantViolations.length > 0) return;
    if (binding.referencePaths.length === 0) return;

    let fnNode: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | null = null;
    if (holder.isFunctionDeclaration()) fnNode = holder.node;
    else if (holder.isVariableDeclarator()) {
      const init = holder.node.init;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) fnNode = init;
    }
    if (!fnNode) return;
    if (ctx.vmEligible.has(fnNode)) return;
    if (!t.isBlockStatement(fnNode.body)) return;
    if (fnNode.generator) return;

    // every reference must be a direct call callee
    const refs = binding.referencePaths as NodePath<t.Identifier>[];
    const declStart = holder.node.start ?? 0;
    for (const ref of refs) {
      const parent = ref.parentPath;
      if (!parent?.isCallExpression() || parent.node.callee !== ref.node) return;
      const rs = ref.node.start ?? 0;
      if (rs < declStart) return; // call-before-declaration would break under `var`
    }

    // body must not call into the runtime (VM stub / helper detection)
    let callsRuntime = false;
    try {
      holder.traverse({
        CallExpression(path: NodePath<t.CallExpression>) {
          if (callsRuntime) return;
          const callee = path.node.callee;
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object, { name: ctx.runtime.binding })
          ) {
            callsRuntime = true;
          }
        },
      });
    } catch {
      callsRuntime = true; // conservative: detached nodes can't be verified
    }
    if (callsRuntime) return;

    targets.push(holder);
  }

  for (const holder of targets) {
    if (holder.isFunctionDeclaration()) {
      const fn = holder.node;
      if (!fn.id) continue;
      const factory = buildFactory(fn, level, ctx);
      const varDecl = t.variableDeclaration("var", [
        t.variableDeclarator(t.identifier(fn.id.name), factory),
      ]);
      holder.replaceWith(varDecl);
      ctx.stats.functionsGenerated++;
    } else if (holder.isVariableDeclarator()) {
      const init = holder.node.init;
      if (!init || (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init))) continue;
      holder.node.init = buildFactory(init, level, ctx);
      ctx.stats.functionsGenerated++;
    }
  }
}

function buildFactory(
  fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
  level: number,
  ctx: Context,
): t.CallExpression {
  const nm = () => confusingName(ctx.rng, ctx.usedNames, 2);
  const inner = nm();
  const factoryFn = t.functionExpression(null, [], t.blockStatement([]));

  // fresh copy of the function as an expression, stripped of its id so `.name`
  // is not preserved
  let copy: t.FunctionExpression | t.ArrowFunctionExpression;
  if (t.isFunctionDeclaration(fn)) {
    copy = t.functionExpression(
      null,
      fn.params,
      fn.body as t.BlockStatement,
      fn.generator,
      fn.async,
    );
  } else {
    const c = t.cloneNode(fn, true);
    if (t.isFunctionExpression(c)) c.id = null;
    copy = c;
  }

  const innerDecl = t.variableDeclaration("var", [
    t.variableDeclarator(t.identifier(inner), copy as t.Expression),
  ]);
  const factoryBody: t.Statement[] = [innerDecl];

  if (level >= 2) {
    // decoy metadata attached to the produced function object (runs after the
    // function binding is initialized, so hoisting semantics are preserved)
    const meta = nm();
    const key = nm();
    factoryBody.push(
      t.variableDeclaration("var", [
        t.variableDeclarator(
          t.identifier(meta),
          t.objectExpression([
            t.objectProperty(
              t.identifier(key),
              t.binaryExpression("^", t.numericLiteral(ctx.rng.range(1, 0x7fff)), t.numericLiteral(ctx.rng.range(1, 0x7fff))),
            ),
          ]),
        ),
      ]),
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(t.identifier(inner), t.identifier(key)),
          t.identifier(meta),
        ),
      ),
    );
  }

  factoryBody.push(t.returnStatement(t.identifier(inner)));

  factoryFn.body = t.blockStatement(factoryBody);
  return t.callExpression(t.parenthesizedExpression(factoryFn), []);
}
