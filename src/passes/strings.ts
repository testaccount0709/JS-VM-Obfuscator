import { traverse, generate } from "../utils/babel.js";
import { parse } from "@babel/parser";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";
import { utf8Encode, toBase64, shuffledAlphabet } from "../utils/codec.js";
import { rtMemberExpr } from "../utils/runtime-api.js";
import { confusingName } from "../utils/names.js";

/**
 * String encryption.
 *  L1: central table + one decode fn (single global key)
 *  L2: per-string derived stream keys
 *  L3: spilling — selected blobs split into fragments scattered through a
 *      synthetic reassembly function (later scattered across CFF blocks),
 *      reassembled + decoded at point of use.
 *
 * Hardening (all levels):
 *  - The blob table is split across 2..4 sub-arrays (`pure` runtime parts, so
 *    the assembler scatters them through the runtime instead of leaving one
 *    contiguous ciphertext array).
 *  - String ids are permuted per build, so dump order reveals nothing.
 *  - Entries use mixed encodings (shuffled-alphabet base64 strings vs raw
 *    keystream-xored numeric arrays), so there is no single uniform ciphertext
 *    shape to grep for.
 *  - Every table is padded with junk entries and spilled slots are replaced by
 *    junk blobs (never decoded), defeating length/`""`-based heuristics.
 *  - The alphabet is stored as keystream-masked char codes, not a string
 *    literal.
 */

export function xorshift32Stream(seed: number, n: number, keystream: { shifts: [number, number, number]; order: number }): number[] {
  let x = seed >>> 0;
  if (x === 0) x = 1;
  const [s1, s2, s3] = keystream.shifts;
  const order = keystream.order;
  const out: number[] = [];
  const applyShifts = (x: number): number => {
    let y = x;
    if (order === 0) {
      y ^= y << s1; y ^= y >>> s2; y ^= y << s3;
    } else if (order === 1) {
      y ^= y << s1; y ^= y << s3; y ^= y >>> s2;
    } else if (order === 2) {
      y ^= y >>> s2; y ^= y << s1; y ^= y << s3;
    } else if (order === 3) {
      y ^= y >>> s2; y ^= y << s3; y ^= y << s1;
    } else if (order === 4) {
      y ^= y << s3; y ^= y << s1; y ^= y >>> s2;
    } else {
      y ^= y << s3; y ^= y >>> s2; y ^= y << s1;
    }
    return y >>> 0;
  };
  for (let i = 0; i < n; i++) {
    x = applyShifts(x);
    out.push(x & 0xff);
  }
  return out;
}

export function streamSeed(globalKey: number, id: number, perString: boolean, nonce = 0): number {
  const raw = perString ? ((globalKey ^ Math.imul(id + 1, 2654435761)) >>> 0) : (globalKey >>> 0);
  return ((raw ^ nonce) >>> 0) || 1;
}

export function encryptString(value: string, seed: number, alphabet: string, keystream: { shifts: [number, number, number]; order: number }): string {
  const bytes = utf8Encode(value);
  const ks = xorshift32Stream(seed, bytes.length, keystream);
  const enc = bytes.map((b, i) => b ^ ks[i]);
  return toBase64(enc, alphabet);
}
function xorshiftStep(x: number, shifts: [number, number, number], order: number): number {
  const [s1, s2, s3] = shifts;
  let y = x;
  if (order === 0) {
    y ^= y << s1; y ^= y >>> s2; y ^= y << s3;
  } else if (order === 1) {
    y ^= y << s1; y ^= y << s3; y ^= y >>> s2;
  } else if (order === 2) {
    y ^= y >>> s2; y ^= y << s1; y ^= y << s3;
  } else if (order === 3) {
    y ^= y >>> s2; y ^= y << s3; y ^= y << s1;
  } else if (order === 4) {
    y ^= y << s3; y ^= y << s1; y ^= y >>> s2;
  } else {
    y ^= y << s3; y ^= y >>> s2; y ^= y << s1;
  }
  return y >>> 0;
}

/** Emit the per-build keystream step JS for a state variable name. */
function ksStepJs(v: string, shifts: [number, number, number], order: number): string {
  const [s1, s2, s3] = shifts;
  if (order === 0) return `${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (order === 1) return `${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}>>>=0;`;
  if (order === 2) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (order === 3) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}>>>=0;`;
  if (order === 4) return `${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}>>>=0;`;
  return `${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}>>>=0;`;
}

function junkBlob(rng: { bytes(n: number): number[]; range(a: number, b: number): number }, alphabet: string): string {
  return toBase64(rng.bytes(rng.range(4, 32)), alphabet);
}

function looksLikeCssOrMarkup(s: string): boolean {
  if (s.length > 200 && (s.includes("@import") || s.includes("@keyframes"))) return true;
  if (s.includes("--md-") || s.includes(".md-")) return true;
  if (s.includes("<") && s.includes(">") && s.includes("class=")) return true;
  return false;
}

function resolveConstString(path: NodePath, expr: t.Expression): string | null {
  if (t.isStringLiteral(expr)) return expr.value;
  if (!t.isIdentifier(expr)) return null;
  const binding = path.scope.getBinding(expr.name);
  if (!binding?.constant) return null;
  if (binding.path.isVariableDeclarator() && t.isStringLiteral(binding.path.node.init)) {
    return binding.path.node.init.value;
  }
  return null;
}

function foldConstantTemplate(path: NodePath<t.TemplateLiteral>): string | null {
  const { quasis, expressions } = path.node;
  let out = "";
  for (let i = 0; i < quasis.length; i++) {
    out += quasis[i].value.cooked ?? "";
    if (i < expressions.length) {
      const v = resolveConstString(path, expressions[i] as t.Expression);
      if (v === null) return null;
      out += v;
    }
  }
  return out;
}

function isDomMarkupAssignment(path: NodePath<t.TemplateLiteral>): boolean {
  let cur: NodePath | null = path.parentPath;
  while (cur) {
    if (cur.isAssignmentExpression()) {
      const left = cur.node.left;
      if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
        const prop = left.property.name;
        if (prop === "textContent" || prop === "innerHTML") return true;
      }
    }
    cur = cur.parentPath;
  }
  return false;
}

export function encryptStrings(ast: t.File, ctx: Context): void {
  const level = ctx.options.strings;
  if (level <= 0) return;

  const order: string[] = [];
  const nonces: number[] = [];
  const noSpillIds = new Set<number>();

  // Each occurrence gets a unique id + a per-site nonce. The nonce is mixed
  // into the per-string key, so a blanket `decode(i)` dump (without the
  // call-site nonce) yields garbage.
  const intern = (value: string, opts?: { noSpill?: boolean }): number => {
    const id = order.length;
    order.push(value);
    nonces.push((ctx.rng.int(0x7ffffffe) + 1) | 0);
    if (opts?.noSpill || looksLikeCssOrMarkup(value)) noSpillIds.add(id);
    return id;
  };

  const decodeCall = (id: number): t.CallExpression =>
    t.callExpression(rtMemberExpr(ctx, "decode"), [t.numericLiteral(id), t.numericLiteral(nonces[id])]);

  const isExcluded = (path: NodePath<t.StringLiteral>): boolean => {
    const parent = path.parentPath?.node;
    if (!parent) return false;
    if (
      (t.isImportDeclaration(parent) || t.isExportNamedDeclaration(parent) || t.isExportAllDeclaration(parent)) &&
      (parent as { source?: unknown }).source === path.node
    ) {
      return true;
    }
    if (t.isImportSpecifier(parent) || t.isImportDefaultSpecifier(parent) || t.isImportNamespaceSpecifier(parent) || t.isExportSpecifier(parent)) {
      return true;
    }
    // Direct-eval sources must stay literal: the rename pass parses them to
    // decide which bindings an eval can see, and encryption would hide that.
    if (
      t.isCallExpression(parent) &&
      t.isIdentifier(parent.callee, { name: "eval" }) &&
      !path.scope.getBinding("eval") &&
      parent.arguments[0] === path.node
    ) {
      return true;
    }
    return false;
  };

  traverse(ast, {
    StringLiteral(path: NodePath<t.StringLiteral>) {
      if (isExcluded(path)) return;
      const parent = path.parentPath?.node;
      if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) {
        if ((parent.key as t.StringLiteral).value === "__proto__") return;
        if (ctx.options.property > 0) return; // property pass handles keys
        const id = intern(path.node.value);
        parent.computed = true;
        parent.key = decodeCall(id);
        ctx.stats.encryptedStrings++;
        return;
      }
      if (t.isObjectMethod(parent) && parent.key === path.node) return;
      if (t.isClassMethod(parent) || t.isClassProperty(parent) || t.isClassPrivateProperty(parent)) return;
      const id = intern(path.node.value);
      path.replaceWith(decodeCall(id));
      ctx.stats.encryptedStrings++;
    },

    TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
      if (path.parentPath?.isTaggedTemplateExpression()) return;

      const markup = isDomMarkupAssignment(path);
      const folded = foldConstantTemplate(path);
      if (folded !== null) {
        const id = intern(folded, { noSpill: true });
        path.replaceWith(decodeCall(id));
        ctx.stats.encryptedStrings++;
        return;
      }

      const parts: t.Expression[] = [];
      const quasis = path.node.quasis;
      const exprs = path.node.expressions;
      for (let i = 0; i < quasis.length; i++) {
        const cooked = quasis[i].value.cooked ?? "";
        if (cooked.length > 0 || i === 0) {
          const id = intern(cooked, { noSpill: markup });
          parts.push(decodeCall(id));
        }
        if (i < exprs.length) {
          const e = exprs[i];
          if (!t.isExpression(e)) return;
          parts.push(t.callExpression(t.identifier("String"), [e]));
        }
      }
      if (parts.length === 0) {
        path.replaceWith(decodeCall(intern("", { noSpill: markup })));
        return;
      }
      let out = parts[0];
      for (let i = 1; i < parts.length; i++) {
        out = t.binaryExpression("+", out, parts[i]);
      }
      path.replaceWith(out);
    },
  });

  const globalKey = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  const alphabet = shuffledAlphabet(ctx.rng);
  const perString = level >= 2;
  const n = order.length;

  // --- per-build id permutation: dump order never matches source order ---
  const perm = ctx.rng.shuffle(Array.from({ length: n }, (_, i) => i)); // perm[origId] = newId
  const inv = new Array<number>(n);
  perm.forEach((newId, origId) => {
    inv[newId] = origId;
  });

  const cipherBytesByNewId: number[][] = new Array(n);
  const b64ByNewId: string[] = new Array(n);
  const rawChoice: boolean[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const i = inv[j];
    const seed = streamSeed(globalKey, j, perString, nonces[i]);
    const bytes = utf8Encode(order[i]);
    const ks = xorshift32Stream(seed, bytes.length, ctx.keystream);
    const enc = bytes.map((b, idx) => b ^ ks[idx]);
    cipherBytesByNewId[j] = enc;
    b64ByNewId[j] = toBase64(enc, alphabet);
    rawChoice[j] = level >= 2 && order[i].length <= 48 && ctx.rng.chance(0.4);
  }

  // --- spill selection ---
  const spillOrigIds = new Set<number>();
  if (level >= 3) {
    for (let i = 0; i < n; i++) {
      if (noSpillIds.has(i)) continue;
      if (order[i].length >= 6 && order[i].length <= 200 && ctx.rng.chance(0.5)) spillOrigIds.add(i);
    }
  }
  const spillNewIds = new Set<number>();
  for (const o of spillOrigIds) spillNewIds.add(perm[o]);

  // --- split blob store into 2..4 sub-arrays with junk padding ---
  const K = ctx.rng.range(2, 4);
  const tables: (string | number[])[][] = Array.from({ length: K }, () => []);
  for (let j = 0; j < n; j++) {
    const tIdx = j % K;
    if (spillNewIds.has(j)) {
      tables[tIdx].push(junkBlob(ctx.rng, alphabet));
    } else if (rawChoice[j]) {
      tables[tIdx].push(cipherBytesByNewId[j]);
    } else {
      tables[tIdx].push(b64ByNewId[j]);
    }
  }
  for (let tIdx = 0; tIdx < K; tIdx++) {
    const extra = ctx.rng.range(1, 4);
    for (let p = 0; p < extra; p++) {
      tables[tIdx].push(ctx.rng.chance(0.5) ? junkBlob(ctx.rng, alphabet) : ctx.rng.bytes(ctx.rng.range(3, 20)));
    }
  }

  // integrity checksum over the FULL blob store (mirrors the runtime check).
  let chk = 0;
  let cnt = 0;
  for (const tb of tables) {
    for (const e of tb) {
      cnt++;
      for (let j = 0; j < e.length; j++) {
        chk = (chk + (typeof e === "string" ? e.charCodeAt(j) : e[j])) | 0;
      }
    }
  }

  // --- runtime part emission ---
  const tableVars = tables.map(() => ctx.freshName("$tb"));
  tables.forEach((tb, tIdx) => {
    const entries = tb
      .map((e) => (typeof e === "string" ? JSON.stringify(e) : "[" + e.join(",") + "]"))
      .join(",");
    ctx.runtime.add(`var ${tableVars[tIdx]} = [${entries}];`, {}, true, true);
  });

  const nT = ctx.freshName("$t");
  const nT1 = ctx.freshName("$t0");
  const nALC = ctx.freshName("$alc");
  const nA = ctx.freshName("$al");
  const nA0 = ctx.freshName("$al0");
  const nB64 = ctx.freshName("$b64");
  const nU8 = ctx.freshName("$u8");
  const nSR = ctx.freshName("$sr");
  const nSF = ctx.freshName("$sf");
  const nD = ctx.freshName("$dec");
  const nGC = ctx.freshName("$gc");
  const nPS = ctx.freshName("$ps");
  const nSD = ctx.freshName("$sd");
  const nDS = ctx.freshName("$ds");

  // alphabet stored as keystream-masked char codes, reconstructed lazily
  const alphabetSeed = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  let ax = alphabetSeed >>> 0;
  const maskedCodes = Array.from(alphabet, (c) => {
    ax = xorshiftStep(ax, ctx.keystream.shifts, ctx.keystream.order);
    return c.codePointAt(0)! ^ (ax & 255);
  });

  const decoderCode = `
var SK = ${(globalKey ^ ctx.sessionKey) >>> 0};
var SC = [];
var AL = "";
var ${nA} = 0;
var ${nALC} = [${maskedCodes.join(",")}];
var ${nT} = 0;
function ${nT1}() {
  if (!${nT}) ${nT} = [${tableVars.join(",")}];
  return ${nT};
}
function ${nA0}() {
  if (${nA}) return;
  ${nA} = 1;
  var x = ${alphabetSeed} >>> 0;
  for (var i = 0; i < ${nALC}.length; i++) {
    ${ksStepJs("x", ctx.keystream.shifts, ctx.keystream.order)}
    AL += String.fromCharCode(${nALC}[i] ^ (x & 255));
  }
}
function ${nB64}(s) {
  ${nA0}();
  var out = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === "=") break;
    var v = AL.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}
function ${nU8}(a) {
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
function ${nSR}(a, seed) {
  var x = seed >>> 0; if (x === 0) x = 1;
  var out = [];
  for (var j = 0; j < a.length; j++) {
    ${ksStepJs("x", ctx.keystream.shifts, ctx.keystream.order)}
    out.push(a[j] ^ (x & 255));
  }
  return out;
}
function ${nSF}(i, n) { var k = (SK ^ SKEY) >>> 0; return ${perString ? "(((k ^ Math.imul(i + 1, 2654435761)) ^ n) >>> 0) || 1" : "((k ^ n) >>> 0) || 1"}; }
function ${nD}(i, n) {
  var c = SC[i];
  if (c !== undefined) return c;
  var e = ${nT1}()[i % ${K}][(i / ${K}) | 0];
  var raw = ${nSR}(typeof e === "string" ? ${nB64}(e) : e, ${nSF}(i, n));
  var s = ${nU8}(raw);
  SC[i] = s;
  return s;
}
function ${nGC}(i) { return SC[i]; }
function ${nPS}(i, s) { SC[i] = s; return s; }
function ${nSD}(a, seed) {
  var x = seed >>> 0; if (x === 0) x = 1;
  var s = "";
  for (var i = 0; i < a.length; i++) {
    ${ksStepJs("x", ctx.keystream.shifts, ctx.keystream.order)}
    s += String.fromCharCode(a[i] ^ (x & 255));
  }
  return s;
}
function ${nDS}(blob, seed) { return ${nU8}(${nSR}(${nB64}(blob), seed)); }`;

  ctx.runtime.add(decoderCode, {
    decode: nD,
    strCacheGet: nGC,
    strCachePut: nPS,
    decodeStream: nDS,
    spillDecode: nSD,
  }, true);
  ctx.runtimeFlags.strings = true;
  ctx.runtimeFlags.skVar = true;
  ctx.runtimeFlags.stringChk = chk >>> 0;
  ctx.runtimeFlags.stringCount = cnt;
  ctx.runtimeFlags.stringTablesName = nT1;

  const decodePub = ctx.runtime.pub("decode");

  // --- spilling ---
  let spillFnCount = 0;
  if (spillNewIds.size > 0) {
    interface SpillData {
      id: number;
      origId: number;
      seedMasked: number;
      fragSeeds: number[];
      encFrags: number[][];
    }
    const spills: SpillData[] = [];
    for (const o of [...spillOrigIds]) {
      const newId = perm[o];
      const realSeed = streamSeed(globalKey, newId, perString, nonces[o]);
      const seedMasked = (realSeed ^ ctx.sessionKey) >>> 0;
      const blob = b64ByNewId[newId];
      const fragCount = Math.min(ctx.rng.range(3, 6), Math.max(2, blob.length));
      const frags: string[] = [];
      let pos = 0;
      for (let f = 0; f < fragCount; f++) {
        const isLast = f === fragCount - 1;
        const len = isLast ? blob.length - pos : Math.max(1, Math.floor(blob.length / fragCount));
        frags.push(blob.slice(pos, pos + len));
        pos += len;
      }
      const fragSeeds = frags.map((_, f) => ((seedMasked ^ Math.imul(f + 1, 2246822519)) >>> 0) || 1);
      const encFrags = frags.map((fr, f) => {
        const bytes = utf8Encode(fr);
        const ks = xorshift32Stream(fragSeeds[f], bytes.length, ctx.keystream);
        return bytes.map((b, idx) => b ^ ks[idx]);
      });
      spills.push({ id: newId, origId: o, seedMasked, fragSeeds, encFrags });
    }

    const nFR = ctx.freshName("$fr");
    const nFRAG = ctx.freshName("$frag");
    const frEntries = spills.map((s) => `${s.id}:${JSON.stringify(s.encFrags)}`).join(",");
    ctx.runtime.add(
      `var ${nFR} = {${frEntries}};
function ${nFRAG}(i, f) { return ${nFR}[i][f]; }`,
      { frag: nFRAG },
      true,
    );

    const nm = () => confusingName(ctx.rng, ctx.usedNames, 2);
    for (const s of spills) {
      const fnName = nm();
      const cacheVar = nm();

      const bodyStmts: t.Statement[] = [];
      bodyStmts.push(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            t.identifier(cacheVar),
            t.callExpression(rtMemberExpr(ctx, "strCacheGet"), [t.numericLiteral(s.id)]),
          ),
        ]),
      );
      bodyStmts.push(
        t.ifStatement(
          t.binaryExpression("!==", t.identifier(cacheVar), t.unaryExpression("void", t.numericLiteral(0))),
          t.blockStatement([t.returnStatement(t.identifier(cacheVar))]),
        ),
      );

      let joined: t.Expression = t.callExpression(rtMemberExpr(ctx, "spillDecode"), [
        t.callExpression(rtMemberExpr(ctx, "frag"), [t.numericLiteral(s.id), t.numericLiteral(0)]),
        t.numericLiteral(s.fragSeeds[0]),
      ]);
      for (let f = 1; f < s.fragSeeds.length; f++) {
        joined = t.binaryExpression("+", joined, t.callExpression(rtMemberExpr(ctx, "spillDecode"), [
          t.callExpression(rtMemberExpr(ctx, "frag"), [t.numericLiteral(s.id), t.numericLiteral(f)]),
          t.numericLiteral(s.fragSeeds[f]),
        ]));
      }

      // masked seed ^ session key == real seed once the program entry ran init
      const realSeedExpr = t.binaryExpression("^", t.numericLiteral(s.seedMasked), t.callExpression(rtMemberExpr(ctx, "sessionKey"), []));
      bodyStmts.push(
        t.returnStatement(
          t.callExpression(rtMemberExpr(ctx, "strCachePut"), [
            t.numericLiteral(s.id),
            t.callExpression(rtMemberExpr(ctx, "decodeStream"), [joined, realSeedExpr]),
          ]),
        ),
      );

      ast.program.body.unshift(t.functionDeclaration(t.identifier(fnName), [], t.blockStatement(bodyStmts)));
      spillFnCount++;

      traverse(ast, {
        CallExpression(path: NodePath<t.CallExpression>) {
          const callee = path.node.callee;
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object, { name: ctx.runtime.binding }) &&
            t.isIdentifier(callee.property, { name: decodePub }) &&
            t.isNumericLiteral(path.node.arguments[0]) &&
            path.node.arguments[0].value === s.origId
          ) {
            path.replaceWith(t.callExpression(t.identifier(fnName), []));
          }
        },
      });
    }
  }

  // --- remap all remaining decode call sites through the id permutation, and
  // inline short strings as self-contained decoders (no central table entry) ---
  if (n > 0) {
    // Pre-pick which short strings get inlined per build (mix: some stay in the
    // table so the layout doesn't become uniform).
    const inlineIds = new Set<number>();
    for (let newId = 0; newId < n; newId++) {
      const oi = inv[newId];
      const len = order[oi].length;
      if (len >= 3 && len <= 10 && !spillNewIds.has(newId) && !noSpillIds.has(oi) && ctx.rng.chance(0.35)) {
        inlineIds.add(newId);
      }
    }
    traverse(ast, {
      CallExpression(path: NodePath<t.CallExpression>) {
        const callee = path.node.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: ctx.runtime.binding }) &&
          t.isIdentifier(callee.property, { name: decodePub }) &&
          t.isNumericLiteral(path.node.arguments[0])
        ) {
          const oldId = path.node.arguments[0].value;
          const newId = perm[oldId];
          if (inlineIds.has(newId)) {
            const oi = inv[newId];
            const nonce = nonces[oi];
            const realSeed = streamSeed(globalKey, newId, perString, nonce);
            const seedMasked = (realSeed ^ ctx.sessionKey) >>> 0;
            const src = inlineDecodeJs(seedMasked, order[oi], ctx.keystream, ctx);
            let expr: t.Expression;
            try {
              const parsed = parse(src, { sourceType: "script" });
              expr = (parsed.program.body[0] as t.ExpressionStatement).expression;
            } catch {
              path.node.arguments[0].value = newId;
              return;
            }
            path.replaceWith(expr);
          } else {
            path.node.arguments[0].value = newId;
          }
        }
      },
    });
  }
  ctx.runtimeFlags.spillFnCount = spillFnCount;
}

/** Compact self-contained decoder: masked code units + per-build keystream. */
function inlineDecodeJs(seedMasked: number, value: string, keystream: { shifts: [number, number, number]; order: number }, ctx: Context): string {
  // session key must come from the runtime public API (SKEY is closure-local)
  const skExpr = generate(
    t.callExpression(rtMemberExpr(ctx, "sessionKey"), []),
    { compact: true },
  ).code;
  // Pre-mask each UTF-16 unit with the keystream at its position; the runtime
  // re-derives the same mask from the seed and XORs it back.
  let maskX = (seedMasked ^ ctx.sessionKey) >>> 0;
  if (maskX === 0) maskX = 1;
  const masked: string[] = [];
  for (let i = 0; i < value.length; i++) {
    maskX = xorshiftStep(maskX, keystream.shifts, keystream.order);
    masked.push(String(value.charCodeAt(i) ^ (maskX & 255)));
  }
  const o: string[] = [];
  for (let i = 0; i < masked.length; i++) o.push("0");
  let js = "(function(){var x=(" + seedMasked + "^" + skExpr + ")>>>0;if(x===0)x=1;var o=[" + o.join(",") + "];";
  for (let i = 0; i < masked.length; i++) {
    js += ksStepJs("x", keystream.shifts, keystream.order);
    js += "o[" + i + "]=" + masked[i] + "^(x&255);";
  }
  js += "return String.fromCharCode.apply(null,o);})()";
  return js;
}

/**
 * Adds the session-key runtime part and injects the program-entry init call.
 * Runs after the string/property passes so it can splice after any spill
 * functions, and before inject-runtime so the runtime IIFE is available when
 * the init call executes.
 */
export function ensureSession(ast: t.File, ctx: Context): void {
  if (ctx.runtimeFlags.session) return;
  ctx.runtimeFlags.session = true;

  // Fixed runtime-local names (SKEY/SETK/GETK) so the string decoder and the
  // property key resolver can reference SKEY across parts; the identifiers pass
  // renames all runtime locals consistently.
  ctx.runtime.add(
    `var SKEY = 0;
function SETK(k) { SKEY = k >>> 0; return k; }
function GETK() { return SKEY >>> 0; }`,
    { initSession: "SETK", sessionKey: "GETK" },
    true,
  );

  const spillCount = (ctx.runtimeFlags.spillFnCount as number) || 0;
  const expr = sessionKeyExpr(ctx);
  const initCall = t.expressionStatement(
    t.callExpression(rtMemberExpr(ctx, "initSession"), [expr]),
  );
  ast.program.body.splice(spillCount, 0, initCall);
}

/**
 * Obfuscated expression that evaluates to the session key.
 *
 * The key `k` is folded through `((k^a)^b)^(a^b)` and then mixed with a
 * runtime-only nonce `r` as a cancelling term `(folded ^ r) ^ r === folded`.
 * The nonce `r` is a runtime value (Date.now()) so `k` is not a statically-
 * foldable constant in the output.
 */
function sessionKeyExpr(ctx: Context): t.Expression {
  const k = ctx.sessionKey;
  const a = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  const b = (ctx.rng.int(0x7ffffffe) + 1) | 0;
  // folded = ((k ^ a) ^ b) ^ (a ^ b)  == k
  const m1 = t.binaryExpression("^", t.numericLiteral(k), t.numericLiteral(a));
  const m2 = t.binaryExpression("^", t.parenthesizedExpression(m1), t.numericLiteral(b));
  const m3 = t.binaryExpression("^", t.numericLiteral(a), t.numericLiteral(b));
  const folded = t.binaryExpression("^", t.parenthesizedExpression(m2), t.parenthesizedExpression(m3));

  // Mix in a runtime nonce that cancels: (folded ^ r) ^ r === folded
  const r = ctx.freshName("$r");
  const nonceExpr = t.callExpression(t.memberExpression(t.identifier("Date"), t.identifier("now")), []);
  const body = t.blockStatement([
    t.variableDeclaration("var", [t.variableDeclarator(t.identifier(r), nonceExpr)]),
    t.returnStatement(
      t.binaryExpression("^",
        t.parenthesizedExpression(t.binaryExpression("^", folded, t.identifier(r))),
        t.identifier(r)),
    ),
  ]);
  return t.callExpression(t.functionExpression(null, [], body), []);
}
