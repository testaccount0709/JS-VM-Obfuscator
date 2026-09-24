#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { obfuscate, stageTimings } from "../core/pipeline.js";
import {
  DEFAULT_OPTIONS, mergeOptions, applyPreset, levelAll,
  parseLevel, parsePack, parseEnvLock, parseVmDecryptMode, type Options, type PresetName, type ConfigFile,
} from "../core/config.js";
import { packStage1, packStage2 } from "../packer/stage1.js";
import { packStage3 } from "../packer/stage3.js";

const program = new Command();

program
  .name("jsvobf")
  .description("Advanced JavaScript VM obfuscator + two-stage packer")
  .argument("<input>", "input bundled .js file")
  .option("-o, --output <file>", "output file (default: <input>.obf.js)")
  .option("--preset <name>", "light | medium | heavy | insane | performance | compact")
  .option("--level-all", "enable every feature at max level (except antidebug)")
  .option("--vm <level>", "off | 1 | 2 | 3")
  .option("--cff <level>", "off | 1 | 2 | 3")
  .option("--strings <level>", "off | 1 | 2 | 3")
  .option("--property <level>", "off | 1 | 2 | 3")
  .option("--identifiers <level>", "off | 1 | 2")
  .option("--deadcode <level>", "off | 1 | 2")
  .option("--numbers <level>", "off | 1")
  .option("--regex <level>", "off | 1")
  .option("--scatter <level>", "off | 1")
  .option("--reshape <level>", "off | 1")
  .option("--extract-objects <level>", "off | 1 | 2")
  .option("--rfactory <level>", "off | 1 | 2")
  .option("--antidebug <level>", "0 | 1 | 2 | 3 (opt-in only)")
  .option("--pack <mode>", "off | stage1 | stage2 | stage3")
  .option("--env <mode>", "environment lock: auto | browser | node")
  .option("--camouflage <onoff>", "on | off")
  .option("--extra-flattening", "re-enable full runtime CFF flattening (bigger output, stronger protection)")
  .option("--seed <n>", "RNG seed for reproducible builds")
  .option("--vm-threshold <n>", "min statements for VM virtualization")
  .option("--vm-decrypt <mode>", "bytecode decrypt: cache | volatile")
  .option("--vm-scatter-ft <onoff>", "scatter FT entries across shards: on | off")
  .option("--config <file>", "JSON config file (CLI flags win)")
  .option("--stats", "print build statistics")
  .addHelpText(
    "before",
    `
Presets:
  light       identifiers=2, cff=1, strings=1, property=1, numbers=1, no VM
  medium      identifiers=2, cff=2, strings=2, property=2, vm=1
  heavy       vm=2, cff=3, strings=3, property=3, deadcode=2, camouflage=on
  insane      heavy + vm=3, extract-objects=2, rfactory=2, antidebug=2
  performance identifiers=2, cff=1, strings=2, property=1, no VM, no MBA -
              keeps renaming/string/regex protection with near-baseline runtime
  compact     identifiers=2, strings=2, property=1, antidebug=1, no VM/CFF/MBA -
              targets ~25% of the insane size for the same input

Defaults: seed 1337, vm-threshold 2, camouflage off, pack off.
`,
  )
  .addHelpText(
    "after",
    `
Examples:
  jsvobf app.js --preset performance -o app.perf.js --stats
  jsvobf app.js --preset compact -o app.small.js --stats
  jsvobf app.js --preset insane --pack stage3 -o app.final.js
  jsvobf app.js --vm 0 --cff 1 --strings 2 --property 1   (hand-rolled perf build)
  jsvobf app.js --preset heavy --antidebug 2              (self-defense checks)
  jsvobf app.js --seed 42 --camouflage on -o out.js
`,
  )
  .showHelpAfterError()
  .action(async (input: string, opts: Record<string, string | undefined>) => {
    let cfg: ConfigFile | undefined;
    if (opts.config) {
      cfg = JSON.parse(readFileSync(opts.config, "utf8")) as ConfigFile;
    }

    const cli: Partial<Options> = {};
    if (opts.vm !== undefined) cli.vm = parseLevel(opts.vm, 3);
    if (opts.cff !== undefined) cli.cff = parseLevel(opts.cff, 3);
    if (opts.strings !== undefined) cli.strings = parseLevel(opts.strings, 3);
    if (opts.property !== undefined) cli.property = parseLevel(opts.property, 3);
    if (opts.identifiers !== undefined) cli.identifiers = parseLevel(opts.identifiers, 2);
    if (opts.deadcode !== undefined) cli.deadcode = parseLevel(opts.deadcode, 2);
    if (opts.numbers !== undefined) cli.numbers = parseLevel(opts.numbers, 1);
    if (opts.regex !== undefined) cli.regex = parseLevel(opts.regex, 1);
    if (opts.scatter !== undefined) cli.scatter = parseLevel(opts.scatter, 1);
    if (opts.reshape !== undefined) cli.reshape = parseLevel(opts.reshape, 1);
    if (opts.extractObjects !== undefined) cli.extractObjects = parseLevel(opts.extractObjects, 2);
    if (opts.rfactory !== undefined) cli.rfactory = parseLevel(opts.rfactory, 2);
    if (opts.antidebug !== undefined) cli.antidebug = parseLevel(opts.antidebug, 3);
    if (opts.pack !== undefined) cli.pack = parsePack(opts.pack);
    if (opts.env !== undefined) cli.envLock = parseEnvLock(opts.env);
    if (opts.seed !== undefined) cli.seed = Number(opts.seed);
    if (opts.vmThreshold !== undefined) cli.vmThreshold = Number(opts.vmThreshold);
    if (opts.vmDecrypt !== undefined) cli.vmDecryptMode = parseVmDecryptMode(opts.vmDecrypt);
    if (opts.vmScatterFt !== undefined) {
      if (opts.vmScatterFt !== "on" && opts.vmScatterFt !== "off") throw new Error("--vm-scatter-ft expects on|off");
      cli.vmScatterFt = opts.vmScatterFt === "on";
    }
    if (opts.camouflage !== undefined) {
      if (opts.camouflage !== "on" && opts.camouflage !== "off") throw new Error("--camouflage expects on|off");
      cli.camouflage = opts.camouflage === "on";
    }
    if (opts.extraFlattening !== undefined) cli.extraFlattening = true;

    let options = mergeOptions(cli, cfg);
    if (opts.preset) options = applyPreset(options, opts.preset as PresetName);
    if (opts.levelAll) options = levelAll(options);
    // re-apply explicit CLI flags so they win over preset/levelAll
    options = { ...options, ...stripUndefined(cli) };

    const source = readFileSync(input, "utf8");
    const result = obfuscate(source, options);
    let code = result.code;

    const integrity = options.antidebug >= 2;
    let packMs = 0;
    if (options.pack !== "off") {
      const packT0 = Date.now();
      if (options.pack === "stage1") {
        code = packStage1(code, options.seed, integrity);
      } else if (options.pack === "stage2") {
        code = await packStage2(code, options.seed, integrity);
      } else if (options.pack === "stage3") {
        code = await packStage3(code, options.seed, integrity);
      }
      packMs = Date.now() - packT0;
    }

    const out = opts.output ?? input.replace(/\.js$/i, "") + ".obf.js";
    writeFileSync(out, code, "utf8");

    if (opts.stats) {
      const s = result.stats;
      console.log(`input:            ${s.inputSize} bytes`);
      console.log(`output:           ${s.outputSize} bytes`);
      console.log(`entropy:          ${s.entropy} bits/char`);
      console.log(`virtualized fns:  ${s.virtualizedFunctions}`);
      const vmExcl = Object.entries(s)
        .filter(([k, v]) => k.startsWith("vmExcl_") && v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (vmExcl.length > 0) {
        console.log("vm exclusions:");
        for (const [k, v] of vmExcl) console.log(`  ${k.slice(7)}: ${v}`);
      }
      if ((s.vmCompileFailed ?? 0) > 0) console.log(`vm compile fail:  ${s.vmCompileFailed}`);
      console.log(`flattened fns:    ${s.flattenedFunctions}`);
      console.log(`encrypted strings:${s.encryptedStrings}`);
      console.log(`lowered props:    ${s.loweredPropertyAccesses}`);
      console.log(`encoded numbers:  ${s.encodedNumbers}`);
      console.log(`lowered regex:    ${s.loweredRegex}`);
      console.log(`dead branches:    ${s.injectedDeadBranches}`);
      console.log(`scattered fns:    ${s.functionsScattered}`);
      console.log(`reshaped fns:     ${s.functionsReshaped}`);
      console.log(`extracted objs:   ${s.objectsExtracted}`);
      console.log(`generated fns:    ${s.functionsGenerated}`);
      if (options.pack !== "off") console.log(`pack chunks:      ${s.chunks}`);
      const timings = stageTimings(s);
      if (timings.length > 0) {
        const totalMs = timings.reduce((n, t) => n + t.ms, 0);
        console.log("stage timings:");
        for (const { stage, ms } of timings) {
          const pct = totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : "0.0";
          console.log(`  ${stage.padEnd(16)} ${String(ms).padStart(6)} ms  (${pct}%)`);
        }
        console.log(`  ${"total".padEnd(16)} ${String(totalMs).padStart(6)} ms`);
      }
      if (packMs > 0) console.log(`pack time:        ${packMs} ms`);
    }
    console.log(`wrote ${out}`);
  });

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

program.parse();
