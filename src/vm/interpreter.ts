import type { OpMap, OpName } from "./ops.js";
import { OP_NAMES } from "./ops.js";
import { B64_STD } from "../utils/codec.js";

/**
 * Generate the VM interpreter source (function V) for a per-build opcode map.
 * Level effects:
 *  - L1: plain switch dispatch
 *  - L2: permuted numbering (from opMap), shuffled case order, handler phrasing variants
 *  - L3: + alias case labels, dead handlers, phantom stack slots, position-keyed
 *        rolling decryption of the bytecode stream
 */
export function buildInterpreterSource(
  opMaps: OpMap | OpMap[],
  level: number,
  rng: { int(n: number): number; shuffle<T>(a: readonly T[]): T[]; chance(p?: number): boolean },
  vmFnName = "V",
  buildKey = 0,
  guardName = "",
  bytecodeKey = 0,
  fields: { b: string; c: string; n: string; p: string; r: string; m: string; k: string; a: string; g: string; o: string } = {
    b: "b", c: "c", n: "n", p: "p", r: "r", m: "m", k: "k", a: "a", g: "g", o: "o",
  },
  constKey = 0,
  keystream: { shifts: [number, number, number]; order: number } = { shifts: [13, 17, 5], order: 0 },
  hasAsync = true,
  hasGenerator = true,
  decryptMode: "cache" | "volatile" = "cache",
  ftAccessor = "FT",
): string {
  const opMapPool = Array.isArray(opMaps) ? opMaps : [opMaps];
  const primaryMap = opMapPool[0];
  const bodies = new Map<OpName, string>();

  const bkKey = buildKey !== 0 ? String(buildKey) : "0";
  const variant = (a: string, b: string) => (rng.chance() ? a : b);

  bodies.set("NOP", "");
  bodies.set("CONST", "stack.push(consts[vx()]);");
  bodies.set("UNDEF", "stack.push(undefined);");
  bodies.set("NULL", "stack.push(null);");
  bodies.set("TRUE", "stack.push(true);");
  bodies.set("FALSE", "stack.push(false);");
  bodies.set("THIS", "stack.push(self);");
  bodies.set("SELF", "stack.push(sf);");
  bodies.set(
    "LOAD",
    variant("stack.push(locals[vx()]);", "var sl = vx(); stack.push(locals[sl]);"),
  );
  bodies.set(
    "STORE",
    variant("locals[vx()] = stack[stack.length - 1];", "var sl = vx(); locals[sl] = stack[stack.length - 1];"),
  );
  bodies.set("LOADCAP", "stack.push(gs[vx()]());");
  bodies.set("STORECAP", "ss[vx()](stack[stack.length - 1]);");
  bodies.set("POP", variant("stack.pop();", "stack.length = stack.length - 1;"));
  bodies.set("DUP", variant("stack.push(stack[stack.length - 1]);", "var dv = stack[stack.length - 1]; stack.push(dv);"));
  bodies.set(
    "ADD",
    variant(
      "var b = stack.pop(); stack.push(stack.pop() + b);",
      "stack[stack.length - 2] = stack[stack.length - 2] + stack[stack.length - 1]; stack.pop();",
    ),
  );
  const binHandler = (opStr: string) => `var b = stack.pop(); var a = stack.pop(); stack.push(a ${opStr} b);`;
  bodies.set("SUB", binHandler("-"));
  bodies.set("MUL", binHandler("*"));
  bodies.set("DIV", binHandler("/"));
  bodies.set("MOD", binHandler("%"));
  bodies.set("POW", binHandler("**"));
  bodies.set("BITAND", binHandler("&"));
  bodies.set("BITOR", binHandler("|"));
  bodies.set("BITXOR", binHandler("^"));
  bodies.set("SHL", binHandler("<<"));
  bodies.set("SHR", binHandler(">>"));
  bodies.set("USHR", binHandler(">>>"));
  bodies.set("EQ", binHandler("=="));
  bodies.set("NEQ", binHandler("!="));
  bodies.set("SEQ", binHandler("==="));
  bodies.set("SNEQ", binHandler("!=="));
  bodies.set("LT", binHandler("<"));
  bodies.set("GT", binHandler(">"));
  bodies.set("LTE", binHandler("<="));
  bodies.set("GTE", binHandler(">="));
  bodies.set("NOT", "stack.push(!stack.pop());");
  bodies.set("BITNOT", "stack.push(~stack.pop());");
  bodies.set("NEG", "stack.push(-stack.pop());");
  bodies.set("POS", "stack.push(+stack.pop());");
  bodies.set("TYPEOF", "stack.push(typeof stack.pop());");
  bodies.set("VOIDOP", "stack.pop(); stack.push(undefined);");
  bodies.set("INOP", "var b = stack.pop(); stack.push(stack.pop() in b);");
  bodies.set("INSTANCEOF", "var b = stack.pop(); stack.push(stack.pop() instanceof b);");
  bodies.set(
    "CALL",
    `var n = vx(); ca.length = n;
for (var i = n - 1; i >= 0; i--) ca[i] = stack.pop();
var fn = stack.pop();
stack.push(fn.apply(undefined, ca));`,
  );
  bodies.set(
    "CALLPROP",
    `var k = consts[vx()]; var n = vx(); ca.length = n;
for (var i = n - 1; i >= 0; i--) ca[i] = stack.pop();
var o = stack.pop();
stack.push(o[k].apply(o, ca));`,
  );
  bodies.set(
    "CALLTHIS",
    `var n = vx(); ca.length = n;
for (var i = n - 1; i >= 0; i--) ca[i] = stack.pop();
var fn = stack.pop(); var th = stack.pop();
stack.push(fn.apply(th, ca));`,
  );
  bodies.set("APPLY", "var ar = stack.pop(); var fn = stack.pop(); stack.push(fn.apply(undefined, ar));");
  bodies.set("APPLYTHIS", "var ar = stack.pop(); var fn = stack.pop(); var th = stack.pop(); stack.push(fn.apply(th, ar));");
  bodies.set(
    "NEWOP",
    `var n = vx(); ca.length = n;
for (var i = n - 1; i >= 0; i--) ca[i] = stack.pop();
var ct = stack.pop();
stack.push(Reflect.construct(ct, ca));`,
  );
  bodies.set("NEWSPREAD", "var ar = stack.pop(); var ct = stack.pop(); stack.push(Reflect.construct(ct, ar));");
  bodies.set("JMP", variant("pc = vx();", "var jt = vx(); pc = jt;"));
  bodies.set("JTRUE", "var t1 = vx(); if (stack.pop()) pc = t1;");
  bodies.set("JFALSE", "var t2 = vx(); if (!stack.pop()) pc = t2;");
  bodies.set("ISNULLISH", "stack.push(stack.pop() == null);");
  bodies.set("RET", "return stack.pop();");
  bodies.set("RETUNDEF", "return undefined;");
  bodies.set("THROW", "throw stack.pop();");
  bodies.set("TRYENTER", "trys.push({ h: vx(), s: stack.length, f: 0 });");
  bodies.set("TRYLEAVE", "trys.pop();");
  bodies.set("FINENTER", "trys.push({ h: vx(), s: stack.length, f: 1 });");
  bodies.set("FINNORMAL", "var tf = trys.pop(); pend = 0; stack.length = tf.s; pc = tf.h;");
  bodies.set("FINPEND", "var pt = vx(); var pv = vx(); var tf = trys.pop(); pend = { t: pt, v: pv }; stack.length = tf.s; pc = tf.h;");
  bodies.set("FINEND", "var p = pend; pend = 0; if (p) { if (p.t === 1) rt(p.v); else if (p.t === 2) throw p.v; else pc = p.v; }");
  bodies.set("GETPROP", "var k = stack.pop(); var o = stack.pop(); stack.push(o[k]);");
  bodies.set("SETPROP", "var v = stack.pop(); var k = stack.pop(); var o = stack.pop(); o[k] = v; stack.push(v);");
  bodies.set("DELPROP", "var k = stack.pop(); var o = stack.pop(); stack.push(delete o[k]);");
  bodies.set("HASPROP", "var k = stack.pop(); var o = stack.pop(); stack.push(k in o);");
  bodies.set(
    "TYPEOFCAP",
    `var ci = vx();
try { stack.push(typeof gs[ci]()); }
catch (te) { if (te instanceof ReferenceError) stack.push("undefined"); else throw te; }`,
  );
  bodies.set("NEWOBJ", "stack.push({});");
  bodies.set("OBJSET", "var v = stack.pop(); var k = stack.pop(); var o = stack.pop(); o[k] = v;");
  bodies.set("OBJASSIGN", "var s = stack.pop(); var o = stack.pop(); stack.push(Object.assign(o, s));");
  bodies.set("NEWARRAY", "stack.push([]);");
  bodies.set(
    "ARRAPPEND",
    `var v = stack.pop(); var o = stack.pop();
if (v === HOLE) { o.length = o.length + 1; } else { o.push(v); }
stack.push(o);`,
  );
  bodies.set(
    "ARRSPREAD",
    `var s = stack.pop(); var o = stack.pop();
for (var it of s) o.push(it);
stack.push(o);`,
  );
  bodies.set(
    "FORIN",
    `var o = stack.pop(); var ks = [];
for (var kk in o) ks.push(kk);
stack.push(ks);`,
  );
  bodies.set(
    "FOROF",
    `var iter = stack.pop();
do {
  var step = iter.next();
  if (step.done) break;
  stack.push(step.value);
} while (true);`,
  );
  bodies.set("YIELD", `var yt = vx(); it.uv = stack.pop(); throw {__g:1, __k:"${bkKey}gen", __yt: yt};`);
  bodies.set("YIELDDELEGATE", `var isl = vx(); it.dg = locals[isl]; it.uv = void 0; it.ty = 2; throw {__g:1, __k:"${bkKey}gen", __yt: 2};`);
  bodies.set("AWAIT", "stack.push(await stack.pop());");
  bodies.set("DEBUGGER", "debugger;");

  // ---- build per-opcode handler functions (function-pointer dispatch) ----
  // Each opcode becomes a closure over the VM's mutable state (stack, locals,
  // pc, trys, ...). The dispatch table HD maps a raw opcode to its handler, so
  // there is no central `switch` for a reverse engineer to anchor on. The
  // handler declaration order and the HD assignment order are both shuffled per
  // build, and aliases / dead slots further scramble the table layout.
  const handlerName = new Map<OpName, string>();
  const handlerDecls: string[] = [];
  for (const name of OP_NAMES) {
    const hn = "h_" + name;
    handlerName.set(name, hn);
    let body = bodies.get(name) ?? "";
    // Control-flow ops: RET/RETUNDEF route through the shared `rt` helper (a
    // cheap sentinel + finally-routing, NO exception), while THROW raises the
    // user value for normal try/catch semantics.
    if (name === "RET") body = "rt(stack.pop());";
    else if (name === "RETUNDEF") body = "rt(undefined);";
    else if (name === "THROW") body = "throw stack.pop();";
    const kw = name === "AWAIT" ? "async function" : "function";
    handlerDecls.push(kw + " " + hn + "(){" + body + "}");
  }
  const shuffledDecls = rng.shuffle(handlerDecls);

  // dispatch-table size must cover every emitted code (incl. aliases + L3 dead)
  let maxCode = 0;
  for (const opMap of opMapPool) {
    for (const name of OP_NAMES) maxCode = Math.max(maxCode, opMap.code[name]);
    for (const al of Object.values(opMap.aliases)) for (const c of al ?? []) maxCode = Math.max(maxCode, c);
  }
  if (level >= 3) maxCode = Math.max(maxCode, 215);
  const tableSize = maxCode + 1;

  const buildAssignLines = (opMap: OpMap): string[] => {
    const assignEntries: { code: number; name: OpName }[] = [];
    for (const name of OP_NAMES) {
      assignEntries.push({ code: opMap.code[name], name });
      const al = opMap.aliases[name];
      if (al) for (const c of al) assignEntries.push({ code: c, name });
    }
    const lines: string[] = [];
    lines.push("for (var __hd = 0; __hd < " + tableSize + "; __hd++) HD[__hd] = " + handlerName.get("NOP") + ";");
    for (const e of rng.shuffle(assignEntries)) {
      lines.push("HD[" + e.code + "] = " + handlerName.get(e.name) + ";");
    }
    return lines;
  };

  const hpoolLines: string[] = ["var HPOOL = [];"];
  for (let mi = 0; mi < opMapPool.length; mi++) {
    hpoolLines.push("(function(){ var HD = new Array(" + tableSize + ");");
    hpoolLines.push(...buildAssignLines(opMapPool[mi]).map((l) => "  " + l));
    hpoolLines.push("  HPOOL[" + mi + "] = HD;");
    hpoolLines.push("})();");
  }
  const hpoolSetup = hpoolLines.join("\n  ");

  const assignLines: string[] = buildAssignLines(primaryMap);

  // Generator handler set: identical opcode logic, but the mutable state lives
  // on the iterator object `it` (so it survives across .next() resumes). We
  // rewrite `stack`->`it.stack`, `locals`->`it.locals`, `pc`->`it.pc`,
  // `trys`->`it.trys`, `pend`->`it.pend`.
  const genBody = (name: OpName): string => {
    let body = bodies.get(name) ?? "";
    switch (name) {
      case "RET":
        body = "ret = stack.pop(); gdone = 1;";
        break;
      case "RETUNDEF":
        body = "ret = void 0; gdone = 1;";
        break;
      case "FINEND":
        body = "var p = pend; pend = 0; if (p) { if (p.t === 1) { ret = p.v; gdone = 1; } else if (p.t === 2) throw p.v; else pc = p.v; }";
        break;
      case "THROW":
        body = "throw stack.pop();";
        break;
      case "NOP":
        body = "";
        break;
      default:
        break;
    }
    // rewrite closure state vars to iterator properties
    body = body
      .replace(/\bstack\b/g, "it.stack")
      .replace(/\blocals\b/g, "it.locals")
      .replace(/\bpc\b/g, "it.pc")
      .replace(/\btrys\b/g, "it.trys")
      .replace(/\bpend\b/g, "it.pend")
      .replace(/\bret\b/g, "it.ret")
      .replace(/\bgdone\b/g, "it.gdone")
      .replace(/\bvx\(\)/g, "gnvx()")
      .replace(/\bnx\(\)/g, "gnx()");
    // generators never run AWAIT (no `await` in generator bodies); make the
    // handler valid JS so the plain function emission parses
    if (name === "AWAIT") body = "it.stack.push(it.stack.pop());";
    return body;
  };
  const genName = new Map<OpName, string>();
  const genDecls: string[] = [];
  for (const name of OP_NAMES) {
    const gn = "gh_" + name;
    genName.set(name, gn);
    genDecls.push("function " + gn + "(){" + genBody(name) + "}");
  }
  const genShuffled = rng.shuffle(genDecls);
  const genAssignEntries: { code: number; name: OpName }[] = [];
  for (const name of OP_NAMES) {
    genAssignEntries.push({ code: primaryMap.code[name], name });
    const al = primaryMap.aliases[name];
    if (al) for (const c of al) genAssignEntries.push({ code: c, name });
  }
  const genAssignLines: string[] = [];
  genAssignLines.push("for (var __gh = 0; __gh < " + tableSize + "; __gh++) GHD[__gh] = " + genName.get("NOP") + ";");
  for (const e of rng.shuffle(genAssignEntries)) {
    genAssignLines.push("GHD[" + e.code + "] = " + genName.get(e.name) + ";");
  }

  const phantom = level >= 3 ? "stack.push(0, null);" : "";
  const bkExpr = bkKey;

  const constDecrypt = constKey !== 0 ? "var __cA = f." + fields.c + ";\n"
    + "    for (var __cI = 0; __cI < __cA.length; __cI++) {\n"
    + "      var __cV = __cA[__cI];\n"
    + "      if (__cV !== null && (typeof __cV === \"string\" || (typeof __cV === \"object\" && Array.isArray(__cV)))) {\n"
    + "        if (Array.isArray(__cV) && __cV.length === 2 && (typeof __cV[0] === \"string\" || Array.isArray(__cV[0]))) {\n"
    + "          var __ca1 = typeof __cV[0] === \"string\" ? __b64(__cV[0]) : __cV[0];\n"
    + "          var __ca2 = typeof __cV[1] === \"string\" ? __b64(__cV[1]) : __cV[1];\n"
    + "          var __k1 = (" + constKey + " ^ SKEY) >>> 0; if (__k1 === 0) __k1 = 1;\n"
    + "          var __b1 = __ca1.slice();\n"
    + "          for (var __j1 = 0; __j1 < __b1.length; __j1++) { "
    + ksStepJs("__k1", keystream) + " __b1[__j1] = (__b1[__j1] ^ (__k1 & 255)) & 0xff; }\n"
    + "          var __k2 = (" + constKey + " ^ SKEY) >>> 0; if (__k2 === 0) __k2 = 1;\n"
    + "          var __b2 = __ca2.slice();\n"
    + "          for (var __j2 = 0; __j2 < __b2.length; __j2++) { "
    + ksStepJs("__k2", keystream) + " __b2[__j2] = (__b2[__j2] ^ (__k2 & 255)) & 0xff; }\n"
    + "          var __cA1 = JSON.parse(__u8(__b1)), __cR1 = JSON.parse(__u8(__b2));\n"
    + "          __cR1 = Object.freeze(__cR1); __cA1.raw = __cR1;\n"
    + "          __cA[__cI] = Object.freeze(__cA1);\n"
    + "        } else {\n"
    + "          var __bytes = typeof __cV === \"string\" ? __b64(__cV) : __cV;\n"
    + "          var __k3 = (" + constKey + " ^ SKEY) >>> 0; if (__k3 === 0) __k3 = 1;\n"
    + "          var __b3 = __bytes.slice();\n"
    + "          for (var __j3 = 0; __j3 < __b3.length; __j3++) { "
    + ksStepJs("__k3", keystream) + " __b3[__j3] = (__b3[__j3] ^ (__k3 & 255)) & 0xff; }\n"
    + "          __cA[__cI] = __u8(__b3);\n"
    + "        }\n"
    + "      }\n"
    + "    }" : "";

  const constDecryptLocal = constKey !== 0
    ? "var consts = f." + fields.c + ".slice();\n"
    + "    for (var __cI = 0; __cI < consts.length; __cI++) {\n"
    + "      var __cV = consts[__cI];\n"
    + "      if (__cV !== null && (typeof __cV === \"string\" || (typeof __cV === \"object\" && Array.isArray(__cV)))) {\n"
    + "        if (Array.isArray(__cV) && __cV.length === 2 && (typeof __cV[0] === \"string\" || Array.isArray(__cV[0]))) {\n"
    + "          var __ca1 = typeof __cV[0] === \"string\" ? __b64(__cV[0]) : __cV[0];\n"
    + "          var __ca2 = typeof __cV[1] === \"string\" ? __b64(__cV[1]) : __cV[1];\n"
    + "          var __k1 = (" + constKey + " ^ SKEY) >>> 0; if (__k1 === 0) __k1 = 1;\n"
    + "          var __b1 = __ca1.slice();\n"
    + "          for (var __j1 = 0; __j1 < __b1.length; __j1++) { "
    + ksStepJs("__k1", keystream) + " __b1[__j1] = (__b1[__j1] ^ (__k1 & 255)) & 0xff; }\n"
    + "          var __k2 = (" + constKey + " ^ SKEY) >>> 0; if (__k2 === 0) __k2 = 1;\n"
    + "          var __b2 = __ca2.slice();\n"
    + "          for (var __j2 = 0; __j2 < __b2.length; __j2++) { "
    + ksStepJs("__k2", keystream) + " __b2[__j2] = (__b2[__j2] ^ (__k2 & 255)) & 0xff; }\n"
    + "          var __cA1 = JSON.parse(__u8(__b1)), __cR1 = JSON.parse(__u8(__b2));\n"
    + "          __cR1 = Object.freeze(__cR1); __cA1.raw = __cR1;\n"
    + "          consts[__cI] = Object.freeze(__cA1);\n"
    + "        } else {\n"
    + "          var __bytes = typeof __cV === \"string\" ? __b64(__cV) : __cV;\n"
    + "          var __k3 = (" + constKey + " ^ SKEY) >>> 0; if (__k3 === 0) __k3 = 1;\n"
    + "          var __b3 = __bytes.slice();\n"
    + "          for (var __j3 = 0; __j3 < __b3.length; __j3++) { "
    + ksStepJs("__k3", keystream) + " __b3[__j3] = (__b3[__j3] ^ (__k3 & 255)) & 0xff; }\n"
    + "          consts[__cI] = __u8(__b3);\n"
    + "        }\n"
    + "      }\n"
    + "    }"
    : "var consts = f." + fields.c + ";";

  const volatileNx = "function nx() { var v = __rawAt(pc); if (enc) v = (v ^ key(pc)) >>> 0; pc++; return v; }\n"
    + "  function vx() { var v = __rawAt(pc); if (enc) v = (v ^ key(pc)) >>> 0; else if (om) v = (v ^ om) >>> 0; pc++; return v; }";

  const cacheNx = "function nx() { var v = code[pc]; if (enc) v = (v ^ key(pc)) >>> 0; pc++; return v; }\n"
    + "  function vx() { var v = code[pc]; if (enc) v = (v ^ key(pc)) >>> 0; else if (om) v = (v ^ om) >>> 0; pc++; return v; }";

  const volatileDecrypt = "var cipher = f." + fields.b + ";\n"
    + "  if (typeof cipher === \"string\") cipher = __b64(cipher);\n"
    + "  var cl = cipher.length, __ksArr = null;\n"
    + "  function __rawAt(idx) {\n"
    + "    if (!__ksArr) {\n"
    + "      __ksArr = new Array(cipher.length);\n"
    + "      var __ks = (" + bytecodeKey + " ^ SKEY) >>> 0; if (__ks === 0) __ks = 1;\n"
    + "      for (var __bi = 0; __bi < cipher.length; __bi++) {\n"
    + "        " + ksStepJs("__ks", keystream) + "\n"
    + "        __ksArr[__bi] = __ks & 255;\n"
    + "      }\n"
    + "    }\n"
    + "    return (cipher[idx] ^ __ksArr[idx]) >>> 0;\n"
    + "  }\n"
    + constDecryptLocal + "\n";

  const cacheDecrypt = "if (f.__d !== 1) {\n"
    + "    var __c = f." + fields.b + ";\n"
    + "    if (typeof __c === \"string\") { __c = __b64(__c); f." + fields.b + " = __c; }\n"
    + "    __c = __c.slice();\n"
    + "    var __ks = (" + bytecodeKey + " ^ SKEY) >>> 0; if (__ks === 0) __ks = 1;\n"
    + "    for (var __bi = 0; __bi < __c.length; __bi++) {\n"
    + "      " + ksStepJs("__ks", keystream) + "\n"
    + "      __c[__bi] = (__c[__bi] ^ (__ks & 255)) >>> 0;\n"
    + "    }\n"
    + "    f." + fields.b + " = __c;\n"
    + constDecrypt
    + "    f.__d = 1;\n"
    + "  }\n"
    + "  var code = f." + fields.b + ", consts = f." + fields.c + ";\n"
    + "  var cl = code.length";

  const bodySetup = "var f = " + ftAccessor + "(id);\n"
    + "  " + (decryptMode === "volatile" ? volatileDecrypt : cacheDecrypt) + "\n"
    + "  var ca = [];\n"
    + "  var HD = HPOOL[f." + fields.o + " | 0] || HPOOL[0];\n"
    + "  var locals = new Array(f." + fields.n + ");\n"
    + "  for (var pi = 0; pi < f." + fields.p + "; pi++) locals[pi] = pi < args.length ? args[pi] : undefined;\n"
    + "  if (f." + fields.r + " >= 0) locals[f." + fields.r + "] = Array.prototype.slice.call(args, f." + fields.r + ");\n"
    + "  var stack = [];\n"
    + phantom
    + "  var pc = 0, trys = [], pend = 0;\n"
    + "  var done = 0, retv;\n"
    + "  function rt(v) {\n"
    + "    var fi = trys.length - 1;\n"
    + "    while (fi >= 0 && trys[fi].f === 0) fi--;\n"
    + "    if (fi >= 0) { var tf = trys[fi]; pend = { t: 1, v: v }; stack.length = tf.s; pc = tf.h; trys.length = fi; return; }\n"
    + "    done = 1; retv = v;\n"
    + "  }\n"
    + "  var om = f." + fields.m + " | 0, rk = f." + fields.k + " | 0, enc = rk !== 0, bk = (" + bkExpr + " ^ SKEY) | 0;\n"
    + "  var $G = globalThis;\n"
    + "  var $Mt = $G[\"Math\"];\n"
    + "  var $Ar = $G[\"Array\"];\n"
    + "  var $Ob = $G[\"Object\"];\n"
    + "  var $Fn = $G[\"Function\"];\n"
    + "  function key(idx) { return (rk ^ $Mt.imul(idx + 1, 2654435761) ^ (bk ? (bk ^ $Mt.imul(idx + 7, 2246822519)) : 0)) >>> 0; }\n"
    + "  " + (decryptMode === "volatile" ? volatileNx : cacheNx) + ";";

  const prelude = shuffledDecls.join("\n  ") + "\n  " + hpoolSetup;

  const syncFn = `function ${vmFnName}0(id, self, args, gs, ss, sf) {
  var $G = globalThis;
  var $Mt = $G["Math"];
  var $Ar = $G["Array"];
  var $Ob = $G["Object"];
  var $Fn = $G["Function"];
${prelude}
${bodySetup}
  for (;;) {
    try {
      while (pc < cl) {
        var op = nx();
        HD[op]();
        if (done) return retv;
      }
      return undefined;
    } catch (ex) {
      ${catchLogic(bkExpr)}
    }
  }
}`;

  const asyncFn = `async function ${vmFnName}A(id, self, args, gs, ss, sf) {
  var $G = globalThis;
  var $Mt = $G["Math"];
  var $Ar = $G["Array"];
  var $Ob = $G["Object"];
  var $Fn = $G["Function"];
${prelude}
${bodySetup}
  for (;;) {
    try {
      while (pc < cl) {
        var op = nx();
        var r = HD[op]();
        if (r && typeof r.then === "function") await r;
        if (done) return retv;
      }
      return undefined;
    } catch (ex) {
      ${catchLogic(bkExpr)}
    }
  }
}`;

  // Generator function: returns an iterator object whose next/throw/return call
  // a resumable interpreter (gre). Mutable VM state lives on `it` and persists
  // across resumes. Suspension is via the YIELD sentinel (__g); the current
  // bytecode/consts are decrypted lazily on first use.
const genFn = `function ${vmFnName}G(id, self, args, gs, ss, sf) {
  var $G = globalThis;
  var $Mt = $G["Math"];
  var $Ar = $G["Array"];
  var $Ob = $G["Object"];
  var $Fn = $G["Function"];
  ${guardName ? `if (${guardName} !== 0) return (function*(){})(); ` : ""}
  var f = ${ftAccessor}(id);
  if (f.__d !== 1) {
    var __c = f.${fields.b};
    if (typeof __c === "string") { __c = __b64(__c); f.${fields.b} = __c; }
    __c = __c.slice();
    var __ks = (${bytecodeKey} ^ SKEY) >>> 0; if (__ks === 0) __ks = 1;
    for (var __bi = 0; __bi < __c.length; __bi++) {
      ${ksStepJs("__ks", keystream)}
      __c[__bi] = (__c[__bi] ^ (__ks & 255)) >>> 0;
    }
    f.${fields.b} = __c;
    ${constDecrypt.replace(/\sf\./g, " f.").replace(/__cA = f\./g, "__cA = f.")}
    f.__d = 1;
  }
  var it = {
    pc: 0, stack: [], locals: [], trys: [], pend: 0, uv: void 0,
    throwVal: void 0, done: false, ret: void 0, started: false, gdone: false
  };
  var code = f.${fields.b}, consts = f.${fields.c};
  var cl = code.length, ca = [];
  it.locals = $Ar.prototype.slice.call(args, 0, f.${fields.p});
  if (f.${fields.r} >= 0) it.locals[f.${fields.r}] = $Ar.prototype.slice.call(args, f.${fields.r});
  ${level >= 3 ? "it.stack.push(0, null);" : ""}
  var om = f.${fields.m} | 0, rk = f.${fields.k} | 0, enc = rk !== 0, bk = (${bkExpr} ^ SKEY) | 0;
  function key(idx) { return rk !== 0 ? ( (rk ^ $Mt.imul(idx + 1, 2654435761) ^ ((bk ^ $Mt.imul(idx + 7, 2246822519)) >>> 0)) >>> 0 ) : 0; }
  var its = f;
  function gnx() { var v = code[it.pc]; if (enc) v = (v ^ key(it.pc)) >>> 0; it.pc++; return v; }
  function gnvx() { var v = code[it.pc]; if (enc) v = (v ^ key(it.pc)) >>> 0; else if (om) v = (v ^ om) >>> 0; it.pc++; return v; }
  ${genShuffled.join("\n  ")}
  var GHD = new Array(${tableSize});
  ${genAssignLines.join("\n  ")}
  function gre(kind, val) {
    if (it.done) return { value: void 0, done: true };
    if (it.started) {
      if (kind === 1) { it.stack.push(val); }   // next(arg) -> value for the yield expression
      else if (kind === 2) { it.throwVal = val; } // throw(err) injected at resume
      else if (kind === 3) { it.uv = val; it.done = true; return { value: val, done: true }; }
    }
    it.started = true;
    for (;;) {
      try {
        if (it.throwVal !== void 0) { var tv = it.throwVal; it.throwVal = void 0; throw tv; }
        while (it.pc < cl) {
          var op = gnx();
          GHD[op]();
          if (it.gdone) { it.done = true; return { value: it.ret, done: true }; }
        }
        it.done = true; it.ret = void 0; return { value: void 0, done: true };
      } catch (ex) {
        if (ex && ex.__g === 1 && ex.__k === "${bkKey}gen") {
          it.done = false; return { value: it.uv, done: false };
        }
        // user exception escaped: rethrow after mapping through catch frames
        if (it.trys.length > 0) {
          var tf = it.trys[it.trys.length - 1];
          if (tf.f === 1) {
            it.pend = { t: 2, v: ex };
            it.stack.length = tf.s; it.pc = tf.h; it.trys.length = it.trys.length - 1;
            continue;
          }
          it.trys.pop(); it.pc = tf.h; it.stack.length = tf.s; it.stack.push(ex);
          continue;
        }
        it.done = true; it.ret = ex;
        return { value: ex, done: true, threw: true };
      }
    }
  }
  var gobj = { next: function(v) { return gre(1, v); },
               "return": function(v) { return gre(3, v); },
               "throw": function(e) { var r = gre(2, e); if (r && r.threw) throw r.value; return r; },
               [Symbol.iterator]: function() { return gobj; } };
  return gobj;
}`;

  // Dispatcher: async > generator > sync. (Async generators are rejected at
  // compile time, so `a` and `g` are never both set.) Unused interpreter
  // variants are omitted entirely so their dead code isn't emitted.
  const aTerm = hasAsync ? `ff.${fields.a} ? ${vmFnName}A(id, self, args, gs, ss, sf) : ` : "";
  const gTerm = hasGenerator ? `ff.${fields.g} ? ${vmFnName}G(id, self, args, gs, ss, sf) : ` : "";
  const dispatchFn = `function ${vmFnName}(id, self, args, gs, ss, sf) {
  ${guardName ? `if (${guardName} !== 0) return ${ftAccessor}(id).${fields.a} ? Promise.resolve(undefined) : undefined;` : ""}
  var ff = ${ftAccessor}(id);
  return ${aTerm}${gTerm}${vmFnName}0(id, self, args, gs, ss, sf);
}`;

  return `
var HOLE = {};
${guardName ? `var ${guardName} = 0;` : ""}
function __b64(s) {
  var o = [], buf = 0, bits = 0;
  var A = "${B64_STD}";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === "=") break;
    var v = A.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; o.push((buf >> bits) & 255); }
  }
  return o;
}
function __u8(a) {
  var s = "", i = 0;
  while (i < a.length) {
    var b = a[i++];
    if (b < 0x80) { s += String.fromCharCode(b); }
    else if (b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (a[i++] & 0x3f)); }
    else if (b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((a[i++] & 0x3f) << 6) | (a[i++] & 0x3f)); }
    else {
      var cp = ((b & 7) << 18) | ((a[i++] & 0x3f) << 12) | ((a[i++] & 0x3f) << 6) | (a[i++] & 0x3f);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}
${syncFn}
${hasAsync ? asyncFn : ""}
${hasGenerator ? genFn : ""}
${dispatchFn}
`;}

function catchLogic(bkExpr: string): string {  return `
      if (trys.length > 0) {
        var tf2 = trys[trys.length - 1];
        if (tf2.f === 1) {
          pend = { t: 2, v: ex };
          stack.length = tf2.s;
          pc = tf2.h;
          trys.length = trys.length - 1;
          continue;
        }
        trys.pop();
        pc = tf2.h;
        stack.length = tf2.s;
        stack.push(ex);
        continue;
      }
      throw ex;`;
}

/** Emit the per-build keystream step JS for a state variable name. */
function ksStepJs(v: string, keystream: { shifts: [number, number, number]; order: number }): string {
  const [s1, s2, s3] = keystream.shifts;
  const o = keystream.order;
  if (o === 0) return `${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (o === 1) return `${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}>>>=0;`;
  if (o === 2) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (o === 3) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}>>>=0;`;
  if (o === 4) return `${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}>>>=0;`;
  return `${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}>>>=0;`;
}
