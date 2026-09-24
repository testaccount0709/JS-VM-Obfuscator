import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { OpMap, OpName } from "./ops.js";
import { pickCode } from "./ops.js";

export interface CompiledFunction {
  code: number[];
  consts: ConstValue[];
  localCount: number;
  paramCount: number;
  restIdx: number;
  captures: string[];
  operandMask: number;
  rollingSeed: number;
  selfNamed: boolean;
  /** async functions run in the async interpreter (awaits suspend/resume) */
  async: boolean;
  /** generator functions run in the generator interpreter (yields suspend/resume) */
  generator: boolean;
  /** index into the per-build opcode-map pool */
  opMapId: number;
}

export type ConstValue =
  | { kind: "number"; v: number }
  | { kind: "string"; v: string }
  | { kind: "symbol-iterator" }
  | { kind: "symbol-async-iterator" }
  | { kind: "hole" }
  | { kind: "template"; cooked: (string | null)[]; raw: string[] };

type FnNode = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod | t.ClassMethod;

interface LoopCtx {
  breakPatches: number[];
  continuePatches: number[];
}

/** Active try-with-finally region (for routing break/continue through it). */
interface FinCtx {
  /** Patch targets for break/continue emitted inside the try body. */
  breakPatches: number[];
  continuePatches: number[];
}

const UNSUPPORTED_TYPES = new Set<string>([
  "ClassExpression", "ClassDeclaration",
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ObjectMethod", "ClassMethod", "ClassPrivateMethod",
  "MetaProperty",
  "WithStatement", "DebuggerStatement",
  "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "ImportExpression", "Import", "JSXElement", "JSXFragment",
  "PrivateName",
]);

export class CompileError extends Error {}

export function compileFunction(
  fnPath: NodePath<FnNode>,
  opMap: OpMap,
  rng: { int(n: number): number },
  level: number,
): CompiledFunction | null {
  const fn = fnPath.node;
  if (!t.isBlockStatement(fn.body)) return null;
  // Async generators fall back to native: the dispatcher routes by the async
  // flag first, so a virtualized async generator would run in the plain async
  // interpreter and return a Promise instead of an async iterator (breaking
  // `for await`), and the generator interpreter's AWAIT handler is a no-op.
  if (fn.async && fn.generator) return null;

  let unsupported = false;
  fnPath.traverse({
    enter(path) {
      if (unsupported) return;
      if (UNSUPPORTED_TYPES.has(path.node.type)) {
        unsupported = true;
        return;
      }
      if ((path.isForInStatement() || path.isForOfStatement()) && !isSupportedForTarget(getForTarget(path.node))) {
        unsupported = true;
        return;
      }
      if (path.isForOfStatement() && path.node.await && !fnPath.node.async) {
        unsupported = true;
        return;
      }
      if (path.isUnaryExpression() && path.node.operator === "delete" && t.isIdentifier(path.node.argument)) {
        unsupported = true;
        return;
      }
    },
  });
  if (unsupported) return null;

  // The VM currently addresses locals/captures by identifier text. Distinct
  // lexical bindings with the same name would collapse into one slot (for
  // example, a captured `i` plus an inner `for (let i = ...)`). Keep such
  // functions native until the compiler uses binding-identity-based slots.
  if (hasShadowedBindingNames(fnPath)) return null;

  // TDZ textual check for let/const
  const scope = fnPath.scope;
  for (const name of Object.keys(scope.bindings)) {
    const b = scope.bindings[name];
    if (b.kind !== "let" && b.kind !== "const") continue;
    const declStart = b.path.node.start ?? 0;
    const initNode = b.path.isVariableDeclarator() ? b.path.node.init : null;
    const initStart = initNode?.start ?? Infinity;
    const initEnd = initNode?.end ?? -1;
    for (const ref of b.referencePaths) {
      const rs = ref.node.start ?? 0;
      if (rs < declStart) return null;
      if (rs >= initStart && rs <= initEnd) return null;
    }
  }

  try {
    const compiler = new FnCompiler(fnPath, opMap, rng, level);
    return compiler.run();
  } catch (e) {
    if (e instanceof CompileError) return null;
    throw e;
  }
}

function hasShadowedBindingNames(fnPath: NodePath<FnNode>): boolean {
  const seen = new Map<string, object | null>();
  let shadowed = false;

  const record = (path: NodePath<t.Identifier>): void => {
    if (shadowed) return;
    const binding = path.scope.getBinding(path.node.name);
    const identity = binding ?? null;
    if (!seen.has(path.node.name)) {
      seen.set(path.node.name, identity);
      return;
    }
    if (seen.get(path.node.name) !== identity) shadowed = true;
  };

  fnPath.traverse({
    ReferencedIdentifier(path) {
      if (path.isIdentifier()) record(path as NodePath<t.Identifier>);
    },
    BindingIdentifier(path) {
      if (path.isIdentifier()) record(path as NodePath<t.Identifier>);
    },
  });
  return shadowed;
}

function getForTarget(node: t.ForInStatement | t.ForOfStatement): t.Node {
  const left = node.left;
  if (t.isVariableDeclaration(left)) return left.declarations[0]?.id ?? left;
  return left;
}

function isSupportedForTarget(target: t.Node): boolean {
  if (t.isIdentifier(target)) return true;
  if (t.isObjectPattern(target) || t.isArrayPattern(target)) return true;
  return false;
}

function patternBindingNames(pattern: t.LVal | t.Pattern): string[] {
  const out: string[] = [];
  const walk = (p: t.LVal | t.Pattern): void => {
    if (t.isIdentifier(p)) { out.push(p.name); return; }
    if (t.isAssignmentPattern(p)) { walk(p.left); return; }
    if (t.isRestElement(p)) { walk(p.argument); return; }
    if (t.isObjectPattern(p)) {
      for (const prop of p.properties) {
        if (t.isRestElement(prop)) walk(prop.argument);
        else if (t.isObjectProperty(prop)) walk(prop.value as t.LVal);
      }
      return;
    }
    if (t.isArrayPattern(p)) {
      for (const el of p.elements) if (el) walk(el);
    }
  };
  walk(pattern);
  return out;
}

const BIN_OPS: Record<string, OpName> = {
  "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "**": "POW",
  "&": "BITAND", "|": "BITOR", "^": "BITXOR", "<<": "SHL", ">>": "SHR", ">>>": "USHR",
  "==": "EQ", "!=": "NEQ", "===": "SEQ", "!==": "SNEQ",
  "<": "LT", ">": "GT", "<=": "LTE", ">=": "GTE",
  in: "INOP", instanceof: "INSTANCEOF",
};

const COMPOUND_TO_BIN: Record<string, OpName> = {
  "+=": "ADD", "-=": "SUB", "*=": "MUL", "/=": "DIV", "%=": "MOD", "**=": "POW",
  "<<=": "SHL", ">>=": "SHR", ">>>=": "USHR", "&=": "BITAND", "^=": "BITXOR", "|=": "BITOR",
};

class FnCompiler {
  code: number[] = [];
  consts: ConstValue[] = [];
  private constKeys = new Map<string, number>();
  locals = new Map<string, number>();
  private captureIdx = new Map<string, number>();
  captures: string[] = [];
  paramCount = 0;
  restIdx = -1;
  private loopStack: LoopCtx[] = [];
  private switchBreakStack: number[][] = [];
  private btStack: ("loop" | "switch")[] = [];
  private finStack: FinCtx[] = [];
  private labelStack: Map<string, LoopCtx>[] = [];
  private pendingLabel: string | null = null;
  private paramRawSlots: number[] = [];
  private tempCounter = 0;
  private selfReferenced = false;
  opMap: OpMap;
  rng: { int(n: number): number };
  operandMask: number;
  rollingSeed: number;
  selfName: string | null = null;

  constructor(
    private fnPath: NodePath<FnNode>,
    opMap: OpMap,
    rng: { int(n: number): number },
    private level: number,
  ) {
    this.opMap = opMap;
    this.rng = rng;
    this.operandMask = level === 2 ? (rng.int(0xfffe) + 1) : 0;
    this.rollingSeed = level >= 3 ? (rng.int(0x7ffffffe) + 1) : 0;
  }

  run(): CompiledFunction {
    const fn = this.fnPath.node;
    if (t.isFunctionExpression(fn) && fn.id) this.selfName = fn.id.name;

    this.allocateSlots();
    this.paramCount = fn.params.length;
    fn.params.forEach((p, i) => {
      if (t.isRestElement(p)) this.restIdx = i;
    });
    this.emitParamDestructuring(fn);
    for (const stmt of (fn.body as t.BlockStatement).body) this.compileStmt(stmt);
    this.emit("RETUNDEF");

    return {
      code: this.code,
      consts: this.consts,
      localCount: this.locals.size,
      paramCount: this.paramCount,
      restIdx: this.restIdx,
      captures: this.captures,
      operandMask: this.operandMask,
      rollingSeed: this.rollingSeed,
      selfNamed: this.selfReferenced,
      async: !!fn.async,
      generator: !!fn.generator,
      opMapId: 0,
    };
  }

  // ---------- slots ----------

  private allocateSlots(): void {
    const fn = this.fnPath.node;
    let paramIdx = 0;
    this.paramRawSlots = [];
    for (const p of fn.params) {
      if (t.isIdentifier(p)) {
        this.paramRawSlots[paramIdx] = this.declareSlot(p.name);
      } else if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
        this.paramRawSlots[paramIdx] = this.declareSlot(p.argument.name);
      } else {
        this.paramRawSlots[paramIdx] = this.declareSlot("$$p" + paramIdx);
        for (const name of patternBindingNames(p as t.Pattern)) this.declareSlot(name);
      }
      paramIdx++;
    }
    this.fnPath.traverse({
      VariableDeclarator: (path) => {
        if (t.isIdentifier(path.node.id)) this.declareSlot(path.node.id.name);
        else for (const name of patternBindingNames(path.node.id)) this.declareSlot(name);
      },
      CatchClause: (path) => {
        if (!path.node.param) return;
        if (t.isIdentifier(path.node.param)) this.declareSlot(path.node.param.name);
        else for (const name of patternBindingNames(path.node.param)) this.declareSlot(name);
      },
      ForInStatement: (path) => {
        const target = getForTarget(path.node);
        if (t.isIdentifier(target)) this.declareSlot(target.name);
        else for (const name of patternBindingNames(target as t.LVal)) this.declareSlot(name);
      },
      ForOfStatement: (path) => {
        const target = getForTarget(path.node);
        if (t.isIdentifier(target)) this.declareSlot(target.name);
        else for (const name of patternBindingNames(target as t.LVal)) this.declareSlot(name);
      },
    });
  }

  private emitParamDestructuring(fn: FnNode): void {
    fn.params.forEach((p, i) => {
      if (t.isIdentifier(p) || (t.isRestElement(p) && t.isIdentifier(p.argument))) return;
      const rawSlot = this.paramRawSlots[i];
      this.emit("LOAD");
      this.emitOperand(rawSlot);
      this.compileBindPattern(p as t.LVal | t.Pattern);
      this.emit("POP");
    });
  }

  /** Bind stack top to `pattern` (consumes one stack value). */
  private compileBindPattern(pattern: t.LVal | t.Pattern): void {
    if (t.isIdentifier(pattern)) {
      const slot = this.locals.get(pattern.name);
      if (slot === undefined) this.fail("pattern slot");
      this.emit("STORE");
      this.emitOperand(slot);
      return;
    }
    if (t.isAssignmentPattern(pattern)) {
      const defTmp = this.allocTemp("pd");
      this.emit("DUP");
      this.emit("STORE");
      this.emitOperand(defTmp);
      this.emit("ISNULLISH");
      const j = this.emitJump("JFALSE");
      this.emit("LOAD");
      this.emitOperand(defTmp);
      this.compileExpr(pattern.right);
      this.emit("STORE");
      this.emitOperand(defTmp);
      this.emit("POP");
      this.patch(j, this.here());
      this.emit("LOAD");
      this.emitOperand(defTmp);
      this.compileBindPattern(pattern.left);
      return;
    }
    if (t.isRestElement(pattern)) {
      const slot = this.locals.get((pattern.argument as t.Identifier).name);
      if (slot === undefined) this.fail("rest slot");
      this.emit("STORE");
      this.emitOperand(slot);
      return;
    }
    if (t.isObjectPattern(pattern)) {
      const objTmp = this.allocTemp("po");
      this.emit("STORE");
      this.emitOperand(objTmp);
      this.emit("POP");
      for (const prop of pattern.properties) {
        if (t.isRestElement(prop)) {
          this.fail("object rest pattern");
        }
        if (!t.isObjectProperty(prop)) this.fail("obj pattern prop");
        const keyName = !prop.computed && t.isIdentifier(prop.key)
          ? prop.key.name
          : t.isStringLiteral(prop.key)
            ? prop.key.value
            : null;
        if (keyName === null) this.fail("computed obj pattern key");
        this.emit("LOAD");
        this.emitOperand(objTmp);
        this.emit("CONST");
        this.emitOperand(this.strConst(keyName));
        this.emit("GETPROP");
        this.compileBindPattern(prop.value as t.LVal);
        this.emit("POP");
      }
      return;
    }
    if (t.isArrayPattern(pattern)) {
      const arrTmp = this.allocTemp("pa");
      this.emit("STORE");
      this.emitOperand(arrTmp);
      this.emit("POP");
      let idx = 0;
      for (const el of pattern.elements) {
        if (el === null) { idx++; continue; }
        if (t.isRestElement(el)) {
          const slot = this.locals.get((el.argument as t.Identifier).name);
          this.emit("LOAD");
          this.emitOperand(arrTmp);
          this.emit("CONST");
          this.emitOperand(this.strConst("slice"));
          this.emit("GETPROP");
          this.emit("CONST");
          this.emitOperand(this.numConst(idx));
          this.emit("CALL");
          this.emitOperand(1);
          this.emit("STORE");
          this.emitOperand(slot!);
          this.emit("POP");
          break;
        }
        this.emit("LOAD");
        this.emitOperand(arrTmp);
        this.emit("CONST");
        this.emitOperand(this.numConst(idx++));
        this.emit("GETPROP");
        this.compileBindPattern(el);
        this.emit("POP");
      }
      return;
    }
    this.fail("pattern");
  }

  private declareSlot(name: string): number {
    const existing = this.locals.get(name);
    if (existing !== undefined) return existing;
    const slot = this.locals.size;
    this.locals.set(name, slot);
    return slot;
  }

  private allocTemp(hint: string): number {
    let name = "$$" + hint + this.tempCounter++;
    while (this.locals.has(name)) name += "_";
    return this.declareSlot(name);
  }

  // ---------- emission ----------

  emit(op: OpName): void {
    this.code.push(pickCode(this.opMap, op, this.rng));
  }

  emitOperand(v: number): void {
    this.code.push(v ^ this.operandMask);
  }

  emitJump(op: OpName): number {
    this.emit(op);
    const at = this.code.length;
    this.code.push(0);
    return at;
  }

  /** Emit an opcode with a constant type operand + a patchable target operand. */
  emitPend(op: OpName, type: number): number {
    this.emit(op);
    this.emitOperand(type);
    const at = this.code.length;
    this.code.push(0);
    return at;
  }

  patch(at: number, target: number): void {
    this.code[at] = target ^ this.operandMask;
  }

  here(): number {
    return this.code.length;
  }

  constIdx(c: ConstValue): number {
    const key = constKeyOf(c);
    const existing = this.constKeys.get(key);
    if (existing !== undefined) return existing;
    const idx = this.consts.length;
    this.consts.push(c);
    this.constKeys.set(key, idx);
    return idx;
  }

  strConst(s: string): number {
    return this.constIdx({ kind: "string", v: s });
  }

  numConst(v: number): number {
    return this.constIdx({ kind: "number", v });
  }

  capture(name: string): number {
    const existing = this.captureIdx.get(name);
    if (existing !== undefined) return existing;
    const idx = this.captures.length;
    this.captures.push(name);
    this.captureIdx.set(name, idx);
    return idx;
  }

  private pushLoopLabel(ctx: LoopCtx): void {
    if (!this.pendingLabel) return;
    const labels = new Map<string, LoopCtx>();
    labels.set(this.pendingLabel, ctx);
    this.labelStack.push(labels);
    this.pendingLabel = null;
  }

  private popLoopLabel(): void {
    if (this.labelStack.length > 0) this.labelStack.pop();
  }

  fail(msg: string): never {
    throw new CompileError(msg);
  }

  // ---------- statements ----------

  compileStmt(node: t.Statement): void {
    switch (node.type) {
      case "LabeledStatement": {
        const inner = node.body;
        if (
          t.isWhileStatement(inner) || t.isDoWhileStatement(inner) || t.isForStatement(inner)
          || t.isForOfStatement(inner) || t.isForInStatement(inner)
        ) {
          this.pendingLabel = node.label.name;
          this.compileStmt(inner);
          this.pendingLabel = null;
          return;
        }
        const ctx: LoopCtx = { breakPatches: [], continuePatches: [] };
        const labels = new Map<string, LoopCtx>();
        labels.set(node.label.name, ctx);
        this.labelStack.push(labels);
        this.compileStmt(node.body);
        this.labelStack.pop();
        for (const p of ctx.breakPatches) this.patch(p, this.here());
        return;
      }
      case "EmptyStatement":
        return;
      case "BlockStatement":
        for (const s of node.body) this.compileStmt(s);
        return;
      case "ExpressionStatement":
        this.compileExpr(node.expression);
        this.emit("POP");
        return;
      case "VariableDeclaration":
        for (const d of node.declarations) {
          if (t.isIdentifier(d.id)) {
            const slot = this.locals.get(d.id.name);
            if (slot === undefined) this.fail("no slot");
            if (d.init) {
              this.compileExpr(d.init);
              this.emit("STORE");
              this.emitOperand(slot);
              this.emit("POP");
            }
          } else {
            if (!d.init) this.fail("pattern decl init");
            this.compileExpr(d.init);
            this.compileBindPattern(d.id);
            this.emit("POP");
          }
        }
        return;
      case "IfStatement": {
        this.compileExpr(node.test);
        const jf = this.emitJump("JFALSE");
        this.compileStmt(node.consequent);
        if (node.alternate) {
          const je = this.emitJump("JMP");
          this.patch(jf, this.here());
          this.compileStmt(node.alternate);
          this.patch(je, this.here());
        } else {
          this.patch(jf, this.here());
        }
        return;
      }
      case "WhileStatement": {
        const ctx: LoopCtx = { breakPatches: [], continuePatches: [] };
        this.loopStack.push(ctx);
        this.pushLoopLabel(ctx);
        const cond = this.here();
        this.compileExpr(node.test);
        const jf = this.emitJump("JFALSE");
        this.btStack.push("loop");
        this.compileStmt(node.body);
        this.btStack.pop();
        this.emit("JMP");
        this.emitOperand(cond);
        const end = this.here();
        this.patch(jf, end);
        for (const p of ctx.breakPatches) this.patch(p, end);
        for (const p of ctx.continuePatches) this.patch(p, cond);
        this.popLoopLabel();
        this.loopStack.pop();
        return;
      }
      case "DoWhileStatement": {
        const ctx: LoopCtx = { breakPatches: [], continuePatches: [] };
        this.loopStack.push(ctx);
        this.pushLoopLabel(ctx);
        const body = this.here();
        this.btStack.push("loop");
        this.compileStmt(node.body);
        this.btStack.pop();
        const cond = this.here();
        this.compileExpr(node.test);
        this.emit("JTRUE");
        this.emitOperand(body);
        const end = this.here();
        for (const p of ctx.breakPatches) this.patch(p, end);
        for (const p of ctx.continuePatches) this.patch(p, cond);
        this.popLoopLabel();
        this.loopStack.pop();
        return;
      }
      case "ForStatement": {
        const ctx: LoopCtx = { breakPatches: [], continuePatches: [] };
        this.loopStack.push(ctx);
        this.pushLoopLabel(ctx);
        if (node.init) {
          if (t.isVariableDeclaration(node.init)) this.compileStmt(node.init);
          else {
            this.compileExpr(node.init);
            this.emit("POP");
          }
        }
        const cond = this.here();
        let jf = -1;
        if (node.test) {
          this.compileExpr(node.test);
          jf = this.emitJump("JFALSE");
        }
        this.btStack.push("loop");
        this.compileStmt(node.body);
        this.btStack.pop();
        const update = this.here();
        if (node.update) {
          this.compileExpr(node.update);
          this.emit("POP");
        }
        this.emit("JMP");
        this.emitOperand(cond);
        const end = this.here();
        if (jf >= 0) this.patch(jf, end);
        for (const p of ctx.breakPatches) this.patch(p, end);
        for (const p of ctx.continuePatches) this.patch(p, update);
        this.popLoopLabel();
        this.loopStack.pop();
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const target = getForTarget(node);
        const isIdTarget = t.isIdentifier(target);
        const slot = isIdTarget ? this.locals.get(target.name) : undefined;
        const capIdx = isIdTarget && slot === undefined ? this.capture(target.name) : -1;
        const ctx: LoopCtx = { breakPatches: [], continuePatches: [] };
        this.loopStack.push(ctx);
        this.pushLoopLabel(ctx);

        const collSlot = this.allocTemp("fc");
        const iSlot = this.allocTemp("fi");

        this.compileExpr(node.right);
        if (node.type === "ForInStatement") {
          this.emit("FORIN");
        } else {
          this.emit("CALLPROP");
          if (node.await) {
            this.emitOperand(this.constIdx({ kind: "symbol-async-iterator" }));
          } else {
            this.emitOperand(this.constIdx({ kind: "symbol-iterator" }));
          }
          this.emitOperand(0);
        }
        this.emit("STORE");
        this.emitOperand(collSlot);
        this.emit("POP");

        this.emit("CONST");
        this.emitOperand(this.numConst(0));
        this.emit("STORE");
        this.emitOperand(iSlot);
        this.emit("POP");

        const cond = this.here();
        let jExit: number;
        if (node.type === "ForInStatement") {
          this.emit("LOAD");
          this.emitOperand(iSlot);
          this.emit("LOAD");
          this.emitOperand(collSlot);
          this.emit("CONST");
          this.emitOperand(this.strConst("length"));
          this.emit("GETPROP");
          this.emit("LT");
          jExit = this.emitJump("JFALSE");
          // target = keys[i]
          this.emit("LOAD");
          this.emitOperand(collSlot);
          this.emit("LOAD");
          this.emitOperand(iSlot);
          this.emit("GETPROP");
        } else {
          // step = iter.next() [await]
          this.emit("LOAD");
          this.emitOperand(collSlot);
          this.emit("CALLPROP");
          this.emitOperand(this.strConst("next"));
          this.emitOperand(0);
          if (node.await) this.emit("AWAIT");
          this.emit("STORE");
          this.emitOperand(iSlot);
          this.emit("POP");
          this.emit("LOAD");
          this.emitOperand(iSlot);
          this.emit("CONST");
          this.emitOperand(this.strConst("done"));
          this.emit("GETPROP");
          jExit = this.emitJump("JTRUE");
          // target = step.value
          this.emit("LOAD");
          this.emitOperand(iSlot);
          this.emit("CONST");
          this.emitOperand(this.strConst("value"));
          this.emit("GETPROP");
        }
        if (isIdTarget) {
          if (slot !== undefined) {
            this.emit("STORE");
            this.emitOperand(slot);
            this.emit("POP");
          } else {
            this.emit("STORECAP");
            this.emitOperand(capIdx);
            this.emit("POP");
          }
        } else {
          this.compileBindPattern(target as t.LVal);
          this.emit("POP");
        }
        this.btStack.push("loop");
        this.compileStmt(node.body);
        this.btStack.pop();
        const update = this.here();
        if (node.type === "ForInStatement") {
          this.emit("LOAD");
          this.emitOperand(iSlot);
          this.emit("CONST");
          this.emitOperand(this.numConst(1));
          this.emit("ADD");
          this.emit("STORE");
          this.emitOperand(iSlot);
          this.emit("POP");
        }
        this.emit("JMP");
        this.emitOperand(cond);
        const end = this.here();
        this.patch(jExit, end);
        for (const p of ctx.breakPatches) this.patch(p, end);
        for (const p of ctx.continuePatches) this.patch(p, update);
        this.popLoopLabel();
        this.loopStack.pop();
        return;
      }
      case "SwitchStatement": {
        this.compileExpr(node.discriminant);
        const discSlot = this.allocTemp("sd");
        this.emit("STORE");
        this.emitOperand(discSlot);
        this.emit("POP");

        const breakPatches: number[] = [];
        this.switchBreakStack.push(breakPatches);

        let defaultIdx = -1;
        node.cases.forEach((c, i) => {
          if (c.test === null) defaultIdx = i;
        });

        const testPatches: number[] = [];
        for (const c of node.cases) {
          const test = c.test;
          if (test === null || test === undefined) continue;
          this.emit("LOAD");
          this.emitOperand(discSlot);
          this.compileExpr(test as t.Expression);
          this.emit("SEQ");
          testPatches.push(this.emitJump("JTRUE"));
        }
        const noMatch = this.emitJump("JMP");

        const bodyStarts: number[] = [];
        this.btStack.push("switch");
        for (const c of node.cases) {
          bodyStarts.push(this.here());
          for (const s of c.consequent) this.compileStmt(s);
        }
        this.btStack.pop();
        const end = this.here();

        let tj = 0;
        for (let i = 0; i < node.cases.length; i++) {
          if (node.cases[i].test === null) continue;
          this.patch(testPatches[tj++], bodyStarts[i]);
        }
        this.patch(noMatch, defaultIdx >= 0 ? bodyStarts[defaultIdx] : end);
        for (const p of breakPatches) this.patch(p, end);
        this.switchBreakStack.pop();
        return;
      }
      case "TryStatement": {
        if (node.finalizer) {
          if (!t.isBlockStatement(node.finalizer)) this.fail("finally block");
          // try { body } finally { fin } compiled as:
          //   FINENTER <finStart>      push finally frame (start + stack depth)
          //   <body>
          //   FINNORMAL                normal exit: pend=0, jump to finally
          //   finStart: <finally body>
          //   FINEND                   resume pending action / fall through
          this.finStack.push({ breakPatches: [], continuePatches: [] });
          this.emit("FINENTER");
          const finStart = this.code.length;
          this.code.push(0);
          for (const s of node.block.body) this.compileStmt(s);
          this.emit("FINNORMAL");
          this.finStack.pop();
          this.patch(finStart, this.here());
          for (const s of node.finalizer.body) this.compileStmt(s);
          this.emit("FINEND");
          return;
        }
        const handler = this.emitJump("TRYENTER");
        for (const s of node.block.body) this.compileStmt(s);
        this.emit("TRYLEAVE");
        const after = this.emitJump("JMP");
        this.patch(handler, this.here());
        if (node.handler) {
          if (node.handler.param) {
            if (t.isIdentifier(node.handler.param)) {
              const slot = this.locals.get(node.handler.param.name);
              if (slot === undefined) this.fail("no catch slot");
              this.emit("STORE");
              this.emitOperand(slot);
              this.emit("POP");
            } else {
              this.compileBindPattern(node.handler.param);
              this.emit("POP");
            }
          } else {
            this.emit("POP");
          }
          for (const s of node.handler.body.body) this.compileStmt(s);
        }
        this.patch(after, this.here());
        return;
      }
      case "ReturnStatement":
        if (node.argument) {
          this.compileExpr(node.argument);
          this.emit("RET");
        } else {
          this.emit("RETUNDEF");
        }
        return;
      case "ThrowStatement":
        this.compileExpr(node.argument);
        this.emit("THROW");
        return;
      case "BreakStatement": {
        if (node.label) {
          for (let i = this.labelStack.length - 1; i >= 0; i--) {
            const ctx = this.labelStack[i].get(node.label.name);
            if (ctx) {
              ctx.breakPatches.push(this.emitJump("JMP"));
              return;
            }
          }
          this.fail("label break");
        }
        if (this.finStack.length > 1) this.fail("multi-finally break");
        const kind = this.btStack.length > 0 ? this.btStack[this.btStack.length - 1] : null;
        if (kind === "switch") {
          const sw = this.switchBreakStack[this.switchBreakStack.length - 1];
          if (!sw) this.fail("break switch");
          if (this.finStack.length === 1) sw.push(this.emitPend("FINPEND", 3));
          else sw.push(this.emitJump("JMP"));
        } else if (kind === "loop") {
          const loop = this.loopStack[this.loopStack.length - 1];
          if (!loop) this.fail("break loop");
          if (this.finStack.length === 1) loop.breakPatches.push(this.emitPend("FINPEND", 3));
          else loop.breakPatches.push(this.emitJump("JMP"));
        } else {
          this.fail("break target");
        }
        return;
      }
      case "ContinueStatement": {
        if (node.label) {
          for (let i = this.labelStack.length - 1; i >= 0; i--) {
            const ctx = this.labelStack[i].get(node.label.name);
            if (ctx) {
              ctx.continuePatches.push(this.emitJump("JMP"));
              return;
            }
          }
          this.fail("label continue");
        }
        if (this.finStack.length > 1) this.fail("multi-finally continue");
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) this.fail("continue target");
        if (this.finStack.length === 1) loop.continuePatches.push(this.emitPend("FINPEND", 4));
        else loop.continuePatches.push(this.emitJump("JMP"));
        return;
      }
      default:
        this.fail("stmt " + node.type);
    }
  }

  // ---------- expressions ----------

  compileExpr(node: t.Expression): void {
    switch (node.type) {
      case "NumericLiteral":
        this.emit("CONST");
        this.emitOperand(this.numConst(node.value));
        return;
      case "StringLiteral":
        this.emit("CONST");
        this.emitOperand(this.strConst(node.value));
        return;
      case "BooleanLiteral":
        this.emit(node.value ? "TRUE" : "FALSE");
        return;
      case "NullLiteral":
        this.emit("NULL");
        return;
      case "RegExpLiteral": {
        this.emit("LOADCAP");
        this.emitOperand(this.capture("RegExp"));
        this.emit("CONST");
        this.emitOperand(this.strConst(node.pattern));
        this.emit("CONST");
        this.emitOperand(this.strConst(node.flags));
        this.emit("NEWOP");
        this.emitOperand(2);
        return;
      }
      case "Identifier": {
        const name = node.name;
        if (name === "undefined") {
          this.emit("UNDEF");
          return;
        }
        const slot = this.locals.get(name);
        if (slot !== undefined) {
          this.emit("LOAD");
          this.emitOperand(slot);
          return;
        }
        if (this.selfName === name) {
          this.selfReferenced = true;
          this.emit("SELF");
          return;
        }
        this.emit("LOADCAP");
        this.emitOperand(this.capture(name));
        return;
      }
      case "ThisExpression":
        this.emit("THIS");
        return;
      case "ArrayExpression": {
        this.emit("NEWARRAY");
        for (const el of node.elements) {
          if (el === null) {
            this.emit("CONST");
            this.emitOperand(this.constIdx({ kind: "hole" }));
            this.emit("ARRAPPEND");
          } else if (t.isSpreadElement(el)) {
            this.compileExpr(el.argument);
            this.emit("ARRSPREAD");
          } else if (t.isExpression(el)) {
            this.compileExpr(el);
            this.emit("ARRAPPEND");
          } else {
            this.fail("array elem " + (el as t.Node).type);
          }
        }
        return;
      }
      case "ObjectExpression": {
        this.emit("NEWOBJ");
        for (const p of node.properties) {
          if (t.isSpreadElement(p)) {
            this.compileExpr(p.argument);
            this.emit("OBJASSIGN");
            continue;
          }
          if (!t.isObjectProperty(p)) this.fail("obj prop " + p.type);
          this.emit("DUP");
          if (p.computed) {
            this.compileExpr(p.key as t.Expression);
          } else if (t.isIdentifier(p.key)) {
            this.emit("CONST");
            this.emitOperand(this.strConst(p.key.name));
          } else if (t.isStringLiteral(p.key)) {
            this.emit("CONST");
            this.emitOperand(this.strConst(p.key.value));
          } else if (t.isNumericLiteral(p.key)) {
            this.emit("CONST");
            this.emitOperand(this.numConst(p.key.value));
          } else {
            this.fail("obj key " + p.key.type);
          }
          this.compileExpr(p.value as t.Expression);
          this.emit("OBJSET");
        }
        return;
      }
      case "MemberExpression": {
        if (node.optional) this.fail("optional member");
        this.compileExpr(node.object as t.Expression);
        if (node.computed) {
          this.compileExpr(node.property as t.Expression);
        } else if (t.isIdentifier(node.property)) {
          this.emit("CONST");
          this.emitOperand(this.strConst(node.property.name));
        } else {
          this.fail("member key");
        }
        this.emit("GETPROP");
        return;
      }
      case "OptionalMemberExpression":
      case "OptionalCallExpression": {
        this.compileChain(node);
        return;
      }
      case "CallExpression": {
        if (node.optional) this.fail("optional call");
        const callee = node.callee;
        const hasSpread = node.arguments.some((a) => t.isSpreadElement(a));
        if (t.isMemberExpression(callee) && !callee.optional) {
          const staticKey = !callee.computed && t.isIdentifier(callee.property) ? callee.property.name : null;
          if (staticKey !== null && !hasSpread) {
            this.compileExpr(callee.object as t.Expression);
            for (const a of node.arguments) this.compileExpr(a as t.Expression);
            this.emit("CALLPROP");
            this.emitOperand(this.strConst(staticKey));
            this.emitOperand(node.arguments.length);
            return;
          }
          if (staticKey !== null && hasSpread) {
            this.compileExpr(callee.object as t.Expression);
            this.emit("CONST");
            this.emitOperand(this.strConst(staticKey));
            this.emit("GETPROP");
            // stack: obj, fn — need fn applied with this=obj
            this.pushArgsArray(node.arguments as (t.Expression | t.SpreadElement)[]);
            this.emit("APPLYTHIS");
            return;
          }
          // dynamic key
          this.compileExpr(callee.object as t.Expression);
          this.emit("DUP");
          this.compileExpr(callee.property as t.Expression);
          this.emit("GETPROP");
          if (hasSpread) {
            this.pushArgsArray(node.arguments as (t.Expression | t.SpreadElement)[]);
            this.emit("APPLYTHIS");
          } else {
            for (const a of node.arguments) this.compileExpr(a as t.Expression);
            this.emit("CALLTHIS");
            this.emitOperand(node.arguments.length);
          }
          return;
        }
        this.compileExpr(callee as t.Expression);
        if (hasSpread) {
          this.pushArgsArray(node.arguments as (t.Expression | t.SpreadElement)[]);
          this.emit("APPLY");
        } else {
          for (const a of node.arguments) this.compileExpr(a as t.Expression);
          this.emit("CALL");
          this.emitOperand(node.arguments.length);
        }
        return;
      }
      case "NewExpression": {
        this.compileExpr(node.callee as t.Expression);
        if (node.arguments.some((a) => t.isSpreadElement(a))) {
          this.pushArgsArray(node.arguments as (t.Expression | t.SpreadElement)[]);
          this.emit("NEWSPREAD");
        } else {
          for (const a of node.arguments) this.compileExpr(a as t.Expression);
          this.emit("NEWOP");
          this.emitOperand(node.arguments.length);
        }
        return;
      }
      case "AssignmentExpression":
        this.compileAssignment(node);
        return;
      case "LogicalExpression": {
        this.compileExpr(node.left);
        if (node.operator === "&&") {
          this.emit("DUP");
          const j = this.emitJump("JFALSE");
          this.emit("POP");
          this.compileExpr(node.right);
          this.patch(j, this.here());
        } else if (node.operator === "||") {
          this.emit("DUP");
          const j = this.emitJump("JTRUE");
          this.emit("POP");
          this.compileExpr(node.right);
          this.patch(j, this.here());
        } else if (node.operator === "??") {
          this.emit("DUP");
          this.emit("NULL");
          this.emit("EQ");
          const j = this.emitJump("JFALSE");
          this.emit("POP");
          this.compileExpr(node.right);
          this.patch(j, this.here());
        } else {
          this.fail("logical " + node.operator);
        }
        return;
      }
      case "ConditionalExpression": {
        this.compileExpr(node.test);
        const jf = this.emitJump("JFALSE");
        this.compileExpr(node.consequent);
        const je = this.emitJump("JMP");
        this.patch(jf, this.here());
        this.compileExpr(node.alternate);
        this.patch(je, this.here());
        return;
      }
      case "SequenceExpression": {
        for (let i = 0; i < node.expressions.length; i++) {
          this.compileExpr(node.expressions[i]);
          if (i < node.expressions.length - 1) this.emit("POP");
        }
        return;
      }
      case "AwaitExpression": {
        // async functions run in the async interpreter; AWAIT suspends the
        // whole VM frame until the awaited promise settles and resumes with
        // the same locals/stack/trys intact.
        this.compileExpr(node.argument as t.Expression);
        this.emit("AWAIT");
        return;
      }
      case "YieldExpression": {
        // yield* delegation requires driving a nested iterator inside the
        // suspended VM (forwarding next/throw/return) — not yet supported, so
        // such generators fall back to native.
        if (node.delegate) this.fail("yield*");
        if (node.argument) this.compileExpr(node.argument as t.Expression);
        else this.emit("UNDEF");
        this.emit("YIELD");
        this.emitOperand(0);
        return;
      }
      case "UnaryExpression": {
        switch (node.operator) {
          case "!":
            this.compileExpr(node.argument);
            this.emit("NOT");
            return;
          case "~":
            this.compileExpr(node.argument);
            this.emit("BITNOT");
            return;
          case "-":
            this.compileExpr(node.argument);
            this.emit("NEG");
            return;
          case "+":
            this.compileExpr(node.argument);
            this.emit("POS");
            return;
          case "typeof": {
            const arg = node.argument;
            if (t.isIdentifier(arg)) {
              if (arg.name === "undefined") {
                this.emit("CONST");
                this.emitOperand(this.strConst("undefined"));
                return;
              }
              const slot = this.locals.get(arg.name);
              if (slot !== undefined) {
                this.emit("LOAD");
                this.emitOperand(slot);
                this.emit("TYPEOF");
              } else {
                this.emit("TYPEOFCAP");
                this.emitOperand(this.capture(arg.name));
              }
              return;
            }
            this.compileExpr(arg);
            this.emit("TYPEOF");
            return;
          }
          case "void":
            this.compileExpr(node.argument);
            this.emit("VOIDOP");
            return;
          case "delete": {
            const arg = node.argument;
            if (t.isMemberExpression(arg) && !arg.optional) {
              this.compileExpr(arg.object as t.Expression);
              if (arg.computed) this.compileExpr(arg.property as t.Expression);
              else if (t.isIdentifier(arg.property)) {
                this.emit("CONST");
                this.emitOperand(this.strConst(arg.property.name));
              } else this.fail("delete key");
              this.emit("DELPROP");
              return;
            }
            this.fail("delete target");
            return;
          }
          default:
            this.fail("unary " + node.operator);
        }
      }
      case "UpdateExpression":
        this.compileUpdate(node);
        return;
      case "BinaryExpression": {
        this.compileExpr(node.left as t.Expression);
        this.compileExpr(node.right);
        const op = BIN_OPS[node.operator];
        if (!op) this.fail("binary " + node.operator);
        this.emit(op);
        return;
      }
      case "TemplateLiteral": {
        const quasis = node.quasis;
        const exprs = node.expressions;
        this.emit("CONST");
        this.emitOperand(this.strConst(quasis[0].value.cooked ?? ""));
        for (let i = 0; i < exprs.length; i++) {
          this.emit("LOADCAP");
          this.emitOperand(this.capture("String"));
          this.compileExpr(exprs[i] as t.Expression);
          this.emit("CALL");
          this.emitOperand(1);
          this.emit("ADD");
          const next = quasis[i + 1].value.cooked ?? "";
          if (next.length > 0) {
            this.emit("CONST");
            this.emitOperand(this.strConst(next));
            this.emit("ADD");
          }
        }
        return;
      }
      case "TaggedTemplateExpression": {
        const tag = node.tag;
        const cooked = node.quasi.quasis.map((q) => q.value.cooked ?? null);
        const raw = node.quasi.quasis.map((q) => q.value.raw);
        const tplIdx = this.constIdx({ kind: "template", cooked, raw });
        const nExprs = node.quasi.expressions.length;
        if (t.isMemberExpression(tag) && !tag.optional) {
          const staticKey = !tag.computed && t.isIdentifier(tag.property) ? tag.property.name : null;
          if (staticKey !== null) {
            this.compileExpr(tag.object as t.Expression);
            this.emit("CONST");
            this.emitOperand(tplIdx);
            for (const e of node.quasi.expressions) this.compileExpr(e as t.Expression);
            this.emit("CALLPROP");
            this.emitOperand(this.strConst(staticKey));
            this.emitOperand(nExprs + 1);
            return;
          }
          this.compileExpr(tag.object as t.Expression);
          this.emit("DUP");
          this.compileExpr(tag.property as t.Expression);
          this.emit("GETPROP");
          this.emit("CONST");
          this.emitOperand(tplIdx);
          for (const e of node.quasi.expressions) this.compileExpr(e as t.Expression);
          this.emit("CALLTHIS");
          this.emitOperand(nExprs + 1);
          return;
        }
        this.compileExpr(tag);
        this.emit("CONST");
        this.emitOperand(tplIdx);
        for (const e of node.quasi.expressions) this.compileExpr(e as t.Expression);
        this.emit("CALL");
        this.emitOperand(nExprs + 1);
        return;
      }
      case "ParenthesizedExpression":
        this.compileExpr(node.expression);
        return;
      default:
        this.fail("expr " + node.type);
    }
  }

  private pushArgsArray(args: (t.Expression | t.SpreadElement)[]): void {
    this.emit("NEWARRAY");
    for (const a of args) {
      if (t.isSpreadElement(a)) {
        this.compileExpr(a.argument);
        this.emit("ARRSPREAD");
      } else {
        this.compileExpr(a);
        this.emit("ARRAPPEND");
      }
    }
  }

  /**
   * Compile `yield* <expr>`. Pushes `<expr>`, computes its iterator (via
   * Symbol.iterator or .next on the object itself), then emits YIELDDELEGATE
   * which hands control to the generator driver. On resume the driver pushes
   * the inner iterator's final `{value,done}` into a temp slot; we read its
   * `.value` as the delegation result.
   */
  private compileYieldStar(node: t.Expression): void {
    const iterSlot = this.allocTemp("yq");
    const finSlot = this.allocTemp("yf");
    this.compileExpr(node);
    // it = value[Symbol.iterator]()  (fallback: value itself if it has .next)
    this.emit("CALLPROP");
    this.emitOperand(this.constIdx({ kind: "symbol-iterator" }));
    this.emitOperand(0);
    this.emit("STORE");
    this.emitOperand(iterSlot);
    this.emit("POP");
    this.emit("YIELDDELEGATE");
    this.emitOperand(iterSlot);
    // on resume: driver pushes inner final {value,done}; store to finSlot; pop
    this.emit("STORE");
    this.emitOperand(finSlot);
    this.emit("POP");
    // load finSlot.value  (the delegated return value)
    this.emit("LOAD");
    this.emitOperand(finSlot);
    this.emit("CONST");
    this.emitOperand(this.strConst("value"));
    this.emit("GETPROP");
  }

  /**
   * Compile optional chaining (`a?.b`, `a?.[x]`, `a?.b?.c(d)`, `fn?.()`).
   * Each `?.` segment guards the current value: DUP; ISNULLISH; JTRUE short-
   * circuit. On a miss the whole chain evaluates to undefined. Member calls
   * preserve the object as `this` (DUP before GETPROP when the member is the
   * direct callee of a non-optional call); bare optional calls use the value
   * itself as `this`.
   */
  private compileChain(node: t.OptionalMemberExpression | t.OptionalCallExpression): void {
    interface Op {
      n: t.OptionalMemberExpression | t.OptionalCallExpression;
      guard: number | null;
    }
    const ops: Op[] = [];
    let cur: t.Node = node;
    while (cur.type === "OptionalMemberExpression" || cur.type === "OptionalCallExpression") {
      ops.unshift({ n: cur as t.OptionalMemberExpression | t.OptionalCallExpression, guard: null });
      cur = cur.type === "OptionalMemberExpression" ? cur.object : cur.callee;
    }
    if (!t.isExpression(cur)) {
      this.fail("optional chain base");
      return;
    }
    this.compileExpr(cur);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const n = op.n;
      const next = ops[i + 1]?.n;
      if (n.optional) {
        this.emit("DUP");
        this.emit("ISNULLISH");
        op.guard = this.emitJump("JTRUE");
      }
      if (n.type === "OptionalMemberExpression") {
        // If this member is the direct callee of a NON-optional call, preserve
        // its object as `this`: [obj, obj.fn] then CALLTHIS.
        const isMemberCall =
          !!next && next.type === "OptionalCallExpression" && next.optional === false && next.callee === n;
        if (isMemberCall) this.emit("DUP");
        if (n.computed) this.compileExpr(n.property as t.Expression);
        else {
          this.emit("CONST");
          this.emitOperand(this.strConst((n.property as t.Identifier).name));
        }
        this.emit("GETPROP");
      } else {
        // OptionalCallExpression
        const hasSpread = n.arguments.some((a) => t.isSpreadElement(a));
        const calleeIsMember = t.isMemberExpression(n.callee) || t.isOptionalMemberExpression(n.callee);
        if (hasSpread) this.pushArgsArray(n.arguments as (t.Expression | t.SpreadElement)[]);
        else for (const a of n.arguments) this.compileExpr(a as t.Expression);

        if (calleeIsMember && !n.optional) {
          // obj.method(args): this=obj (preserved via DUP above); stack [obj, fn, args...]
          this.emit("CALLTHIS");
          this.emitOperand(n.arguments.length);
        } else if (hasSpread) {
          this.emit("APPLYTHIS");
        } else if (n.optional) {
          // x?.(): this=x, fn=x
          this.emit("DUP");
          this.emit("CALLTHIS");
          this.emitOperand(n.arguments.length);
        } else {
          // bare call fn(args): this=undefined
          this.emit("CALL");
          this.emitOperand(n.arguments.length);
        }
      }
    }

    // main path falls to end; guards jump to the undefined-block
    const endLabel = this.emitJump("JMP");
    const guardStart = this.here();
    for (const op of ops) {
      if (op.guard !== null) this.patch(op.guard, guardStart);
    }
    this.emit("POP");
    this.emit("UNDEF");
    this.patch(endLabel, this.here());
  }

  private compileUpdate(node: t.UpdateExpression): void {
    const arg = node.argument;
    const isInc = node.operator === "++";
    const arith: OpName = isInc ? "ADD" : "SUB";

    if (t.isIdentifier(arg)) {
      const slot = this.locals.get(arg.name);
      if (slot !== undefined) {
        if (node.prefix) {
          this.emit("LOAD");
          this.emitOperand(slot);
          this.emit("CONST");
          this.emitOperand(this.numConst(1));
          this.emit(arith);
          this.emit("DUP");
          this.emit("STORE");
          this.emitOperand(slot);
          this.emit("POP");
        } else {
          this.emit("LOAD");
          this.emitOperand(slot);
          this.emit("LOAD");
          this.emitOperand(slot);
          this.emit("CONST");
          this.emitOperand(this.numConst(1));
          this.emit(arith);
          this.emit("STORE");
          this.emitOperand(slot);
          this.emit("POP");
        }
        return;
      }
      const ci = this.capture(arg.name);
      this.emit("LOADCAP");
      this.emitOperand(ci);
      if (node.prefix) {
        this.emit("CONST");
        this.emitOperand(this.numConst(1));
        this.emit(arith);
        this.emit("DUP");
        this.emit("STORECAP");
        this.emitOperand(ci);
        this.emit("POP");
      } else {
        this.emit("DUP");
        this.emit("CONST");
        this.emitOperand(this.numConst(1));
        this.emit(arith);
        this.emit("STORECAP");
        this.emitOperand(ci);
        this.emit("POP");
      }
      return;
    }

    if (t.isMemberExpression(arg) && !arg.optional) {
      const baseTmp = this.allocTemp("ub");
      const keyTmp = this.allocTemp("uk");
      this.compileExpr(arg.object as t.Expression);
      this.emit("STORE");
      this.emitOperand(baseTmp);
      this.emit("POP");
      if (arg.computed) this.compileExpr(arg.property as t.Expression);
      else if (t.isIdentifier(arg.property)) {
        this.emit("CONST");
        this.emitOperand(this.strConst(arg.property.name));
      } else this.fail("update key");
      this.emit("STORE");
      this.emitOperand(keyTmp);
      this.emit("POP");

      // old = base[key]
      this.emit("LOAD");
      this.emitOperand(baseTmp);
      this.emit("LOAD");
      this.emitOperand(keyTmp);
      this.emit("GETPROP");
      const oldTmp = this.allocTemp("uo");
      this.emit("STORE");
      this.emitOperand(oldTmp);
      this.emit("POP");
      // new = old +/- 1
      this.emit("LOAD");
      this.emitOperand(oldTmp);
      this.emit("CONST");
      this.emitOperand(this.numConst(1));
      this.emit(arith);
      const newTmp = this.allocTemp("un");
      this.emit("STORE");
      this.emitOperand(newTmp);
      this.emit("POP");
      // base[key] = new
      this.emit("LOAD");
      this.emitOperand(baseTmp);
      this.emit("LOAD");
      this.emitOperand(keyTmp);
      this.emit("LOAD");
      this.emitOperand(newTmp);
      this.emit("SETPROP");
      this.emit("POP");
      // result
      this.emit("LOAD");
      this.emitOperand(node.prefix ? newTmp : oldTmp);
      return;
    }

    this.fail("update target");
  }

  private compileAssignment(node: t.AssignmentExpression): void {
    const left = node.left;
    const op = node.operator;

    if (t.isIdentifier(left)) {
      const name = left.name;
      const slot = this.locals.get(name);
      if (op === "=") {
        this.compileExpr(node.right);
        if (slot !== undefined) {
          this.emit("STORE");
          this.emitOperand(slot);
        } else {
          this.emit("STORECAP");
          this.emitOperand(this.capture(name));
        }
        return;
      }
      const bop = COMPOUND_TO_BIN[op];
      if (!bop) this.fail("assign op " + op);
      if (slot !== undefined) {
        this.emit("LOAD");
        this.emitOperand(slot);
        this.compileExpr(node.right);
        this.emit(bop);
        this.emit("STORE");
        this.emitOperand(slot);
      } else {
        const ci = this.capture(name);
        this.emit("LOADCAP");
        this.emitOperand(ci);
        this.compileExpr(node.right);
        this.emit(bop);
        this.emit("STORECAP");
        this.emitOperand(ci);
      }
      return;
    }

    if (t.isMemberExpression(left) && !left.optional) {
      const baseTmp = this.allocTemp("ab");
      const keyTmp = this.allocTemp("ak");
      this.compileExpr(left.object as t.Expression);
      this.emit("STORE");
      this.emitOperand(baseTmp);
      this.emit("POP");
      if (left.computed) this.compileExpr(left.property as t.Expression);
      else if (t.isIdentifier(left.property)) {
        this.emit("CONST");
        this.emitOperand(this.strConst(left.property.name));
      } else this.fail("assign key");
      this.emit("STORE");
      this.emitOperand(keyTmp);
      this.emit("POP");

      if (op !== "=") {
        const bop = COMPOUND_TO_BIN[op];
        if (!bop) this.fail("assign op " + op);
        this.emit("LOAD");
        this.emitOperand(baseTmp);
        this.emit("LOAD");
        this.emitOperand(keyTmp);
        this.emit("GETPROP");
        this.compileExpr(node.right);
        this.emit(bop);
      } else {
        this.compileExpr(node.right);
      }
      const vTmp = this.allocTemp("av");
      this.emit("STORE");
      this.emitOperand(vTmp);
      this.emit("POP");
      this.emit("LOAD");
      this.emitOperand(baseTmp);
      this.emit("LOAD");
      this.emitOperand(keyTmp);
      this.emit("LOAD");
      this.emitOperand(vTmp);
      this.emit("SETPROP");
      return;
    }

    this.fail("assignment target");
  }
}

function constKeyOf(c: ConstValue): string {
  switch (c.kind) {
    case "number":
      return "n:" + (Object.is(c.v, -0) ? "-0" : String(c.v));
    case "string":
      return "s:" + c.v;
    case "symbol-iterator":
      return "y:iter";
    case "symbol-async-iterator":
      return "y:aiter";
    case "hole":
      return "h:ole";
    case "template":
      return "t:" + JSON.stringify(c.cooked) + "|" + JSON.stringify(c.raw);
  }
}
