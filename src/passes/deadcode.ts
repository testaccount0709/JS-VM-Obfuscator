import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { isRuntimePath } from "../core/context.js";
import { opaquePredicate } from "../utils/predicates.js";
import { mbaExpr } from "../utils/mba.js";
import { confusingName } from "../utils/names.js";
import { DECOY_GLOBAL_NAMES } from "../utils/names.js";

const HONEYPOT_STRINGS = [
  "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
  "AKIAIOSFODNN7EXAMPLE",
  "-----BEGIN RSA PRIVATE KEY-----",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
  "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "xoxb-1234567890-abcdefghijklmnop",
];

export function injectDeadCode(ast: t.File, ctx: Context): void {
  const level = ctx.options.deadcode;
  if (level <= 0) return;

  const bodies: NodePath<t.BlockStatement>[] = [];
  traverse(ast, {
    BlockStatement(path: NodePath<t.BlockStatement>) {
      if (isRuntimePath(path, ctx)) return;
      if (path.parentPath?.isFunction() || path.parentPath?.isProgram()) bodies.push(path);
    },
  });
  // program body
  const programBody = ast.program.body;

  const mkJunk = (count: number): t.Statement[] => {
    const stmts: t.Statement[] = [];
    for (let i = 0; i < count; i++) {
      const name = freshLocal(ctx);
      stmts.push(
        t.variableDeclaration("var", [t.variableDeclarator(t.identifier(name), mbaExpr(ctx.rng, ctx.rng.range(1, 0x7fff), 2))]),
      );
      stmts.push(
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.identifier(name),
            t.binaryExpression("^", t.identifier(name), mbaExpr(ctx.rng, ctx.rng.range(1, 0x7fff), 1)),
          ),
        ),
      );
      if (level >= 2 && ctx.rng.chance(0.4)) {
        stmts.push(
          t.expressionStatement(
            t.assignmentExpression("=", t.identifier(name), t.stringLiteral(ctx.rng.pick(HONEYPOT_STRINGS))),
          ),
        );
      }
    }
    return stmts;
  };

  const injections = Math.min(bodies.length, ctx.rng.range(2, 4 + level * 2));
  const chosen = ctx.rng.pickIndices(injections, bodies.length);
  for (const idx of chosen) {
    const body = bodies[idx];
    const pred = opaquePredicate(ctx.rng, false).expr;
    const dead = t.ifStatement(pred, t.blockStatement(mkJunk(ctx.rng.range(1, 3))));
    const pos = ctx.rng.range(0, body.node.body.length);
    body.node.body.splice(pos, 0, dead);
    ctx.stats.injectedDeadBranches++;
  }

  // top-level dead branch
  if (programBody.length > 0) {
    const pred = opaquePredicate(ctx.rng, false).expr;
    const dead = t.ifStatement(pred, t.blockStatement(mkJunk(ctx.rng.range(1, 2))));
    programBody.splice(ctx.rng.range(0, programBody.length), 0, dead);
    ctx.stats.injectedDeadBranches++;
  }

  // L2: decoy functions (never called)
  if (level >= 2) {
    const decoyCount = ctx.rng.range(1, 3);
    for (let i = 0; i < decoyCount; i++) {
      const name = freshLocal(ctx);
      const p1 = freshLocal(ctx);
      const p2 = freshLocal(ctx);
      const body = t.blockStatement([
        t.variableDeclaration("var", [
          t.variableDeclarator(
            t.identifier(freshLocal(ctx)),
            t.binaryExpression("+", t.identifier(p1), t.identifier(p2)),
          ),
        ]),
        ...(ctx.rng.chance(0.5)
          ? [t.expressionStatement(t.assignmentExpression("=", t.identifier(freshLocal(ctx)), t.stringLiteral(ctx.rng.pick(HONEYPOT_STRINGS))))]
          : []),
        t.returnStatement(mbaExpr(ctx.rng, ctx.rng.range(0, 100), 1)),
      ]);
      const decl = t.functionDeclaration(t.identifier(name), [t.identifier(p1), t.identifier(p2)], body);
      programBody.splice(ctx.rng.range(0, programBody.length), 0, decl);
    }
  }
}

function freshLocal(ctx: Context): string {
  if (ctx.options.identifiers >= 2) {
    return confusingName(ctx.rng, ctx.usedNames, 2);
  }
  return ctx.freshName("$d");
}
