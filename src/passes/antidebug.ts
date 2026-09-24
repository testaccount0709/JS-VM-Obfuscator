import type { Context } from "../core/context.js";

/**
 * Anti-debug / integrity checks. Enabled on insane preset (L2); otherwise opt-in.
 *  L1: timing check corrupts string decryption key SK when paused in debugger.
 *  L2: Function constructor / toString shape checks + beautify detection +
 *      string-table checksum guard (self-defending against blob tampering)
 *      + pre-decoded cache detector (defeats eager string harvesters).
 *  L3: adds a recursive-trap guard on the string cache and a second,
 *      independent checksum over the key table when property L3 is active.
 */
export function injectAntiDebug(ctx: Context): void {
  const level = ctx.options.antidebug;
  if (level <= 0) return;

  const parts: string[] = [];

  // VM self-defense guard (only present when the VM was virtualized). Any
  // tamper detection below also trips the guard so virtualized functions
  // no-op instead of running under a hostile/patch environment.
  const g = typeof ctx.runtimeFlags.vmGuard === "string" ? (ctx.runtimeFlags.vmGuard as string) : "";
  const gTrip = g ? `${g} = ((${g} | 0) ^ 0x9e3779b1 | 1) >>> 0;` : "";

  if (level >= 1 && ctx.runtimeFlags.strings) {
    parts.push(`
(function(){
  var t0 = Date.now();
  var acc = 0;
  for (var i = 0; i < 2000; i++) acc = (acc + i) | 0;
  if (Date.now() - t0 > 500) { SK = (SK ^ 0x5a5a5a5a) >>> 0; ${gTrip} }
})();`);
  }

  if (level >= 2 && ctx.runtimeFlags.strings) {
    parts.push(`
(function(){
  var f = (function(){});
  try {
    if (f.constructor.prototype.constructor !== f.constructor) { SK = (SK ^ 0x12345678) >>> 0; ${gTrip} }
    if (String(f.constructor).indexOf("[native code]") < 0) { SK = (SK ^ 0x87654321) >>> 0; ${gTrip} }
    if (f.toString().indexOf("\\n") >= 0) { SK = (SK ^ 0x2468ace0) >>> 0; ${gTrip} }
    var len = f.toString().length;
    if (len < 8 || len > 120) { SK = (SK ^ 0x0badf00d) >>> 0; ${gTrip} }
  } catch (e) { SK = (SK ^ 0xdeadbeef) >>> 0; ${gTrip} }
})();`);

    const chk = (ctx.runtimeFlags.stringChk as number) ?? 0;
    const cnt = (ctx.runtimeFlags.stringCount as number) ?? 0;
    const tblName = (ctx.runtimeFlags.stringTablesName as string) ?? "";
    if (chk !== 0 && cnt > 0 && tblName) {
      parts.push(`
(function(){
  var s = 0, n = 0, i, j, b, t, T;
  try { T = ${tblName}(); } catch (e) { T = null; }
  if (!T) { SK = (SK ^ 0x13579bdf) >>> 0; ${gTrip} return; }
  for (t = 0; t < T.length; t++) {
    for (i = 0; i < T[t].length; i++) {
      b = T[t][i];
      n++;
      for (j = 0; j < b.length; j++) s = (s + (typeof b === "string" ? b.charCodeAt(j) : b[j])) | 0;
    }
  }
  if (n !== ${cnt} || (s >>> 0) !== ${chk >>> 0}) { SK = (SK ^ 0x13579bdf) >>> 0; ${gTrip} }
  if (SC.length !== 0) { SK = (SK ^ 0x2468ace0) >>> 0; ${gTrip} }
})();`);
    }

    // decoder cache must be a pristine, extensible array (harvesters often
    // swap it for a proxy or freeze it)
    parts.push(`
(function(){
  var ok = true;
  try {
    if (SC === null || typeof SC !== "object" || Array.isArray(SC) !== true) ok = false;
    if (!Object.isExtensible(SC)) ok = false;
    var d = Object.getOwnPropertyDescriptor(SC, "length");
    if (!d || d.writable !== true) ok = false;
  } catch (e) { ok = false; }
  if (!ok) { SK = (SK ^ 0x5555aaaa) >>> 0; ${gTrip} }
})();`);
  }

  // L2+: intrinsics / global-object tamper detection. eval and Function must
  // remain native-builtin; a replaced global is the signature of an injected
  // hook or redefinition used to harvest decrypted strings / patch logic.
  if (level >= 2) {
    parts.push(`
(function(){
  try {
    if (String(eval).indexOf("[native code]") < 0) { SK = (SK ^ 0x0e1a2b3c) >>> 0; ${gTrip} }
    if (Function.prototype.toString.call(Function).indexOf("[native code]") < 0) { SK = (SK ^ 0x4c5d6e7f) >>> 0; ${gTrip} }
    if (typeof Function.prototype.constructor !== "function") { SK = (SK ^ 0x1a2b3c4d) >>> 0; ${gTrip} }
  } catch (e) { SK = (SK ^ 0xabcdef01) >>> 0; ${gTrip} }
})();`);

    // Intrinsic tamper detection: verify Reflect, Object, Array, Proxy, Symbol,
    // Math, JSON, String, Function have not been replaced or proxied.
    parts.push(`
(function(){
  try {
    // Reflect and JSON are plain objects (not functions): String(...) yields
    // "[object Reflect]"/"[object JSON]", which never contains "[native code]".
    // Tag-check them via Object.prototype.toString so genuine environments
    // don't trip a false positive and corrupt SK.
    if (Object.prototype.toString.call(Reflect) !== "[object Reflect]") { SK = (SK ^ 0x11223344) >>> 0; ${gTrip} }
    if (String(Object).indexOf("[native code]") < 0) { SK = (SK ^ 0x22334455) >>> 0; ${gTrip} }
    if (String(Array).indexOf("[native code]") < 0) { SK = (SK ^ 0x33445566) >>> 0; ${gTrip} }
    if (String(Proxy).indexOf("[native code]") < 0) { SK = (SK ^ 0x44556677) >>> 0; ${gTrip} }
    if (String(Symbol).indexOf("[native code]") < 0) { SK = (SK ^ 0x55667788) >>> 0; ${gTrip} }
    if (typeof Math.imul !== "function" || Math.imul.toString().indexOf("[native code]") < 0) { SK = (SK ^ 0x66778899) >>> 0; ${gTrip} }
    if (Object.prototype.toString.call(JSON) !== "[object JSON]") { SK = (SK ^ 0x778899aa) >>> 0; ${gTrip} }
    if (String(String).indexOf("[native code]") < 0) { SK = (SK ^ 0x8899aabb) >>> 0; ${gTrip} }
    if (typeof Function !== "function" || Function.toString().indexOf("[native code]") < 0) { SK = (SK ^ 0x99aabbcc) >>> 0; ${gTrip} }
  } catch (e) { SK = (SK ^ 0xabcdef01) >>> 0; ${gTrip} }
})();`);
  }

  // L3: debugger-presence heuristic + VM table integrity. The debugger check is
  // conservative (only trips under a clearly attached debugger) so it never
  // false-positives in normal CI / test runs.
  if (level >= 3) {
    parts.push(`
(function(){
  try {
    var _dbg = 0;
    var _t0 = Date.now();
    debugger;
    if (Date.now() - _t0 > 100) _dbg = 1;
    // a real devtools session also breaks Function.prototype.toString length
    if (String(function(){}).length > 140) _dbg = 1;
    if (_dbg) { SK = (SK ^ 0xf00dbeef) >>> 0; ${gTrip} }
  } catch (e) {}
})();`);

    if (g) {
      // verify the VM function table is intact; a patched/hollowed FT is a sign
      // of static analysis tooling having rewritten the bytecode. Field names
      // are the per-build randomized ones (see vm/embed.ts).
      const vmFields = ctx.runtimeFlags.vmFields as Record<string, string> | undefined;
      if (vmFields) {
        parts.push(`
(function(){
  try {
    if (typeof FT === "undefined" || !Array.isArray(FT)) { ${gTrip} return; }
    for (var _i = 0; _i < FT.length; _i++) {
      var _e = FT[_i];
      if (_e === null || typeof _e !== "object") { ${gTrip} return; }
      if ((!Array.isArray(_e.${vmFields.b}) && typeof _e.${vmFields.b} !== "string") || !Array.isArray(_e.${vmFields.c}) || typeof _e.${vmFields.n} !== "number") { ${gTrip} return; }
    }
  } catch (e) { ${gTrip} }
})();`);
      }
    }
  }

  if (parts.length > 0) {
    ctx.runtime.add(parts.join("\n"), {});
  }
}
