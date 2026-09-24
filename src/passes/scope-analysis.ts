import { traverse } from "../utils/babel.js";
import { parse } from "@babel/parser";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Context } from "../core/context.js";

export type FunctionNode =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.ClassMethod
  | t.ClassPrivateMethod;

export interface InternalCallInfo {
  bindingName: string;
  bindingPath: NodePath;
  callSites: NodePath<t.CallExpression>[];
}

export interface ScopeInfo {
  isModule: boolean;
  programStrict: boolean;
  /** Functions eligible for VM virtualization. */
  vmEligible: Set<FunctionNode>;
  /** Exclusion reasons for debugging/stats. */
  vmExcluded: Map<FunctionNode, string>;
  /** Per-function strictness (propagated from program/directives). */
  fnStrict: Map<FunctionNode, boolean>;
  /** Scopes (path nodes) where renaming is blocked (with statement visible). */
  renameBlockedScopes: Set<t.Node>;
  /**
   * Individual bindings whose names must not change. Direct eval sees only the
   * bindings on its own scope chain (its source is a string, so its references
   * cannot be renamed with the AST); blocking just those bindings — instead of
   * every binding in every enclosing scope — lets unrelated functions/locals
   * still be renamed.
   */
  renameBlockedBindings: Set<t.Node>;
  /** Functions whose .length/.name/.prototype is observed. */
  metaObserved: Set<FunctionNode>;
  /** Functions invoked with `new`. */
  constructed: Set<FunctionNode>;
  /** Functions that are only ever called directly at known sites (reshape candidates). */
  internalCalls: Map<FunctionNode, InternalCallInfo>;
  /** Direct eval present anywhere. */
  hasDirectEval: boolean;
}

const FUNCTION_TYPES = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
];

function isFunctionNode(n: t.Node | null | undefined): n is FunctionNode {
  return !!n && (FUNCTION_TYPES as string[]).includes(n.type);
}

/** True for getter/setter accessors, which cannot become parameterized stubs. */
function isAccessor(fn: FunctionNode): boolean {
  if (t.isObjectMethod(fn) || t.isClassMethod(fn) || t.isClassPrivateMethod(fn)) {
    return fn.kind === "get" || fn.kind === "set";
  }
  return false;
}

/** True when `decl` is a FunctionDeclaration among leading declarations in `fn`'s block body. */
function isLeadingFunctionDeclaration(
  decl: t.FunctionDeclaration,
  fn: FunctionNode,
): boolean {
  if (!t.isBlockStatement(fn.body)) return false;
  const body = fn.body.body;
  const idx = body.indexOf(decl);
  if (idx < 0) return false;
  for (let i = 0; i < idx; i++) {
    if (!t.isFunctionDeclaration(body[i])) return false;
  }
  return true;
}

function isPrototypeIntrinsicMember(node: t.MemberExpression): boolean {
  if (node.computed) return false;
  if (t.isIdentifier(node.property, { name: "prototype" })) {
    return t.isIdentifier(node.object, { name: "Function" })
      || t.isIdentifier(node.object, { name: "Object" })
      || t.isIdentifier(node.object, { name: "Array" })
      || t.isIdentifier(node.object, { name: "Reflect" });
  }
  const obj = node.object;
  if (!t.isMemberExpression(obj) || obj.computed) return false;
  if (!t.isIdentifier(obj.property, { name: "prototype" })) return false;
  return t.isIdentifier(obj.object, { name: "Function" })
    || t.isIdentifier(obj.object, { name: "Object" })
    || t.isIdentifier(obj.object, { name: "Array" })
    || t.isIdentifier(obj.object, { name: "Reflect" });
}

export function analyzeScopes(ast: t.File, ctx: Context): ScopeInfo {
  const info: ScopeInfo = {
    isModule: ast.program.sourceType === "module",
    programStrict: false,
    vmEligible: new Set(),
    vmExcluded: new Map(),
    fnStrict: new Map(),
    renameBlockedScopes: new Set(),
    renameBlockedBindings: new Set(),
    metaObserved: new Set(),
    constructed: new Set(),
    internalCalls: new Map(),
    hasDirectEval: false,
  };

  // --- program strictness ---
  info.programStrict =
    info.isModule || ast.program.directives.some((d) => d.value.value === "use strict");
  ctx.isStrict = info.programStrict;
  ctx.hasUseStrict = ast.program.directives.some((d) => d.value.value === "use strict");

  // --- detect module format ---
  let sawImportExport = false;
  let sawCjs = false;
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node) || t.isExportNamedDeclaration(node) || t.isExportDefaultDeclaration(node) || t.isExportAllDeclaration(node)) {
      sawImportExport = true;
    }
  }
  traverse(ast, {
    ReferencedIdentifier(path: NodePath<t.Identifier>) {
      const n = path.node.name;
      if ((n === "module" || n === "exports" || n === "require" || n === "__dirname" || n === "__filename") && !path.scope.getBinding(n)) {
        sawCjs = true;
      }
    },
  });
  ctx.sourceFormat = sawImportExport ? "esm" : sawCjs ? "cjs" : "iife";

  // --- direct eval / with: block renaming up the scope chain ---
  const rblock = analyzeRenameBlocking(ast);
  for (const n of rblock.scopes) info.renameBlockedScopes.add(n);
  for (const n of rblock.bindings) info.renameBlockedBindings.add(n);
  if (rblock.bindings.size > 0) info.hasDirectEval = true;

  // --- per-function analysis ---
  const fnPaths: NodePath<FunctionNode>[] = [];
  traverse(ast, {
    enter(path: NodePath) {
      if (isFunctionNode(path.node)) {
        fnPaths.push(path as NodePath<FunctionNode>);
      }
    },
  });

  // strictness propagation: compute by walking parents
  for (const fnPath of fnPaths) {
    let strict = info.programStrict;
    let cur: NodePath | null = fnPath;
    const chain: NodePath[] = [];
    while (cur) {
      chain.push(cur);
      cur = cur.parentPath;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i];
      if (p.isFunction() && t.isBlockStatement(p.node.body)) {
        if ((p.node.body as t.BlockStatement).directives?.some((d) => d.value.value === "use strict")) {
          strict = true;
        }
      }
    }
    if (fnPath.isArrowFunctionExpression()) {
      // arrows inherit enclosing strictness (computed above)
    }
    info.fnStrict.set(fnPath.node, strict);
  }

  // --- exclusion scanning ---
  for (const fnPath of fnPaths) {
    const fn = fnPath.node;
    const exclude = (reason: string) => {
      info.vmExcluded.set(fn, reason);
    };

    // async and generator functions ARE supported by the VM (await compiles to
    // AWAIT; yield compiles to YIELD/YIELDDELEGATE and runs in a resumable
    // generator interpreter). for-await-of and other unsupported constructs are
    // rejected later by the compiler.

    let hasBlockingNestedFunction = false;
    let hasSuper = false;
    let hasNewTarget = false;
    let hasWith = false;
    let hasDirectEvalHere = false;
    let usesArguments = false;
    let hasLabel = false;
    let hasClass = false;
    let patchesPrototype = false;

    const patchesPrototypeIntrinsics = (left: t.MemberExpression): boolean =>
      isPrototypeIntrinsicMember(left);

    fnPath.traverse({
      Function(innerPath) {
        if (innerPath.node === fn) return;
        const inner = innerPath.node;
        if (t.isFunctionDeclaration(inner) && isLeadingFunctionDeclaration(inner, fn)) {
          innerPath.skip();
          return;
        }
        hasBlockingNestedFunction = true;
        innerPath.skip();
      },
      ClassDeclaration() {
        hasClass = true;
      },
      ClassExpression() {
        hasClass = true;
      },
      Super() {
        hasSuper = true;
      },
      MetaProperty(path) {
        if (path.node.meta.name === "new" && path.node.property.name === "target") hasNewTarget = true;
      },
      WithStatement() {
        hasWith = true;
      },
      LabeledStatement() {
        hasLabel = true;
      },
      CallExpression(path) {
        if (t.isIdentifier(path.node.callee, { name: "eval" }) && !path.scope.getBinding("eval")) {
          hasDirectEvalHere = true;
        }
      },
      ReferencedIdentifier(path) {
        if (path.node.name === "arguments" && !path.scope.getBinding("arguments") && isInsideOwnFunction(path, fnPath)) {
          usesArguments = true;
        }
      },
      AssignmentExpression(path) {
        const left = path.node.left;
        if (t.isMemberExpression(left) && patchesPrototypeIntrinsics(left)) {
          patchesPrototype = true;
        }
      },
    });

    if (hasBlockingNestedFunction) exclude("nested-function");
    if (hasClass) exclude("class");
    if (hasSuper) exclude("super");
    if (hasNewTarget) exclude("new.target");
    if (hasWith) exclude("with");
    if (hasDirectEvalHere) exclude("direct-eval");
    if (usesArguments) exclude("arguments");
    if (hasLabel) exclude("label");
    if (patchesPrototype) exclude("prototype-hook");

    // destructuring params are supported by the VM compiler
    const stmtCount = t.isBlockStatement(fn.body) ? fn.body.body.length : 1;
    if (stmtCount < ctx.options.vmThreshold) exclude("too-small");
  }

  // Functions installed on Function/Object.prototype must stay native — VM
  // stubs break bind/apply/defineProperty hooks on hostile host pages.
  traverse(ast, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      const left = path.node.left;
      if (!t.isMemberExpression(left) || !isPrototypeIntrinsicMember(left)) return;
      const right = path.node.right;
      if (isFunctionNode(right)) info.vmExcluded.set(right, "prototype-hook");
    },
  });

  // --- meta observation + new usage ---
  const resolveFn = (path: NodePath<t.Identifier>): FunctionNode | undefined => {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) return undefined;
    const bp = binding.path;
    if (bp.isFunctionDeclaration()) return bp.node;
    if (bp.isVariableDeclarator() && isFunctionNode(bp.node.init as t.Node)) {
      return bp.node.init as FunctionNode;
    }
    return undefined;
  };

  traverse(ast, {
    MemberExpression(path: NodePath<t.MemberExpression>) {
      const obj = path.node.object;
      if (!t.isIdentifier(obj)) return;
      const fn = resolveFn(path.get("object") as NodePath<t.Identifier>);
      if (!fn) return;
      let key: string | undefined;
      if (!path.node.computed && t.isIdentifier(path.node.property)) key = path.node.property.name;
      else if (path.node.computed && t.isStringLiteral(path.node.property)) key = path.node.property.value;
      if (key === "length" || key === "name" || key === "prototype" || key === "toString" || key === "toSource") {
        info.metaObserved.add(fn);
      }
    },
    NewExpression(path: NodePath<t.NewExpression>) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee)) {
        const fn = resolveFn(path.get("callee") as NodePath<t.Identifier>);
        if (fn) info.constructed.add(fn);
      }
    },
  });

  // --- VM eligibility finalization ---
  for (const fnPath of fnPaths) {
    const fn = fnPath.node;
    if (info.vmExcluded.has(fn)) continue;
    // getters/setters cannot be compiled to parameterized stubs; never virtualize
    if (isAccessor(fn)) {
      info.vmExcluded.set(fn, "accessor");
      continue;
    }
    if (info.metaObserved.has(fn)) {
      info.vmExcluded.set(fn, "meta-observed");
      continue;
    }
    if (info.constructed.has(fn)) {
      info.vmExcluded.set(fn, "constructed");
      continue;
    }
    // class methods with static blocks / decorators already excluded via class rule
    // NOTE: only mark eligible when the VM is actually enabled. Otherwise CFF,
    // scatter, reshape and runtime-factory would skip these functions, leaving
    // them almost untouched.
    if (ctx.options.vm > 0) {
      info.vmEligible.add(fn);
      ctx.vmEligible.add(fn);
    }
  }

  // Record VM exclusion reason counts for --stats
  if (ctx.options.vm > 0) {
    for (const reason of info.vmExcluded.values()) {
      ctx.incVmStat("vmExcl_" + reason);
    }
  }

  // --- internal-only call analysis (reshape candidates) ---
  traverse(ast, {
    "FunctionDeclaration|VariableDeclarator"(path: NodePath) {
      let fn: FunctionNode | undefined;
      let name: string | undefined;
      if (path.isFunctionDeclaration() && path.node.id) {
        fn = path.node;
        name = path.node.id.name;
      } else if (path.isVariableDeclarator() && t.isIdentifier(path.node.id) && isFunctionNode(path.node.init as t.Node)) {
        fn = path.node.init as FunctionNode;
        name = path.node.id.name;
      }
      if (!fn || !name) return;
      if (fn.generator) return;
      if (fn.params.some((p) => !t.isIdentifier(p))) return; // no defaults/rest/destructuring
      const binding = path.scope.getBinding(name);
      if (!binding) return;
      if (binding.constantViolations.length > 0) return;
      const callSites: NodePath<t.CallExpression>[] = [];
      let ok = true;
      for (const ref of binding.referencePaths) {
        const parent = ref.parentPath;
        if (parent?.isCallExpression() && parent.node.callee === ref.node) {
          callSites.push(parent);
          continue;
        }
        ok = false;
        break;
      }
      if (!ok || callSites.length === 0) return;
      // ensure no `arguments` usage inside (already a VM exclusion, but reshape-specific)
      let usesArgs = false;
      (path as NodePath).traverse({
        ReferencedIdentifier(p) {
          if (p.node.name === "arguments" && !p.scope.getBinding("arguments")) usesArgs = true;
        },
      });
      if (usesArgs) return;
      info.internalCalls.set(fn, { bindingName: name, bindingPath: path, callSites });
    },
  });

  return info;
}

function isInsideOwnFunction(idPath: NodePath, fnPath: NodePath): boolean {
  let cur: NodePath | null = idPath.parentPath;
  while (cur && cur !== fnPath) {
    if (cur.isFunction()) return false; // belongs to a nested function
    cur = cur.parentPath;
  }
  return cur === fnPath;
}

export interface RenameBlocking {
  scopes: Set<t.Node>;
  bindings: Set<t.Node>;
}

/**
 * Compute rename-blocking for the CURRENT AST.
 *
 * Direct eval sees every binding on its scope chain, and its source is a
 * string that the AST renamer cannot touch. For a *statically analyzable* eval
 * source (string literal, foldable constant, or constant template) we parse it
 * and block only the bindings it actually references, so unrelated functions
 * and locals in the same scope chain can still be renamed. Un-analyzable eval
 * sources (dynamic strings, parse failures, `with`/module syntax inside) fall
 * back to blocking every binding visible from the eval site.
 */
export function analyzeRenameBlocking(ast: t.File): RenameBlocking {
  const scopes = new Set<t.Node>();
  const bindings = new Set<t.Node>();

  const blockAllVisible = (scope: NodePath["scope"] | undefined): void => {
    let s: NodePath["scope"] | undefined = scope;
    while (s) {
      for (const name of Object.keys(s.bindings)) bindings.add(s.bindings[name].path.node);
      if (s.path.isProgram()) break;
      s = s.parent;
    }
  };

  const blockNamed = (scope: NodePath["scope"] | undefined, names: Set<string>): void => {
    let s: NodePath["scope"] | undefined = scope;
    while (s) {
      for (const name of names) {
        const b = s.bindings[name];
        if (b) bindings.add(b.path.node);
      }
      if (s.path.isProgram()) break;
      s = s.parent;
    }
  };

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee, { name: "eval" }) || path.scope.getBinding("eval")) return;

      const arg = path.node.arguments[0];
      let literal: string | null = null;
      if (arg && t.isStringLiteral(arg)) literal = arg.value;
      else if (arg && t.isTemplateLiteral(arg) && arg.expressions.length === 0) literal = arg.quasis[0].value.cooked ?? "";
      else if (arg && t.isIdentifier(arg)) {
        const b = path.scope.getBinding(arg.name);
        if (b?.constant && b.path.isVariableDeclarator() && t.isStringLiteral(b.path.node.init)) {
          literal = b.path.node.init.value;
        }
      }

      if (literal === null) {
        blockAllVisible(path.scope);
        return;
      }
      const names = evalSourceRefs(literal);
      if (names === null) {
        blockAllVisible(path.scope);
        return;
      }
      blockNamed(path.scope, names);
    },
    WithStatement(path: NodePath<t.WithStatement>) {
      let scope: NodePath["scope"] | undefined = path.scope;
      while (scope) {
        scopes.add(scope.path.node);
        if (scope.path.isProgram()) break;
        scope = scope.parent;
      }
    },
  });

  return { scopes, bindings };
}

/** Identifier names referenced/declared in a static eval source, or null if un-analyzable. */
function evalSourceRefs(src: string): Set<string> | null {
  let prog: t.File;
  try {
    prog = parse(src, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
    });
  } catch {
    return null;
  }
  const names = new Set<string>();
  let ok = true;
  traverse(prog, {
    enter(path: NodePath) {
      const n = path.node;
      if (t.isWithStatement(n)) ok = false;
      if (
        t.isImportDeclaration(n) ||
        t.isExportNamedDeclaration(n) ||
        t.isExportDefaultDeclaration(n) ||
        t.isExportAllDeclaration(n)
      ) {
        ok = false;
      }
    },
    Identifier(path: NodePath<t.Identifier>) {
      names.add(path.node.name);
    },
  });
  if (!ok) return null;
  return names;
}
