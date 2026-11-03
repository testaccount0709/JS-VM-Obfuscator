# JS-VM-Obfuscator

JS-VM-Obfuscator, or **jsvobf** for short, is a Babel-based JavaScript obfuscator. Has been put back up on 9/24/26


## Layout

```
src/
  index.ts              public API
  cli/main.ts           jsvobf command
  core/                 options, shared context, pipeline
  passes/               AST transforms
  vm/                   bytecode compiler and interpreter
  packer/               post-generation wrappers (stage1–3)
  utils/                RNG, codecs, naming, opaque predicates
```

## Getting Started

Requires Node.js 18 or newer.

```bash
npm install
```

Run the CLI against a bundled script (CJS or IIFE). The npm script uses `tsx`, so a build is not required:

```bash
npm run jsvobf -- app.js --preset medium -o app.obf.js
```

With no `-o`, the output is written next to the input as `app.obf.js`.

To install the `jsvobf` command, build first:

```bash
npm run build
npx jsvobf app.js --preset medium -o app.obf.js
```

Print the full flag list, presets, and examples:

```bash
npm run jsvobf -- --help
```

`-h` is the same flag. After a build, `npx jsvobf --help` prints the same text.

## Entry points

`index.ts` exports the library surface:

- `obfuscate(source, options)`: parse, transform, generate. Returns `{ code, stats }`.
- `PIPELINE_STAGES` and `stageTimings(stats)`: ordered stage names and the `time_<stage>` measurements stored on `stats`.
- `DEFAULT_OPTIONS`, `PRESETS`, `mergeOptions`, `applyPreset`, `levelAll`.
- `packStage1` / `packStage2`. Stage 3 is CLI-only (`packer/stage3.ts`).

`cli/main.ts` is a CLI wrapper for `index.ts` that reads a bundled `.js` file, merges flags, runs `obfuscate`, and packs if requested. Option precedence is defaults, then the JSON config file, then `--preset` / `--level-all`, then explicit CLI flags.

## Source Info / Technical Info

### Pipeline Info

`core/pipeline.ts` runs stages in this order. A stage is a no-op when its option level is `0`.

| Stage | Module | What it does |
| --- | --- | --- |
| `parse` | `@babel/parser` | `sourceType: "unambiguous"`. |
| `lift-nested` | `passes/lift-nested-functions.ts` | Hoists safe nested functions so more of the program can be virtualized. Runs only when `vm >= 1`. |
| `scope-analysis` | `passes/scope-analysis.ts` | Builds `ScopeInfo`: which functions are internal, call graphs, and what blocks renaming (`eval`, `with`). |
| `extract-objects` | `passes/extract-objects.ts` | Dissolves object literals whose only uses are static-key reads into per-property bindings. |
| `numbers` | `passes/numbers.ts` | Rewrites numeric literals as mixed boolean-arithmetic expressions (`utils/mba.ts`). |
| `property` | `passes/property.ts` | Lowers member read, write, call, `in`, and `delete` through runtime helpers keyed by opaque tokens. |
| `regex` | `passes/regex.ts` | Turns regex literals into `new RegExp(...)` so the strings pass can encrypt the pattern. |
| `strings` | `passes/strings.ts` | Encrypts string literals into scattered tables decoded by the runtime. |
| `session` | `passes/strings.ts` (`ensureSession`) | Injects the session-key initializer the decoders depend on. |
| `reshape` | `passes/reshape.ts` | Permutes parameter order of internal functions and rewrites their direct call sites. |
| `scatter` | `passes/scatter.ts` | Clones internal functions and splits call sites across the clones. |
| `cff` | `passes/cff.ts` | Flattens function bodies into a dispatcher driven by opaque predicates. |
| `vm` | `vm/embed.ts` | Compiles eligible functions to bytecode and replaces them with interpreter stubs. |
| `antidebug` | `passes/antidebug.ts` | Adds opt-in integrity checks that corrupt keys or trip the VM guard. |
| `inject-runtime` | `core/pipeline.ts` | Assembles runtime fragments and splices them into the program, keeping `"use strict"` first. |
| `runtime-cff` | `passes/cff.ts` | Flattens the runtime's own helpers. Off unless `--extra-flattening`. |
| `deadcode` | `passes/deadcode.ts` | Inserts unreachable branches and decoy literals. |
| `rfactory` | `passes/runtime-factory.ts` | Replaces static `function` declarations with an invoked factory so the declaration disappears. |
| `identifiers` | `passes/identifiers.ts` | Renames bindings last, so names introduced by earlier passes are covered too. Also mangles private names. |
| `generate` | `@babel/generator` | Emits the script. `camouflage` switches on compact output and a fake license banner. |

### Shared state

`core/context.ts` is the object every pass receives.

- `Context` holds the merged `Options`, the `RNG`, a set of names already taken, the runtime builder, and `stats`.
- `RuntimeBuilder` collects source fragments from passes (string tables, property resolvers, the VM). Data-only fragments are scattered through the program; the executable IIFE is inserted so it runs before the session initializer. Capability names (`decode`, `vmRun`, …) are defined in `utils/runtime-api.ts` and given a fresh public name per build.
- `isRuntimePath` lets later passes skip nodes that belong to the injected runtime.

### Levels

Each transform is a `Level` (`0 | 1 | 2 | 3`). `0` is off. Higher levels add work inside that pass:

| Option | 1 | 2 | 3 |
| --- | --- | --- | --- |
| `vm` | Sequential opcodes, switch dispatch | Permuted opcodes, shuffled handlers | Alias opcodes, dead handlers, rolling bytecode decrypt |
| `cff` | Light flattening | Stronger opaque predicates | Full dispatcher, including nested structure |
| `strings` | One table, one global key | Per-string stream keys | Spilled fragments reassembled at the use site |
| `property` | Tokenized member access | Computed keys, more helper variants | Proxy around the resolver only |
| `identifiers` | Minified names | Confusing names, private-name mangling, shadow decoys |: |
| `deadcode` | Opaque dead branches | Heavier decoys |: |
| `extract-objects` | Static-key reads | Also `++` and compound assignment |: |
| `rfactory` | Factory-wrapped declarations | Decoy metadata on the produced function |: |
| `antidebug` | Debugger timing corrupts the string key | Constructor / `toString` checks, checksums | Cache trap and a second key-table checksum |
| `numbers`, `regex`, `scatter`, `reshape` | On or off |: |: |

`antidebug` stays off in `levelAll()`. It is on in the `insane` preset (`2`) and the `compact` preset (`1`).

Presets in `core/config.ts`: `light`, `medium`, `heavy`, `insane`, `performance` (no VM, no MBA), `compact` (no VM, no CFF, smaller output).

### Virtual machine

`vm/` turns a function into a stub that calls the embedded interpreter.

- `ops.ts`: opcode names. Numbering is sequential at level 1 and shuffled per build from level 2.
- `compile.ts`: lowers one function body to bytecode. Throws `CompileError` when a construct cannot be represented; that function is left as source and counted in `stats`.
- `interpreter.ts`: emits the interpreter function for the build's opcode map.
- `embed.ts`: selects functions at or above `vmThreshold` statements, compiles them, and installs the runtime entry (`vmRun`).

### Packer

Packing runs after generation, in the CLI. Each stage wraps the previous artifact. `integrity` (on when `antidebug >= 2`) checks that the function constructor still looks native before invoking the payload.

| Mode | Module | Layer |
| --- | --- | --- |
| `stage1` | `packer/stage1.ts` | XOR keystream, chunked codecs, reconstruction via opaque predicates. The payload runs through a captured function constructor, not a literal `eval`. |
| `stage2` | `packer/stage2.ts` | LZMA-compresses the stage-1 script and embeds a decoder. |
| `stage3` | `packer/stage3.ts` | Gzip-compresses the stage-2 script and inflates it with `DecompressionStream`. |

### Utilities

| File | Role |
| --- | --- |
| `utils/rng.ts` | Seeded PRNG used by every pass. |
| `utils/codec.ts` | Base64 alphabets, UTF-8, xorshift32 keystreams. |
| `utils/mba.ts` | Mixed boolean-arithmetic expressions that fold to a constant. |
| `utils/predicates.ts` | Opaque predicates (MBA, parity, exceptions, coercions) used by CFF, dead code, and the packer. |
| `utils/names.ts` | Minified and homoglyph-style identifiers, reserved-word checks, decoy global names. |
| `utils/entropy.ts` | Shannon entropy reported in `--stats`. |
| `utils/babel.ts` | Default-export unwrap for `@babel/traverse` and `@babel/generator`. |
