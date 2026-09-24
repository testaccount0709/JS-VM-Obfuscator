export type Level = 0 | 1 | 2 | 3;
export type PackMode = "off" | "stage1" | "stage2" | "stage3";
export type EnvLock = "auto" | "browser" | "node";

export type VmDecryptMode = "cache" | "volatile";

export interface Options {
  vm: Level;
  cff: Level;
  strings: Level;
  property: Level;
  identifiers: Level;
  deadcode: Level;
  numbers: Level;
  regex: Level;
  scatter: Level;
  reshape: Level;
  antidebug: Level;
  extractObjects: Level;
  rfactory: Level;
  pack: PackMode;
  camouflage: boolean;
  /** Re-enable full CFF flattening of the runtime's own small per-op handlers
   *  (off by default to keep output small). */
  extraFlattening: boolean;
  seed: number;
  vmThreshold: number;
  /** Bytecode decrypt strategy: cache plaintext on FT entry, or decrypt per read. */
  vmDecryptMode: VmDecryptMode;
  /** Scatter FT entries across synthetic containers (vm >= 2). */
  vmScatterFt: boolean;
  stats: boolean;
  envLock: EnvLock;
}

export const DEFAULT_OPTIONS: Options = {
  vm: 0,
  cff: 0,
  strings: 0,
  property: 0,
  identifiers: 0,
  deadcode: 0,
  numbers: 0,
  regex: 0,
  scatter: 0,
  reshape: 0,
  antidebug: 0,
  extractObjects: 0,
  rfactory: 0,
  pack: "off",
  camouflage: false,
  extraFlattening: false,
  seed: 1337,
  vmThreshold: 2,
  vmDecryptMode: "cache",
  vmScatterFt: false,
  stats: false,
  envLock: "auto",
};

export type PresetName = "light" | "medium" | "heavy" | "insane" | "performance" | "compact";

export const PRESETS: Record<PresetName, Partial<Options>> = {
  light: {
    identifiers: 2, cff: 1, strings: 1, property: 1, deadcode: 1,
    numbers: 1, regex: 1, vm: 0, scatter: 0, reshape: 0, extractObjects: 1, rfactory: 0, camouflage: true,
  },
  medium: {
    identifiers: 2, cff: 2, strings: 2, property: 2, deadcode: 1,
    numbers: 1, regex: 1, vm: 1, scatter: 1, reshape: 0, extractObjects: 1, rfactory: 1, camouflage: true,
  },
  heavy: {
    vm: 2, cff: 3, strings: 3, property: 3, deadcode: 2, numbers: 1,
    identifiers: 2, regex: 1, scatter: 1, reshape: 1, extractObjects: 1, rfactory: 1, camouflage: true,
    vmThreshold: 1,
  },
  insane: {
    vm: 3, cff: 3, strings: 3, property: 3, deadcode: 2, numbers: 1,
    identifiers: 2, regex: 1, scatter: 1, reshape: 1, extractObjects: 2, rfactory: 2, camouflage: true,
    antidebug: 2,
    vmThreshold: 1,
    vmDecryptMode: "volatile",
    vmScatterFt: true,
  },
  // Speed-critical builds: keeps meaningful protection (identifier renaming,
  // string/number/regex encoding, light CFF + property lowering) while dropping
  // the heaviest runtime machinery — no VM interpreter, no MBA chains, no
  // string spilling. Runtime overhead is close to the baseline.
  performance: {
    identifiers: 2, cff: 1, strings: 2, property: 1, deadcode: 1,
    numbers: 0, regex: 1, vm: 0, scatter: 0, reshape: 0, extractObjects: 0, rfactory: 0,
    camouflage: true, antidebug: 0,
  },
  // Size-optimized builds: targets ~25% of the insane-preset size for the same
  // input (compact output + no VM interpreter + no MBA chains + no CFF
  // state-machine growth), while keeping the strongest cheap protections:
  // identifier renaming, per-string-seeded string encryption, property-access
  // lowering, regex rewriting, and SK self-defense (antidebug=1).
  compact: {
    identifiers: 2, cff: 0, strings: 2, property: 1, deadcode: 0,
    numbers: 0, regex: 1, vm: 0, scatter: 0, reshape: 0, extractObjects: 0, rfactory: 0,
    camouflage: true, antidebug: 1,
  },
};

export function applyPreset(base: Options, preset: PresetName): Options {
  return { ...base, ...PRESETS[preset] };
}

export function levelAll(base: Options): Options {
  return {
    ...base,
    vm: 3, cff: 3, strings: 3, property: 3, identifiers: 2, deadcode: 2,
    numbers: 1, regex: 1, scatter: 1, reshape: 1, extractObjects: 2, rfactory: 2, camouflage: true,
    // antidebug stays opt-in
  };
}

export function parseLevel(v: string | undefined, max = 3): Level | undefined {
  if (v === undefined) return undefined;
  if (v === "off") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`invalid level "${v}" (expected off or 0..${max})`);
  }
  return n as Level;
}

export function parseVmDecryptMode(v: string | undefined): VmDecryptMode | undefined {
  if (v === undefined) return undefined;
  if (v === "cache" || v === "volatile") return v;
  throw new Error(`invalid vm decrypt mode "${v}" (expected cache|volatile)`);
}

export function parsePack(v: string | undefined): PackMode | undefined {
  if (v === undefined) return undefined;
  if (v === "off" || v === "stage1" || v === "stage2" || v === "stage3") return v;
  throw new Error(`invalid pack mode "${v}" (expected off|stage1|stage2|stage3)`);
}

export function parseEnvLock(v: string | undefined): EnvLock | undefined {
  if (v === undefined) return undefined;
  if (v === "auto" || v === "browser" || v === "node") return v;
  throw new Error(`invalid env lock "${v}" (expected auto|browser|node)`);
}

export interface ConfigFile {
  preset?: PresetName;
  levelAll?: boolean;
  options?: Partial<Options>;
}

/** Merge order: defaults <- config file <- preset <- levelAll <- CLI flags. */
export function mergeOptions(cli: Partial<Options>, cfg?: ConfigFile): Options {
  let opts = { ...DEFAULT_OPTIONS };
  if (cfg?.options) opts = { ...opts, ...cfg.options };
  if (cfg?.preset) opts = applyPreset(opts, cfg.preset);
  if (cfg?.levelAll) opts = levelAll(opts);
  opts = { ...opts, ...stripUndefined(cli) };
  return opts;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
