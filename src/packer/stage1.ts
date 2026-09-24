import { parse } from "@babel/parser";
import { traverse, generate } from "../utils/babel.js";
import * as t from "@babel/types";
import { RNG } from "../utils/rng.js";
import { utf8Encode, toBase64, shuffledAlphabet, B64_STD, xorBytes, xorshift32Keystream, randomKeystream } from "../utils/codec.js";
import type { KeystreamLike } from "../utils/codec.js";
import { opaquePredicate } from "../utils/predicates.js";
import { confusingName } from "../utils/names.js";

/** Emit the per-build keystream step JS for a state variable name. */
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

/**
 * Packer Stage 1 — polymorphic de-packer.
 *
 * The artifact is stream-encrypted, split into varied-size chunks, each encoded
 * with one of several codecs and hidden across synthetic containers (functions,
 * junk-interleaved arrays, computed-key objects) under scrambled token keys.
 * Order + codec map are reconstructed at runtime purely through opaque
 * predicates (no plaintext manifest). The reassembled source materializes only
 * transiently and executes via a pristine-capture sink that never references
 * the global `eval`/`Function` identifiers.
 */

/** Capture the function constructor from a fresh literal; never touch globals. */
function sinkSource(rng: RNG, srcVar: string, integrity: boolean): string {
  const fvar = "FN" + rng.int(1e9);
  // randomize how the code-execution primitive is acquired so a hook that only
  // targets `(function(){}).constructor` misses many builds
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

/** Build the polymorphic depacker for an already-obfuscated artifact. */
export function packStage1(artifact: string, seed: number, integrity = false): string {
  const rng = new RNG(BigInt(seed >>> 0) | 0x100000000n);
  const used = new Set<string>();
  const nm = () => confusingName(rng, used, 2);

  // ---- stream-encrypt the artifact ----
  const keySeed = (rng.int(0x7ffffffe) + 1) | 0;
  const ksConfig = randomKeystream(rng);
  const plain = utf8Encode(artifact);
  const keystream = xorshift32Keystream(keySeed, plain.length, ksConfig);
  const enc = xorBytes(plain, keystream);

  // ---- split into varied chunks ----
  const nChunks = Math.max(6, Math.min(24, rng.range(6, 24)));
  const sizes: number[] = [];
  let remaining = enc.length;
  for (let i = 0; i < nChunks; i++) {
    if (i === nChunks - 1) {
      sizes.push(remaining);
    } else {
      const avg = remaining / (nChunks - i);
      const sz = Math.max(1, Math.min(remaining - (nChunks - i - 1), Math.round(avg * (0.5 + rng.float()))));
      sizes.push(sz);
      remaining -= sz;
    }
  }
  const chunks: number[][] = [];
  let off = 0;
  for (const sz of sizes) {
    chunks.push(enc.slice(off, off + sz));
    off += sz;
  }

  // ---- per-chunk codec + encode ----
  // codec 0: shuffled-alphabet base64; 1: XOR+std base64; 2: bit-reversed+std base64; 3: custom base-N
  const alph = shuffledAlphabet(rng);
  const xorKey = rng.bytes(16);
  // deterministic base-N alphabet shared by encoder + emitted decoder
  const bnAlph = baseNAlphabet(new RNG(BigInt(seed >>> 0) | 0x100000000n));
  const tokens: number[] = [];
  const codecs: number[] = [];
  const payloads: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const codec = rng.int(4);
    codecs.push(codec);
    tokens.push(rng.int(0x7fffff));
    const c = chunks[i];
    if (codec === 0) payloads.push(toBase64(c, alph));
    else if (codec === 1) payloads.push(toBase64(xorBytes(c, xorKey), B64_STD));
    else if (codec === 2) payloads.push(toBase64(bitReverse(c), B64_STD));
    else payloads.push(toBaseN(c, bnAlph));
  }

  // ---- containers: scatter chunks across synthetic structures ----
  const containers: string[] = [];
  const tokenToRef = new Map<number, string>();
  const objName = nm();
  containers.push(`var ${objName}=Object.create(null);`);

  for (let i = 0; i < payloads.length; i++) {
    const tok = tokens[i];
    const lit = JSON.stringify(payloads[i]);
    const style = rng.int(3);
    if (style === 0) {
      const fn = nm();
      containers.push(`function ${fn}(){return ${lit};}`);
      containers.push(`${objName}[${tok}]=${fn}();`);
    } else if (style === 1) {
      const arr = nm();
      const idx = rng.int(4);
      const junk: string[] = [];
      for (let k = 0; k < idx; k++) junk.push(JSON.stringify(rng.ident(rng.range(2, 8))));
      junk.push(lit);
      while (junk.length < idx + 1 + rng.int(3)) junk.push(String(rng.int(256)));
      containers.push(`var ${arr}=[${junk.join(",")}];`);
      containers.push(`${objName}[${tok}]=${arr}[${idx}];`);
    } else {
      containers.push(`${objName}[${tok}]=${lit};`);
    }
    tokenToRef.set(tok, `${objName}[${tok}]`);
  }

  // decoy chunks (never referenced by the manifest)
  const nDecoys = rng.range(2, 5);
  for (let i = 0; i < nDecoys; i++) {
    const dt = rng.int(0x7fffff);
    containers.push(`${objName}[${dt}]=${JSON.stringify(rng.ident(rng.range(8, 40)))};`);
  }

  // ---- manifest via opaque predicates (order + codec map) ----
  const ordVar = nm();
  const codVar = nm();
  const manifest: string[] = [`var ${ordVar}=[],${codVar}=[];`];
  for (let i = 0; i < tokens.length; i++) {
    const pred = generate(opaquePredicate(rng, true).expr, { compact: true }).code;
    const decoyTok = rng.int(0x7fffff);
    manifest.push(
      `if(${pred}){${ordVar}.push(${tokens[i]});${codVar}.push(${codecs[i]});}else{${ordVar}.push(${decoyTok});${codVar}.push(${rng.int(4)});}`,
    );
  }

  // ---- codec decode helpers (only those used) ----
  const helpers: string[] = [];
  const decFns: Record<number, string> = {};
  const usedCodecs = new Set(codecs);
  const b64dName = nm();
  helpers.push(
    `function ${b64dName}(s,AL){var o=[],buf=0,bits=0;for(var i=0;i<s.length;i++){var ch=s.charAt(i);if(ch==="=")break;var v=AL.indexOf(ch);if(v<0)continue;buf=(buf<<6)|v;bits+=6;if(bits>=8){bits-=8;o.push((buf>>bits)&255);}}return o;}`,
  );
  if (usedCodecs.has(0)) {
    const f = nm();
    decFns[0] = f;
    helpers.push(`function ${f}(s){return ${b64dName}(s,${JSON.stringify(alph)});}`);
  }
  if (usedCodecs.has(1)) {
    const f = nm();
    decFns[1] = f;
    helpers.push(
      `function ${f}(s){var r=${b64dName}(s,${JSON.stringify(B64_STD)});var k=${JSON.stringify(xorKey)};for(var i=0;i<r.length;i++)r[i]^=k[i%k.length];return r;}`,
    );
  }
  if (usedCodecs.has(2)) {
    const f = nm();
    decFns[2] = f;
    helpers.push(
      `function ${f}(s){var r=${b64dName}(s,${JSON.stringify(B64_STD)});for(var i=0;i<r.length;i++){var b=r[i];b=((b&240)>>4)|((b&15)<<4);b=((b&204)>>2)|((b&51)<<2);b=((b&170)>>1)|((b&85)<<1);r[i]=b&255;}return r;}`,
    );
  }
  if (usedCodecs.has(3)) {
    const f = nm();
    decFns[3] = f;
    helpers.push(
      `function ${f}(s){var AL=${JSON.stringify(bnAlph)};var base=AL.length;var out=[];var i=0;while(i<s.length){var cnt=s.charCodeAt(i++)-32;var dlen=s.charCodeAt(i++)-32;var n=0;for(var j=0;j<dlen;j++){n=n*base+AL.indexOf(s.charAt(i++));}for(var j=0;j<cnt;j++){out.push(n&255);n>>>=8;}}return out;}`,
    );
  }

  // ---- reassembly + stream decrypt ----
  const bufVar = nm();
  const iVar = nm();
  const xVar = nm();
  const outVar = nm();
  const srcVar = nm();
  const reassemble: string[] = [];
  reassemble.push(`var ${bufVar}=[];`);
  reassemble.push(
    `for(var ${iVar}=0;${iVar}<${ordVar}.length;${iVar}++){var tk=${ordVar}[${iVar}];var cd=${codVar}[${iVar}];var by=cd===0?${decFns[0] ?? b64dName}(${objName}[tk]):cd===1?${decFns[1] ?? b64dName}(${objName}[tk]):cd===2?${decFns[2] ?? b64dName}(${objName}[tk]):${decFns[3] ?? b64dName}(${objName}[tk]);for(var j=0;j<by.length;j++)${bufVar}.push(by[j]);}`,
  );
  reassemble.push(`var ${xVar}=${keySeed}>>>0;if(${xVar}===0)${xVar}=1;var ${outVar}=[];`);
  reassemble.push(
    `for(var ${iVar}=0;${iVar}<${bufVar}.length;${iVar}++){${ksStepJs(xVar, ksConfig)}${outVar}.push(${bufVar}[${iVar}]^(${xVar}&255));}`,
  );
  reassemble.push(`var ${srcVar}=${u8DecodeSource(outVar)};`);

  const sink = sinkSource(rng, srcVar, integrity);

  // ---- assemble the depacker IIFE ----
  const body = [
    '"use strict";',
    ...containers,
    ...manifest,
    ...helpers,
    ...reassemble,
    sink,
  ].join("\n");
  const depackerSrc = `(function(){\n${body}\n})();`;

  // ---- polymorphic rename of all depacker locals ----
  return renameDepackerLocals(depackerSrc, rng);
}

function u8DecodeSource(outVar: string): string {
  // decode the byte array in `outVar` to a string via UTF-8
  return `(function(a){var s="",i=0;while(i<a.length){var b=a[i++];if(b<128){s+=String.fromCharCode(b);}else if(b<224){s+=String.fromCharCode(((b&31)<<6)|(a[i++]&63));}else if(b<240){s+=String.fromCharCode(((b&15)<<12)|((a[i++]&63)<<6)|(a[i++]&63));}else{var cp=((b&7)<<18)|((a[i++]&63)<<12)|((a[i++]&63)<<6)|(a[i++]&63);cp-=65536;s+=String.fromCharCode(55296+(cp>>10),56320+(cp&1023));}}return s;})(${outVar})`;
}

function bitReverse(bytes: number[]): number[] {
  return bytes.map((b) => {
    let x = b;
    x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
    return x & 0xff;
  });
}

function baseNAlphabet(rng: RNG): string {
  // printable, quote-safe alphabet for custom base-N
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return rng.shuffle(chars.split("")).join("").slice(0, 32);
}

function toBaseN(bytes: number[], AL: string): string {
  const base = AL.length;
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    // pack up to 3 bytes little-endian into one number
    const cnt = Math.min(3, bytes.length - i);
    let n = 0;
    for (let j = 0; j < cnt; j++) n |= bytes[i + j] << (8 * j);
    let d = "";
    let tmp = n;
    while (tmp > 0) {
      d = AL[tmp % base] + d;
      tmp = Math.floor(tmp / base);
    }
    if (d.length === 0) d = AL[0];
    out += String.fromCharCode(32 + cnt) + String.fromCharCode(32 + d.length) + d;
    i += cnt;
  }
  return out;
}

function renameDepackerLocals(src: string, rng: RNG): string {
  const ast = parse(src, { sourceType: "script" });
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

// ---- Stage 2 ----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Packer Stage 2 — masked LZMA layer wrapping Stage 1.
 * LZMA-compresses the Stage 1 depacker, masks the stream + splits the header,
 * and stores it as separate segments. A compact embedded LZMA decoder
 * reconstructs the Stage 1 source and hands it to the same stealth sink.
 */
export async function packStage2(artifact: string, seed: number, integrity = false): Promise<string> {
  const rng = new RNG(BigInt(seed >>> 0) | 0x200000000n);
  const used = new Set<string>();
  const nm = () => confusingName(rng, used, 2);
  const stage1 = packStage1(artifact, seed, integrity);
  const stage1Bytes = utf8Encode(stage1);

  const lzma = require("lzma");
  const compressed: number[] = await new Promise((resolve, reject) => {
    lzma.compress(stage1Bytes, 1, (result: number[]) => {
      if (result) resolve(result.map((b) => b & 0xff));
      else reject(new Error("lzma compress failed"));
    });
  });

  // header = first 13 bytes (props + dict size + unpack size); body = rest
  const header = compressed.slice(0, 13);
  const body = compressed.slice(13);

  const maskKey = (rng.int(0x7ffffffe) + 1) | 0;
  const ks2 = randomKeystream(rng);
  const headerKs = xorshift32Keystream(maskKey, header.length, ks2);
  const maskedHeader = xorBytes(header, headerKs);
  const bodyKs = xorshift32Keystream(maskKey ^ 0x5a5a5a5a, body.length, ks2);
  const maskedBody = xorBytes(body, bodyKs);

  // split body into a few segments kept apart
  const segCount = rng.range(3, 6);
  const segments: number[][] = [];
  const per = Math.ceil(maskedBody.length / segCount);
  for (let i = 0; i < segCount; i++) {
    segments.push(maskedBody.slice(i * per, Math.min((i + 1) * per, maskedBody.length)));
  }
  const alph = shuffledAlphabet(rng);

  const hdrVar = nm();
  const decoderName = nm();
  const segVars = segments.map(() => nm());

  const decoderSrc = lzmaDecoderSource(decoderName);

  const srcVar = nm();
  const sink = sinkSource(rng, srcVar, integrity);

  const segDecls = segments.map((s, i) => `var ${segVars[i]}=${JSON.stringify(toBase64(s, alph))};`).join("\n");
  let segConcat = `b64(${segVars[0]})`;
  for (let i = 1; i < segVars.length; i++) segConcat += `.concat(b64(${segVars[i]}))`;

  const wrapper = `(function(){
"use strict";
var ${hdrVar}=${JSON.stringify(toBase64(maskedHeader, alph))};
${segDecls}
var AL=${JSON.stringify(alph)};
function b64(s){var o=[],buf=0,bits=0;for(var i=0;i<s.length;i++){var ch=s.charAt(i);if(ch==="=")break;var v=AL.indexOf(ch);if(v<0)continue;buf=(buf<<6)|v;bits+=6;if(bits>=8){bits-=8;o.push((buf>>bits)&255);}}return o;}
function unm(a,k){var x=k>>>0;if(x===0)x=1;var o=[];for(var i=0;i<a.length;i++){${ksStepJs("x", ks2)}o.push(a[i]^(x&255));}return o;}
${decoderSrc}
var hdr=unm(b64(${hdrVar}),${maskKey});
var bod=unm(${segConcat},${maskKey ^ 0x5a5a5a5a});
var full=hdr.concat(bod);
var out=${decoderName}(full);
var ${srcVar}=(function(a){var s="",i=0;while(i<a.length){var b=a[i++];if(b<128){s+=String.fromCharCode(b);}else if(b<224){s+=String.fromCharCode(((b&31)<<6)|(a[i++]&63));}else if(b<240){s+=String.fromCharCode(((b&15)<<12)|((a[i++]&63)<<6)|(a[i++]&63));}else{var cp=((b&7)<<18)|((a[i++]&63)<<12)|((a[i++]&63)<<6)|(a[i++]&63);cp-=65536;s+=String.fromCharCode(55296+(cp>>10),56320+(cp&1023));}}return s;})(out);
${sink}
})();`;

  return renameDepackerLocals(wrapper, rng);
}

/** Compact synchronous LZMA decoder (standalone format) as embeddable source. */
export function lzmaDecoderSource(fnName: string): string {
  return `function ${fnName}(input){
var ip=0;function rb(){return input[ip++]&255;}
var props=rb();
var dictSize=rb()|(rb()<<8)|(rb()<<16)|(rb()<<24);
var usLo=(rb()|(rb()<<8)|(rb()<<16)|(rb()<<24))>>>0;
var usHi=(rb()|(rb()<<8)|(rb()<<16)|(rb()<<24))>>>0;
var hasSize=!(usLo===4294967295&&usHi===4294967295);
var unpackSize=usLo;
var lc=props%9;var tmp=(props/9)|0;var lp=tmp%5;var pb=(tmp/5)|0;
function np(n){var a=new Array(n);for(var i=0;i<n;i++)a[i]=1024;return a;}
var range=4294967295,code=0;
rb();
code=((rb()<<24)|(rb()<<16)|(rb()<<8)|rb())>>>0;
function norm(){while((range>>>0)<16777216){range=(range<<8)>>>0;code=((code<<8)|rb())>>>0;}}
function db(p,i){var pr=p[i];var nb=((range>>>11)*pr)>>>0;var b;if((code>>>0)<nb){b=0;range=nb;p[i]=(pr+((2048-pr)>>>5))&65535;}else{b=1;range=(range-nb)>>>0;code=(code-nb)>>>0;p[i]=(pr-(pr>>>5))&65535;}norm();return b;}
function dd(bits){var r=0;for(var i=0;i<bits;i++){range=(range>>>1)>>>0;if((code>>>0)>=(range>>>0)){code=(code-range)>>>0;r=((r<<1)|1)>>>0;}else{r=(r<<1)>>>0;}norm();}return r;}
function bt(p,base,nb){var m=1;for(var i=0;i<nb;i++)m=(m<<1)|db(p,base+m);return m-(1<<nb);}
function btr(p,base,nb){var m=1,s=0;for(var i=0;i<nb;i++){var b=db(p,base+m);m=(m<<1)|b;s|=b<<i;}return s;}
var isMatch=np(192),isRep=np(12),isRepG0=np(12),isRepG1=np(12),isRepG2=np(12),isRep0Long=np(192);
var posSlot=np(256),posDec=np(115),align=np(16);
var litProbs=np(768<<(lc+lp));
function mkLen(){return{ch:np(1),ch2:np(1),low:np(128),mid:np(128),high:np(256)};}
var lenD=mkLen(),repLenD=mkLen();
function dLen(L,ps){if(db(L.ch,0)===0)return bt(L.low,ps*8,3);if(db(L.ch2,0)===0)return 8+bt(L.mid,ps*8,3);return 16+bt(L.high,0,8);}
function dLit(ls,pb2,st){var base=768*ls;var sym=1;if(st>=7){var mb=pb2;for(;;){var mbit=(mb>>7)&1;mb=(mb<<1)&255;var b=db(litProbs,base+((1+mbit)<<8)+sym);sym=(sym<<1)|b;if(mbit!==b){while(sym<256)sym=(sym<<1)|db(litProbs,base+sym);break;}if(sym>=256)break;}}else{while(sym<256)sym=(sym<<1)|db(litProbs,base+sym);}return sym&255;}
var out=[];var nowPos=0;var state=0;var rep0=0,rep1=0,rep2=0,rep3=0;
var posMask=(1<<pb)-1;var lpMask=(1<<lp)-1;
function l2p(len){len-=2;return len<4?len:3;}
for(;;){
if(hasSize&&nowPos>=unpackSize)break;
var posState=nowPos&posMask;
if(db(isMatch,(state<<4)+posState)===0){
var prevB=nowPos>0?out[nowPos-1]:0;
var litState=((nowPos&lpMask)<<lc)+(prevB>>(8-lc));
out[nowPos]=dLit(litState,state>=7?out[nowPos-rep0-1]:0,state);nowPos++;
state=state<4?0:(state<10?state-3:state-6);
}else{
var len;
if(db(isRep,state)===1){
var dist;
if(db(isRepG0,state)===0){
if(db(isRep0Long,(state<<4)+posState)===0){out[nowPos]=out[nowPos-rep0-1];nowPos++;state=state<7?9:11;continue;}
dist=rep0;
}else{
if(db(isRepG1,state)===0){dist=rep1;}
else{if(db(isRepG2,state)===0){dist=rep2;}else{dist=rep3;rep3=rep2;}rep2=rep1;}
rep1=rep0;rep0=dist;
}
len=dLen(repLenD,posState)+2;state=state<7?8:11;
}else{
rep3=rep2;rep2=rep1;rep1=rep0;
len=dLen(lenD,posState)+2;state=state<7?7:10;
var ps=bt(posSlot,l2p(len)*64,6);
if(ps>=4){
var ndb=(ps>>1)-1;
rep0=(2|(ps&1))<<ndb;
if(ps<14){rep0+=btr(posDec,rep0-ps-1,ndb);}
else{rep0+=dd(ndb-4)<<4;rep0+=btr(align,0,4);if((rep0>>>0)===4294967295)break;}
}else{rep0=ps;}
}
for(var i=0;i<len;i++){out[nowPos]=out[nowPos-rep0-1];nowPos++;if(hasSize&&nowPos>=unpackSize)break;}
}
}
return out;}`;
}
