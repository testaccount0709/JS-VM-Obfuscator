import { utf8Encode, toBase64, shuffledAlphabet, xorBytes, xorshift32Keystream, randomKeystream } from "../utils/codec.js";
import type { KeystreamLike } from "../utils/codec.js";
import { confusingName } from "../utils/names.js";
import { RNG } from "../utils/rng.js";
import { packStage2 } from "./stage2.js";

/** Emit the per-build xorshift32 keystream step JS for a state variable name. */
function ksStepJs(v: string, ks: KeystreamLike): string {
  const [s1, s2, s3] = ks.shifts;
  const o = ks.order;
  if (o === 0) return `${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (o === 1) return `${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}>>>=0;`;
  if (o === 2) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}^=${v}<<${s3};${v}>>>=0;`;
  if (o === 3) return `${v}^=${v}>>>${s2};${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}>>>=0;`;
  if (o === 4) return `${v}^=${v}<<${s3};${v}^=${v}<<${s1};${v}^=${v}>>>${s2};${v}>>>=0;`;
  return `${v}^=${v}<<${s3};${v}^=${v}>>>${s2};${v}^=${v}<<${s1};${v}>>>=0;`;
}

/** Capture the function constructor from a fresh literal; never touch globals. */
function sinkSource(rng: RNG, srcVar: string, integrity: boolean): string {
  const fvar = "FN" + rng.int(1e9);
  const acq = rng.int(5);
  let captureVar: string;
  if (acq === 0) captureVar = `var ${fvar}=(function(){}).constructor;`;
  else if (acq === 1) captureVar = `var ${fvar}=(()=>{}).constructor;`;
  else if (acq === 2) captureVar = `var ${fvar}=Object.getPrototypeOf(function(){}).constructor;`;
  else if (acq === 3) captureVar = `var ${fvar}=(async function(){}).constructor;`;
  else captureVar = `var ${fvar}=[].filter.constructor;`;
  let check = "";
  let close = "";
  if (integrity) {
    check = `if(${fvar}.prototype.constructor===${fvar}&&String(${fvar}).indexOf("[native code]")>-1){`;
    close = "}";
  }
  let invoke: string;
  const variant = rng.int(3);
  if (variant === 0) {
    invoke = `(0,${fvar})(${srcVar})();`;
  } else if (variant === 1) {
    const gvar = "G" + rng.int(1e9);
    invoke = `var ${gvar}=Reflect.construct(${fvar},[${srcVar}]);${gvar}();`;
  } else {
    invoke = `Function.prototype.apply.call(${fvar},null,[${srcVar}])();`;
  }
  return captureVar + check + invoke + close;
}

/** Stage 3 — gzip/DecompressionStream compression layer for size optimization. */
export async function packStage3(artifact: string, seed: number, integrity = false): Promise<string> {
  const rng = new RNG(BigInt(seed >>> 0) | 0x300000000n);

  // ---- Stage 2 depacker source (must be byte-faithfully recoverable) ----
  const stage2 = await packStage2(artifact, seed, integrity);
  const stage2Bytes = utf8Encode(stage2);

  // ---- Gzip compress Stage 2 ----
  const gzipStream = new CompressionStream("gzip");
  const reader = gzipStream.readable.getReader();
  const writer = gzipStream.writable.getWriter();
  const compressedChunks: Uint8Array[] = [];
  const readDone: { value?: Uint8Array; done: boolean }[] = [];
  const readLoop = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { readDone.push({ done: true }); break; }
      compressedChunks.push(value);
    }
  };
  const readPromise = readLoop();
  await writer.write(new Uint8Array(stage2Bytes));
  await writer.close();
  await readPromise;
  const compressed = new Uint8Array(compressedChunks.reduce((a, b) => a + b.length, 0));
  let offset = 0;
  for (const chunk of compressedChunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }
  const compressedBytes = Array.from(compressed);

  // ---- Single xorshift32 layer; seed + shift config are embedded in the depacker ----
  const ksCfg = randomKeystream(new RNG(BigInt(seed >>> 0) | 0x900000000n));
  const ks = { shifts: ksCfg.shifts, order: 0 };
  let keySeed = (seed ^ 0x9e3779b9) >>> 0;
  if (keySeed === 0) keySeed = 1;
  const enc = xorshift32Keystream(keySeed, compressedBytes.length, ks);
  const masked = xorBytes(compressedBytes, enc);

  // ---- Split into 12 segments ----
  const segCount = 12;
  const segments: number[][] = [];
  let remaining = masked.length;
  for (let i = 0; i < segCount; i++) {
    if (i === segCount - 1) {
      segments.push(masked.slice(masked.length - remaining));
    } else {
      const avg = remaining / (segCount - i);
      const sz = Math.max(4, Math.min(remaining - (segCount - i - 1), Math.round(avg * (0.4 + Math.random() * 0.6))));
      segments.push(masked.slice(masked.length - remaining, masked.length - remaining + sz));
      remaining -= sz;
    }
  }

  // ---- Alphabet (shared between encoder and decoder) ----
  const alph = shuffledAlphabet(rng);

  // ---- Decoy noise (syntactically valid, never executed) ----
  const decoyCount = 10 + Math.floor(Math.random() * 8);
  const decoyStmts: string[] = [];
  for (let i = 0; i < decoyCount; i++) {
    const type = Math.floor(Math.random() * 4);
    const name = confusingName(rng, new Set(), 2);
    if (type === 0) {
      let expr = Math.floor(Math.random() * 1000).toString();
      for (let j = 0; j < 5; j++) expr += ["+", "-", "*", "^", "&", "|", ">>", "<<", ">>>"][Math.floor(Math.random() * 9)] + Math.floor(Math.random() * 1000).toString();
      decoyStmts.push(`function ${confusingName(rng, new Set(), 2)}(){return ${expr};}`);
    } else if (type === 1) {
      const arr = [];
      for (let j = 0; j < 10 + Math.floor(Math.random() * 10); j++) arr.push(Math.floor(Math.random() * 256));
      decoyStmts.push(`var ${confusingName(rng, new Set(), 2)}=[${arr.join(",")}];`);
    } else if (type === 2) {
      const props = [];
      for (let j = 0; j < 5; j++) props.push(`${confusingName(rng, new Set(), 2)}:${Math.floor(Math.random() * 1000)}`);
      decoyStmts.push(`var ${confusingName(rng, new Set(), 2)}={${props.join(",")}};`);
    } else {
      decoyStmts.push(`var ${confusingName(rng, new Set(), 2)}="${confusingName(rng, new Set(), 2)}";`);
    }
  }

  // ---- Build the depacker source (readable names; renamed later) ----
  const segDecls = segments.map((s, i) => `seg${i}=${JSON.stringify(toBase64(s, alph))}`).join(",");
  const concatStmts = segments.map((_, i) => `arr=arr.concat(b64d(seg${i},al));`).join("");
  const src = `
(async function(){
"use strict";
var ${segDecls};
var al=${JSON.stringify(alph)};
var arr=[];
${decoyStmts.join("\n")}
function b64d(s,AL){var o=[],buf=0,bits=0;for(var i=0;i<s.length;i++){var ch=s.charAt(i);if(ch==="=")break;var v=AL.indexOf(ch);if(v<0)continue;buf=(buf<<6)|v;bits+=6;if(bits>=8){bits-=8;o.push((buf>>bits)&255);}}return o;}
function unm(a,k){var x=k>>>0;if(x===0)x=1;var o=[];for(var i=0;i<a.length;i++){${ksStepJs("x", ks)}o.push(a[i]^(x&255));}return o;}
${concatStmts}
var comp=unm(arr,${keySeed});
var gz=new DecompressionStream("gzip");
var w=gz.writable.getWriter();w.write(new Uint8Array(comp));w.close();
var rd=gz.readable.getReader();
var chunks=[];
for(;;){var rc=await rd.read();if(rc.done)break;chunks.push(...rc.value);}
var out=new TextDecoder().decode(new Uint8Array(chunks));
${sinkSource(new RNG(BigInt(seed >>> 0) | 0xA00000000n), "out", false)}
})();
`;

  return renameDepackerLocals(src, rng);
}

async function renameDepackerLocals(src: string, rng: RNG): Promise<string> {
  const { parse } = await import("@babel/parser");
  const { traverse, generate } = await import("../utils/babel.js");
  let ast;
  try {
    ast = parse(src, { sourceType: "script" });
  } catch (e) {
    const fs = await import("fs");
    fs.writeFileSync("stage3.fail.js", src);
    throw e;
  }
  const used = new Set<string>();
  traverse(ast, {
    Scope(path: import("@babel/traverse").NodePath) {
      for (const name of Object.keys(path.scope.bindings)) {
        const next = confusingName(rng, used, 2);
        try {
          path.scope.rename(name, next);
        } catch {
          /* ignore rename failures (collision with an outer binding) */
        }
      }
    },
  });
  return generate(ast, { compact: true }).code;
}
