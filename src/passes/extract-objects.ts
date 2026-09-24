import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { isRuntimePath } from "../core/context.js";
import { confusingName } from "../utils/names.js";

/**
 * Object Property Extraction.
 *
 * For object literals bound to a variable whose only observable uses are
 * static-key member reads (optionally ++ / compound ops at L2), the object is
 * dissolved: each property value is hoisted into its own variable and every
 * `obj.key` read is rewritten to reference that variable directly. The literal
 * disappears entirely, so tooling that recovers object shapes from literals,
 * tracks the object graph, or hooks `obj.key` accessors loses its anchor.
 *
 * Strict gates keep semantics intact: no whole-object use, no writes, no
 * calls through a member (would change `this`), no reads before the
 * declaration, no computed keys / spreads / methods / __proto__ / duplicates.
 */
export function extractObjects(ast: t.File, ctx: Context): void {
  const level = ctx.options.extractObjects;
  if (level <= 0) return;

  interface Candidate {
    path: NodePath<t.VariableDeclarator>;
    keys: string[];
    values: (t.Expression | t.SpreadElement)[];
  }

  const candidates: Candidate[] = [];

  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (isRuntimePath(path, ctx)) return;
      const init = path.node.init;
      if (!t.isObjectExpression(init)) return;
      if (init.properties.length === 0) return;
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      if (id.name === "arguments" || id.name === "undefined") return;

      const keys: string[] = [];
      const values: (t.Expression | t.SpreadElement)[] = [];
      for (const p of init.properties) {
        if (!t.isObjectProperty(p) || p.computed || p.shorthand) return;
        let k: string | undefined;
        if (t.isIdentifier(p.key)) k = p.key.name;
        else if (t.isStringLiteral(p.key)) k = p.key.value;
        else if (t.isNumericLiteral(p.key)) k = String(p.key.value);
        else return;
        if (k === "__proto__") return;
        if (keys.includes(k)) return; // duplicate keys: last-wins ordering not worth modeling
        keys.push(k);
        values.push(p.value as t.Expression);
      }

      const binding = path.scope.getBinding(id.name);
      if (!binding) return;
      if (binding.constantViolations.length > 0) return;
      if (binding.referencePaths.length === 0) return;

      const declStart = path.node.start ?? 0;
      const keySet = new Set(keys);

      for (const ref of binding.referencePaths) {
        const rs = ref.node.start ?? 0;
        if (rs < declStart) return; // hoisting would change behavior
        const parent = ref.parentPath;
        if (!parent || !parent.isMemberExpression()) return;
        const member = parent.node;
        if (member.object !== ref.node) return;
        let k: string | undefined;
        if (!member.computed && t.isIdentifier(member.property)) k = member.property.name;
        else if (member.computed && t.isStringLiteral(member.property)) k = member.property.value;
        else if (member.computed && t.isNumericLiteral(member.property)) k = String(member.property.value);
        else return;
        if (k === undefined || !keySet.has(k)) return;

        const pp = parent.parentPath;
        if (pp?.isCallExpression() && pp.node.callee === member) return; // o.k() changes `this`
        if (pp?.isNewExpression() && pp.node.callee === member) return;
        if (pp?.isTaggedTemplateExpression() && pp.node.tag === member) return;
        if (pp?.isUnaryExpression() && pp.node.operator === "delete" && pp.node.argument === member) return;
        if (pp?.isAssignmentExpression() && pp.node.left === member && pp.node.operator === "=") return;
        if (pp?.isAssignmentExpression() && pp.node.left === member && pp.node.operator !== "=" && level < 2) return;
        if (pp?.isUpdateExpression() && pp.node.argument === member && level < 2) return;
      }

      candidates.push({ path, keys, values });
    },
  });

  if (candidates.length === 0) return;

  const nm = () => confusingName(ctx.rng, ctx.usedNames, 2);

  for (const cand of candidates) {
    const { path, keys, values } = cand;
    const decl = path.parentPath;
    if (!decl?.isVariableDeclaration()) continue;

    const varNames = keys.map(() => nm());
    const nameByKey = new Map<string, string>();
    keys.forEach((k, i) => nameByKey.set(k, varNames[i]));

    // rewrite every obj.key use to the extracted variable
    const binding = path.scope.getBinding((path.node.id as t.Identifier).name);
    if (!binding) continue;
    for (const ref of binding.referencePaths) {
      const parent = ref.parentPath;
      if (!parent?.isMemberExpression()) continue;
      const member = parent.node;
      let k: string | undefined;
      if (!member.computed && t.isIdentifier(member.property)) k = member.property.name;
      else if (member.computed && t.isStringLiteral(member.property)) k = member.property.value;
      else if (member.computed && t.isNumericLiteral(member.property)) k = String(member.property.value);
      if (k === undefined) continue;
      const target = nameByKey.get(k);
      if (target === undefined) continue;
      parent.replaceWith(t.identifier(target));
    }

    // replace the declarator with one extracted variable per property
    const newDecls: t.VariableDeclarator[] = values.map(
      (v, i) =>
        t.variableDeclarator(t.identifier(varNames[i]), v as t.Expression),
    );
    const oldDecls = decl.node.declarations;
    const idx = oldDecls.indexOf(path.node);
    decl.node.declarations = [
      ...oldDecls.slice(0, idx),
      ...newDecls,
      ...oldDecls.slice(idx + 1),
    ];
    ctx.stats.objectsExtracted++;
  }
}
