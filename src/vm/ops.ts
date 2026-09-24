/** VM opcode names. Numbering is permuted per build at vm>=2. */
export const OP_NAMES = [
  "NOP", "CONST", "UNDEF", "NULL", "TRUE", "FALSE", "THIS", "SELF",
  "LOAD", "STORE", "LOADCAP", "STORECAP",
  "POP", "DUP",
  "ADD", "SUB", "MUL", "DIV", "MOD", "POW",
  "BITAND", "BITOR", "BITXOR", "SHL", "SHR", "USHR",
  "EQ", "NEQ", "SEQ", "SNEQ", "LT", "GT", "LTE", "GTE",
  "NOT", "BITNOT", "NEG", "POS", "TYPEOF", "VOIDOP",
  "INOP", "INSTANCEOF",
  "CALL", "CALLPROP", "CALLTHIS", "APPLY", "APPLYTHIS", "NEWOP", "NEWSPREAD",
  "JMP", "JTRUE", "JFALSE", "ISNULLISH",
  "RET", "RETUNDEF", "THROW", "AWAIT",
  "YIELD", "YIELDDELEGATE", "YIELDVAL", "YIELDEND",
  "TRYENTER", "TRYLEAVE", "FINENTER", "FINNORMAL", "FINPEND", "FINEND",
  "GETPROP", "SETPROP", "DELPROP", "HASPROP",
  "TYPEOFCAP",
  "NEWOBJ", "OBJSET", "OBJASSIGN", "NEWARRAY", "ARRAPPEND", "ARRSPREAD",
  "FORIN", "FOROF", "DEBUGGER",
] as const;

export type OpName = (typeof OP_NAMES)[number];

export interface OpMap {
  /** op name -> emitted numeric code */
  code: Record<OpName, number>;
  /** alias codes (L3): op name -> extra numeric codes with same semantics */
  aliases: Partial<Record<OpName, number[]>>;
}

/** Build a per-build opcode numbering. level 1: sequential; 2+: permuted; 3: + aliases. */
export function buildOpMap(rng: { int(n: number): number; shuffle<T>(a: readonly T[]): T[]; chance(p?: number): boolean }, level: number): OpMap {
  const nums = Array.from({ length: OP_NAMES.length }, (_, i) => i);
  const order = level >= 2 ? rng.shuffle(nums) : nums;
  const code = {} as Record<OpName, number>;
  OP_NAMES.forEach((name, i) => {
    code[name] = order[i];
  });
  const aliases: Partial<Record<OpName, number[]>> = {};
  if (level >= 3) {
    // unused code space 100..149 holds alias + dead handlers
    let extra = 100;
    for (const name of OP_NAMES) {
      if (rng.chance(0.25)) {
        aliases[name] = [extra++];
      }
    }
  }
  return { code, aliases };
}

/** Pick an emitted code for an op (may be an alias at L3). */
export function pickCode(map: OpMap, name: OpName, rng: { int(n: number): number }): number {
  const al = map.aliases[name];
  if (al && al.length > 0 && rng.int(4) === 0) return al[rng.int(al.length)];
  return map.code[name];
}
