import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { buildOpMap } from "./ops.js";
import { compileFunction, CompiledFunction, ConstValue } from "./compile.js";
import { buildInterpreterSource } from "./interpreter.js";
import { rtMemberExpr } from "../utils/runtime-api.js";
import { xorshift32Keystream, utf8Encode, B64_STD, toBase64 } from "../utils/codec.js";
import { confusingName } from "../utils/names.js";

type FnNode = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod | t.ClassMethod;

const FN_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod",
]);

/** IIFE callee with a block body suitable for $entry extraction. */
type EntryCallee = t.ArrowFunctionExpression | t.FunctionExpression;

function getEntryCallee(call: t.CallExpression): EntryCallee | null {
  const c = call.callee;
  if (t.isArrowFunctionExpression(c) || t.isFunctionExpression(c)) return c;
  return null;
}

function extractProgramEntry(ast: t.File, ctx: Context): void {
  if (ctx.options.vm < 1) return;
  for (const stmt of ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const call = stmt.expression;
    if (!t.isCallExpression(call)) continue;
    const callee = getEntryCallee(call);
    if (!callee) continue;
    if (!t.isBlockStatement(callee.body)) continue;
    // An async entry body cannot be moved into a plain (non-async) $entry
    // function: its `await` expressions would become syntax errors.
    if (callee.async) continue;

    if (!tryExtractEntryFromCallee(callee, ctx)) continue;
    return;
  }
}

function tryExtractEntryFromCallee(callee: EntryCallee, ctx: Context): boolean {
  if (!t.isBlockStatement(callee.body)) return false;
  const body = callee.body.body;
  const hoisted: t.FunctionDeclaration[] = [];
  const linear: t.Statement[] = [];
  for (const s of body) {
    if (t.isFunctionDeclaration(s)) hoisted.push(s);
    else linear.push(s);
  }
  if (linear.length < ctx.options.vmThreshold) return false;

  // CFF may have moved formerly top-level FunctionDeclarations into switch
  // cases while leaving their function-scope bindings intact. Wrapping that
  // dispatcher in a new $entry function would move its local variables behind
  // a scope boundary while those declarations remain outside it.
  if (linear.some(containsStructuralFunctionDeclaration)) {
    ctx.vmEligible.delete(callee);
    ctx.incVmStat("vmExcl_entry-scope");
    return false;
  }

  // Bindings referenced by the hoisted functions must remain visible to them.
  // Moving them into $entry would leave dangling references (e.g. a `const NS`
  // used by `runHarness`). We hoist a `let <name>;` placeholder to the IIFE
  // body and keep the *initialization* inside $entry at its original position,
  // so the value is produced when the entry runs (preserving DOM-timing).
  const needed = new Set<string>();
  for (const fn of hoisted) collectReferenced(fn, needed);
  // transitive closure: a needed binding's initializer may reference others
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of linear) {
      if (!t.isVariableDeclaration(s)) continue;
      for (const d of s.declarations) {
        if (t.isIdentifier(d.id) && needed.has(d.id.name) && d.init) {
          const before = needed.size;
          collectReferenced(d.init, needed);
          if (needed.size > before) changed = true;
        }
      }
    }
  }

  const declaredInLinear = new Set<string>();
  for (const s of linear) for (const n of declaredNames(s)) declaredInLinear.add(n);
  const structurallyDeclared = new Set<string>();
  for (const s of linear) collectStructuralDeclarations(s, structurallyDeclared);
  const hiddenCapture = [...needed].some(
    (name) => structurallyDeclared.has(name) && !declaredInLinear.has(name),
  );
  if (hiddenCapture) {
    ctx.vmEligible.delete(callee);
    ctx.incVmStat("vmExcl_entry-scope");
    return false;
  }

  // a ClassDeclaration that hoisted fns reference can't be split cleanly
  const bail = linear.some((s) => t.isClassDeclaration(s) && s.id && needed.has(s.id.name));
  if (bail) return false;

  const hoistedNames = [...needed].filter((n) => declaredInLinear.has(n));

  const placeholder = t.variableDeclaration(
    "let",
    hoistedNames.map((n) => t.variableDeclarator(t.identifier(n))),
  );

  const entryBody: t.Statement[] = [];
  for (const s of linear) {
    if (t.isVariableDeclaration(s)) {
      const newDecls: t.VariableDeclarator[] = [];
      for (const d of s.declarations) {
        if (t.isIdentifier(d.id) && needed.has(d.id.name)) {
          if (d.init) entryBody.push(t.expressionStatement(t.assignmentExpression("=", t.identifier(d.id.name), d.init)));
        } else {
          newDecls.push(d);
        }
      }
      if (newDecls.length > 0) entryBody.push(t.variableDeclaration(s.kind, newDecls));
    } else {
      entryBody.push(s);
    }
  }

  const entryName = ctx.freshName("$entry");
  const entryFn = t.functionDeclaration(t.identifier(entryName), [], t.blockStatement(entryBody));
  callee.body.body = [...hoisted, ...(hoistedNames.length ? [placeholder] : []), entryFn, t.expressionStatement(t.callExpression(t.identifier(entryName), []))];
  ctx.vmEligible.add(entryFn);
  return true;
}

function containsStructuralFunctionDeclaration(node: t.Node): boolean {
  if (t.isFunctionDeclaration(node)) return true;
  // Functions nested inside expressions introduce their own scope and move
  // together with the expression, so their declarations are irrelevant here.
  if (t.isFunction(node)) return false;
  const keys = t.VISITOR_KEYS[node.type] ?? [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child
          && containsStructuralFunctionDeclaration(child as t.Node)) return true;
      }
    } else if (value && typeof value === "object" && "type" in value
      && containsStructuralFunctionDeclaration(value as t.Node)) {
      return true;
    }
  }
  return false;
}

function collectStructuralDeclarations(node: t.Node, out: Set<string>): void {
  if (t.isVariableDeclaration(node)) {
    for (const decl of node.declarations) {
      if (t.isIdentifier(decl.id)) out.add(decl.id.name);
    }
  } else if (t.isClassDeclaration(node) && node.id) {
    out.add(node.id.name);
  }
  if (t.isFunction(node) || t.isClass(node)) return;
  const keys = t.VISITOR_KEYS[node.type] ?? [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          collectStructuralDeclarations(child as t.Node, out);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      collectStructuralDeclarations(value as t.Node, out);
    }
  }
}

function declaredNames(stmt: t.Statement): string[] {
  const out: string[] = [];
  if (t.isVariableDeclaration(stmt)) {
    for (const d of stmt.declarations) {
      if (t.isIdentifier(d.id)) out.push(d.id.name);
    }
  } else if (t.isFunctionDeclaration(stmt) && stmt.id) {
    out.push(stmt.id.name);
  } else if (t.isClassDeclaration(stmt) && stmt.id) {
    out.push(stmt.id.name);
  }
  return out;
}

function collectReferenced(node: t.Node, out: Set<string>): void {
  const visit = (n: t.Node, isKey: boolean): void => {
    if (t.isIdentifier(n)) {
      if (!isKey) out.add(n.name);
      return;
    }
    if (t.isMemberExpression(n)) {
      visit(n.object, false);
      if (n.computed) visit(n.property, false);
      else visit(n.property, true);
      return;
    }
    if (t.isObjectProperty(n)) {
      visit(n.value, false);
      if (n.computed) visit(n.key, false);
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments" || key === "extra" || key === "comments") continue;
      const val = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(val)) {
        for (const item of val) if (item && typeof item === "object" && "type" in (item as object)) visit(item as t.Node, false);
      } else if (val && typeof val === "object" && "type" in (val as object)) {
        visit(val as t.Node, false);
      }
    }
  };
  visit(node, false);
}

export function virtualizeFunctions(ast: t.File, ctx: Context): void {
  const level = ctx.options.vm;
  if (level <= 0) return;

  extractProgramEntry(ast, ctx);

  const compiled: CompiledFunction[] = [];
  const targets: NodePath<FnNode>[] = [];

  traverse(ast, {
    enter(path: NodePath) {
      if (FN_TYPES.has(path.node.type) && ctx.vmEligible.has(path.node)) {
        targets.push(path as NodePath<FnNode>);
      }
    },
  });

  const opMapPoolSize = level >= 2 ? Math.min(8, Math.max(2, Math.ceil(targets.length / 3) || 2)) : 1;
  const opMapPool = Array.from({ length: opMapPoolSize }, () => buildOpMap(ctx.rng, level));

  for (const fnPath of targets) {
    const opMapId = opMapPoolSize > 1 && !fnPath.node.generator ? ctx.rng.int(opMapPoolSize) : 0;
    const res = compileFunction(fnPath, opMapPool[opMapId], ctx.rng, level);
    if (!res) {
      ctx.incVmStat("vmCompileFailed");
      continue;
    }
    res.opMapId = opMapId;
    const id = compiled.length;
    compiled.push(res);
    replaceWithStub(fnPath, id, res, ctx);
    ctx.stats.virtualizedFunctions++;
  }

  if (compiled.length === 0) return;

  const buildKey = level >= 3 ? (ctx.rng.int(0x7ffffffe) + 1) | 0 : 0;
  ctx.runtimeFlags.vmBuildKey = buildKey;
  // At-rest bytecode cipher: the VM function-table bytecode is XOR-masked with a
  // per-build keystream before being embedded, so it is not stored as plaintext
  // number arrays a static disassembler could read directly. The interpreter
  // reverses it once per function invocation (see buildInterpreterSource).
  const bytecodeSeed = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  ctx.runtimeFlags.vmBytecodeKey = bytecodeSeed;
  // Const-pool strings (runtime capability names, property keys, templates)
  // are stored as keystream-masked UTF-8 byte arrays instead of plaintext.
  const constSeed = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  ctx.runtimeFlags.vmConstKey = constSeed;
  // Randomize the FT entry field names per build so the stable
  // `{b:[...],c:[...],n,p,r,m,k}` shape (a structural fingerprint that survives
  // identifier renaming) is no longer greppable. Object-property keys are not
  // renamed by the identifiers pass, so they must be confusing up front.
  const vmFields = {
    b: confusingName(ctx.rng, ctx.usedNames, 2),
    c: confusingName(ctx.rng, ctx.usedNames, 2),
    n: confusingName(ctx.rng, ctx.usedNames, 2),
    p: confusingName(ctx.rng, ctx.usedNames, 2),
    r: confusingName(ctx.rng, ctx.usedNames, 2),
    m: confusingName(ctx.rng, ctx.usedNames, 2),
    k: confusingName(ctx.rng, ctx.usedNames, 2),
    a: confusingName(ctx.rng, ctx.usedNames, 2),
    g: confusingName(ctx.rng, ctx.usedNames, 2),
    o: confusingName(ctx.rng, ctx.usedNames, 2),
  };
  ctx.runtimeFlags.vmFields = vmFields;
  const scatterFt = ctx.options.vmScatterFt && level >= 2;
  const ftSource = serializeFunctionTable(
    compiled, level, buildKey, bytecodeSeed, vmFields, constSeed, ctx.keystream, scatterFt, ctx.rng,
  );
  ctx.runtimeFlags.vmFtResolver = "$ftg";
  const vmFn = ctx.freshName("$vm");
  // Emit only the interpreter variants actually needed (dead async/generator
  // interpreters are pure size overhead when no such function is virtualized).
  const hasAsync = compiled.some((f) => f.async);
  const hasGenerator = compiled.some((f) => f.generator);
  // The interpreter's own dispatch functions must not be re-flattened by the
  // runtime-dogfooding pass (their dispatch loop is already a state machine).
  const vmFnNames = [vmFn, vmFn + "0"];
  if (hasAsync) vmFnNames.push(vmFn + "A");
  if (hasGenerator) vmFnNames.push(vmFn + "G");
  ctx.runtimeFlags.vmFnNames = vmFnNames;
  // Self-defense guard: a per-build variable in the shared runtime scope. If an
  // analyst patches the VM (or the anti-debug checks detect tampering) the
  // guard is set non-zero and every virtualized function no-ops, breaking the
  // program instead of letting it run tampered.
  const guardName = ctx.freshName("$vg");
  ctx.runtimeFlags.vmGuard = guardName;
  // Seeds are embedded XOR-masked with the session key so the interpreter is not
  // self-sufficient: a static reader cannot recover the bytecode/const/build
  // ciphers without first recovering SKEY (which is itself runtime-derived).
  const interpSource = buildInterpreterSource(
    opMapPool, level, ctx.rng, vmFn,
    (buildKey ^ ctx.sessionKey) >>> 0,
    guardName,
    (bytecodeSeed ^ ctx.sessionKey) >>> 0,
    vmFields,
    (constSeed ^ ctx.sessionKey) >>> 0,
    ctx.keystream,
    hasAsync,
    hasGenerator,
    ctx.options.vmDecryptMode,
    scatterFt ? "$ftg" : "$ftg",
  );
  // FT is pure data -> emitted as a scattered program-level statement; the
  // interpreter references it via closure.
  ctx.runtime.add(ftSource, {}, true, true);
  ctx.runtime.add(interpSource, { vmRun: vmFn });
}

function replaceWithStub(fnPath: NodePath<FnNode>, id: number, res: CompiledFunction, ctx: Context): void {
  const fn = fnPath.node;
  const argsId = t.identifier(ctx.freshName("$a"));

  const getters = t.arrayExpression(
    res.captures.map((name) => t.arrowFunctionExpression([], t.identifier(name))),
  );
  const setters = t.arrayExpression(
    res.captures.map((name) => {
      const v = t.identifier(ctx.freshName("$v"));
      return t.arrowFunctionExpression(
        [v],
        t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(name), v))]),
      );
    }),
  );

  const vMember = rtMemberExpr(ctx, "vmRun");
  const callArgs: t.Expression[] = [t.numericLiteral(id), t.thisExpression(), argsId, getters, setters];
  if (res.selfNamed && t.isFunctionExpression(fn) && fn.id) {
    callArgs.push(t.identifier(fn.id.name));
  }
  const call = t.callExpression(vMember, callArgs);

  // The stub is a plain function: calling a virtualized generator function
  // returns the VM iterator object ($vmG already returns a proper iterator),
  // and `next()/throw()/return()` operate on it. The stub must NOT itself be a
  // generator, or calling it would return a native generator wrapper and the
  // iterator protocol would be wrong.
  fn.params = [t.restElement(argsId)];
  fn.body = t.blockStatement([t.returnStatement(call)]);
  // Clear the generator flag on EVERY stub shape (FunctionDeclaration,
  // FunctionExpression, ObjectMethod, ClassMethod, ...): the VM's $vmG already
  // returns a proper iterator object, so the stub must be a plain function
  // that returns it. Leaving `generator: true` on an ObjectMethod stub makes it
  // a native generator whose `return vmRun(...)` yields no values, silently
  // breaking `for..of` over virtualized generator methods.
  (fn as { generator?: boolean }).generator = false;
}

function serializeFunctionTable(
  fns: CompiledFunction[],
  level: number,
  buildKey: number,
  bytecodeSeed: number,
  fields: { b: string; c: string; n: string; p: string; r: string; m: string; k: string; a: string; g: string; o: string },
  constSeed: number,
  keystream: { shifts: [number, number, number]; order: number },
  scatter: boolean,
  rng: { int(n: number): number; chance(p?: number): boolean },
): string {
  const shardCount = scatter ? rng.int(2) + 2 : 1;
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  const shardOf: number[] = [];
  const slotOf: number[] = [];

  const encodeEntry = (f: CompiledFunction, i: number): string => {
    let code = f.code.slice();
    if (level >= 3 && f.rollingSeed !== 0) {
      code = code.map((v, idx) => (v ^ ((f.rollingSeed ^ Math.imul(idx + 1, 2654435761)) >>> 0)) >>> 0);
    }
    if (level >= 3 && buildKey !== 0) {
      code = code.map((v, idx) => (v ^ ((buildKey ^ Math.imul(idx + 7, 2246822519)) >>> 0)) >>> 0);
    }
    const ks = xorshift32Keystream(bytecodeSeed, code.length, keystream);
    code = code.map((v, idx) => (v ^ ks[idx]) >>> 0);
    return (
      `{${fields.b}:[${code.join(",")}],${fields.c}:[${f.consts.map((c) => serializeConst(c, constSeed, keystream)).join(",")}],` +
      `${fields.n}:${f.localCount},${fields.p}:${f.paramCount},${fields.r}:${f.restIdx},${fields.m}:${f.operandMask},${fields.k}:${f.rollingSeed},${fields.a}:${f.async ? 1 : 0},${fields.g}:${f.generator ? 1 : 0},${fields.o}:${f.opMapId}}`
    );
  };

  fns.forEach((f, i) => {
    const entry = encodeEntry(f, i);
    if (scatter) {
      const s = rng.int(shardCount);
      const slot = shards[s].length;
      shards[s].push(`FT[${slot}] = ${entry};`);
      shardOf.push(s);
      slotOf.push(slot);
      // junk padding
      if (rng.chance(0.4)) {
        const junkSlot = shards[s].length;
        shards[s].push(`FT[${junkSlot}] = {${fields.b}:[],${fields.c}:[],${fields.n}:0,${fields.p}:0,${fields.r}:-1,${fields.m}:0,${fields.k}:0,${fields.a}:0,${fields.g}:0,${fields.o}:0};`);
      }
    } else {
      shards[0].push(`FT[${i}] = ${entry};`);
    }
  });

  if (!scatter) {
    return "var FT = [];\n" + shards[0].join("\n") + "\nfunction $ftg(i){return FT[i];}";
  }

  const shardNames = shards.map((_, i) => `$fs${i}`);
  const lines: string[] = shardNames.map((n) => `var ${n} = [];`);
  for (let s = 0; s < shardCount; s++) {
    for (const line of shards[s]) {
      lines.push(line.replace(/^FT\[/, `${shardNames[s]}[`));
    }
  }
  lines.push(`var $fsh = [${shardOf.join(",")}];`);
  lines.push(`var $fsl = [${slotOf.join(",")}];`);
  const resolverParts = shardNames.map((n, i) => `s===${i}?${n}[l]`).join(":");
  lines.push(`function $ftg(i){var s=$fsh[i],l=$fsl[i];return ${resolverParts}:${shardNames[0]}[0];}`);
  return lines.join("\n");
}

/** Serialize a const value; string/template consts become masked byte arrays. */
function serializeConst(c: ConstValue, constSeed: number, keystream: { shifts: [number, number, number]; order: number }): string {
  switch (c.kind) {
    case "number": {
      const v = c.v;
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Infinity";
      if (v === -Infinity) return "-Infinity";
      if (Object.is(v, -0)) return "-0";
      return String(v);
    }
    case "string":
      return maskedBytes(c.v ?? "", constSeed, keystream);
    case "symbol-iterator":
      return "Symbol.iterator";
    case "symbol-async-iterator":
      return "Symbol.asyncIterator";
    case "hole":
      return "HOLE";
    case "template": {
      return `[${maskedBytes(JSON.stringify(c.cooked), constSeed, keystream)},${maskedBytes(JSON.stringify(c.raw), constSeed, keystream)}]`;
    }
  }
}

/** UTF-8 bytes of `s`, XOR-masked with a keystream derived from `seed`,
 * transported as a base64 string (denser than a decimal array). */
function maskedBytes(s: string, seed: number, keystream: { shifts: [number, number, number]; order: number }): string {
  const bytes = utf8Encode(s);
  const ks = xorshift32Keystream(seed, bytes.length, keystream);
  return JSON.stringify(toBase64(bytes.map((b, i) => (b ^ ks[i]) & 0xff), B64_STD));
}
