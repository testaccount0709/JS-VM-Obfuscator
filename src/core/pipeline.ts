import { parse } from "@babel/parser";
import { traverse, generate } from "../utils/babel.js";
import * as t from "@babel/types";
import type { Options } from "./config.js";
import { Context, isRuntimePath } from "./context.js";
import { analyzeScopes } from "../passes/scope-analysis.js";
import { liftNestedFunctions } from "../passes/lift-nested-functions.js";
import { extractObjects } from "../passes/extract-objects.js";
import { encodeNumbers } from "../passes/numbers.js";
import { lowerProperties } from "../passes/property.js";
import { lowerRegex } from "../passes/regex.js";
import { encryptStrings, ensureSession } from "../passes/strings.js";
import { flattenControlFlow, flattenRuntimeFunctions } from "../passes/cff.js";
import { virtualizeFunctions } from "../vm/embed.js";
import { injectAntiDebug } from "../passes/antidebug.js";
import { renameIdentifiers } from "../passes/identifiers.js";
import { injectDeadCode } from "../passes/deadcode.js";
import { scatterFunctions } from "../passes/scatter.js";
import { reshapeFunctions } from "../passes/reshape.js";
import { factoryFunctions } from "../passes/runtime-factory.js";
import { shannonEntropy } from "../utils/entropy.js";

export interface ObfuscateResult {
  code: string;
  stats: Context["stats"];
}

export { isRuntimePath };

/** Pipeline stages in execution order (keys are stored as `time_<stage>` in stats). */
export const PIPELINE_STAGES = [
  "parse",
  "lift-nested",
  "scope-analysis",
  "extract-objects",
  "numbers",
  "property",
  "regex",
  "strings",
  "session",
  "reshape",
  "scatter",
  "cff",
  "vm",
  "antidebug",
  "inject-runtime",
  "runtime-cff",
  "deadcode",
  "rfactory",
  "identifiers",
  "generate",
] as const;

export function stageTimings(stats: Context["stats"]): { stage: string; ms: number }[] {
  const seen = new Set<string>();
  const out: { stage: string; ms: number }[] = [];
  for (const stage of PIPELINE_STAGES) {
    const ms = stats["time_" + stage];
    if (typeof ms === "number" && ms > 0) {
      out.push({ stage, ms });
      seen.add(stage);
    }
  }
  for (const [k, v] of Object.entries(stats)) {
    if (!k.startsWith("time_") || typeof v !== "number" || v <= 0) continue;
    const stage = k.slice(5);
    if (!seen.has(stage)) out.push({ stage, ms: v });
  }
  return out;
}

export function obfuscate(source: string, options: Options): ObfuscateResult {
  const ctx = new Context(options);
  ctx.stats.inputSize = source.length;

  const ast = ctx.time("parse", () => parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: false,
  }));

  ctx.time("lift-nested", () => liftNestedFunctions(ast, ctx));
  const info = ctx.time("scope-analysis", () => analyzeScopes(ast, ctx));

  if (options.pack !== "off" && ctx.sourceFormat === "esm") {
    throw new Error("packing ESM output is not supported; bundle to CJS/IIFE first");
  }

  ctx.time("extract-objects", () => extractObjects(ast, ctx));
  ctx.time("numbers", () => encodeNumbers(ast, ctx));
  ctx.time("property", () => lowerProperties(ast, ctx));
  ctx.time("regex", () => lowerRegex(ast, ctx));
  ctx.time("strings", () => encryptStrings(ast, ctx));
  ctx.time("session", () => ensureSession(ast, ctx));
  ctx.time("reshape", () => reshapeFunctions(ast, ctx, info));
  ctx.time("scatter", () => scatterFunctions(ast, ctx, info));
  ctx.time("cff", () => flattenControlFlow(ast, ctx));
  ctx.time("vm", () => virtualizeFunctions(ast, ctx));
  ctx.time("antidebug", () => injectAntiDebug(ctx));
  ctx.time("inject-runtime", () => injectRuntime(ast, ctx));
  ctx.time("runtime-cff", () => flattenRuntimeFunctions(ast, ctx));
  ctx.time("deadcode", () => injectDeadCode(ast, ctx));
  ctx.time("rfactory", () => factoryFunctions(ast, ctx));
  // Renaming runs LAST so bindings introduced by the structural passes (spill
  // functions, factory rewrites, scatter clones, CFF state) are renamed too.
  ctx.time("identifiers", () => renameIdentifiers(ast, ctx, info));

  const output = ctx.time("generate", () => generate(ast, {
    compact: options.camouflage,
    comments: false,
    concise: false,
  }));
  let code = output.code;

  if (options.camouflage) {
    code = camouflageBanner(ctx) + code;
  }

  ctx.stats.outputSize = code.length;
  ctx.stats.entropy = Math.round(shannonEntropy(code) * 1000) / 1000;
  return { code, stats: ctx.stats };
}

function injectRuntime(ast: t.File, ctx: Context): void {
  if (!ctx.runtime.hasParts) return;
  const { dataParts, iife } = ctx.runtime.assemble();
  const iifeAst = parse(iife, { sourceType: "script" });
  const iifeStmt = iifeAst.program.body[0];
  const dataStmtBlocks: t.Statement[][] = dataParts.map((p) => {
    const dAst = parse(p, { sourceType: "script" });
    return dAst.program.body;
  });

  // mark all nodes so later passes can skip the runtime subtree where needed
  const allStmts = [...dataStmtBlocks.flat(), iifeStmt];
  traverse(t.file(t.program(allStmts)), {
    enter(path: import("@babel/traverse").NodePath) {
      ctx.runtimeNodes.add(path.node);
    },
  });

  const body = ast.program.body;
  // Leading directives (e.g. "use strict") must stay at the very top.
  let d = 0;
  while (d < body.length && t.isDirective(body[d])) d++;
  // The session-init call (and spill-function declarations) are injected by
  // ensureSession at position `spillFnCount`; the runtime IIFE must execute
  // BEFORE that init call, and every data initializer before the IIFE's
  // load-time checks. So: scatter data blocks at positions <= spillFnCount,
  // then insert the IIFE right after the last data statement (which is
  // exactly spillFnCount + totalInserted — all earlier data and the init
  // shift right by totalInserted).
  const spillCount = Math.max(d, (ctx.runtimeFlags.spillFnCount as number) || 0);

  let totalInserted = 0;
  for (const block of dataStmtBlocks) {
    let pos = ctx.rng.range(d, spillCount);
    for (const st of block) {
      body.splice(pos, 0, st);
      pos++;
    }
    totalInserted += block.length;
  }
  if (iifeStmt) {
    body.splice(spillCount + totalInserted, 0, iifeStmt);
  }
}

const BANNERS = [
  "/*! For license information please see vendor.bundle.js.LICENSE.txt */",
  "/*!\n * core-js polyfill runtime\n * (c) 2014-2024 Denis Pushkarev\n * Released under the MIT license.\n */",
  "/*! webpack runtime chunk — do not edit */",
  "/* Bundled and minified for production. */",
];

function camouflageBanner(ctx: Context): string {
  return ctx.rng.pick(BANNERS) + "\n";
}
