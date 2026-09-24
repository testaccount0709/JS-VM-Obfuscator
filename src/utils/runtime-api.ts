import * as t from "@babel/types";
import type { Context } from "../core/context.js";

/** Stable capability keys used across obfuscation passes. */
export type RuntimeCap =
  | "decode"
  | "strCacheGet"
  | "strCachePut"
  | "decodeStream"
  | "read"
  | "write"
  | "has"
  | "del"
  | "call"
  | "newOp"
  | "upPost"
  | "up"
  | "writeAssign"
  | "readOpt"
  | "callOpt"
  | "readDyn"
  | "writeDyn"
  | "callDyn"
  | "newDyn"
  | "delDyn"
  | "callOptDyn"
  | "keyResolve"
  | "spillDecode"
  | "frag"
  | "initSession"
  | "sessionKey"
  | "vmRun";

export function rtMemberExpr(ctx: Context, cap: RuntimeCap): t.MemberExpression {
  return t.memberExpression(t.identifier(ctx.runtime.binding), t.identifier(ctx.runtime.pub(cap)));
}

export function rtCallExpr(ctx: Context, cap: RuntimeCap, args: t.Expression[]): t.CallExpression {
  return t.callExpression(rtMemberExpr(ctx, cap), args);
}
