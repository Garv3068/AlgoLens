// Tree-walking interpreter for JavaScript with step tracing, in the same schema as tracer.py.
// Chrome extension pages forbid eval / new Function, so user code is parsed with acorn and executed
// here instead. Values are real JS values (arrays, Maps, Sets, objects), so built-ins behave natively;
// only user-written functions go through the interpreter.
import * as acorn from "./acorn.mjs";
import { splitInput, parseValue } from "../inputs.js";
import { makeGlobals, buildList, buildTree, ListNode, TreeNode, PriorityQueue, Queue, Deque } from "./runtime.js";

const MAX_CALL_DEPTH = 450, MAX_OPS = 4_000_000, MAX_ITEMS = 40, MAX_STR = 60;
const UNSET = Symbol("unset"), SHORT = Symbol("short-circuit");

class Abort { constructor(reason) { this.reason = reason; } }
class InterpError extends Error { constructor(msg, line) { super(msg); this.line = line; } }

class Env {
  constructor(parent) { this.parent = parent; this.vars = new Map(); this.ctx = null; }
  find(name) { for (let e = this; e; e = e.parent) { const r = e.vars.get(name); if (r) return r; } return null; }
}

// ---------------------------------------------------------------- AST helpers
function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": for (const x of p.properties) patternNames(x.type === "RestElement" ? x.argument : x.value, out); break;
    case "ArrayPattern": for (const x of p.elements) patternNames(x, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
    case "RestElement": patternNames(p.argument, out); break;
  }
  return out;
}
function collectVars(node, out) {
  if (Array.isArray(node)) { for (const x of node) collectVars(x, out); return; }
  if (!node) return;
  switch (node.type) {
    case "VariableDeclaration": if (node.kind === "var") for (const d of node.declarations) patternNames(d.id, out); break;
    case "BlockStatement": collectVars(node.body, out); break;
    case "IfStatement": collectVars(node.consequent, out); collectVars(node.alternate, out); break;
    case "ForStatement": collectVars(node.init, out); collectVars(node.body, out); break;
    case "ForInStatement": case "ForOfStatement": collectVars(node.left, out); collectVars(node.body, out); break;
    case "WhileStatement": case "DoWhileStatement": case "LabeledStatement": collectVars(node.body, out); break;
    case "TryStatement": collectVars(node.block, out); if (node.handler) collectVars(node.handler.body, out); collectVars(node.finalizer, out); break;
    case "SwitchStatement": for (const c of node.cases) collectVars(c.consequent, out); break;
  }
}
function walk(node, fn) {
  if (Array.isArray(node)) { for (const x of node) walk(x, fn); return; }
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const v = node[key];
    if (v && typeof v === "object") walk(v, fn);
  }
}
const isFnNode = (n) => n && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "FunctionDeclaration");

export function parseCode(code) {
  try { return acorn.parse(code, { ecmaVersion: "latest", locations: true, sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true }); }
  catch (e) {
    const line = e.loc ? e.loc.line : null;
    const err = new Error(`Syntax error${line ? ` on line ${line}` : ""}: ${String(e.message).replace(/\s*\(\d+:\d+\)$/, "")}`);
    err.syntax = true; throw err;
  }
}

// ---------------------------------------------------------------- interpreter
export class Interpreter {
  constructor({ maxSteps = 1500 } = {}) {
    this.maxSteps = maxSteps; this.trace = false; this.steps = []; this.stack = []; this.out = "";
    this.ops = 0; this.callDepth = 0; this.curLine = 0; this.errLine = null; this.nids = new Map(); this.code = "";
    this.hoistCache = new WeakMap(); this.usedCache = new WeakMap(); this.varCache = new WeakMap();
    this.globals = makeGlobals((s) => { if (this.out.length < 4000) this.out += s + "\n"; });
    this.root = new Env(null); this.root.ctx = { thisVal: undefined, info: null, newTarget: undefined, home: null };
    this.f = { name: "<global>", root: this.root, quiet: true, lastEnv: this.root, info: null, curLine: 0 };
  }

  // ---------------------------------------------------------------- snapshots
  nid(o) { let n = this.nids.get(o); if (!n) { n = this.nids.size + 1; this.nids.set(o, n); } return n; }
  plain(v) { return v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : typeof v === "object" || typeof v === "function" ? String(this.snapShort(v)) : String(v); }
  snapShort(v) { const s = this.snap(v, 3); return s.t === "prim" || s.t === "str" ? s.v : s.t === "list" ? `array[${s.n}]` : s.t === "dict" ? `{…}` : s.t; }
  snap(v, depth = 0, seen = new Set()) {
    if (v === null) return { t: "prim", v: null };
    if (v === undefined || v === UNSET) return { t: "repr", v: "undefined" };
    switch (typeof v) {
      case "boolean": return { t: "prim", v };
      case "number": return { t: "prim", v: !Number.isFinite(v) ? String(v) : Math.abs(v) < 1e15 ? v : String(v) };
      case "bigint": return { t: "prim", v: `${v}n` };
      case "string": return { t: "str", v: v.slice(0, MAX_STR), cut: v.length > MAX_STR };
      case "symbol": return { t: "repr", v: v.toString() };
      case "function": return { t: "repr", v: `ƒ ${v.name || "anonymous"}()` };
    }
    const own = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d && "value" in d ? d.value : "(accessor)"; };
    const isNodeLike = Array.isArray(v) ? false : "val" in v && ("next" in v || ("left" in v && "right" in v));
    if (isNodeLike) {
      const isTree = "left" in v && "right" in v;
      if (depth > 0) return { t: "node", k: isTree ? "tree" : "ll", v: this.plain(own(v, "val")), id: this.nid(v) };
      if (!isTree) {
        const vals = [], ids = [], at = new Map(); let cur = v;
        while (cur && typeof cur === "object" && !at.has(cur) && vals.length < MAX_ITEMS) { at.set(cur, ids.length); ids.push(this.nid(cur)); vals.push(this.plain(own(cur, "val"))); cur = own(cur, "next"); }
        const live = cur && typeof cur === "object";
        const cto = live && at.has(cur) ? at.get(cur) : null;
        return { t: "ll", v: vals, ids, cycle: cto !== null, cto, cut: !!live && cto === null };
      }
      const budget = [31];
      const walkTree = (n, d) => { if (!n || typeof n !== "object" || budget[0] <= 0 || d > 5) return null; budget[0]--; return { v: this.plain(own(n, "val")), id: this.nid(n), l: walkTree(own(n, "left"), d + 1), r: walkTree(own(n, "right"), d + 1) }; };
      return { t: "tree", v: walkTree(v, 0) };
    }
    if (seen.has(v) || depth > 3) return { t: "repr", v: "…" };
    const seen2 = new Set(seen).add(v), kids = (arr) => arr.slice(0, MAX_ITEMS).map((x) => this.snap(x, depth + 1, seen2));
    if (Array.isArray(v)) return { t: "list", v: kids(v), n: v.length, cut: v.length > MAX_ITEMS, oid: this.nid(v), label: "array" };
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) { const a = Array.from(v.subarray(0, MAX_ITEMS)); return { t: "list", v: kids(a), n: v.length, cut: v.length > MAX_ITEMS, oid: this.nid(v), label: v.constructor.name }; }
    if (v instanceof PriorityQueue) return { t: "list", v: kids(v._a), n: v._a.length, cut: v._a.length > MAX_ITEMS, oid: this.nid(v), label: "priority queue" };
    if (v instanceof Queue || v instanceof Deque) return { t: "deque", v: kids(v._a), n: v._a.length, cut: v._a.length > MAX_ITEMS, oid: this.nid(v), label: v instanceof Queue ? "queue" : "deque" };
    if (v instanceof Set) { const ks = [...v]; return { t: "set", v: kids(ks), n: ks.length, cut: ks.length > MAX_ITEMS, oid: this.nid(v), label: "Set" }; }
    if (v instanceof Map) { const es = [...v]; return { t: "dict", v: es.slice(0, MAX_ITEMS).map(([k, x]) => [this.snap(k, depth + 1, seen2), this.snap(x, depth + 1, seen2)]), n: es.length, cut: es.length > MAX_ITEMS, oid: this.nid(v), label: "Map" }; }
    if (v instanceof Date) return { t: "repr", v: Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString() };
    if (v instanceof RegExp) return { t: "repr", v: String(v) };
    if (v instanceof Error) return { t: "repr", v: `${v.name}: ${v.message}`.slice(0, MAX_STR) };
    if (v instanceof WeakMap || v instanceof WeakSet) return { t: "repr", v: v.constructor.name };
    const keys = Object.keys(v).filter((k) => !k.startsWith("#"));
    const ctor = Object.getPrototypeOf(v) && Object.getPrototypeOf(v).constructor && Object.getPrototypeOf(v).constructor.name;
    return { t: "dict", v: keys.slice(0, MAX_ITEMS).map((k) => [{ t: "str", v: k.slice(0, MAX_STR), cut: false }, this.snap(own(v, k), depth + 1, seen2)]), n: keys.length, cut: keys.length > MAX_ITEMS, oid: this.nid(v), label: ctor && ctor !== "Object" ? ctor : "object" };
  }
  usedNames(node) {
    if (!node) return null;
    let s = this.usedCache.get(node);
    if (!s) { s = new Set(); walk(node, (n) => { if (n.type === "Identifier") s.add(n.name); }); this.usedCache.set(node, s); }
    return s;
  }
  snapLocals(env, frame) {
    const out = {}, chain = [];
    for (let e = env; e; e = e.parent) { chain.push(e); if (e === frame.root) break; }
    for (let i = chain.length - 1; i >= 0; i--)
      for (const [k, r] of chain[i].vars) { if (r.v === UNSET || k === "arguments" || typeof r.v === "function") continue; out[k] = this.snap(r.v); }
    const used = frame.info ? this.usedNames(frame.info.node) : null;   // variables captured from enclosing scopes
    if (used) for (let e = frame.root.parent; e; e = e.parent)
      for (const [k, r] of e.vars) { if (k in out || !used.has(k) || r.v === UNSET || typeof r.v === "function") continue; out[k] = this.snap(r.v); }
    return out;
  }
  record(ev, line, env, extra = {}) {
    const f = this.f;
    if (!this.trace || !f || f.quiet) return;
    if (this.steps.length >= this.maxSteps) throw new Abort("steps");
    this.steps.push({ ev, line, fn: f.name, depth: this.stack.length, locals: this.snapLocals(env, f), stack: this.stack.slice(), ...extra });
  }
  step(node, env) {
    const line = node.loc.start.line; this.curLine = line;
    if (++this.ops > MAX_OPS) throw new Abort("time");
    const f = this.f;
    if (f && !f.quiet) { f.lastEnv = env; f.curLine = line; this.record("line", line, env); }
  }
  src(n) { const s = this.code.slice(n.start, n.end).replace(/\s+/g, " "); return s.length > 48 ? s.slice(0, 45) + "…" : s; }

  // ---------------------------------------------------------------- scopes and hoisting
  ident(name, env) {
    const r = env.find(name);
    if (r) { if (r.v === UNSET) throw new ReferenceError(`Cannot access '${name}' before initialization`); return r.v; }
    if (name === "undefined") return undefined;
    if (Object.prototype.hasOwnProperty.call(this.globals, name)) return this.globals[name];
    throw new ReferenceError(`${name} is not defined`);
  }
  assignIdent(name, value, env) {
    const r = env.find(name);
    if (r) {
      if (r.kind === "const") throw new TypeError("Assignment to constant variable.");
      if (r.v === UNSET) throw new ReferenceError(`Cannot access '${name}' before initialization`);
      r.v = value;
    } else this.root.vars.set(name, { v: value, kind: "var" });   // sloppy-mode implicit global
  }
  ctxOf(env) { for (let e = env; e; e = e.parent) if (e.ctx) return e.ctx; return this.root.ctx; }
  hoistList(stmts, env) {
    let h = this.hoistCache.get(stmts);
    if (!h) {
      h = { lex: [], fns: [] };
      for (const s of stmts) {
        if (s.type === "FunctionDeclaration") h.fns.push(s);
        else if (s.type === "ClassDeclaration") h.lex.push([s.id.name, "let"]);
        else if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) for (const nm of patternNames(d.id)) h.lex.push([nm, s.kind]);
      }
      this.hoistCache.set(stmts, h);
    }
    for (const [nm, kind] of h.lex) env.vars.set(nm, { v: UNSET, kind });
    for (const f of h.fns) env.vars.set(f.id.name, { v: this.makeFunction(f, env, {}), kind: "var" });
    return h;
  }
  hoistVarsOf(key, body, env) {
    let vars = this.varCache.get(key);
    if (!vars) { vars = []; collectVars(body, vars); this.varCache.set(key, vars); }
    for (const v of vars) if (!env.vars.has(v)) env.vars.set(v, { v: undefined, kind: "var" });
    this.hoistList(body, env);
  }
  blockEnv(stmts, env) {
    let h = this.hoistCache.get(stmts);
    if (!h) { const probe = new Env(null); h = this.hoistList(stmts, probe); }
    if (!h.lex.length && !h.fns.length) return env;
    const e = new Env(env); this.hoistList(stmts, e); return e;
  }

  bindName(name, value, env, mode) {
    if (mode === "let" || mode === "const") env.vars.set(name, { v: value, kind: mode });
    else if (mode === "var") { const r = env.find(name); if (r) r.v = value; else this.root.vars.set(name, { v: value, kind: "var" }); }
    else this.assignIdent(name, value, env);
  }
  /** mode: "let" | "const" | "var" for declarations, null for plain assignment */
  bindPattern(p, value, env, mode) {
    switch (p.type) {
      case "Identifier": return this.bindName(p.name, value, env, mode);
      case "MemberExpression": { const o = this.evMemberObject(p, env), k = this.memberKey(p, env); o[k] = value; return; }
      case "AssignmentPattern": { if (value === undefined) value = this.evalNamed(p.right, env, p.left.type === "Identifier" ? p.left.name : ""); return this.bindPattern(p.left, value, env, mode); }
      case "ObjectPattern": {
        if (value === null || value === undefined) throw new TypeError(`Cannot destructure '${this.src(p)}' as it is ${value}.`);
        const used = [];
        for (const prop of p.properties) {
          if (prop.type === "RestElement") { const rest = {}; for (const k of Object.keys(value)) if (!used.includes(k)) rest[k] = value[k]; this.bindPattern(prop.argument, rest, env, mode); continue; }
          const key = this.propKey(prop, env); used.push(key);
          this.bindPattern(prop.value, value[key], env, mode);
        }
        return;
      }
      case "ArrayPattern": {
        if (value === null || value === undefined || typeof value[Symbol.iterator] !== "function") throw new TypeError(`${value === null || value === undefined ? value : typeof value} is not iterable`);
        const it = value[Symbol.iterator]();
        for (const el of p.elements) {
          if (el && el.type === "RestElement") { const rest = []; for (let r = it.next(); !r.done; r = it.next()) rest.push(r.value); this.bindPattern(el.argument, rest, env, mode); break; }
          const r = it.next();
          if (el) this.bindPattern(el, r.done ? undefined : r.value, env, mode);
        }
        return;
      }
      case "RestElement": return this.bindPattern(p.argument, value, env, mode);
    }
    throw new InterpError(`Unsupported assignment target (${p.type})`, this.curLine);
  }

  // ---------------------------------------------------------------- functions and classes
  makeFunction(node, env, opts = {}) {
    const interp = this, name = (node.id && node.id.name) || opts.name || "";
    let fenv = env;
    if (node.type === "FunctionExpression" && node.id) fenv = new Env(env);
    const info = { node, env: fenv, name, traced: !!name, isArrow: node.type === "ArrowFunctionExpression", home: opts.home || null, isClass: false };
    const w = info.isArrow ? (...args) => interp.callFunction(info, undefined, args, undefined)
      : function (...args) { return interp.callFunction(info, this, args, new.target); };
    let len = 0; for (const p of node.params) { if (p.type === "AssignmentPattern" || p.type === "RestElement") break; len++; }
    Object.defineProperty(w, "name", { value: name, configurable: true });
    Object.defineProperty(w, "length", { value: len, configurable: true });
    if (fenv !== env) fenv.vars.set(node.id.name, { v: w, kind: "var" });
    return w;
  }
  evalNamed(node, env, name) {
    if (name) {
      if ((node.type === "FunctionExpression" && !node.id) || node.type === "ArrowFunctionExpression") return this.makeFunction(node, env, { name });
      if (node.type === "ClassExpression" && !node.id) return this.makeClass(node, env, name);
    }
    return this.ev(node, env);
  }
  propKey(p, env) {
    if (p.computed) { const k = this.ev(p.key, env); return typeof k === "symbol" ? k : String(k); }
    const k = p.key;
    return k.type === "Identifier" ? k.name : k.type === "PrivateIdentifier" ? "#" + k.name : String(k.value);
  }
  makeClass(node, env, nameHint) {
    const interp = this, name = (node.id && node.id.name) || nameHint || "";
    const parent = node.superClass ? this.ev(node.superClass, env) : null;
    if (node.superClass && parent !== null && typeof parent !== "function") throw new TypeError(`Class extends value ${String(parent)} is not a constructor or null`);
    const cenv = new Env(env);
    const ctorDef = node.body.body.find((m) => m.type === "MethodDefinition" && m.kind === "constructor");
    const info = { node: ctorDef ? ctorDef.value : null, env: cenv, name, traced: true, isArrow: false, isClass: true, parent, derived: !!node.superClass, fields: [], line: node.loc.start.line, home: null };
    const C = function (...args) { return interp.callFunction(info, this, args, new.target); };
    Object.defineProperty(C, "name", { value: name, configurable: true });
    if (typeof parent === "function") { Object.setPrototypeOf(C, parent); Object.setPrototypeOf(C.prototype, parent.prototype); }
    else if (node.superClass && parent === null) Object.setPrototypeOf(C.prototype, null);
    info.home = C.prototype;
    if (node.id) cenv.vars.set(node.id.name, { v: C, kind: "const" });
    const staticEnv = () => { const e = new Env(cenv); e.ctx = { thisVal: C, info: null, newTarget: undefined, home: C }; return e; };
    for (const m of node.body.body) {
      if (m.type === "MethodDefinition") {
        if (m.kind === "constructor") continue;
        const key = this.propKey(m, cenv), target = m.static ? C : C.prototype;
        const fn = this.makeFunction(m.value, cenv, { name: typeof key === "symbol" ? "" : key, home: target });
        if (m.kind === "get" || m.kind === "set") {
          const d = Object.getOwnPropertyDescriptor(target, key), nd = { configurable: true, enumerable: false };
          if (d && (d.get || d.set)) { nd.get = d.get; nd.set = d.set; }
          nd[m.kind] = fn; Object.defineProperty(target, key, nd);
        } else Object.defineProperty(target, key, { value: fn, writable: true, configurable: true, enumerable: false });
      } else if (m.type === "PropertyDefinition") {
        const key = this.propKey(m, cenv);
        if (m.static) Object.defineProperty(C, key, { value: m.value ? this.evalNamed(m.value, staticEnv(), String(key)) : undefined, writable: true, configurable: true, enumerable: true });
        else info.fields.push({ key, value: m.value });
      } else if (m.type === "StaticBlock") { const e = staticEnv(); this.hoistList(m.body, e); this.execList(m.body, e); }
    }
    return C;
  }
  initFields(info, obj) {
    for (const f of info.fields) {
      const e = new Env(info.env); e.ctx = { thisVal: obj, info: null, newTarget: undefined, home: info.home };
      const v = f.value ? this.evalNamed(f.value, e, String(f.key)) : undefined;
      Object.defineProperty(obj, f.key, { value: v, writable: true, configurable: true, enumerable: !String(f.key).startsWith("#") });
    }
  }
  paramKey(p, i) {
    if (p.type === "Identifier") return p.name;
    if (p.type === "AssignmentPattern" && p.left.type === "Identifier") return p.left.name;
    if (p.type === "RestElement" && p.argument.type === "Identifier") return p.argument.name;
    return this.src(p) || `arg${i}`;
  }
  callFunction(info, thisVal, args, newTarget) {
    const node = info.node;
    if (node && (node.async || node.generator)) throw new InterpError(`${node.async ? "async functions" : "generators"} aren't supported by the AlgoLens JavaScript tracer yet`, this.curLine);
    if (info.isClass && !newTarget) throw new TypeError(`Class constructor ${info.name} cannot be invoked without 'new'`);
    if (this.callDepth >= MAX_CALL_DEPTH) throw new RangeError("Maximum call stack size exceeded");
    if (++this.ops > MAX_OPS) throw new Abort("time");
    const env = new Env(info.env), ctx = info.isArrow ? null : { thisVal, info, newTarget, home: info.home };
    env.ctx = ctx;
    const frame = { name: info.name, root: env, quiet: !info.traced || !this.trace, info, lastEnv: env, curLine: node ? node.loc.start.line : info.line };
    const savedF = this.f, savedLine = this.curLine; this.f = frame; this.callDepth++;
    let pushed = false;
    try {
      const params = node ? node.params : [];
      if (node && !info.isArrow && this.usedNames(node).has("arguments")) env.vars.set("arguments", { v: args, kind: "var" });
      params.forEach((p, i) => { if (p.type === "RestElement") this.bindPattern(p.argument, args.slice(i), env, "let"); else this.bindPattern(p, args[i], env, "let"); });
      if (!frame.quiet) {
        const argSnaps = {};
        params.forEach((p, i) => { const key = this.paramKey(p, i); argSnaps[key] = p.type === "Identifier" ? this.snap(env.vars.get(p.name).v) : this.snap(p.type === "RestElement" ? args.slice(i) : args[i]); });
        this.stack.push({ fn: info.name, args: argSnaps }); pushed = true;
        this.record("call", frame.curLine, env);
      }
      let ret, retLine, retEnv = env;
      if (info.isClass) {
        if (!info.derived) this.initFields(info, ctx.thisVal);
        if (node) {
          this.hoistVarsOf(node, node.body.body, env);
          const c = this.execList(node.body.body, env);
          if (c && c.k === "return") { ret = c.value; retLine = c.line; retEnv = c.env; }
        } else if (info.derived) { ctx.thisVal = Reflect.construct(info.parent, args, newTarget); this.initFields(info, ctx.thisVal); }
        if (!(ret !== null && (typeof ret === "object" || typeof ret === "function"))) ret = ctx.thisVal;
        if (retLine === undefined) { retLine = frame.curLine; retEnv = frame.lastEnv; }
      } else if (node.expression) {
        this.step(node.body, env); ret = this.ev(node.body, env); retLine = node.body.loc.start.line;
      } else {
        this.hoistVarsOf(node, node.body.body, env);
        const c = this.execList(node.body.body, env);
        if (c && c.k === "return") { ret = c.value; retLine = c.line; retEnv = c.env; } else { retLine = frame.curLine; retEnv = frame.lastEnv; }
      }
      if (!frame.quiet) this.record("return", retLine, retEnv, { ret: this.snap(ret) });
      return ret;
    } catch (e) {
      if (this.errLine === null && !(e instanceof Abort)) this.errLine = this.curLine;
      throw e;
    } finally {
      if (pushed) this.stack.pop();
      this.f = savedF; this.callDepth--; this.curLine = savedLine;
    }
  }

  // ---------------------------------------------------------------- statements
  execList(stmts, env) { for (const s of stmts) { const c = this.exec(s, env, null); if (c) return c; } }
  loopCtl(c, labels) {
    if (c.k === "break") return c.label === null || labels.includes(c.label) ? "break" : null;
    if (c.k === "continue") return c.label === null || labels.includes(c.label) ? "continue" : null;
    return null;
  }
  execDecl(n, env) {
    for (const d of n.declarations) {
      if (!d.init) { if (n.kind !== "var") this.bindPattern(d.id, undefined, env, n.kind); continue; }
      this.bindPattern(d.id, this.evalNamed(d.init, env, d.id.type === "Identifier" ? d.id.name : ""), env, n.kind);
    }
  }
  bindFor(left, value, ie) {
    if (left.type === "VariableDeclaration") this.bindPattern(left.declarations[0].id, value, ie, left.kind);
    else this.bindPattern(left, value, ie, null);
  }
  exec(n, env, labels) {
    labels = labels || [];
    switch (n.type) {
      case "ExpressionStatement": this.step(n, env); this.ev(n.expression, env); return;
      case "VariableDeclaration": this.step(n, env); this.execDecl(n, env); return;
      case "FunctionDeclaration": case "EmptyStatement": case "DebuggerStatement": return;
      case "ClassDeclaration": { const C = this.makeClass(n, env, n.id.name); env.vars.set(n.id.name, { v: C, kind: "let" }); return; }
      case "ReturnStatement": { this.step(n, env); const value = n.argument ? this.ev(n.argument, env) : undefined; return { k: "return", value, line: n.loc.start.line, env }; }
      case "BreakStatement": this.step(n, env); return { k: "break", label: n.label ? n.label.name : null };
      case "ContinueStatement": this.step(n, env); return { k: "continue", label: n.label ? n.label.name : null };
      case "ThrowStatement": { this.step(n, env); throw this.ev(n.argument, env); }
      case "BlockStatement": return this.execList(n.body, this.blockEnv(n.body, env));
      case "LabeledStatement": {
        const c = this.exec(n.body, env, [...labels, n.label.name]);
        if (c && c.k === "break" && c.label === n.label.name) return;
        return c;
      }
      case "IfStatement": {
        this.step(n, env);
        if (this.ev(n.test, env)) return this.exec(n.consequent, env, null);
        if (n.alternate) return this.exec(n.alternate, env, null);
        return;
      }
      case "ForStatement": {
        let loopEnv = new Env(env);
        const perIter = n.init && n.init.type === "VariableDeclaration" && n.init.kind !== "var";
        this.step(n, env);
        if (n.init) { if (n.init.type === "VariableDeclaration") this.execDecl(n.init, loopEnv); else this.ev(n.init, loopEnv); }
        for (let first = true; ; first = false) {
          if (!first) {
            if (perIter) { const ne = new Env(env); for (const [k, r] of loopEnv.vars) ne.vars.set(k, { v: r.v, kind: r.kind }); loopEnv = ne; }
            if (n.update) this.ev(n.update, loopEnv);
            this.step(n, loopEnv);
          }
          if (n.test && !this.ev(n.test, loopEnv)) break;
          const c = this.exec(n.body, loopEnv, null);
          if (c) { const a = this.loopCtl(c, labels); if (a === "break") break; if (a !== "continue") return c; }
        }
        return;
      }
      case "WhileStatement": {
        for (;;) {
          this.step(n, env);
          if (!this.ev(n.test, env)) break;
          const c = this.exec(n.body, env, null);
          if (c) { const a = this.loopCtl(c, labels); if (a === "break") break; if (a !== "continue") return c; }
        }
        return;
      }
      case "DoWhileStatement": {
        for (;;) {
          const c = this.exec(n.body, env, null);
          if (c) { const a = this.loopCtl(c, labels); if (a === "break") break; if (a !== "continue") return c; }
          this.step(n, env);
          if (!this.ev(n.test, env)) break;
        }
        return;
      }
      case "ForInStatement": {
        const obj = this.ev(n.right, env), keys = [];
        if (obj !== null && obj !== undefined) for (const k in obj) keys.push(k);
        for (const k of keys) {
          const ie = new Env(env); this.bindFor(n.left, k, ie); this.step(n, ie);
          const c = this.exec(n.body, ie, null);
          if (c) { const a = this.loopCtl(c, labels); if (a === "break") break; if (a !== "continue") return c; }
        }
        return;
      }
      case "ForOfStatement": {
        if (n.await) throw new InterpError("for await isn't supported by the AlgoLens JavaScript tracer", n.loc.start.line);
        const iterable = this.ev(n.right, env);
        if (iterable === null || iterable === undefined || typeof iterable[Symbol.iterator] !== "function") throw new TypeError(`${this.src(n.right)} is not iterable`);
        for (const item of iterable) {
          const ie = new Env(env); this.bindFor(n.left, item, ie); this.step(n, ie);
          const c = this.exec(n.body, ie, null);
          if (c) { const a = this.loopCtl(c, labels); if (a === "break") break; if (a !== "continue") return c; }
        }
        return;
      }
      case "SwitchStatement": {
        this.step(n, env);
        const d = this.ev(n.discriminant, env), senv = new Env(env);
        if (!n._all) n._all = n.cases.flatMap((c) => c.consequent);
        this.hoistList(n._all, senv);
        let start = -1;
        for (let i = 0; i < n.cases.length; i++) if (n.cases[i].test && d === this.ev(n.cases[i].test, senv)) { start = i; break; }
        if (start < 0) start = n.cases.findIndex((c) => !c.test);
        if (start >= 0) for (let i = start; i < n.cases.length; i++) {
          const r = this.execList(n.cases[i].consequent, senv);
          if (r) { if (r.k === "break" && r.label === null) return; return r; }
        }
        return;
      }
      case "TryStatement": {
        let comp, thrown, has = false;
        try { comp = this.exec(n.block, env, null); }
        catch (e) { if (e instanceof Abort || e instanceof InterpError) throw e; has = true; thrown = e; }
        if (has && n.handler) {
          has = false; this.errLine = null;
          const cenv = new Env(env);
          if (n.handler.param) this.bindPattern(n.handler.param, thrown, cenv, "let");
          try { comp = this.exec(n.handler.body, cenv, null); }
          catch (e2) { if (e2 instanceof Abort || e2 instanceof InterpError) throw e2; has = true; thrown = e2; }
        }
        if (has && this.errLine === null) this.errLine = this.curLine;
        if (n.finalizer) { const fc = this.exec(n.finalizer, env, null); if (fc) { this.errLine = null; return fc; } }
        if (has) throw thrown;
        return comp;
      }
    }
    throw new InterpError(`Unsupported statement: ${n.type}`, n.loc ? n.loc.start.line : this.curLine);
  }

  // ---------------------------------------------------------------- expressions
  memberKey(n, env) {
    if (n.computed) return this.ev(n.property, env);
    return n.property.type === "PrivateIdentifier" ? "#" + n.property.name : n.property.name;
  }
  evMemberObject(m, env) { return m.object.type === "Super" ? this.ctxOf(env).thisVal : this.ev(m.object, env); }
  evArgs(list, env) {
    const out = [];
    for (const a of list) { if (a.type === "SpreadElement") { for (const x of this.ev(a.argument, env)) out.push(x); } else out.push(this.ev(a, env)); }
    return out;
  }
  binop(op, a, b) {
    switch (op) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b; case "%": return a % b; case "**": return a ** b;
      case "==": return a == b; case "!=": return a != b; case "===": return a === b; case "!==": return a !== b;  // eslint-disable-line eqeqeq
      case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
      case "<<": return a << b; case ">>": return a >> b; case ">>>": return a >>> b;
      case "&": return a & b; case "|": return a | b; case "^": return a ^ b;
      case "in": return a in b; case "instanceof": return a instanceof b;
    }
    throw new InterpError(`Unsupported operator ${op}`, this.curLine);
  }
  ev(n, env) {
    if (++this.ops > MAX_OPS) throw new Abort("time");
    switch (n.type) {
      case "Literal": if (n.regex) return new RegExp(n.regex.pattern, n.regex.flags); if (n.bigint !== undefined) return BigInt(n.bigint); return n.value;
      case "Identifier": return this.ident(n.name, env);
      case "ThisExpression": return this.ctxOf(env).thisVal;
      case "TemplateLiteral": {
        let s = n.quasis[0].value.cooked;
        for (let i = 0; i < n.expressions.length; i++) s += String(this.ev(n.expressions[i], env)) + n.quasis[i + 1].value.cooked;
        return s;
      }
      case "TaggedTemplateExpression": {
        const strs = n.quasi.quasis.map((q) => q.value.cooked); strs.raw = n.quasi.quasis.map((q) => q.value.raw);
        const args = [strs, ...n.quasi.expressions.map((e) => this.ev(e, env))];
        const fn = this.ev(n.tag, env);
        if (typeof fn !== "function") throw new TypeError(`${this.src(n.tag)} is not a function`);
        return fn(...args);
      }
      case "ArrayExpression": {
        const arr = [];
        for (const el of n.elements) {
          if (el === null) arr.length++;
          else if (el.type === "SpreadElement") { for (const x of this.ev(el.argument, env)) arr.push(x); }
          else arr.push(this.ev(el, env));
        }
        return arr;
      }
      case "ObjectExpression": {
        const obj = {};
        for (const p of n.properties) {
          if (p.type === "SpreadElement") { Object.assign(obj, this.ev(p.argument, env)); continue; }
          const key = this.propKey(p, env);
          if (p.kind === "get" || p.kind === "set") {
            const fn = this.makeFunction(p.value, env, { name: String(key), home: obj });
            const d = Object.getOwnPropertyDescriptor(obj, key), nd = { enumerable: true, configurable: true };
            if (d && (d.get || d.set)) { nd.get = d.get; nd.set = d.set; }
            nd[p.kind] = fn; Object.defineProperty(obj, key, nd);
          } else if (p.method) obj[key] = this.makeFunction(p.value, env, { name: String(key), home: obj });
          else if (key === "__proto__" && !p.computed && !p.shorthand) Object.setPrototypeOf(obj, this.ev(p.value, env));
          else obj[key] = this.evalNamed(p.value, env, typeof key === "string" ? key : "");
        }
        return obj;
      }
      case "FunctionExpression": case "ArrowFunctionExpression": return this.makeFunction(n, env, {});
      case "ClassExpression": return this.makeClass(n, env, "");
      case "UnaryExpression": {
        const op = n.operator;
        if (op === "typeof" && n.argument.type === "Identifier") {
          const nm = n.argument.name;
          if (!env.find(nm) && nm !== "undefined" && !Object.prototype.hasOwnProperty.call(this.globals, nm)) return "undefined";
        }
        if (op === "delete") {
          const a = n.argument;
          if (a.type === "MemberExpression") { const o = this.evMemberObject(a, env); return delete o[this.memberKey(a, env)]; }
          return true;
        }
        const v = this.ev(n.argument, env);
        switch (op) { case "-": return -v; case "+": return +v; case "!": return !v; case "~": return ~v; case "typeof": return typeof v; case "void": return undefined; }
        throw new InterpError(`Unsupported operator ${op}`, this.curLine);
      }
      case "UpdateExpression": {
        const a = n.argument, inc = n.operator === "++";
        const bump = (old) => { const o = typeof old === "bigint" ? old : +old; return [o, typeof o === "bigint" ? (inc ? o + 1n : o - 1n) : inc ? o + 1 : o - 1]; };
        if (a.type === "Identifier") { const [o, nv] = bump(this.ident(a.name, env)); this.assignIdent(a.name, nv, env); return n.prefix ? nv : o; }
        const obj = this.evMemberObject(a, env), key = this.memberKey(a, env), [o, nv] = bump(obj[key]);
        obj[key] = nv; return n.prefix ? nv : o;
      }
      case "BinaryExpression": {
        if (n.left.type === "PrivateIdentifier") return ("#" + n.left.name) in this.ev(n.right, env);
        return this.binop(n.operator, this.ev(n.left, env), this.ev(n.right, env));
      }
      case "LogicalExpression": {
        const l = this.ev(n.left, env);
        if (n.operator === "&&") return l ? this.ev(n.right, env) : l;
        if (n.operator === "||") return l ? l : this.ev(n.right, env);
        return l !== null && l !== undefined ? l : this.ev(n.right, env);
      }
      case "ConditionalExpression": return this.ev(n.test, env) ? this.ev(n.consequent, env) : this.ev(n.alternate, env);
      case "SequenceExpression": { let v; for (const e of n.expressions) v = this.ev(e, env); return v; }
      case "AssignmentExpression": {
        const op = n.operator, t = n.left;
        if (op === "=") {
          if (t.type === "Identifier") { const v = this.evalNamed(n.right, env, t.name); this.assignIdent(t.name, v, env); return v; }
          if (t.type === "MemberExpression") {
            const o = this.evMemberObject(t, env), k = this.memberKey(t, env);
            const v = this.evalNamed(n.right, env, typeof k === "string" ? k : ""); o[k] = v; return v;
          }
          const v = this.ev(n.right, env); this.bindPattern(t, v, env, null); return v;
        }
        let obj, key, cur;
        if (t.type === "Identifier") cur = this.ident(t.name, env);
        else { obj = this.evMemberObject(t, env); key = this.memberKey(t, env); cur = obj[key]; }
        let nv;
        if (op === "&&=") { if (!cur) return cur; nv = this.ev(n.right, env); }
        else if (op === "||=") { if (cur) return cur; nv = this.ev(n.right, env); }
        else if (op === "??=") { if (cur !== null && cur !== undefined) return cur; nv = this.ev(n.right, env); }
        else nv = this.binop(op.slice(0, -1), cur, this.ev(n.right, env));
        if (t.type === "Identifier") this.assignIdent(t.name, nv, env); else obj[key] = nv;
        return nv;
      }
      case "ChainExpression": { const r = this.ev(n.expression, env); return r === SHORT ? undefined : r; }
      case "MemberExpression": {
        if (n.object.type === "Super") { const ctx = this.ctxOf(env); return Reflect.get(Object.getPrototypeOf(ctx.home), this.memberKey(n, env), ctx.thisVal); }
        const o = this.ev(n.object, env);
        if (o === SHORT || (n.optional && (o === null || o === undefined))) return SHORT;
        return o[this.memberKey(n, env)];
      }
      case "CallExpression": {
        const c = n.callee;
        if (c.type === "Super") {
          const ctx = this.ctxOf(env), info = ctx.info, args = this.evArgs(n.arguments, env);
          ctx.thisVal = Reflect.construct(info.parent, args, ctx.newTarget);
          this.initFields(info, ctx.thisVal); return undefined;
        }
        let fn, thisVal;
        if (c.type === "MemberExpression") {
          if (c.object.type === "Super") { const ctx = this.ctxOf(env); thisVal = ctx.thisVal; fn = Reflect.get(Object.getPrototypeOf(ctx.home), this.memberKey(c, env), thisVal); }
          else {
            const o = this.ev(c.object, env);
            if (o === SHORT || (c.optional && (o === null || o === undefined))) return SHORT;
            thisVal = o; fn = o[this.memberKey(c, env)];
          }
        } else { fn = this.ev(c, env); if (fn === SHORT) return SHORT; }
        if (n.optional && (fn === null || fn === undefined)) return SHORT;
        const args = this.evArgs(n.arguments, env);
        if (typeof fn !== "function") throw new TypeError(`${this.src(c)} is not a function`);
        this.curLine = n.loc.start.line;
        return Reflect.apply(fn, thisVal, args);
      }
      case "NewExpression": {
        const C = this.ev(n.callee, env), args = this.evArgs(n.arguments, env);
        if (typeof C !== "function") throw new TypeError(`${this.src(n.callee)} is not a constructor`);
        this.curLine = n.loc.start.line;
        return Reflect.construct(C, args);
      }
      case "MetaProperty": return this.ctxOf(env).newTarget;
      case "SpreadElement": throw new InterpError("Unexpected spread", n.loc.start.line);
      case "AwaitExpression": throw new InterpError("await isn't supported by the AlgoLens JavaScript tracer yet", n.loc.start.line);
      case "YieldExpression": throw new InterpError("Generators aren't supported by the AlgoLens JavaScript tracer yet", n.loc.start.line);
    }
    throw new InterpError(`Unsupported expression: ${n.type}`, n.loc ? n.loc.start.line : this.curLine);
  }

  // ---------------------------------------------------------------- program loading and entry
  load(code) {
    this.code = code;
    const ast = parseCode(code);
    this.ast = ast;
    this.trace = false;
    this.hoistVarsOf(ast, ast.body, this.root);
    const c = this.execList(ast.body, this.root);
    void c;
    return ast;
  }
}

// ---------------------------------------------------------------- input conversion
const LIST_NAMES = /^(head|l1|l2|list\d?|headA|headB|node)$/, TREE_NAMES = /^(root\d?|tree|p|q|subRoot|t1|t2)$/;
function jsdocTypes(code) {
  const types = {};
  for (const m of code.matchAll(/@param\s*\{([^}]*)\}\s*\[?\s*(\w+)/g)) types[m[2]] = m[1].trim();
  return types;
}
function convertInput(name, val, type) {
  const t = type || "";
  const deep = (v, kind, dims) => (dims > 0 ? (Array.isArray(v) ? v.map((x) => deep(x, kind, dims - 1)) : v) : Array.isArray(v) ? (kind === "list" ? buildList(v) : buildTree(v)) : v);
  const m = /(ListNode|TreeNode)((?:\s*\[\s*\])*)/.exec(t);
  if (m) return deep(val, m[1] === "ListNode" ? "list" : "tree", (m[2].match(/\[/g) || []).length);
  if (!t && Array.isArray(val)) {
    if (LIST_NAMES.test(name) && val.every((x) => typeof x === "number")) return buildList(val);
    if (TREE_NAMES.test(name) && val.every((x) => x === null || typeof x === "number")) return buildTree(val);
  }
  return val;
}

function describeError(e, I) {
  const line = I.errLine ?? I.curLine;
  if (e instanceof InterpError) return { error: `${e.message}${e.line ? ` (line ${e.line})` : ""}`, line: e.line || line };
  let text;
  if (e instanceof Error) text = `${e.name}: ${e.message}`;
  else { let s; try { s = typeof e === "string" ? JSON.stringify(e) : String(e); } catch { s = "[object]"; } text = `Uncaught ${s}`; }
  return { error: `${text}${line ? ` (line ${line})` : ""}`, line };
}

function topLevelCandidates(ast) {
  const out = [], isFn = (x) => x && (x.type === "FunctionExpression" || x.type === "ArrowFunctionExpression") && !x.async && !x.generator;
  for (const s of ast.body) {
    if (s.type === "FunctionDeclaration") { if (!s.async && !s.generator) out.push({ name: s.id.name, node: s }); }
    else if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) if (d.id.type === "Identifier" && isFn(d.init)) out.push({ name: d.id.name, node: d.init });
    } else if (s.type === "ClassDeclaration" && s.id.name === "Solution") {
      for (const m of s.body.body) if (m.type === "MethodDefinition" && m.kind === "method" && !m.static && !m.computed && m.key.type === "Identifier") out.push({ name: m.key.name, node: m.value, cls: s.id.name });
    }
  }
  return out;
}

export function traceJs(code, inputText, maxSteps = 1500) {
  const I = new Interpreter({ maxSteps });
  let pairs;
  try { pairs = splitInput(inputText).map(([n, raw]) => [n, parseValue(n, raw)]); } catch (e) { return { ok: false, error: e.message }; }
  const names = pairs.map(([n]) => n);
  try { I.load(code); }
  catch (e) {
    if (e && e.syntax) return { ok: false, error: e.message };
    if (e instanceof Abort) return { ok: false, error: "Your top-level code ran for too long before the function was called." };
    return { ok: false, error: `Error while loading your code: ${describeError(e, I).error}` };
  }
  const cands = topLevelCandidates(I.ast);
  if (!cands.length) return { ok: false, error: "No function found. Define a function such as `var twoSum = function(nums, target) { ... }`, as on LeetCode." };
  let best = null;
  for (const c of cands) {
    const params = c.node.params.map((p, i) => I.paramKey(p, i));
    const score = names.filter((n) => params.includes(n)).length * 10 - Math.abs(params.length - names.length);
    if (!best || score > best.score) best = { ...c, params, score };
  }
  const missing = best.params.filter((p) => !names.includes(p)), extra = names.filter((n) => !best.params.includes(n));
  if (missing.length || extra.length) return { ok: false, error: `\`${best.name}\` takes (${best.params.join(", ")}). Input has: ${names.join(", ")}. Fix the input field.` };
  const types = jsdocTypes(code);
  let args;
  try { args = best.params.map((p) => convertInput(p, pairs.find(([n]) => n === p)[1], types[p])); } catch (e) { return { ok: false, error: e.message }; }

  const result = { ok: true, steps: [], result: null, stdout: "", error: null, truncated: false, function: best.name };
  result.input = Object.fromEntries(best.params.map((p, i) => [p, I.snap(args[i])]));
  try {
    let fn, thisVal;
    if (best.cls) { const C = I.root.vars.get(best.cls).v; thisVal = Reflect.construct(C, []); fn = thisVal[best.name]; }
    else { const r = I.root.vars.get(best.name); fn = r && r.v; }
    if (typeof fn !== "function") throw new InterpError(`${best.name} is not a function (it was reassigned by your top-level code)`, 0);
    I.trace = true;
    const ret = Reflect.apply(fn, thisVal, args);
    result.result = I.snap(ret);
  } catch (e) {
    if (e instanceof Abort) { result.truncated = true; if (e.reason === "time") result.error = "Stopped: the program ran too many operations (possible infinite loop)."; }
    else { const d = describeError(e, I); result.error = d.error; result.error_line = d.line; }
  }
  result.steps = I.steps; result.stdout = I.out.slice(0, 2000);
  return result;
}

// ---------------------------------------------------------------- static analysis
export function analyzeJs(code) {
  let ast;
  try { ast = parseCode(code); } catch (e) { return { ok: false, error: e.message }; }
  const tags = [], evidence = {}, tag = (n, why) => { if (!tags.includes(n)) { tags.push(n); evidence[n] = why; } };
  const pointers = new Set(["i", "j", "k", "l", "r", "lo", "hi", "left", "right", "mid", "low", "high", "start", "end", "slow", "fast", "idx", "ptr"]);
  const fns = [];
  walk(ast, (n) => { if (isFnNode(n)) fns.push(n); });
  const nameOf = new Map();
  walk(ast, (n) => {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isFnNode(n.init)) nameOf.set(n.init, n.id.name);
    if (n.type === "AssignmentExpression" && isFnNode(n.right)) nameOf.set(n.right, n.left.type === "Identifier" ? n.left.name : n.left.type === "MemberExpression" && !n.left.computed ? n.left.property.name : "");
    if (n.type === "MethodDefinition" && !n.computed && n.key.type === "Identifier") nameOf.set(n.value, n.key.name);
    if (n.type === "MemberExpression" && n.computed) walk(n.property, (x) => { if (x.type === "Identifier") pointers.add(x.name); });
  });
  let recursive = false;
  for (const f of fns) {
    const nm = (f.id && f.id.name) || nameOf.get(f); if (!nm) continue;
    walk(f.body, (n) => {
      if (n.type !== "CallExpression") return;
      const c = n.callee;
      if (c.type === "Identifier" && c.name === nm) recursive = true;
      if (c.type === "MemberExpression" && !c.computed && c.property.name === nm && c.object.type === "ThisExpression") recursive = true;
    });
  }
  const LOOPS = new Set(["ForStatement", "WhileStatement", "DoWhileStatement", "ForInStatement", "ForOfStatement"]), HOF = new Set(["forEach", "map", "filter", "reduce", "some", "every", "find", "findIndex", "flatMap"]);
  const loopDepth = (node, d) => {
    let best = d;
    if (Array.isArray(node)) { for (const x of node) best = Math.max(best, loopDepth(x, d)); return best; }
    if (!node || typeof node.type !== "string") return best;
    let nd = d;
    if (LOOPS.has(node.type)) nd = d + 1;
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && HOF.has(node.callee.property.name) && node.arguments.some(isFnNode)) nd = d + 1;
    best = nd;
    for (const key of Object.keys(node)) { if (key === "loc") continue; const v = node[key]; if (v && typeof v === "object") best = Math.max(best, loopDepth(v, nd)); }
    return best;
  };
  const maxLoop = loopDepth(ast.body, 0), src = code;
  if (recursive) tag("Recursion", "a function calls itself");
  if (/\b(memo|cache|seen|visited)\b/.test(src) && recursive) tag("Memoization", "recursion with a memo/cache table");
  if (/\b(mid|m)\s*=\s*[^;\n]*(\/\s*2|>>>?\s*1)/.test(src)) tag("Binary search", "computes a midpoint of two bounds");
  if (!tags.includes("Binary search") && /while\s*\(\s*\w+\s*<=?\s*\w+\s*\)/.test(src) && /\b(left|l|lo|i|start|slow)\b/.test(src)) tag("Two pointers", "loop moves two indices toward each other");
  if (/\b(left|l)\s*\+\+|\b(left|l)\s*\+=\s*1/.test(src) && /for\s*\(\s*(let|var|const)\s+(right|r|j)\b/.test(src)) tag("Sliding window", "right pointer advances in a for-loop while left moves forward");
  if (/new\s+Map\b|=\s*\{\s*\}|Object\.(keys|entries|create)/.test(src)) tag("Hash map", "uses a Map / object as a dictionary");
  if (/new\s+Set\b/.test(src)) tag("Hash set", "uses a Set");
  if (/\.shift\(\)|new\s+Queue\b/.test(src)) tag("BFS / queue", "uses a queue (shift / Queue)");
  if (/PriorityQueue\b/.test(src)) tag("Heap / priority queue", "uses a PriorityQueue");
  if (/\.sort\(|\.toSorted\(/.test(src)) tag("Sorting", "calls sort()");
  if (/\.push\(/.test(src) && /\.pop\(\)/.test(src) && !/\.shift\(\)/.test(src)) tag("Stack", "push() and pop() on the same array");
  if (/\bdp\b|\bdp\[/.test(src)) tag("Dynamic programming", "a dp table");
  if (/Math\.max\(\s*\w+\s*,\s*\w+\s*\+\s*\w+\s*\)/.test(src)) tag("Kadane-style running best", "max(x, running + x) update");
  if (/\bprefix\b|\bpre\[/.test(src)) tag("Prefix sums", "prefix array");
  if (recursive && /\.push\([^)]*\)[\s\S]{0,300}\.pop\(\)/.test(src)) tag("Backtracking", "choose → recurse → undo (push … pop)");
  const usesSort = tags.includes("Sorting");
  let time;
  if (recursive && !tags.includes("Memoization") && !tags.includes("Dynamic programming")) time = "Depends on recursion (often O(n) for tree/DFS, exponential if branching)";
  else if (maxLoop === 0 && !usesSort) time = "O(1) or O(n) via built-ins";
  else if (tags.includes("Binary search") && maxLoop <= 1) time = "O(log n)";
  else if (usesSort && maxLoop <= 1) time = "O(n log n)";
  else time = maxLoop === 1 ? "O(n)" : maxLoop === 2 ? "O(n²)" : `O(n^${maxLoop})`;
  const makesStruct = /new\s+(Map|Set|Array|Queue|Deque|\w*PriorityQueue)\b|=\s*\[\s*\]|=\s*\{\s*\}|\.fill\(|Array\.from\(/.test(src);
  return { ok: true, tags, evidence, time, space: makesStruct || recursive ? "O(n) auxiliary" : "O(1) auxiliary", pointers: [...pointers].sort(), recursive };
}
