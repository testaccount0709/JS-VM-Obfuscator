import { RNG } from "./rng.js";

export const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function shuffledAlphabet(rng: RNG): string {
  return rng.shuffle(B64_STD.split("")).join("");
}

export interface KeystreamLike {
  shifts: [number, number, number];
  order: number;
}

/** Generate a per-build randomized xorshift32 keystream config. */
export function randomKeystream(rng: RNG): KeystreamLike {
  let shifts: [number, number, number];
  do {
    shifts = [rng.int(31) + 1, rng.int(31) + 1, rng.int(31) + 1];
  } while (shifts[0] === shifts[1] || shifts[0] === shifts[2] || shifts[1] === shifts[2]);
  return { shifts, order: rng.int(6) };
}

export function toBase64(bytes: number[] | Uint8Array, alphabet: string): string {  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < n ? alphabet[b2 & 63] : "=";
  }
  return out;
}

export function fromBase64(s: string, alphabet: string): number[] {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = lookup[ch];
    if (v === undefined) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** xorshift128+ keystream generator matching utils/rng.ts (runs at runtime). */
export function xorKeystream(seed: bigint, n: number): number[] {
  const r = new RNG(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.int(256));
  return out;
}

/**
 * xorshift32 keystream with per-build randomized shift amounts and order.
 * MUST match the inline depacker loops emitted by packer/stage1.ts and the
 * interpreter's bytecode/const decryption loops.
 */
export function xorshift32Keystream(seed: number, n: number, keystream: { shifts: [number, number, number]; order: number }): number[] {
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

export function xorBytes(data: number[], key: number[]): number[] {
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}

export function utf8Encode(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

export function utf8Decode(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function bytesToBitReversed(bytes: number[]): number[] {
  const rev = (b: number) => {
    let x = b;
    x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
    return x & 0xff;
  };
  return bytes.map(rev);
}
