import type { Node } from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { RNG } from "../utils/rng.js";
import type { Options } from "./config.js";
import type { RuntimeCap } from "../utils/runtime-api.js";
import { confusingName } from "../utils/names.js";
import { randomKeystream } from "../utils/codec.js";
import type { KeystreamLike } from "../utils/codec.js";

export interface RuntimePart {
  /** Local declarations placed inside the runtime IIFE body. */
  code: string;
  /** capability -> local function/var name inside the IIFE */
  exports: Partial<Record<RuntimeCap, string>>;
  /**
   * Pure data/declarations only (var/function decls, self-contained data
   * initializers). Pure parts are safe to reorder among themselves, so the
   * assembler shuffles them to scatter recognizable data tables (string blobs,
   * key stores) across the runtime instead of leaving them in one block.
   * Impure parts (top-level executable statements such as anti-debug probes)
   * are always appended after every pure part so their effects run after all
   * data initializers.
   */
  pure?: boolean;
  /**
   * Self-contained DATA initializers only (arrays/objects built from literals,
   * no function references). These are emitted as program-level statements
   * interleaved with the surrounding code (runtime scattering) instead of being
   * hidden inside the runtime IIFE, so there is no single contiguous
   * "runtime block" at the top of the file.
   */
  data?: boolean;
}

/**
 * Accumulates runtime source fragments contributed by passes and assembles them
 * into a single IIFE assigned to the runtime binding. The runtime is injected
 * into the program AST late in the pipeline so the identifiers pass renames its
 * internals for free (dogfooding).
 */
export class RuntimeBuilder {
  private parts: RuntimePart[] = [];
  private publicByCap = new Map<RuntimeCap, string>();
  private localByCap = new Map<RuntimeCap, string>();
  private takenPublic = new Set<string>();
  /**
   * Binding name used by transformed code. Randomized per build so the runtime
   * never carries a stable greppable identifier even when program-scope
   * renaming is blocked (direct eval / with).
   */
  readonly binding: string;

  constructor(private rng: RNG) {
    this.binding = confusingName(rng, new Set<string>(), 2);
  }

  /** Per-build randomized export property name for a capability. */
  pub(cap: RuntimeCap): string {
    let name = this.publicByCap.get(cap);
    if (!name) {
      name = confusingName(this.rng, this.takenPublic, 2);
      this.publicByCap.set(cap, name);
    }
    return name;
  }

  /** All public export property names (for rename-exclusion). */
  publicNames(): IterableIterator<string> {
    return this.publicByCap.values();
  }

  add(code: string, exports: Partial<Record<RuntimeCap, string>>, pure?: boolean, data?: boolean): void {
    for (const [cap, local] of Object.entries(exports) as [RuntimeCap, string][]) {
      if (!this.localByCap.has(cap)) this.localByCap.set(cap, local);
    }
    this.parts.push({ code, exports, pure, data });
  }

  get hasParts(): boolean {
    return this.parts.length > 0;
  }

  /** Assemble the runtime: returns scattered program-level data blocks + the IIFE. */
  assemble(): { dataParts: string[]; iife: string } {
    const exportEntries: string[] = [];
    const seen = new Set<RuntimeCap>();
    for (const p of this.parts) {
      for (const cap of Object.keys(p.exports) as RuntimeCap[]) {
        if (seen.has(cap)) continue;
        seen.add(cap);
        const local = this.localByCap.get(cap);
        if (!local) continue;
        exportEntries.push(`${this.pub(cap)}: ${local}`);
      }
    }
    const dataParts = this.parts.filter((p) => p.data).map((p) => p.code);
    const pure = this.parts.filter((p) => p.pure && !p.data);
    const impure = this.parts.filter((p) => !p.pure && !p.data);
    const shuffled = this.rng.shuffle(pure);
    const body = [...shuffled, ...impure].map((p) => p.code).join("\n");
    return {
      dataParts,
      iife: `var ${this.binding} = (function(){\n${body}\nreturn { ${exportEntries.join(", ")} };\n})();`,
    };
  }
}

export interface Stats {
  inputSize: number;
  outputSize: number;
  entropy: number;
  virtualizedFunctions: number;
  flattenedFunctions: number;
  encryptedStrings: number;
  loweredPropertyAccesses: number;
  encodedNumbers: number;
  loweredRegex: number;
  injectedDeadBranches: number;
  chunks: number;
  objectsExtracted: number;
  functionsGenerated: number;
  /** VM exclusion / compile-failure counters (vmExcl_<reason>, vmCompileFailed). */
  [k: string]: number;
}

export class Context {
  rng: RNG;
  options: Options;
  runtime: RuntimeBuilder;
  stats: Stats = {
    inputSize: 0,
    outputSize: 0,
    entropy: 0,
    virtualizedFunctions: 0,
    flattenedFunctions: 0,
    encryptedStrings: 0,
    loweredPropertyAccesses: 0,
    encodedNumbers: 0,
    loweredRegex: 0,
    injectedDeadBranches: 0,
    chunks: 0,
    objectsExtracted: 0,
    functionsGenerated: 0,
  };
  /** Names already used, to avoid collisions for late passes. */
  usedNames = new Set<string>();
  /** Marker set for nodes belonging to injected runtime (passes skip these). */
  runtimeNodes = new WeakSet<Node>();
  /** Function nodes marked eligible for VM virtualization. */
  vmEligible = new WeakSet<Node>();
  /** Format of the input module. */
  sourceFormat: "cjs" | "esm" | "iife" = "iife";
  isStrict = false;
  /** Directives ("use strict" etc.) preserved at output top. */
  hasUseStrict = false;
  /** Which runtime parts exist (cross-part coordination, e.g. antidebug -> SK). */
  runtimeFlags: Record<string, number | boolean | string | string[] | Record<string, string>> = {};
  /**
   * Per-build session key. The program entry calls the runtime's initSession
   * with this value before any string/key decryption, and every decryption
   * derives its key from (maskedKey ^ SKEY). Evaluating the runtime in
   * isolation therefore yields garbage: the table is not self-sufficient.
   */
  readonly sessionKey: number;

  /**
   * Per-build keystream configuration. Randomizes the xorshift32 shift amounts
   * and order per build so the xorshift32 signature is not greppable.
   */
  readonly keystream: KeystreamLike;

  constructor(options: Options) {
    this.options = options;
    const s = BigInt(options.seed >>> 0);
    this.rng = new RNG(s | ((s ^ 0x9e3779b9n) << 32n));
    this.runtime = new RuntimeBuilder(this.rng);
    this.sessionKey = (this.rng.int(0x7ffffffe) + 1) | 0;
    this.keystream = randomKeystream(this.rng);
  }

  freshName(hint: string): string {
    let n = hint;
    let i = 0;
    while (this.usedNames.has(n)) n = hint + "$" + i++;
    this.usedNames.add(n);
    return n;
  }

  /** Increment a VM-related stat counter (exclusion reason or compile failure). */
  incVmStat(key: string): void {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
  }

  time<T>(name: string, fn: () => T): T {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      const k = "time_" + name;
      this.stats[k] = (this.stats[k] ?? 0) + (Date.now() - t0);
    }
  }
}

/** True if the path is inside the injected runtime subtree. */
export function isRuntimePath(path: NodePath, ctx: Context): boolean {
  let cur: NodePath | null = path;
  while (cur) {
    if (ctx.runtimeNodes.has(cur.node)) return true;
    cur = cur.parentPath;
  }
  return false;
}
