import { traverse, generate } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { isRuntimePath } from "../core/context.js";
import { opaquePredicate, flavorsForCff } from "../utils/predicates.js";
import { isReserved } from "../utils/names.js";

interface Block {
  stmts: t.Statement[];
  term: Term | null;
}

type Term =
  | { kind: "goto"; target: Block }
  | { kind: "branch"; test: t.Expression; t: Block; f: Block }
  | { kind: "return"; arg?: t.Expression }
  | { kind: "throw"; arg: t.Expression }
  | { kind: "exit" };

type FnLike = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod | t.ClassMethod;

class CfgBuilder {
  blocks: Block[] = [];
  aborted = false;

  newBlock(): Block {
    const b: Block = { stmts: [], term: null };
    this.blocks.push(b);
    return b;
  }

  abort(): Block {
    this.aborted = true;
    return this.newBlock();
  }

  /** Lower a statement list; cont is the block control falls into afterwards. */
  lowerList(stmts: t.Statement[], cont: Block, topLevel: boolean): Block {
    let next = cont;
    for (let i = stmts.length - 1; i >= 0; i--) {
      next = this.lowerStmt(stmts[i], cont, next, topLevel && i === -1);
      if (this.aborted) return next;
    }
    return next;
  }

  private lowerStmt(stmt: t.Statement, _cont: Block, next: Block, _isTop: boolean): Block {
    if (this.aborted) return next;
    switch (stmt.type) {
      case "EmptyStatement":
        return next;
      case "BlockStatement":
        return this.lowerList(stmt.body, next, false);
      case "IfStatement": {
        const b = this.newBlock();
        const thenB = this.lowerStmt(stmt.consequent, next, next, false);
        const elseB = stmt.alternate ? this.lowerStmt(stmt.alternate, next, next, false) : next;
        b.term = { kind: "branch", test: stmt.test, t: thenB, f: elseB };
        return b;
      }
      case "ReturnStatement": {
        const b = this.newBlock();
        b.term = { kind: "return", arg: stmt.argument ?? undefined };
        return b;
      }
      case "ThrowStatement": {
        const b = this.newBlock();
        b.term = { kind: "throw", arg: stmt.argument };
        return b;
      }
      case "FunctionDeclaration": {
        // function declarations in decomposed (non-top) position would change
        // block scoping in strict mode -> abort
        this.aborted = true;
        return next;
      }
      case "BreakStatement":
      case "ContinueStatement": {
        // cannot appear in decomposed regions (loops are atomic); if they do, abort
        this.aborted = true;
        return next;
      }
      default: {
        // atomic statement (loops, switch, try, for-of/in, expressions, var decls, with, debugger)
        const b = this.newBlock();
        b.stmts.push(stmt);
        b.term = { kind: "goto", target: next };
        return b;
      }
    }
  }
}

/** Check if a statement (or its descendants) contains a specific node. */
function stmtContainsNode(stmt: t.Statement, target: t.Node): boolean {
  if (stmt === target) return true;
  let found = false;
  function walk(node: t.Node): void {
    if (found) return;
    if (node === target) { found = true; return; }
    const keys = t.VISITOR_KEYS[node.type];
    if (!keys) return;
    for (const key of keys) {
      const val = (node as any)[key];
      if (Array.isArray(val)) {
        for (const child of val) { if (child && typeof child === "object") walk(child); }
      } else if (val && typeof val === "object") {
        walk(val);
      }
    }
  }
  walk(stmt);
  return found;
}

/** Walk the decomposed region (top-level list + if branches) checking for unsafe constructs. */
function scanDecomposed(stmts: t.Statement[], ctx: { bad: boolean }, topLevel = true): void {
  for (const stmt of stmts) {
    if (ctx.bad) return;
    switch (stmt.type) {
      case "BlockStatement":
        scanDecomposed(stmt.body, ctx, false);
        break;
      case "IfStatement":
        scanDecomposed([stmt.consequent], ctx, false);
        if (stmt.alternate) scanDecomposed([stmt.alternate], ctx, false);
        break;
      case "VariableDeclaration":
        if (stmt.kind !== "var") ctx.bad = true;
        break;
      case "FunctionDeclaration":
        if (!topLevel) ctx.bad = true;
        break;
      case "ClassDeclaration":
        // Classes are block-scoped (TDZ) and may contain self-references
        // (`new.target === Cls`, `class B extends A`, static members). Flattening
        // them reorders/renames the binding and breaks those references, so
        // functions containing a class declaration are left native.
        ctx.bad = true;
        break;
      case "LabeledStatement":
        ctx.bad = true;
        break;
      case "EmptyStatement":
      case "ExpressionStatement":
      case "ReturnStatement":
      case "ThrowStatement":
      case "DebuggerStatement":
        break;
      default:
        // atomic (loops/switch/try/with): do not recurse
        break;
    }
  }
}

/** Detect break/continue crossing a try boundary (targets dissolved by flattening). */
function hasTryCrossingBreak(fnPath: NodePath): boolean {
  let found = false;
  fnPath.traverse({
    Function(inner) {
      inner.skip();
    },
    "BreakStatement|ContinueStatement"(path) {
      if (found) return;
      const node = path.node as t.BreakStatement | t.ContinueStatement;
      if (node.label) {
        found = true;
        return;
      }
      // walk up to the target loop/switch; if we cross a TryStatement, unsafe
      let cur: NodePath | null = path.parentPath;
      while (cur && cur !== fnPath) {
        if (cur.isTryStatement()) {
          found = true;
          return;
        }
        if (node.type === "ContinueStatement") {
          if (cur.isLoop()) return;
        } else {
          if (cur.isLoop() || cur.isSwitchStatement()) return;
        }
        cur = cur.parentPath;
      }
    },
  });
  return found;
}

export function flattenControlFlow(ast: t.File, ctx: Context): void {
  const level = ctx.options.cff;
  if (level <= 0) return;

  const targets: NodePath<FnLike>[] = [];
  traverse(ast, {
    enter(path: NodePath) {
      const n = path.node;
      if (
        (t.isFunctionDeclaration(n) || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) || t.isObjectMethod(n) || t.isClassMethod(n)) &&
        !ctx.vmEligible.has(n)
      ) {
        targets.push(path as NodePath<FnLike>);
      }
    },
  });

  for (const fnPath of targets) {
    tryFlatten(fnPath, ctx, level);
  }
}

function tryFlatten(fnPath: NodePath<FnLike>, ctx: Context, level: number): void {
  const fn = fnPath.node;
  if (!t.isBlockStatement(fn.body)) return;
  const body = fn.body;
  if (body.body.length < 3) return;

  // Detect early returns (returns not at the end of the function).
  // Traverse the entire function body to find ALL return statements.
  // If there are multiple returns, or a return that's not at the very end,
  // the function has early returns and shouldn't be flattened.
  let returnCount = 0;
  let lastReturnNode: t.ReturnStatement | null = null;
  fnPath.traverse({
    ReturnStatement(path) {
      returnCount++;
      lastReturnNode = path.node;
    },
    // Don't traverse into nested functions
    Function(path) {
      if (path !== fnPath) path.skip();
    },
  });
  if (returnCount === 0) {
    // No returns at all - OK to flatten
  } else if (returnCount > 1) {
    return; // Multiple returns = early returns
  } else if (returnCount === 1 && lastReturnNode) {
    // Single return: check if it's the last statement in the function body
    // (at top level, or as the last statement in the last block)
    const bodyStmts = body.body;
    const lastStmt = bodyStmts[bodyStmts.length - 1];
    const isLast = stmtContainsNode(lastStmt, lastReturnNode);
    if (!isLast) return; // Early return
  }

  const scanCtx = { bad: false };
  scanDecomposed(body.body, scanCtx);
  if (scanCtx.bad) return;
  if (hasTryCrossingBreak(fnPath)) return;

  const exitBlock: Block = { stmts: [], term: { kind: "exit" } };
  const builder = new CfgBuilder();
  builder.blocks.push(exitBlock); // block 0 = exit

  // pull top-level function declarations out (they stay before the dispatcher)
  const topFns: t.Statement[] = [];
  const rest: t.Statement[] = [];
  for (const s of body.body) {
    if (t.isFunctionDeclaration(s)) topFns.push(s);
    else rest.push(s);
  }

  const entry = builder.lowerList(rest, exitBlock, true);
  if (builder.aborted) return;

  const realBlocks = builder.blocks.slice(1);
  if (realBlocks.length < 2) return;

  // ---- CFF v2: opaque duplicate blocks -------------------------------
  // Some `goto` edges become `if (pred) S=A else S=B` where A and B lead to
  // two *real* blocks whose bodies are identical and which converge on the
  // same successor. Both paths execute, so the predicate is genuinely opaque
  // (a static analyzer cannot prove one side dead), and no "dead state"
  // recovery constant leaks the real next state.
  const locals = Object.keys(fnPath.scope.bindings).filter((n) => !isReserved(n)).slice(0, 32);
  const opaqueTargets = new Map<Block, { pred: t.Expression; dup: Block }>();
  const dups: Block[] = [];
  for (const b of realBlocks) {
    const term = b.term;
    if (!term || term.kind !== "goto") continue;
    const tgt = term.target;
    if (tgt === exitBlock) continue;
    if (tgt.stmts.length > 1) continue;
    const tterm = tgt.term;
    if (tterm && tterm.kind !== "goto" && tterm.kind !== "exit") continue;
    if (!ctx.rng.chance(0.15)) continue;
    const dup: Block = { stmts: tgt.stmts, term: tgt.term };
    dups.push(dup);
    opaqueTargets.set(b, { pred: opaquePredicate(ctx.rng, true, flavorsForCff(level), locals).expr, dup });
  }

  // ---- state numbers: 0 reserved for exit; shuffled per build -------
  const allBlocks = [...realBlocks, ...dups];
  const numbers = ctx.rng.shuffle(allBlocks.map((_, i) => i + 1));
  const stateOf = new Map<Block, number>();
  allBlocks.forEach((b, i) => stateOf.set(b, numbers[i]));
  const entryState = stateOf.get(entry)!;
  const EXIT = 0;

  const stateVar = ctx.freshName("$s");
  const stateId = () => t.identifier(stateVar);

  // ---- CFF v2: runtime-keyed state masking --------------------------
  // At L2+ every state constant is XOR-masked with a per-invocation runtime
  // key `K` (`Date.now()` or `Math.random()` captured once at entry). Case
  // labels become `case (n ^ K)` and transitions `S = (m ^ K)`, so the whole
  // state graph is unknowable statically AND differs per invocation. The key
  // is assigned exactly once, so it is stable for the whole dispatch loop.
  const mask = level >= 2 ? ctx.freshName("$k") : null;
  const stateExpr = (n: number): t.Expression => {
    if (!mask) return t.numericLiteral(n);
    return t.binaryExpression("^", t.numericLiteral(n), t.identifier(mask));
  };

  const stmts: t.Statement[] = [];
  if (mask) {
    const kSeed = (ctx.rng.int(0x7ffffffe) + 1) | 0;
    const kExpr = ctx.rng.chance(0.5)
      ? t.binaryExpression("^", t.callExpression(t.memberExpression(t.identifier("Date"), t.identifier("now")), []), t.numericLiteral(kSeed))
      : t.binaryExpression(
          ">>>",
          t.binaryExpression("*", t.callExpression(t.memberExpression(t.identifier("Math"), t.identifier("random")), []), t.numericLiteral(4294967296)),
          t.numericLiteral(0),
        );
    stmts.push(t.variableDeclaration("var", [t.variableDeclarator(t.identifier(mask), kExpr)]));
  }
  stmts.push(t.variableDeclaration("var", [t.variableDeclarator(t.identifier(stateVar), stateExpr(entryState))]));

  // ---- exception-edge token (L3) ------------------------------------
  const useExceptionEdges = level >= 3 && ctx.rng.chance(0.85);
  const tokName = ctx.freshName("$t");
  if (useExceptionEdges) {
    // token creation varies: bare Symbol, described Symbol, or a random string
    const tokKind = ctx.rng.int(3);
    const tokInit =
      tokKind === 0
        ? t.callExpression(t.identifier("Symbol"), [])
        : tokKind === 1
          ? t.callExpression(t.identifier("Symbol"), [t.stringLiteral(ctx.rng.ident(3))])
          : t.stringLiteral(ctx.rng.ident(5));
    stmts.push(t.variableDeclaration("var", [t.variableDeclarator(t.identifier(tokName), tokInit)]));
  }

  // ---- dispatcher skeleton variant ----------------------------------
  // 0 for, 1 while, 2 do-while, 3 labeled-for, 4 guarded-for
  const loopKind = ctx.rng.int(5);
  const labelName = loopKind === 3 ? ctx.freshName("$L") : null;
  const continueStmt = (): t.ContinueStatement =>
    labelName ? t.continueStatement(t.identifier(labelName)) : t.continueStatement();

  const cases: t.SwitchCase[] = [];

  const mkTransition = (curNum: number, target: Block): t.Statement[] => {
    const num = stateOf.get(target) ?? EXIT;
    if (num === EXIT) {
      return [t.breakStatement()];
    }
    if (useExceptionEdges && ctx.rng.chance(0.25)) {
      // exception-edge transition: throw a token object caught by the outer dispatcher
      const obj = t.objectExpression([t.objectProperty(t.identifier(tokName), stateExpr(num), true)]);
      return [t.throwStatement(obj)];
    }
    if (level >= 2 && ctx.rng.chance(0.4)) {
      // state-dependent transition: S = (S ^ cur) ^ tgt.
      // Inside this block S === cur ^ K, so this evaluates to K ^ tgt === tgt ^ K.
      // The transition depends on the current (masked) state value: reducing it
      // requires discovering the S === cur ^ K invariant, not just folding constants.
      const st = t.expressionStatement(
        t.assignmentExpression(
          "=",
          stateId(),
          t.binaryExpression(
            "^",
            t.binaryExpression("^", t.cloneNode(stateId()), t.numericLiteral(curNum)),
            t.numericLiteral(num),
          ),
        ),
      );
      return [st, continueStmt()];
    }
    return [t.expressionStatement(t.assignmentExpression("=", stateId(), stateExpr(num))), continueStmt()];
  };

  const buildBody = (b: Block): t.Statement[] => {
    const bodyStmts: t.Statement[] = [...b.stmts];
    if (level >= 2 && bodyStmts.length > 0 && ctx.rng.chance(0.2)) {
      // harmless state-touching noise so not every case is a bare statement
      bodyStmts.unshift(
        t.expressionStatement(
          t.assignmentExpression("=", stateId(), t.binaryExpression("^", t.cloneNode(stateId()), t.numericLiteral(0))),
        ),
      );
    }
    const term = b.term;
    if (!term) return bodyStmts;
    const curNum = stateOf.get(b)!;
    switch (term.kind) {
      case "goto": {
        const op = opaqueTargets.get(b);
        if (op) {
          bodyStmts.push(
            t.ifStatement(
              op.pred,
              t.blockStatement([t.expressionStatement(t.assignmentExpression("=", stateId(), stateExpr(stateOf.get(term.target)!)))]),
              t.blockStatement([t.expressionStatement(t.assignmentExpression("=", stateId(), stateExpr(stateOf.get(op.dup)!)))]),
            ),
          );
          bodyStmts.push(continueStmt());
        } else {
          bodyStmts.push(...mkTransition(curNum, term.target));
        }
        break;
      }
      case "branch": {
        const thenStmts = mkTransition(curNum, term.t);
        const elseStmts = mkTransition(curNum, term.f);
        bodyStmts.push(t.ifStatement(term.test, t.blockStatement(thenStmts), t.blockStatement(elseStmts)));
        break;
      }
      case "return":
        bodyStmts.push(t.returnStatement(term.arg ?? null));
        break;
      case "throw":
        bodyStmts.push(t.throwStatement(term.arg));
        break;
      case "exit":
        bodyStmts.push(t.breakStatement());
        break;
    }
    return bodyStmts;
  };

  for (const b of allBlocks) {
    cases.push(t.switchCase(stateExpr(stateOf.get(b)!), [t.blockStatement(buildBody(b))]));
  }
  // exit case
  cases.push(t.switchCase(stateExpr(EXIT), [t.blockStatement([t.breakStatement()])]));
  // dead handler cases (L2+): never executed; recover to entry if ever reached
  if (level >= 2) {
    const deadCount = ctx.rng.range(1, 3);
    for (let i = 0; i < deadCount; i++) {
      const deadNum = ctx.rng.range(100000, 999999);
      const junk = t.expressionStatement(t.assignmentExpression("=", stateId(), stateExpr(entryState)));
      cases.push(t.switchCase(stateExpr(deadNum), [t.blockStatement([junk, t.continueStatement()])]));
    }
  }
  // shuffle case order
  const shuffledCases = ctx.rng.shuffle(cases);

  // Dispatch mechanism: either a `switch` or a nested if/else chain (no switch
  // anchor) for functions with few enough blocks. Chosen per function.
  const useIfElse = allBlocks.length <= 30 && ctx.rng.chance(0.3);
  let switchStmt: t.Statement;
  if (useIfElse) {
    // S === L1 ? {body} : S === L2 ? {body} : ... : {break}
    let chain: t.Statement = t.blockStatement([t.breakStatement()]);
    for (let i = shuffledCases.length - 1; i >= 0; i--) {
      const c = shuffledCases[i];
      if (!c.test) continue;
      const test = t.binaryExpression("===", stateId(), c.test);
      chain = t.ifStatement(test, t.blockStatement(c.consequent), chain);
    }
    switchStmt = chain;
  } else {
    switchStmt = t.switchStatement(stateId(), shuffledCases);
  }
  const breakAfter = t.breakStatement();

  let inner: t.Statement;
  switch (loopKind) {
    case 1:
      inner = t.whileStatement(t.booleanLiteral(true), t.blockStatement([switchStmt, breakAfter]));
      break;
    case 2:
      inner = t.doWhileStatement(t.booleanLiteral(true), t.blockStatement([switchStmt, breakAfter]));
      break;
    case 3: {
      const loop = t.forStatement(null, null, null, t.blockStatement([switchStmt, breakAfter]));
      inner = t.labeledStatement(t.identifier(labelName!), loop);
      break;
    }
    case 4: {
      // guarded: the switch only runs while S is a "live" value (always true)
      const guard = t.ifStatement(
        t.binaryExpression("!==", stateId(), t.nullLiteral()),
        t.blockStatement([switchStmt]),
        null,
      );
      inner = t.forStatement(null, null, null, t.blockStatement([guard, breakAfter]));
      break;
    }
    default:
      inner = t.forStatement(null, null, null, t.blockStatement([switchStmt, breakAfter]));
      break;
  }

  let dispatcher: t.Statement;
  if (useExceptionEdges) {
    const errName = ctx.freshName("$e");
    const errId = () => t.identifier(errName);
    const outerBody = t.blockStatement([
      t.tryStatement(
        t.blockStatement([inner, t.breakStatement()]),
        t.catchClause(
          t.identifier(errName),
          t.blockStatement([
            t.ifStatement(
              t.logicalExpression(
                "&&",
                t.binaryExpression("!==", errId(), t.nullLiteral()),
                t.binaryExpression(
                  "!==",
                  t.memberExpression(errId(), t.identifier(tokName), true),
                  t.unaryExpression("void", t.numericLiteral(0)),
                ),
              ),
              t.blockStatement([
                t.expressionStatement(
                  t.assignmentExpression("=", stateId(), t.memberExpression(errId(), t.identifier(tokName), true)),
                ),
                t.continueStatement(),
              ]),
            ),
            t.throwStatement(errId()),
          ]),
        ),
      ),
    ]);
    dispatcher = t.forStatement(null, null, null, outerBody);
  } else {
    dispatcher = inner;
  }

  body.body = [...topFns, ...stmts, dispatcher];
  ctx.stats.flattenedFunctions++;
}

/**
 * Dogfood the CFF pass on the injected runtime: flatten the string decoder,
 * property resolver and spill reassembly helpers so they are no longer plain
 * readable JS. The VM interpreter's own dispatch functions are skipped (their
 * dispatch loop is already a state machine and must not be re-flattened).
 */
export function flattenRuntimeFunctions(ast: t.File, ctx: Context): void {
  const level = ctx.options.cff;
  if (level <= 0) return;
  const skip = new Set<string>((ctx.runtimeFlags.vmFnNames as string[] | undefined) ?? []);
  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (!isRuntimePath(path, ctx)) return;
      const id = path.node.id?.name;
      if (id && skip.has(id)) return;
      // Skip trivial runtime helpers: flattening a 1-3 line function into a
      // multi-KB state machine is pure bloat and dominates the runtime size
      // (the VM emits ~80 tiny per-op handlers). Those handlers are already
      // protected by the shuffled function-pointer dispatch + per-build opcode
      // map, so skipping their flattening keeps the dispatch obfuscation while
      // cutting the runtime dramatically. Larger runtime functions (decoder,
      // property helpers, session) are still flattened at the configured level.
      const bodySrc = generate(path.node.body, { compact: true }).code;
      // Skip trivial runtime helpers (default ON for size): flattening a 1-3
      // line function into a multi-KB state machine is pure bloat and dominates
      // the runtime size (the VM emits ~80 tiny per-op handlers). Those handlers
      // are already protected by the shuffled function-pointer dispatch +
      // per-build opcode map. With --extra-flattening, restore the previous
      // stronger behavior and flatten them too (bigger output).
      if (!ctx.options.extraFlattening && bodySrc.length < 180) return;
      tryFlatten(path, ctx, level);
    },
  });
}
