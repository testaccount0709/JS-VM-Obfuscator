import { parse } from "@babel/parser";
import { traverse, generate } from "../utils/babel.js";
import * as t from "@babel/types";
import { RNG } from "../utils/rng.js";
import { utf8Encode, toBase64, shuffledAlphabet, B64_STD, xorBytes, xorshift32Keystream, randomKeystream } from "../utils/codec.js";
import type { KeystreamLike } from "../utils/codec.js";
import { opaquePredicate } from "../utils/predicates.js";
import { confusingName } from "../utils/names.js";
import { packStage1 } from "./stage1.js";

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

/** Enhanced Stage 2 — LZMA layer wrapping Stage 1. */
export async function packStage2(artifact: string, seed: number, integrity = false): Promise<string> {
  const rng = new RNG(BigInt(seed >>> 0) | 0x200000000n);
  const used = new Set<string>();
  const nm = () => confusingName(rng, used, 2);

  const stage1 = packStage1(artifact, seed, integrity);
  const stage1Bytes = utf8Encode(stage1);

  const lzma: any = await import("lzma");
  const compressed: number[] = await new Promise((resolve, reject) => {
    lzma.default.compress(stage1Bytes, 1, (result: number[]) => {
      if (result) resolve(result.map((b) => b & 0xff));
      else reject(new Error("lzma compress failed"));
    });
  });

  const header = compressed.slice(0, 13);
  const body = compressed.slice(13);

  const keySeed = (rng.int(0x7ffffffe) + 1) | 0;
  const ks = randomKeystream(rng);
  const headerKs = xorshift32Keystream(keySeed, header.length, ks);
  const maskedHeader = xorBytes(header, headerKs);
  const bodyKs = xorshift32Keystream(keySeed ^ 0x5a5a5a5a, body.length, ks);
  const maskedBody = xorBytes(body, bodyKs);

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
  const sink = sinkSource(rng, srcVar, false);

  const segDecls = segments.map((s, i) => `var ${segVars[i]}=${JSON.stringify(toBase64(s, alph))};`).join("\n");
  let segConcat = `b64d(${segVars[0]})`;
  for (let i = 1; i < segVars.length; i++) segConcat += `.concat(b64d(${segVars[i]}))`;

  const wrapper = `(function(){
"use strict";
var ${hdrVar}=${JSON.stringify(toBase64(maskedHeader, alph))};
${segDecls}
var AL=${JSON.stringify(alph)};
function b64d(s){var o=[],buf=0,bits=0;for(var i=0;i<s.length;i++){var ch=s.charAt(i);if(ch==="=")break;var v=AL.indexOf(ch);if(v<0)continue;buf=(buf<<6)|v;bits+=6;if(bits>=8){bits-=8;o.push((buf>>bits)&255);}}return o;}
function unm(a,k){var x=k>>>0;if(x===0)x=1;var o=[];for(var i=0;i<a.length;i++){${ksStepJs("x", ks)}o.push(a[i]^(x&255));}return o;}
${decoderSrc}
var hdr=unm(b64d(${hdrVar}),${keySeed});
var bod=unm(${segConcat},${keySeed ^ 0x5a5a5a5a});
var full=hdr.concat(bod);
var ${srcVar}=(function(a){var s="",i=0;while(i<a.length){var b=a[i++];if(b<128){s+=String.fromCharCode(b);}else if(b<224){s+=String.fromCharCode(((b&31)<<6)|(a[i++]&63));}else if(b<240){s+=String.fromCharCode(((b&15)<<12)|((a[i++]&63)<<6)|(a[i++]&63));}else{var cp=((b&7)<<18)|((a[i++]&63)<<12)|((a[i++]&63)<<6)|(a[i++]&63);cp-=65536;s+=String.fromCharCode(55296+(cp>>10),56320+(cp&1023));}}return s;})(${decoderName}(full));
${sink}
})();`;

  return renameDepackerLocals(wrapper, rng);
}

async function renameDepackerLocals(src: string, rng: RNG): Promise<string> {
  const { parse } = await import("@babel/parser");
  const { traverse, generate } = await import("../utils/babel.js");
  let ast;
  try {
    ast = parse(src, { sourceType: "script" });
  } catch (e) {
    const fs = await import("fs");
    fs.writeFileSync("stage2.fail.js", src);
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

// ---- LZMA Decoder ----
function lzmaDecoderSource(fnName: string): string {
  const lines = [
    "function " + fnName + "(input){",
    "var ip=0;function rb(){return input[ip++]&255;}",
    "var props=rb();",
    "var dictSize=rb()|(rb()<<8)|(rb()<<16)|(rb()<<24);",
    "var usLo=(rb()|(rb()<<8)|(rb()<<16)|(rb()<<24))>>>0;",
    "var usHi=(rb()|(rb()<<8)|(rb()<<16)|(rb()<<24))>>>0;",
    "var hasSize=!(usLo===4294967295&&usHi===4294967295);",
    "var unpackSize=usLo;",
    "var lc=props%9;var tmp=(props/9)|0;var lp=tmp%5;var pb=(tmp/5)|0;",
    "function np(n){var a=new Array(n);for(var i=0;i<n;i++)a[i]=1024;return a;}",
    "var range=4294967295,code=0;",
    "rb();",
    "code=((rb()<<24)|(rb()<<16)|(rb()<<8)|rb())>>>0;",
    "function norm(){while((range>>>0)<16777216){range=(range<<8)>>>0;code=((code<<8)|rb())>>>0;}}",
    "function db(p,i){var pr=p[i];var nb=((range>>>11)*pr)>>>0;var b;if((code>>>0)<nb){b=0;range=nb;p[i]=(pr+((2048-pr)>>>5))&65535;}else{b=1;range=(range-nb)>>>0;code=(code-nb)>>>0;p[i]=(pr-(pr>>>5))&65535;}norm();return b;}",
    "function dd(bits){var r=0;for(var i=0;i<bits;i++){range=(range>>>1)>>>0;if((code>>>0)>=(range>>>0)){code=(code-range)>>>0;r=((r<<1)|1)>>>0;}else{r=(r<<1)>>>0;}norm();}return r;}",
    "function bt(p,base,nb){var m=1;for(var i=0;i<nb;i++)m=(m<<1)|db(p,base+m);return m-(1<<nb);}",
    "function btr(p,base,nb){var m=1,s=0;for(var i=0;i<nb;i++){var b=db(p,base+m);m=(m<<1)|b;s|=b<<i;}return s;}",
    "var isMatch=np(192),isRep=np(12),isRepG0=np(12),isRepG1=np(12),isRepG2=np(12),isRep0Long=np(192);",
    "var posSlot=np(256),posDec=np(115),align=np(16);",
    "var litProbs=np(768<<(lc+lp));",
    "function mkLen(){return{ch:np(1),ch2:np(1),low:np(128),mid:np(128),high:np(256)};}",
    "var lenD=mkLen(),repLenD=mkLen();",
    "function dLen(L,ps){if(db(L.ch,0)===0)return bt(L.low,ps*8,3);if(db(L.ch2,0)===0)return 8+bt(L.mid,ps*8,3);return 16+bt(L.high,0,8);}",
    "function dLit(ls,pb2,st){var base=768*ls;var sym=1;if(st>=7){var mb=pb2;for(;;){var mbit=(mb>>7)&1;mb=(mb<<1)&255;var b=db(litProbs,base+((1+mbit)<<8)+sym);sym=(sym<<1)|b;if(mbit!==b){while(sym<256)sym=(sym<<1)|db(litProbs,base+sym);break;}if(sym>=256)break;}}else{while(sym<256)sym=(sym<<1)|db(litProbs,base+sym);}return sym&255;}",
    "var out=[];var nowPos=0;var state=0;var rep0=0,rep1=0,rep2=0,rep3=0;",
    "var posMask=(1<<pb)-1;var lpMask=(1<<lp)-1;",
    "function l2p(len){len-=2;return len<4?len:3;}",
    "for(;;){",
    "if(hasSize&&nowPos>=unpackSize)break;",
    "var posState=nowPos&posMask;",
    "if(db(isMatch,(state<<4)+posState)===0){",
    "var prevB=nowPos>0?out[nowPos-1]:0;",
    "var litState=((nowPos&lpMask)<<lc)+(prevB>>(8-lc));",
    "out[nowPos]=dLit(litState,state>=7?out[nowPos-rep0-1]:0,state);nowPos++;",
    "state=state<4?0:(state<10?state-3:state-6);",
    "}else{",
    "var len;",
    "if(db(isRep,state)===1){",
    "var dist;",
    "if(db(isRepG0,state)===0){",
    "if(db(isRep0Long,(state<<4)+posState)===0){out[nowPos]=out[nowPos-rep0-1];nowPos++;state=state<7?9:11;continue;}",
    "dist=rep0;",
    "}else{",
    "if(db(isRepG1,state)===0){dist=rep1;}",
    "else{if(db(isRepG2,state)===0){dist=rep2;}else{dist=rep3;rep3=rep2;}rep2=rep1;}",
    "rep1=rep0;rep0=dist;",
    "}",
    "len=dLen(repLenD,posState)+2;state=state<7?8:11;",
    "}else{",
    "rep3=rep2;rep2=rep1;rep1=rep0;",
    "len=dLen(lenD,posState)+2;state=state<7?7:10;",
    "var ps=bt(posSlot,l2p(len)*64,6);",
    "if(ps>=4){",
    "var ndb=(ps>>1)-1;",
    "rep0=(2|(ps&1))<<ndb;",
    "if(ps<14){rep0+=btr(posDec,rep0-ps-1,ndb);}",
    "else{rep0+=dd(ndb-4)<<4;rep0+=btr(align,0,4);if((rep0>>>0)===4294967295)break;}",
    "}else{rep0=ps;}",
    "}",
    "for(var i=0;i<len;i++){out[nowPos]=out[nowPos-rep0-1];nowPos++;if(hasSize&&nowPos>=unpackSize)break;}",
    "}",
    "}",
    "return out;",
    "}"
  ];
  return lines.join("\n");
}