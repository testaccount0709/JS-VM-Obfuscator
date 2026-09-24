import { traverse } from "../utils/babel.js";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";
import type { Context } from "../core/context.js";
import { rtCallExpr, type RuntimeCap } from "../utils/runtime-api.js";

/**
 * Property access obfuscation.
 *
 * Every member read/write/call/in/delete is lowered through runtime helpers
 * keyed by opaque tokens; object-literal keys are scattered to computed keys
 * resolved at runtime. Proxies (L3) wrap only the resolver machinery, never
 * user objects.
 */

interface TokenInfo {
  id: number;
  key: string | number;
}

const COMPOUND_OPS: Record<string, number> = {
  "+=": 0, "-=": 1, "*=": 2, "/=": 3, "%=": 4,
  "<<=": 5, ">>=": 6, ">>>=": 7, "&=": 8, "^=": 9, "|=": 10, "**=": 11,
};

const INTRINSIC_METHODS = new Set(["call", "apply", "bind"]);

function isInt32Key(v: number): boolean {
  return Number.isFinite(v) && Math.floor(v) === v && v >= -2147483648 && v <= 2147483647;
}

export function lowerProperties(ast: t.File, ctx: Context): void {
  const level = ctx.options.property;
  if (level <= 0) return;

  const tokens = new Map<string | number, TokenInfo>();
  const tokenOf = (key: string | number): number => {
    const existing = tokens.get(key);
    if (existing) return existing.id;
    const id = tokens.size;
    tokens.set(key, { id, key });
    return id;
  };

  const keepNative = (tokenId: number, key?: string | number): boolean => {
    if (key !== undefined && typeof key === "string" && INTRINSIC_METHODS.has(key)) return true;
    return level >= 2 && (Math.imul(tokenId + 1, 0x9e3779b1) >>> 0) % 6 === 0;
  };

  /** Member nodes that belong to our own runtime API calls (never lower). */
  const apiNodes = new WeakSet<t.Node>();
  const rtCall = (cap: RuntimeCap, args: t.Expression[]): t.CallExpression => {
    const call = rtCallExpr(ctx, cap, args);
    const callee = call.callee;
    if (t.isMemberExpression(callee)) apiNodes.add(callee);
    return call;
  };

  const isSkippableObject = (node: t.Node): boolean =>
    t.isSuper(node) || t.isMetaProperty(node) || t.isIdentifier(node, { name: "arguments" });

  /** Leave prototype intrinsic access native — required for bind/apply/defineProperty hooks. */
  const isPrototypeIntrinsicAccess = (node: t.MemberExpression): boolean => {
    if (node.computed) return false;
    if (t.isIdentifier(node.property, { name: "prototype" })) {
      return t.isIdentifier(node.object, { name: "Function" })
        || t.isIdentifier(node.object, { name: "Object" })
        || t.isIdentifier(node.object, { name: "Array" })
        || t.isIdentifier(node.object, { name: "Reflect" });
    }
    const obj = node.object;
    if (!t.isMemberExpression(obj) || obj.computed) return false;
    if (!t.isIdentifier(obj.property, { name: "prototype" })) return false;
    return t.isIdentifier(obj.object, { name: "Function" })
      || t.isIdentifier(obj.object, { name: "Object" })
      || t.isIdentifier(obj.object, { name: "Array" })
      || t.isIdentifier(obj.object, { name: "Reflect" });
  };

  const skipMember = (node: t.MemberExpression): boolean =>
    isSkippableObject(node.object) || isPrototypeIntrinsicAccess(node);

  /** Static key of a member expression, if any. */
  const staticKey = (node: t.MemberExpression): string | number | undefined => {
    if (!node.computed) {
      if (t.isIdentifier(node.property)) return node.property.name;
      if (t.isPrivateName(node.property)) return undefined;
      return undefined;
    }
    if (t.isStringLiteral(node.property)) return node.property.value;
    if (t.isNumericLiteral(node.property) && isInt32Key(node.property.value)) return node.property.value;
    return undefined;
  };

  /**
   * Optional-chain rule: a chain with exactly one optional link at the top is
   * lowerable (RO/CO). Deeper optional links short-circuit the whole chain and
   * are left as-is in v1.
   */
  const optionalDepth = (node: t.Node): number => {
    let depth = 0;
    let cur: t.Node = node;
    for (;;) {
      if (t.isMemberExpression(cur)) {
        if (cur.optional) depth++;
        cur = cur.object;
      } else if (t.isCallExpression(cur)) {
        if (cur.optional) depth++;
        cur = cur.callee;
      } else {
        break;
      }
    }
    return depth;
  };
  const chainSafe = (node: t.MemberExpression): boolean => {
    const depth = optionalDepth(node);
    if (depth === 0) return true;
    if (depth === 1 && node.optional) return true; // top link optional only
    return false;
  };

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (apiNodes.has(callee)) return;
      if (t.isMemberExpression(callee) && skipMember(callee)) return;
      if (!chainSafe(callee)) return;
      if (t.isPrivateName(callee.property)) return;

      const key = staticKey(callee);
      if (key !== undefined && keepNative(tokenOf(key), key)) return;
      const argsArr = t.arrayExpression(path.node.arguments as (t.Expression | t.SpreadElement)[]);
      if (path.node.optional) {
        // whole chain short-circuits: a?.b(...) / a?.[k](...)
        const replacement = key === undefined
          ? rtCall("callOptDyn", [callee.object as t.Expression, callee.property as t.Expression, argsArr])
          : rtCall("callOpt", [callee.object as t.Expression, t.numericLiteral(tokenOf(key)), argsArr]);
        path.replaceWith(replacement);
        ctx.stats.loweredPropertyAccesses++;
        return;
      }
      if (callee.optional) {
        // (a?.b)(...) — short-circuit when base or property is nullish
        const replacement = key === undefined
          ? rtCall("callOptDyn", [callee.object as t.Expression, callee.property as t.Expression, argsArr])
          : rtCall("callOpt", [callee.object as t.Expression, t.numericLiteral(tokenOf(key)), argsArr]);
        path.replaceWith(replacement);
        ctx.stats.loweredPropertyAccesses++;
        return;
      }
      const replacement = key === undefined
        ? rtCall("callDyn", [callee.object as t.Expression, callee.property as t.Expression, argsArr])
        : rtCall("call", [callee.object as t.Expression, t.numericLiteral(tokenOf(key)), argsArr]);
      path.replaceWith(replacement);
      ctx.stats.loweredPropertyAccesses++;
    },

    NewExpression(path: NodePath<t.NewExpression>) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (t.isMemberExpression(callee) && skipMember(callee)) return;
      if (t.isPrivateName(callee.property)) return;
      if (optionalDepth(callee) > 0) return;
      const key = staticKey(callee);
      const argsArr = t.arrayExpression(path.node.arguments as (t.Expression | t.SpreadElement)[]);
      const replacement = key === undefined
        ? rtCall("newDyn", [callee.object as t.Expression, callee.property as t.Expression, argsArr])
        : rtCall("newOp", [callee.object as t.Expression, t.numericLiteral(tokenOf(key)), argsArr]);
      path.replaceWith(replacement);
      ctx.stats.loweredPropertyAccesses++;
    },

    BinaryExpression(path: NodePath<t.BinaryExpression>) {
      if (path.node.operator !== "in") return;
      const left = path.node.left;
      let key: string | number | undefined;
      if (t.isStringLiteral(left)) key = left.value;
      else if (t.isNumericLiteral(left) && isInt32Key(left.value)) key = left.value;
      else return;
      const right = path.node.right;
      if (!t.isExpression(right) || isSkippableObject(right)) return;
      if (keepNative(tokenOf(key), key)) return;
      path.replaceWith(rtCall("has", [right, t.numericLiteral(tokenOf(key))]));
      ctx.stats.loweredPropertyAccesses++;
    },

    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      if (path.node.operator !== "delete") return;
      const arg = path.node.argument;
      if (!t.isMemberExpression(arg)) return;
      if (skipMember(arg)) return;
      if (optionalDepth(arg) > 0) return;
      const key = staticKey(arg);
      const replacement = key === undefined
        ? rtCall("delDyn", [arg.object as t.Expression, arg.property as t.Expression])
        : rtCall("del", [arg.object as t.Expression, t.numericLiteral(tokenOf(key))]);
      path.replaceWith(replacement);
      ctx.stats.loweredPropertyAccesses++;
    },

    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      const arg = path.node.argument;
      if (!t.isMemberExpression(arg)) return;
      if (skipMember(arg)) return;
      if (optionalDepth(arg) > 0) return;
      const key = staticKey(arg);
      if (key === undefined) return;
      const delta = path.node.operator === "++" ? 1 : -1;
      const cap: RuntimeCap = path.node.prefix ? "upPost" : "up";
      if (keepNative(tokenOf(key), key)) return;
      path.replaceWith(
        rtCall(cap, [arg.object as t.Expression, t.numericLiteral(tokenOf(key)), t.numericLiteral(delta)]),
      );
      ctx.stats.loweredPropertyAccesses++;
    },

    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      const left = path.node.left;
      if (!t.isMemberExpression(left)) return;
      if (skipMember(left)) return;
      if (optionalDepth(left) > 0) return;
      const key = staticKey(left);
      if (key === undefined) return;
      if (keepNative(tokenOf(key), key)) return;
      if (path.node.operator === "=") {
        const replacement = key === undefined
          ? rtCall("writeDyn", [left.object as t.Expression, left.property as t.Expression, path.node.right])
          : rtCall("write", [left.object as t.Expression, t.numericLiteral(tokenOf(key)), path.node.right]);
        path.replaceWith(replacement);
        ctx.stats.loweredPropertyAccesses++;
        return;
      }
      const opIdx = COMPOUND_OPS[path.node.operator];
      if (opIdx === undefined || key === undefined) return;
      path.replaceWith(
        rtCall("writeAssign", [left.object as t.Expression, t.numericLiteral(tokenOf(key)), t.numericLiteral(opIdx), path.node.right]),
      );
      ctx.stats.loweredPropertyAccesses++;
    },

    MemberExpression(path: NodePath<t.MemberExpression>) {
      const node = path.node;
      if (apiNodes.has(node)) return;
      if (skipMember(node)) return;
      if (t.isPrivateName(node.property)) return;
      if (!chainSafe(node)) return;
      // tagged-template tag: lowering would change `this` binding of the tag fn
      if (path.parentPath?.isTaggedTemplateExpression() && path.parentPath.node.tag === node) return;
      // parent handlers own these contexts (assignment targets, delete, in, call callee, new callee)
      const parent = path.parentPath;
      if (parent?.isAssignmentExpression() && parent.node.left === node) return;
      if (parent?.isUpdateExpression() && parent.node.argument === node) return;
      if (parent?.isUnaryExpression() && parent.node.operator === "delete" && parent.node.argument === node) return;
      if (parent?.isBinaryExpression() && parent.node.operator === "in" && parent.node.right === node) return;
      if (parent?.isNewExpression() && parent.node.callee === node) return;
      if (parent?.isCallExpression() && parent.node.callee === node) return;
      const key = staticKey(node);
      if (key !== undefined && keepNative(tokenOf(key), key)) return;
      let replacement: t.Expression;
      if (key === undefined) {
        replacement = rtCall("readDyn", [node.object as t.Expression, node.property as t.Expression]);
      } else if (node.optional) {
        replacement = rtCall("readOpt", [node.object as t.Expression, t.numericLiteral(tokenOf(key))]);
      } else {
        replacement = rtCall("read", [node.object as t.Expression, t.numericLiteral(tokenOf(key))]);
      }
      path.replaceWith(replacement);
      ctx.stats.loweredPropertyAccesses++;
    },

    ObjectProperty(path: NodePath<t.ObjectProperty>) {
      const node = path.node;
      if (node.computed) {
        if (t.isStringLiteral(node.key)) {
          if (node.key.value === "__proto__") return;
          node.key = rtCall("keyResolve", [t.numericLiteral(tokenOf(node.key.value))]);
          ctx.stats.loweredPropertyAccesses++;
        } else if (t.isNumericLiteral(node.key) && isInt32Key(node.key.value)) {
          node.key = rtCall("keyResolve", [t.numericLiteral(tokenOf(node.key.value))]);
          ctx.stats.loweredPropertyAccesses++;
        }
        return;
      }
      let key: string | number | undefined;
      if (t.isIdentifier(node.key)) key = node.key.name;
      else if (t.isStringLiteral(node.key)) key = node.key.value;
      else if (t.isNumericLiteral(node.key) && isInt32Key(node.key.value)) key = node.key.value;
      else return;
      if (key === undefined) return;
      if (key === "__proto__") return;
      if (node.shorthand) node.shorthand = false;
      node.computed = true;
      node.key = rtCall("keyResolve", [t.numericLiteral(tokenOf(key))]);
      ctx.stats.loweredPropertyAccesses++;
    },

    ObjectMethod(path: NodePath<t.ObjectMethod>) {
      const node = path.node;
      if (node.computed) return;
      let key: string | number | undefined;
      if (t.isIdentifier(node.key)) key = node.key.name;
      else if (t.isStringLiteral(node.key)) key = node.key.value;
      else if (t.isNumericLiteral(node.key) && isInt32Key(node.key.value)) key = node.key.value;
      else return;
      if (key === undefined) return;
      if (key === "__proto__") return;
      node.computed = true;
      node.key = rtCall("keyResolve", [t.numericLiteral(tokenOf(key))]);
      ctx.stats.loweredPropertyAccesses++;
    },
  });

  emitPropertyRuntime(ctx, level, [...tokens.values()]);
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

function encodeKey(key: string | number, kk: number, shifts: [number, number, number], order: number): { data: string; numeric: boolean } {
  if (typeof key === "number") {
    return { data: String((key | 0) ^ kk), numeric: true };
  }
  const codes = Array.from(key).map((c) => c.codePointAt(0)!);
  let x = kk >>> 0;
  const out: number[] = [];
  for (const c of codes) {
    x = xorshiftStep(x, shifts, order);
    out.push(c ^ (x & 0xff));
  }
  return { data: JSON.stringify(out), numeric: false };
}

function emitPropertyRuntime(ctx: Context, level: number, tokens: TokenInfo[]): void {
  const rng = ctx.rng;
  // Real key used to encode the table; the runtime resolves keys with
  // (kkMasked ^ SKEY), so keyResolve(t) only works after the program entry set
  // the session key (runtime is not self-sufficient).
  const kkReal = (rng.int(0x7ffffffe) + 1) | 0;
  const kkMasked = (kkReal ^ ctx.sessionKey) >>> 0;
  const streamStepJs = ksStepJs("x", ctx.keystream.shifts, ctx.keystream.order);

  const nKT = "kt" + rng.int(1e6);
  const nRK = "rk" + rng.int(1e6);
  const nRC = "rc" + rng.int(1e6);
  const nR = ctx.freshName("$pr");
  const nW = ctx.freshName("$pw");
  const nH = ctx.freshName("$ph");
  const nX = ctx.freshName("$px");
  const nC = ctx.freshName("$pc");
  const nN = ctx.freshName("$pn");
  const nU = ctx.freshName("$pu");
  const nUP = ctx.freshName("$pup");
  const nWA = ctx.freshName("$pwa");
  const nRO = ctx.freshName("$pro");
  const nCO = ctx.freshName("$pco");
  const nRD = ctx.freshName("$prd");
  const nWD = ctx.freshName("$pwd");
  const nCD = ctx.freshName("$pcd");
  const nND = ctx.freshName("$pnd");
  const nXD = ctx.freshName("$pxd");
  const nCDO = ctx.freshName("$pcdo");
  const nK = ctx.freshName("$pk");

  // Intrinsics: capture globals via globalThis with obfuscated keys so they
  // cannot be found by static grep and the identifiers pass renames the locals.
  const nG = ctx.freshName("$g");
  const nRf = ctx.freshName("$rf"); // Reflect
  const nOb = ctx.freshName("$ob"); // Object
  const nAr = ctx.freshName("$ar"); // Array
  const nPx = ctx.freshName("$px"); // Proxy
  const nSy = ctx.freshName("$sy"); // Symbol
  const nMt = ctx.freshName("$mt"); // Math
  const nJs = ctx.freshName("$js"); // JSON
  const nSt = ctx.freshName("$st"); // String
  const nFn = ctx.freshName("$fn"); // Function
  const nObProto = ctx.freshName("$op"); // Object.prototype
  const nObHas = ctx.freshName("$oh"); // Object.prototype.hasOwnProperty
  const nObGpd = ctx.freshName("$og"); // Object.getOwnPropertyDescriptor
  const nObIse = ctx.freshName("$oi"); // Object.isExtensible
  const nObCr = ctx.freshName("$oc"); // Object.create
  const nObGpo = ctx.freshName("$opg"); // Object.getPrototypeOf
  const nArIs = ctx.freshName("$ai"); // Array.isArray
  const nRfC = ctx.freshName("$rc"); // Reflect.construct
  const nAp = ctx.freshName("$ap"); // Function.prototype.apply captured at bootstrap
  const nRfH = ctx.freshName("$rh"); // Reflect.has
  const nRfO = ctx.freshName("$ro"); // Reflect.ownKeys
  const nRfG = ctx.freshName("$rg"); // Reflect.getPrototypeOf
  const nPxC = ctx.freshName("$pxc"); // Proxy.constructor (Proxy itself)

  const intrinsics = `
var ${nG} = globalThis;
var ${nRf} = ${nG}["Reflect"];
var ${nOb} = ${nG}["Object"];
var ${nAr} = ${nG}["Array"];
var ${nPx} = ${nG}["Proxy"];
var ${nSy} = ${nG}["Symbol"];
var ${nMt} = ${nG}["Math"];
var ${nJs} = ${nG}["JSON"];
var ${nSt} = ${nG}["String"];
var ${nFn} = ${nG}["Function"];
var ${nAp} = ${nFn}.prototype.apply;
var ${nObProto} = ${nOb}.prototype;
var ${nObHas} = ${nObProto}.hasOwnProperty;
var ${nObGpd} = ${nOb}.getOwnPropertyDescriptor;
var ${nObIse} = ${nOb}.isExtensible;
var ${nObCr} = ${nOb}.create;
var ${nObGpo} = ${nOb}.getPrototypeOf;
var ${nArIs} = ${nAr}.isArray;
var ${nRfC} = ${nRf}.construct;
var ${nRfH} = ${nRf}.has;
var ${nRfO} = ${nRf}.ownKeys;
var ${nRfG} = ${nRf}.getPrototypeOf;
var ${nPxC} = ${nPx};
`;

  let storeDecl: string;
  let resolveExpr: string;
  const boxes: { token: number; extra: number; q: number }[] = [];
  const extraEntries = new Map<number, string>();
  let depth = 1;
  let layers: string[] = [];

  if (level === 1) {
    const entries = tokens.map((ti) => encodeKey(ti.key, kkReal, ctx.keystream.shifts, ctx.keystream.order).data);
    storeDecl = `var ${nKT} = [${entries.join(",")}];`;
    resolveExpr = `${nKT}[t]`;
  } else {
    depth = rng.range(2, 4);
    layers = [];
    for (let i = 0; i < depth; i++) layers.push("pl" + i + "_" + rng.int(1e6));
    // vary the base container: Object.create(null) vs plain object literal, so
    // the key store does not always carry the Object.create(null) fingerprint
    const baseCtor = rng.chance(0.5) ? `${nObCr}(null)` : "{}";
    let decl = `var ${layers[0]} = ${baseCtor};`;
    for (let i = 1; i < depth; i++) decl += `var ${layers[i]} = ${nObCr}(${layers[i - 1]});`;

    const assignments: string[] = [];
    let extraCounter = 0;
    for (const ti of tokens) {
      const enc = encodeKey(ti.key, kkReal, ctx.keystream.shifts, ctx.keystream.order);
      let stored = enc.data;
      if (level >= 3 && rng.chance(0.3) && !enc.numeric) {
        const q = (rng.int(0x7ffffffe) + 1) | 0;
        const extraIdx = tokens.length + extraCounter++;
        const arr = JSON.parse(enc.data) as number[];
        let x = q >>> 0;
        const xored = arr.map((b) => {
          x = xorshiftStep(x, ctx.keystream.shifts, ctx.keystream.order);
          return b ^ (x & 0xff);
        });
        extraEntries.set(extraIdx, JSON.stringify(xored));
        boxes.push({ token: ti.id, extra: extraIdx, q });
        stored = rng.chance(0.5) ? `{p:${extraIdx},q:${q}}` : `[${extraIdx},${q},[]]`;
      }
      const lvl = level >= 3 ? ti.id % depth : rng.int(depth);
      assignments.push(`${layers[lvl]}[${ti.id}] = ${stored};`);
    }
    for (const [idx, data] of [...extraEntries.entries()].sort((a, b) => a[0] - b[0])) {
      assignments.push(`${layers[rng.int(depth)]}[${idx}] = ${data};`);
    }
    storeDecl = decl + assignments.join("");
    resolveExpr = `${layers[depth - 1]}[t]`;
  }

  let proxyDecl = "";
  if (level >= 3) {
    const nNC = "nc" + rng.int(1e6);
    const nR = "rs" + rng.int(1e6);
    const nB = "bx" + rng.int(1e6);
    const nCache = "cx" + rng.int(1e6);
    const proxyNames: string[] = [];
    for (let i = 0; i < depth; i++) proxyNames.push("px" + i + "_" + rng.int(1e6));
    const topName = proxyNames[depth - 1];
    // The get trap would otherwise walk the prototype chain on *every* property
    // access. A per-token cache (${nCache}) memoizes the resolved box so the
    // chain walk + box decode runs once per token, slashing Proxy overhead.
    const traps = `get: function(t, k) {
    ${nNC} = (${nNC} + 1) | 0;
    if (${nObHas}.call(${nCache}, k)) return ${nCache}[k];
    var ${topName}__r = ${nB}(${nR}(t, k), ${topName});
    ${nCache}[k] = ${topName}__r;
    return ${topName}__r;
  }, has: function(t, k) { return ${nRfH}(t, k); }, ownKeys: function(t) { return ${nRfO}(t); }, getPrototypeOf: function(t) { return ${nRfG}(t); }`;
    // Vary Proxy construction so `new Proxy` is not a uniform greppable anchor
    const useReflectConstruct = rng.chance(0.5);
    const mkProxy = (n: string, layer: string) =>
      useReflectConstruct ? `var ${n} = ${nRfC}(${nPxC}, [${layer}, { ${traps} }]);` : `var ${n} = new ${nPxC}(${layer}, { ${traps} });`;
    const proxies = proxyNames.map((n, i) => mkProxy(n, layers[i])).join("\n");
    proxyDecl = `var ${nNC} = 0;
var ${nCache} = ${nObCr}(null);
function ${nR}(o, k) {
  var cur = o, v;
  for (;;) {
    if (cur === null || cur === void 0) return void 0;
    if (${nObHas}.call(cur, k)) { v = cur[k]; break; }
    cur = ${nObGpo}(cur);
  }
  return v;
}
function ${nB}(v, p) {
  var g = 0, ei, q;
  while (v && typeof v === "object") {
    if (${nArIs}(v) && v.length === 3 && ${nArIs}(v[2])) { ei = v[0]; q = v[1]; }
    else if (typeof v.p === "number" && typeof v.q === "number") { ei = v.p; q = v.q; }
    else break;
    var inner = p[ei];
    if (typeof inner === "object" && inner !== null) {
      var x = q >>> 0, s = [];
      for (var i = 0; i < inner.length; i++) {
        ${streamStepJs}
        s.push(inner[i] ^ (x & 0xff));
      }
      inner = s;
    }
    v = inner;
    if (++g > 8) break;
  }
  return v;
}
${proxies}`;
    resolveExpr = `${topName}[t]`;
  }

  const decodeFn = `
var ${nRC} = [];
function ${nRK}(t) {
  var c = ${nRC}[t];
  if (c !== undefined) return c;
  var e = ${resolveExpr};
  var s;
  if (typeof e === "number") { s = e ^ (${kkMasked} ^ SKEY); }
  else {
    var x = (${kkMasked} ^ SKEY) >>> 0;
    s = "";
    for (var i = 0; i < e.length; i++) {
      ${streamStepJs}
      s += ${nSt}.fromCharCode(e[i] ^ (x & 0xff));
    }
  }
  ${nRC}[t] = s;
  return s;
}`;

  const invoke = (fnVar: string, baseVar: string, argsVar: string) =>
    `if(typeof ${fnVar}!=="function")throw new TypeError(${fnVar}+ " is not a function");return ${nAp}.call(${fnVar},${baseVar},${argsVar});`;

  const helpers = `
function ${nR}(b, t) { return b[${nRK}(t)]; }
function ${nW}(b, t, v) { b[${nRK}(t)] = v; return v; }
function ${nH}(b, t) { return ${nRK}(t) in b; }
function ${nX}(b, t) { return delete b[${nRK}(t)]; }
function ${nC}(b, t, a) { var fn = b[${nRK}(t)]; ${invoke("fn", "b", "a")} }
function ${nN}(b, t, a) { return ${nRfC}(b[${nRK}(t)], a); }
function ${nU}(b, t, d) { var k = ${nRK}(t), v = b[k] + d; b[k] = v; return v - d; }
function ${nUP}(b, t, d) { var k = ${nRK}(t), v = b[k] + d; b[k] = v; return v; }
function ${nWA}(b, t, o, v) {
  var k = ${nRK}(t);
  switch (o) {
    case 0: b[k] += v; break; case 1: b[k] -= v; break; case 2: b[k] *= v; break;
    case 3: b[k] /= v; break; case 4: b[k] %= v; break; case 5: b[k] <<= v; break;
    case 6: b[k] >>= v; break; case 7: b[k] >>>= v; break; case 8: b[k] &= v; break;
    case 9: b[k] ^= v; break; case 10: b[k] |= v; break; case 11: b[k] **= v; break;
  }
  return b[k];
}
function ${nRO}(b, t) { return b == null ? undefined : b[${nRK}(t)]; }
function ${nCO}(b, t, a) { if (b == null) return undefined; var fn = b[${nRK}(t)]; if (fn == null) return undefined; ${invoke("fn", "b", "a")} }
function ${nRD}(b, k) { return b[k]; }
function ${nWD}(b, k, v) { b[k] = v; return v; }
function ${nCD}(b, k, a) { var fn = b[k]; ${invoke("fn", "b", "a")} }
function ${nND}(b, k, a) { return ${nRfC}(b[k], a); }
function ${nXD}(b, k) { return delete b[k]; }
function ${nCDO}(b, k, a) { if (b == null) return undefined; var fn = b[k]; if (fn == null) return undefined; ${invoke("fn", "b", "a")} }
function ${nK}(t) { return ${nRK}(t); }`;

  void boxes;
  const code = `${intrinsics}${storeDecl}${proxyDecl}${decodeFn}${helpers}`;
  ctx.runtime.add(code, {
    read: nR,
    write: nW,
    has: nH,
    del: nX,
    call: nC,
    newOp: nN,
    up: nU,
    upPost: nUP,
    writeAssign: nWA,
    readOpt: nRO,
    callOpt: nCO,
    readDyn: nRD,
    writeDyn: nWD,
    callDyn: nCD,
    newDyn: nND,
    delDyn: nXD,
    callOptDyn: nCDO,
    keyResolve: nK,
  });
}
