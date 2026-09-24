/**
 * Deterministic seeded PRNG (xorshift128+). Drives ALL per-build randomization
 * so the same seed always yields byte-identical output.
 */
export class RNG {
  private s0: bigint;
  private s1: bigint;

  constructor(seed: number | bigint = 0x9e3779b97f4a7c15n) {
    let s = BigInt(seed) & 0xffffffffffffffffn;
    if (s === 0n) s = 0x9e3779b97f4a7c15n;
    // splitmix64 to initialize the two state words
    this.s0 = RNG.splitmix64(s);
    this.s1 = RNG.splitmix64(this.s0);
    if (this.s0 === 0n && this.s1 === 0n) this.s1 = 1n;
    // warm up
    for (let i = 0; i < 20; i++) this.nextBigint();
  }

  private static splitmix64(x: bigint): bigint {
    x = (x + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return (x ^ (x >> 31n)) & 0xffffffffffffffffn;
  }

  /** Raw 64-bit unsigned value. */
  nextBigint(): bigint {
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x = (x ^ ((x << 23n) & 0xffffffffffffffffn)) & 0xffffffffffffffffn;
    this.s1 =
      (x ^ y ^ (x >> 17n) ^ (y >> 26n)) & 0xffffffffffffffffn;
    return (this.s1 + y) & 0xffffffffffffffffn;
  }

  /** Uniform uint32. */
  next(): number {
    return Number(this.nextBigint() >> 32n);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) return 0;
    return this.next() % n;
  }

  /** Uniform integer in [min, max] inclusive. */
  range(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.int(max - min + 1);
  }

  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Pick n distinct indices. */
  pickIndices(count: number, max: number): number[] {
    const n = Math.min(count, max);
    const set = new Set<number>();
    while (set.size < n) set.add(this.int(max));
    return [...set];
  }

  /** Fisher-Yates shuffle (returns a new array). */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /** Random boolean with probability p of true. */
  chance(p = 0.5): boolean {
    return this.float() < p;
  }

  /** Random alphanumeric identifier of given length. */
  ident(len: number, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"): string {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[this.int(alphabet.length)];
    return s;
  }

  /** Random bytes as number array. */
  bytes(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.int(256));
    return out;
  }
}
