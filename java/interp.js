// Tree-walking interpreter for a Java subset, with step tracing in the same schema as tracer.py.
import { parse, JavaSyntaxError } from "./parser.js";
import * as R from "./runtime.js";
import { splitInput, parseValue } from "../inputs.js";
const { JD, JC, JArr, JList, JMap, JSet, JPQ, JSB, JEntry, JObj, JEx, JLambda, JavaThrow, coerce, castTo, arith, jeq, toNum, toStr, jthrow } = R;

const MAX_DEPTH = 400, MAX_OPS = 4_000_000, MAX_ITEMS = 40, MAX_STR = 60;
const UNSET = Symbol("unset");
class Abort extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class InterpError extends Error { constructor(msg, line) { super(msg); this.line = line; } }
const STATIC_CLASSES = new Set(["Math", "StrictMath", "Integer", "Long", "Double", "Float", "Boolean", "Character", "String", "Arrays", "Collections", "List", "Set", "Map", "Objects", "Comparator", "System", "Thread", "Short", "Byte", "Entry", "Optional"]);
const PRELUDE = `
class ListNode { int val; ListNode next; ListNode() {} ListNode(int val) { this.val = val; } ListNode(int val, ListNode next) { this.val = val; this.next = next; } }
class TreeNode { int val; TreeNode left; TreeNode right; TreeNode() {} TreeNode(int val) { this.val = val; }
  TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; } }`;

class Scope { constructor(parent = null) { this.vars = new Map(); this.parent = parent; }
  lookup(n) { for (let s = this; s; s = s.parent) { const r = s.vars.get(n); if (r) return r; } return undefined; } }
class Frame { constructor(scope, thisObj, cls, name, quiet) { Object.assign(this, { scope, root: scope, thisObj, cls, name, quiet }); } }

class ClassInfo {
  constructor(ast, quiet, outer) {
    this.ast = ast; this.name = ast.name; this.parent = ast.parent; this.quiet = quiet; this.outer = outer; this.statics = {}; this.methods = new Map(); this.interp = null;
    for (const m of ast.methods) { m.cls = this; if (!this.methods.has(m.name)) this.methods.set(m.name, []); this.methods.get(m.name).push(m); }
  }
  findMethods(name) { for (let c = this; c; c = this.interp.classes.get(c.parent)) { const l = c.methods.get(name); if (l) return l; } return null; }
  findMethod(name) { const l = this.findMethods(name); return l ? l[0] : null; }
  isSubclassOf(name) { for (let c = this; c; c = this.interp.classes.get(c.parent)) { if (c.name === name) return true; if (c.parent === name) return true; } return false; }
}

function typeMatch(v, t) { // overload scoring: -1 = incompatible
  if (t.dims > 0) return v === null || v instanceof JArr ? 2 : -1;
  switch (t.name) {
    case "int": case "short": case "byte": return typeof v === "number" ? 3 : v instanceof JC ? 1 : -1;
    case "Integer": return typeof v === "number" ? 2 : v === null ? 1 : -1;
    case "long": case "Long": return typeof v === "bigint" ? 3 : typeof v === "number" || v instanceof JC ? 1 : -1;
    case "double": case "float": case "Double": return v instanceof JD ? 3 : typeof v === "number" || typeof v === "bigint" || v instanceof JC ? 1 : -1;
    case "char": case "Character": return v instanceof JC ? 3 : -1;
    case "boolean": case "Boolean": return typeof v === "boolean" ? 3 : -1;
    case "String": return typeof v === "string" ? 3 : v === null ? 1 : -1;
    default: if (R.isNum(v) || typeof v === "boolean") return /^[A-Z]/.test(t.name) && t.name.length > 1 && !["Object", "Number", "Comparable"].includes(t.name) ? -1 : 0; return 1;
  }
}

export class Interpreter {
  constructor({ maxSteps = 1500, trace = true } = {}) {
    this.maxSteps = maxSteps; this.trace = trace; this.steps = []; this.stack = []; this.classes = new Map();
    this.out = ""; this.ops = 0; this.depth = 0; this.f = null; this.curLine = 0; this.pendingLabel = null; this.pointerNames = new Set();
    R.hooks.callFn = (fn, args) => this.callFn(fn, args);
    R.hooks.invokeMethod = (m, thisObj, args) => this.invoke(m, thisObj, args);
    R.hooks.userToString = (o) => { const m = o.cls.findMethod("toString"); return m ? toStr(this.invoke(m, o, [])) : `${o.cls.name}@1b6d3586`; };
    R.hooks.userEquals = (a, b) => { const m = a.cls.findMethod("equals"); return m ? this.invoke(m, a, [b]) : undefined; };
    R.hooks.userHash = (o) => { const m = o.cls.findMethod("hashCode"); return m ? this.invoke(m, o, []) : undefined; };
  }

  // ---------------------------------------------------------------- setup
  load(src) {
    for (const [source, quiet] of [[PRELUDE, true], [src, false]]) {
      const unit = parse(source);
      const register = (ast, outer) => { const ci = new ClassInfo(ast, quiet, outer); ci.interp = this; this.classes.set(ast.name, ci); for (const inner of ast.inner) register(inner, ci); return ci; };
      for (const c of unit.classes) register(c, null);
    }
  }
  initStatics() {
    const quietFrame = new Frame(new Scope(), null, null, "<static>", true); this.f = quietFrame;
    for (const ci of this.classes.values()) {
      if (ci.staticsReady) continue; ci.staticsReady = true; quietFrame.cls = ci;
      for (const fld of ci.ast.fields) if (fld.static) ci.statics[fld.name] = { v: this.initialValue(fld), t: fld.type };
      for (const init of ci.ast.inits) if (init.static) this.ex(init.body);
    }
  }
  initialValue(fld) {
    if (!fld.init) return R.defaultValue(fld.type.name, fld.type.dims);
    return fld.init.k === "arrayInit" ? this.evalArrayInit(fld.init) : coerce(this.ev(fld.init), fld.type);
  }

  // ---------------------------------------------------------------- tracing
  nid(o) { if (!this.nids) this.nids = new Map(); let n = this.nids.get(o); if (!n) { n = this.nids.size + 1; this.nids.set(o, n); } return n; }
  snap(v, depth = 0, seen = new Set()) {
    if (v === null || v === undefined || v === UNSET) return { t: "prim", v: null };
    if (typeof v === "boolean") return { t: "prim", v };
    if (typeof v === "number") return { t: "prim", v };
    if (typeof v === "bigint") return { t: "prim", v: v > -(2n ** 53n) && v < 2n ** 53n ? Number(v) : String(v) };
    if (v instanceof JD) return { t: "prim", v: R.jdStr(v.v) };
    if (v instanceof JC) return { t: "prim", v: String.fromCharCode(v.c) };
    if (typeof v === "string") return { t: "str", v: v.slice(0, MAX_STR), cut: v.length > MAX_STR };
    if (v instanceof JSB) return { t: "str", v: v.s.slice(0, MAX_STR), cut: v.s.length > MAX_STR };
    if (v instanceof JObj) {
      const name = v.cls.name;
      const isLL = "val" in v.f && "next" in v.f, isTree = "val" in v.f && "left" in v.f && "right" in v.f;
      if ((isLL || isTree) && depth > 0) return { t: "node", k: isTree ? "tree" : "ll", v: this.plain(v.f.val), id: this.nid(v) };
      if (isLL && !isTree) {
        const vals = [], ids = [], at = new Map(); let cur = v;
        while (cur && !at.has(cur) && vals.length < MAX_ITEMS) { at.set(cur, ids.length); ids.push(this.nid(cur)); vals.push(this.plain(cur.f.val)); cur = cur.f.next; }
        const cto = cur && at.has(cur) ? at.get(cur) : null;
        return { t: "ll", v: vals, ids, cycle: cto !== null, cto, cut: !!cur && cto === null };
      }
      if (isTree) {
        const budget = [31];
        const walk = (n, d) => { if (!n || budget[0] <= 0 || d > 5) return null; budget[0]--; return { v: this.plain(n.f.val), id: this.nid(n), l: walk(n.f.left, d + 1), r: walk(n.f.right, d + 1) }; };
        return { t: "tree", v: walk(v, 0) };
      }
    }
    if (seen.has(v) || depth > 3) return { t: "repr", v: "…" };
    const seen2 = new Set(seen).add(v), kids = (arr) => arr.slice(0, MAX_ITEMS).map((x) => this.snap(x, depth + 1, seen2));
    if (v instanceof JArr) return { t: "list", v: kids(v.a), n: v.a.length, cut: v.a.length > MAX_ITEMS, oid: this.nid(v) };
    if (v instanceof JPQ) return { t: "list", v: kids(v.a), n: v.a.length, cut: v.a.length > MAX_ITEMS, oid: this.nid(v), kind: "PriorityQueue" };
    if (v instanceof JList) return { t: ["ArrayDeque", "LinkedList"].includes(v.kind) ? "deque" : "list", v: kids(v.a), n: v.a.length, cut: v.a.length > MAX_ITEMS, oid: this.nid(v), kind: v.kind };
    if (v instanceof JSet) { const ks = R.orderedKeys(v); return { t: "set", v: kids(ks), n: ks.length, cut: ks.length > MAX_ITEMS, oid: this.nid(v) }; }
    if (v instanceof JMap) { const es = R.orderedEntries(v); return { t: "dict", v: es.slice(0, MAX_ITEMS).map((e) => [this.snap(e.k, depth + 1, seen2), this.snap(e.v, depth + 1, seen2)]), n: es.length, cut: es.length > MAX_ITEMS, oid: this.nid(v) }; }
    if (v instanceof JObj) {
      const body = Object.entries(v.f).filter(([k]) => !k.startsWith("__")).map(([k, x]) => `${k}=${this.short(x)}`).join(", ");
      return { t: "repr", v: `${v.cls.name}{${body}}`.slice(0, MAX_STR) };
    }
    return { t: "repr", v: toStr(v).slice(0, MAX_STR) };
  }
  plain(v) { return v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : toStr(v); }
  short(v) { const s = this.snap(v, 3); return s.t === "prim" ? String(s.v) : s.t === "str" ? JSON.stringify(s.v) : s.t === "ll" ? "list" : s.t === "tree" ? "tree" : `${s.t}[${s.n ?? "?"}]`; }
  snapLocals(frame) {
    const scopes = []; for (let s = frame.scope; s; s = s.parent) { scopes.push(s); if (s === frame.root) break; }
    const out = {};
    for (const s of scopes.reverse()) for (const [k, rec] of s.vars) if (rec.v !== UNSET) out[k] = this.snap(rec.v);
    if (!frame.cls || frame.cls.quiet) return out;
    if (frame.thisObj) for (const [k, v] of Object.entries(frame.thisObj.f)) if (!k.startsWith("__") && !(k in out)) out[k] = this.snap(v);
    for (let c = frame.cls; c; c = this.classes.get(c.parent)) for (const [k, rec] of Object.entries(c.statics)) if (!(k in out)) out[k] = this.snap(rec.v);
    return out;
  }
  record(ev, line, extra = {}) {
    const f = this.f; if (!this.trace || f.quiet) return;
    if (this.steps.length >= this.maxSteps) throw new Abort("steps");
    this.steps.push({ ev, line, fn: f.name, depth: this.stack.length, locals: this.snapLocals(f), stack: this.stack.slice(), ...extra });
  }
  step(line) { this.curLine = line; this.record("line", line); }

  // ---------------------------------------------------------------- calls
  err(msg, line = this.curLine) { throw new InterpError(msg, line); }
  pickMethod(list, args) {
    let best = null, bestScore = -1;
    for (const m of list) {
      const va = m.params.length && m.params[m.params.length - 1].varargs;
      if (!va && m.params.length !== args.length) continue;
      if (va && args.length < m.params.length - 1) continue;
      let score = va ? 0 : 1, ok = true;
      m.params.forEach((p, i) => { if (!ok || (va && i === m.params.length - 1)) return; const s = typeMatch(args[i], p.type); if (s < 0) ok = false; else score += s; });
      if (ok && score > bestScore) { best = m; bestScore = score; }
    }
    return best;
  }
  bindParams(m, scope, args) {
    const ps = m.params;
    ps.forEach((p, i) => {
      let v;
      if (p.varargs) {
        const rest = args.slice(i);
        v = rest.length === 1 && (rest[0] instanceof JArr || rest[0] === null) ? rest[0] : new JArr(rest.map((x) => coerce(x, { name: p.type.name, dims: p.type.dims - 1 })), p.type.name, p.type.dims);
      } else v = coerce(args[i], p.type);
      scope.vars.set(p.name, { v, t: p.type });
    });
  }
  invoke(m, thisObj, args, opts = {}) {
    if (this.depth >= MAX_DEPTH) jthrow("StackOverflowError");
    const cls = m.cls, scope = new Scope();
    this.bindParams(m, scope, args);
    const name = opts.ctorOf ? cls.name : m.name;
    const frame = new Frame(scope, thisObj, cls, name, cls.quiet), saved = this.f;
    this.depth++; this.f = frame;
    const quiet = cls.quiet;
    try {
      if (!quiet) {
        const argSnaps = {}; for (const p of m.params) argSnaps[p.name] = this.snap(scope.vars.get(p.name).v);
        this.stack.push({ fn: name, args: argSnaps }); this.f = frame;
        this.record("call", m.line);
      }
      let ret = null;
      const stmts = m.body.body;
      let sig;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (opts.ctorOf && i === 0 && s.k === "expr" && (s.e.k === "ctorCall" || s.e.k === "superCall")) { this.step(s.line); this.ev(s.e); continue; }
        sig = this.ex(s); if (sig) break;
      }
      if (sig && sig.s === "return") ret = sig.v;
      if (!opts.ctorOf) ret = coerce(ret, m.type);
      if (!quiet) this.record("return", this.curLine, { ret: this.snap(ret), ...(sig && sig.s === "return" && this.retLocals ? { locals: this.retLocals } : {}) });
      return ret;
    } finally {
      this.depth--; this.f = saved; if (!quiet) this.stack.pop();
    }
  }
  callFn(fn, args) {
    if (fn === null) jthrow("NullPointerException");
    if (fn.native) return fn.native(args);
    if (fn instanceof JLambda) {
      const scope = new Scope(fn.scope), saved = this.f;
      fn.params.forEach((p, i) => scope.vars.set(p, { v: args[i], t: null }));
      const frame = new Frame(scope, fn.thisObj, fn.cls, "lambda", true); this.f = frame; this.depth++;
      try {
        if (this.depth > MAX_DEPTH) jthrow("StackOverflowError");
        if (fn.body.k !== "block") return this.ev(fn.body);
        frame.quiet = false; frame.cls = fn.cls;
        const sig = this.ex(fn.body); return sig && sig.s === "return" ? sig.v : null;
      } finally { this.depth--; this.f = saved; }
    }
    if (fn instanceof JObj) { // anonymous class / functional object: call its single user method
      const ms = [...fn.cls.methods.values()].flat(); const m = this.pickMethod(ms, args) || ms[0];
      if (!m) this.err("Object is not callable"); return this.invoke(m, fn, args);
    }
    this.err("Value is not callable");
  }
  construct(cls, args, node) {
    const obj = new JObj(cls);
    const chain = []; for (let c = cls; c; c = this.classes.get(c.parent)) chain.unshift(c);
    const saved = this.f, tmp = new Frame(new Scope(), obj, cls, "<init>", true); this.f = tmp;
    try {
      for (const c of chain) {
        tmp.cls = c;
        for (const fld of c.ast.fields) if (!fld.static) obj.f[fld.name] = this.initialValue(fld);
        for (const init of c.ast.inits) if (!init.static) this.ex(init.body);
      }
    } finally { this.f = saved; }
    this.runCtor(cls, obj, args);
    return obj;
  }
  runCtor(cls, obj, args) {
    const ctors = cls.ast.ctors;
    if (!ctors.length) {
      if (args.length && !cls.ast.name.startsWith("$")) this.err(`No constructor ${cls.name}(${args.length} args)`);
      const parent = this.classes.get(cls.parent); if (parent) this.runCtor(parent, obj, []);
      return;
    }
    const m = this.pickMethod(ctors.map((c) => ({ ...c, cls })), args);
    if (!m) this.err(`No matching constructor for ${cls.name} with ${args.length} argument(s)`);
    this.invoke(m, obj, args, { ctorOf: true });
  }
  findUserMethod(cls, name, args) { const list = cls.findMethods(name); return list ? this.pickMethod(list, args) : null; }

  // ---------------------------------------------------------------- name resolution
  lookupVar(id) {
    const r = this.f.scope.lookup(id); if (r) return { kind: "local", rec: r };
    const o = this.f.thisObj; if (o && id in o.f) return { kind: "field", obj: o, id, t: this.fieldType(o.cls, id) };
    for (let c = this.f.cls; c; c = c.outer || this.classes.get(c.parent)) { for (let k = c; k; k = this.classes.get(k.parent)) if (id in k.statics) return { kind: "static", rec: k.statics[id] }; }
    return null;
  }
  fieldType(cls, id) { for (let c = cls; c; c = this.classes.get(c.parent)) { const f = c.ast.fields.find((x) => x.name === id); if (f) return f.type; } return null; }
  classRef(node) {
    if (node.k === "name" && !this.lookupVar(node.id) && (this.classes.has(node.id) || STATIC_CLASSES.has(node.id))) return node.id;
    if (node.k === "field" && node.obj.k === "name" && node.obj.id === "Map" && node.name === "Entry") return "Entry";
    return null;
  }
  readTarget(t) {
    switch (t.k) {
      case "name": { const v = this.lookupVar(t.id); if (!v) this.err(`Cannot find symbol: ${t.id}`, t.line); const val = v.kind === "local" ? v.rec.v : v.kind === "field" ? v.obj.f[t.id] : v.rec.v; if (val === UNSET) this.err(`Variable '${t.id}' might not have been initialized`, t.line); return val; }
      default: return this.ev(t);
    }
  }

  // ---------------------------------------------------------------- statements
  runBlockBody(stmts) { for (const s of stmts) { const sig = this.ex(s); if (sig) return sig; } return undefined; }
  withScope(fn) { const f = this.f, saved = f.scope; f.scope = new Scope(saved); try { return fn(); } finally { f.scope = saved; } }
  loopSignal(sig, label) { // returns "break" | "continue" | sig (propagate) | undefined
    if (!sig) return undefined;
    if (sig.s === "break") return !sig.label || sig.label === label ? "break" : sig;
    if (sig.s === "continue") return !sig.label || sig.label === label ? "continue" : sig;
    return sig;
  }
  truthy(v, line) { if (typeof v !== "boolean") { if (v === null) jthrow("NullPointerException"); this.err("Condition is not a boolean", line); } return v; }
  declare(name, v, t) { this.f.scope.vars.set(name, { v, t }); }
  ex(node) {
    if (++this.ops > MAX_OPS) throw new Abort("time");
    switch (node.k) {
      case "block": return this.withScope(() => this.runBlockBody(node.body));
      case "empty": return undefined;
      case "local": {
        this.step(node.line);
        for (const d of node.decls) {
          const isVar = d.type.name === "var" && d.type.dims === 0;
          if (!d.init) { this.declare(d.name, UNSET, d.type); continue; }
          const v = d.init.k === "arrayInit" ? this.evalArrayInit(d.init) : this.ev(d.init);
          this.declare(d.name, isVar ? v : coerce(v, d.type), isVar ? null : d.type);
        }
        return undefined;
      }
      case "expr": this.step(node.line); this.ev(node.e); return undefined;
      case "if": { this.step(node.line); if (this.truthy(this.ev(node.cond), node.line)) return this.ex(node.then); return node.els ? this.ex(node.els) : undefined; }
      case "labeled": {
        this.pendingLabel = node.label; const sig = this.ex(node.stmt); this.pendingLabel = null;
        return sig && sig.s === "break" && sig.label === node.label ? undefined : sig;
      }
      case "while": {
        const label = this.pendingLabel; this.pendingLabel = null;
        for (;;) {
          this.step(node.line); if (!this.truthy(this.ev(node.cond), node.line)) break;
          const r = this.loopSignal(this.ex(node.body), label); if (r === "break") break; if (r && r !== "continue") return r;
        }
        return undefined;
      }
      case "doWhile": {
        const label = this.pendingLabel; this.pendingLabel = null;
        do {
          const r = this.loopSignal(this.ex(node.body), label); if (r === "break") break; if (r && r !== "continue") return r;
          this.step(node.line);
        } while (this.truthy(this.ev(node.cond), node.line));
        return undefined;
      }
      case "for": {
        const label = this.pendingLabel; this.pendingLabel = null;
        return this.withScope(() => {
          for (const s of node.init) {
            if (s.k === "local") { for (const d of s.decls) { const v = d.init ? (d.init.k === "arrayInit" ? this.evalArrayInit(d.init) : this.ev(d.init)) : UNSET; this.declare(d.name, v === UNSET ? v : coerce(v, d.type), d.type); } }
            else this.ev(s.e);
          }
          for (;;) {
            this.step(node.line);
            if (node.cond && !this.truthy(this.ev(node.cond), node.line)) break;
            const r = this.loopSignal(this.ex(node.body), label); if (r === "break") break; if (r && r !== "continue") return r;
            for (const u of node.update) this.ev(u);
          }
          return undefined;
        });
      }
      case "foreach": {
        const label = this.pendingLabel; this.pendingLabel = null;
        const items = R.iterate(this.ev(node.iter));
        for (const item of items) {
          const r = this.withScope(() => {
            const isVar = node.type.name === "var";
            this.declare(node.name, isVar ? item : coerce(item, node.type), isVar ? null : node.type);
            this.step(node.line); return this.loopSignal(this.ex(node.body), label);
          });
          if (r === "break") break; if (r && r !== "continue") return r;
        }
        return undefined;
      }
      case "return": { this.step(node.line); const v = node.e ? this.ev(node.e) : null; this.retLocals = this.trace && !this.f.quiet ? this.snapLocals(this.f) : null; return { s: "return", v }; }
      case "break": case "continue": this.step(node.line); return { s: node.k, label: node.label };
      case "yield": this.step(node.line); return { s: "yield", v: this.ev(node.e) };
      case "throw": { this.step(node.line); const v = this.ev(node.e); if (v === null) jthrow("NullPointerException"); throw new JavaThrow(v, node.line); }
      case "arrowExpr": this.step(node.line); this.ev(node.e); return undefined;
      case "localClass": { const ci = new ClassInfo(node.cls, false, this.f.cls); ci.interp = this; this.classes.set(node.cls.name, ci); ci.staticsReady = true; return undefined; }
      case "switch": { this.step(node.line); const r = this.runSwitch(node, false); return r && r.s === "break" && !r.label ? undefined : r; }
      case "try": return this.runTry(node);
      default: this.err(`Unsupported statement: ${node.k}`, node.line);
    }
  }
  runSwitch(node, asExpr) {
    const sel = this.ev(node.expr);
    const matches = (c) => c.labels.some((l) => { const v = l.k === "name" && !this.lookupVar(l.id) ? l.id : this.ev(l); return typeof sel === "string" && typeof v === "string" ? sel === v : jeq(sel, v) || (sel instanceof JObj && false); });
    let idx = node.cases.findIndex(matches);
    if (idx < 0) idx = node.cases.findIndex((c) => c.isDefault);
    if (idx < 0) { if (sel === null) jthrow("NullPointerException"); return undefined; }
    return this.withScope(() => {
      for (let i = idx; i < node.cases.length; i++) {
        const c = node.cases[i];
        for (const s of c.body) {
          if (asExpr && c.arrow && s.k === "arrowExpr") { this.step(s.line); return { s: "yield", v: this.ev(s.e) }; }
          const sig = this.ex(s); if (sig) return sig;
        }
        if (c.arrow) break;
      }
      return undefined;
    });
  }
  runTry(node) {
    const run = () => this.withScope(() => {
      for (const r of node.resources) this.ex(r);
      return this.ex(node.block);
    });
    let sig, pending = null;
    try {
      try { sig = run(); }
      catch (e) {
        if (e instanceof RangeError) e = new JavaThrow(new JEx("StackOverflowError"), this.curLine);
        if (!(e instanceof JavaThrow)) throw e;
        if (!e.line) e.line = this.curLine;
        const c = node.catches.find((cc) => cc.types.some((t) => this.exceptionMatches(e.value, t)));
        if (!c) throw e;
        sig = this.withScope(() => { this.declare(c.name, e.value, null); return this.ex(c.body); });
      }
    } catch (e) { pending = e; }
    if (node.fin) { const fs = this.ex(node.fin); if (fs) return fs; }
    if (pending) throw pending;
    return sig;
  }
  exceptionMatches(val, typeName) {
    if (typeName === "Throwable") return true;
    if (val instanceof JEx) return R.exInherits(val.name, typeName);
    if (val instanceof JObj) { for (let c = val.cls; c; c = this.classes.get(c.parent)) { if (c.name === typeName) return true; if (!this.classes.has(c.parent) && c.parent && R.exInherits(c.parent, typeName)) return true; } }
    return false;
  }

  // ---------------------------------------------------------------- expressions
  evalArrayInit(node) {
    const t = node.type, inner = { name: t.name, dims: t.dims - 1 };
    return new JArr(node.elems.map((e) => e.k === "arrayInit" ? this.evalArrayInit(e) : coerce(this.ev(e), inner)), t.name, t.dims);
  }
  makeArray(node, level) {
    const n = toNum(this.ev(node.dimExprs[level]));
    if (n < 0) jthrow("NegativeArraySizeException", String(n));
    const dims = node.total - level, a = new Array(n);
    if (level === node.dimExprs.length - 1) { const d = R.defaultValue(node.type.name, dims - 1); for (let i = 0; i < n; i++) a[i] = d; }
    else for (let i = 0; i < n; i++) a[i] = this.makeArray(node, level + 1);
    return new JArr(a, node.type.name, dims);
  }
  assignTo(target, value) {
    switch (target.k) {
      case "name": {
        const v = this.lookupVar(target.id); if (!v) this.err(`Cannot find symbol: ${target.id}`, target.line);
        if (v.kind === "local") { const rec = v.rec; rec.v = rec.t ? coerce(value, rec.t) : value; return rec.v; }
        if (v.kind === "field") { v.obj.f[target.id] = coerce(value, v.t); return v.obj.f[target.id]; }
        v.rec.v = coerce(value, v.rec.t); return v.rec.v;
      }
      case "field": {
        const cr = this.classRef(target.obj);
        if (cr && this.classes.has(cr)) { const rec = this.classes.get(cr).statics[target.name]; if (!rec) this.err(`No static field ${target.name}`, target.line); rec.v = coerce(value, rec.t); return rec.v; }
        const o = target.obj.k === "this" ? this.f.thisObj : this.ev(target.obj);
        if (o === null) jthrow("NullPointerException", `Cannot assign field "${target.name}" because value is null`);
        if (!(o instanceof JObj)) this.err(`Cannot assign field ${target.name}`, target.line);
        o.f[target.name] = coerce(value, this.fieldType(o.cls, target.name)); return o.f[target.name];
      }
      case "index": {
        const arr = this.ev(target.obj), i = toNum(this.ev(target.idx));
        if (arr === null) jthrow("NullPointerException", "Cannot store to array because value is null");
        if (i < 0 || i >= arr.a.length) jthrow("ArrayIndexOutOfBoundsException", `Index ${i} out of bounds for length ${arr.a.length}`);
        arr.a[i] = coerce(value, { name: arr.et, dims: arr.dims - 1 }); return arr.a[i];
      }
    }
    this.err("Invalid assignment target", target.line);
  }
  ev(node) {
    if (++this.ops > MAX_OPS) throw new Abort("time");
    switch (node.k) {
      case "lit": switch (node.kind) {
        case "int": return /^0[xX]/.test(node.text) ? parseInt(node.text.slice(2), 16) | 0 : /^0[bB]/.test(node.text) ? parseInt(node.text.slice(2), 2) | 0 : Number(node.text) | 0;
        case "long": { const t = node.text.slice(0, -1); return BigInt.asIntN(64, BigInt(/^0[xXbB]/.test(t) ? t : t)); }
        case "double": return new JD(parseFloat(node.text.replace(/[fFdD]$/, "")));
        case "string": return node.v; case "char": return new JC(node.v.charCodeAt(0)); case "bool": return node.v; case "null": return null;
      } break;
      case "paren": return this.ev(node.e);
      case "name": return this.readTarget(node);
      case "this": return this.f.thisObj;
      case "field": return this.evField(node);
      case "index": {
        const arr = this.ev(node.obj), i = toNum(this.ev(node.idx));
        if (arr === null) jthrow("NullPointerException", "Cannot load from array because value is null");
        if (!(arr instanceof JArr)) this.err("Indexing a non-array value", node.line);
        if (i < 0 || i >= arr.a.length) jthrow("ArrayIndexOutOfBoundsException", `Index ${i} out of bounds for length ${arr.a.length}`);
        return arr.a[i];
      }
      case "call": return this.evCall(node);
      case "new": return this.evNew(node);
      case "newArray": return node.init ? this.evalArrayInit(node.init) : this.makeArray(node, 0);
      case "arrayInit": return this.evalArrayInit(node);
      case "unary": {
        const v = this.ev(node.e);
        switch (node.op) {
          case "!": return !v;
          case "-": return typeof v === "bigint" ? BigInt.asIntN(64, -v) : v instanceof JD ? new JD(-v.v) : (-toNum(v)) | 0;
          case "+": return v instanceof JC ? v.c : v;
          case "~": return typeof v === "bigint" ? ~v : ~toNum(v);
        }
        break;
      }
      case "update": {
        const cur = this.readTarget(node.target), d = node.op === "++" ? 1 : -1;
        const next = typeof cur === "bigint" ? BigInt.asIntN(64, cur + BigInt(d)) : cur instanceof JD ? new JD(cur.v + d) : cur instanceof JC ? new JC((cur.c + d) & 0xffff) : (cur + d) | 0;
        const stored = this.assignTo(node.target, next);
        return node.prefix ? stored : cur;
      }
      case "binary": return this.evBinary(node);
      case "assign": {
        if (node.op === "=") { const v = node.value.k === "arrayInit" ? this.evalArrayInit(node.value) : this.ev(node.value); return this.assignTo(node.target, v); }
        const cur = this.readTarget(node.target), rhs = this.ev(node.value), op = node.op.slice(0, -1);
        let res = arith(op, cur, rhs);
        const t = node.target.k === "name" ? (this.lookupVar(node.target.id) || {}).rec?.t : null;
        if (!(typeof res === "string")) res = castTo(res, t || this.inferType(cur));
        return this.assignTo(node.target, res);
      }
      case "cond": return this.truthy(this.ev(node.c), node.line) ? this.ev(node.a) : this.ev(node.b);
      case "cast": return castTo(this.ev(node.e), node.type);
      case "instanceof": return this.instanceOf(this.ev(node.e), node.type.name);
      case "lambda": return new JLambda(node.params, node.body, this.f.scope, this.f.thisObj, this.f.cls);
      case "methodRef": return this.evMethodRef(node);
      case "switchExpr": { const r = this.runSwitch(node, true); if (!r || r.s !== "yield") this.err("Switch expression produced no value", node.line); return r.v; }
      case "ctorCall": { const args = node.args.map((a) => this.ev(a)); this.runCtorOn(this.f.cls, this.f.thisObj, args); return null; }
      case "superCall": {
        const args = node.args.map((a) => this.ev(a)), parent = this.classes.get(this.f.cls.parent);
        if (parent) this.runCtor(parent, this.f.thisObj, args); else if (typeof args[0] === "string") this.f.thisObj.f.__msg = args[0];
        return null;
      }
    }
    this.err(`Unsupported expression: ${node.k}${node.kind ? " " + node.kind : ""}`, node.line);
  }
  runCtorOn(cls, obj, args) { const ms = cls.ast.ctors.map((c) => ({ ...c, cls })); const m = this.pickMethod(ms, args); if (!m) this.err(`No matching constructor for this(...)`); this.invoke(m, obj, args, { ctorOf: true }); }
  inferType(v) { return typeof v === "number" ? { name: "int", dims: 0 } : typeof v === "bigint" ? { name: "long", dims: 0 } : v instanceof JD ? { name: "double", dims: 0 } : v instanceof JC ? { name: "char", dims: 0 } : null; }
  instanceOf(v, name) {
    if (v === null) return false;
    switch (name) {
      case "Object": return true; case "String": case "CharSequence": return typeof v === "string"; case "Integer": return typeof v === "number"; case "Long": return typeof v === "bigint";
      case "Double": return v instanceof JD; case "Character": return v instanceof JC; case "Boolean": return typeof v === "boolean"; case "Number": return typeof v === "number" || typeof v === "bigint" || v instanceof JD;
      case "List": case "ArrayList": case "LinkedList": case "Collection": case "Deque": case "Queue": return v instanceof JList; case "Map": case "HashMap": case "TreeMap": return v instanceof JMap; case "Set": case "HashSet": case "TreeSet": return v instanceof JSet;
    }
    return v instanceof JObj && v.cls.isSubclassOf(name);
  }
  evBinary(node) {
    const op = node.op;
    if (op === "&&") return this.truthy(this.ev(node.l), node.line) && this.truthy(this.ev(node.r), node.line);
    if (op === "||") return this.truthy(this.ev(node.l), node.line) || this.truthy(this.ev(node.r), node.line);
    const a = this.ev(node.l), b = this.ev(node.r);
    switch (op) {
      case "==": return jeq(a, b); case "!=": return !jeq(a, b);
      case "<": case ">": case "<=": case ">=": if (a === null || b === null) jthrow("NullPointerException"); return R.compareNums(op, a, b);
      default: return arith(op, a, b);
    }
  }
  evField(node) {
    const cr = this.classRef(node.obj);
    if (cr) {
      const ci = this.classes.get(cr);
      if (ci) { const rec = ci.statics[node.name]; if (rec) return rec.v; this.err(`No static field ${cr}.${node.name}`, node.line); }
      const v = R.callStaticBuiltin(cr, node.name, []); if (v !== undefined) return v;
      this.err(`Unsupported constant ${cr}.${node.name}`, node.line);
    }
    const o = node.obj.k === "this" ? this.f.thisObj : this.ev(node.obj);
    if (o === null) jthrow("NullPointerException", `Cannot read field "${node.name}" because value is null`);
    if (o instanceof JArr && node.name === "length") return o.a.length;
    if (o instanceof JObj) { if (node.name in o.f) return o.f[node.name]; for (let c = o.cls; c; c = this.classes.get(c.parent)) if (node.name in c.statics) return c.statics[node.name].v; }
    this.err(`Cannot find field '${node.name}'`, node.line);
  }
  evNew(node) {
    const t = node.type, args = node.args.map((a) => this.ev(a));
    if (node.body) { // anonymous class
      const ast = { ...node.body, name: "$anon" + node.line }; const ci = new ClassInfo(ast, false, this.f.cls); ci.interp = this; ci.staticsReady = true;
      if (!this.classes.has(ast.name)) this.classes.set(ast.name, ci);
      return this.construct(this.classes.get(ast.name), [], node);
    }
    const ci = this.classes.get(t.name);
    if (ci) return this.construct(ci, args, node);
    if (R.isExceptionName(t.name)) return new JEx(t.name, typeof args[0] === "string" ? args[0] : args[0] instanceof JEx ? toStr(args[0]) : null, args[1] ?? (args[0] instanceof JEx ? args[0] : null));
    const v = R.newCollection(t.name, args);
    if (v === undefined) this.err(`Unsupported class: ${t.name}`, node.line);
    return v;
  }
  evMethodRef(node) {
    const name = node.name, cr = this.classRef(node.obj), line = node.line;
    if (cr) {
      const ci = this.classes.get(cr);
      if (name === "new") return new JLambda(null, null, null, null, null, (args) => ci ? this.construct(ci, args) : R.newCollection(cr, args));
      return new JLambda(null, null, null, null, null, (args) => {
        if (ci) { const m = this.findUserMethod(ci, name, args); if (m && m.static) return this.invoke(m, null, args); const m2 = args[0] instanceof JObj ? this.findUserMethod(args[0].cls, name, args.slice(1)) : null; if (m2) return this.invoke(m2, args[0], args.slice(1)); this.err(`Cannot resolve ${cr}::${name}`, line); }
        const s = R.callStaticBuiltin(cr, name, args); if (s !== undefined) return s;
        const r = R.callBuiltinMethod(args[0], name, args.slice(1), null); if (r !== undefined) return r;
        this.err(`Cannot resolve ${cr}::${name}`, line);
      });
    }
    if (node.obj.k === "field" && node.obj.obj.k === "name" && node.obj.obj.id === "System") return new JLambda(null, null, null, null, null, (args) => { this.out += (name === "println" ? toStr(args[0]) + "\n" : toStr(args[0])); return null; });
    const recv = node.obj.k === "this" ? this.f.thisObj : this.ev(node.obj);
    return new JLambda(null, null, null, null, null, (args) => this.callOn(recv, name, args, node));
  }
  callOn(recv, name, args, node) {
    if (recv === null) jthrow("NullPointerException", `Cannot invoke "${name}()" because value is null`);
    if (recv instanceof JObj) {
      const m = this.findUserMethod(recv.cls, name, args); if (m) return this.invoke(m, recv, args);
      if (name === "getMessage") return recv.f.__msg ?? null; if (name === "toString") return toStr(recv); if (name === "equals") return recv === args[0]; if (name === "hashCode") return 0;
      if (name === "printStackTrace") return null;
      this.err(`Cannot find method ${recv.cls.name}.${name}`, node.line);
    }
    const r = R.callBuiltinMethod(recv, name, args, node);
    if (r === undefined) this.err(`Unsupported method: ${name}() on ${recv instanceof JList ? recv.kind : recv instanceof JMap ? recv.kind : typeof recv === "object" ? recv.constructor.name : typeof recv}`, node.line);
    return r;
  }
  evCall(node) {
    const name = node.name;
    if (!node.obj) {
      const args = node.args.map((a) => this.ev(a));
      const start = this.f.thisObj ? this.f.thisObj.cls : this.f.cls;
      let m = null;
      for (let c = start; c && !m; c = c.outer) m = this.findUserMethod(c, name, args);
      if (!m && this.f.cls) for (let c = this.f.cls; c && !m; c = c.outer) m = this.findUserMethod(c, name, args);
      if (!m) { const lv = this.lookupVar(name); if (lv) return this.callFn(this.readTarget({ k: "name", id: name }), args); this.err(`Cannot find method '${name}' with ${args.length} argument(s)`, node.line); }
      return this.invoke(m, m.static ? null : (this.f.thisObj && this.f.thisObj.cls.isSubclassOf(m.cls.name) ? this.f.thisObj : this.f.thisObj), args);
    }
    const o = node.obj;
    if (o.k === "field" && o.obj.k === "name" && o.obj.id === "System" && (o.name === "out" || o.name === "err")) {
      const args = node.args.map((a) => this.ev(a)); const s = args.length ? (args[0] instanceof JArr && args[0].et === "char" ? args[0].a.map(toStr).join("") : name === "printf" || name === "format" ? R.formatJava(args[0], args.slice(1)) : toStr(args[0])) : "";
      if (o.name === "out" && ["println", "print", "printf", "format"].includes(name)) { this.out += s + (name === "println" ? "\n" : ""); if (this.out.length > 20000) this.out = this.out.slice(0, 20000); }
      return null;
    }
    if (o.k === "name" && o.id === "super") {
      const args = node.args.map((a) => this.ev(a)), parent = this.classes.get(this.f.cls.parent), m = parent && this.findUserMethod(parent, name, args);
      if (!m) this.err(`Cannot find super method ${name}`, node.line); return this.invoke(m, this.f.thisObj, args);
    }
    const cr = this.classRef(o);
    if (cr) {
      const args = node.args.map((a) => this.ev(a)), ci = this.classes.get(cr);
      if (ci) { const m = this.findUserMethod(ci, name, args); if (!m) this.err(`Cannot find static method ${cr}.${name}`, node.line); return this.invoke(m, null, args); }
      const r = R.callStaticBuiltin(cr, name, args); if (r === undefined) this.err(`Unsupported method: ${cr}.${name}()`, node.line); return r;
    }
    const recv = o.k === "this" ? this.f.thisObj : this.ev(o);
    const args = node.args.map((a) => this.ev(a));
    if (name === "remove" && node.args.length === 1) { const a0 = node.args[0]; node.removeObject = (a0.k === "call" && a0.obj?.k === "name" && a0.obj.id === "Integer" && a0.name === "valueOf") || (a0.k === "cast" && ["Integer", "Object", "Long"].includes(a0.type.name)); }
    return this.callOn(recv, name, args, node);
  }

  // ---------------------------------------------------------------- run
  runEntry(cls, method, args) {
    this.initStatics();
    const root = new Frame(new Scope(), null, cls, "<entry>", true); this.f = root;
    const obj = method.static ? null : this.construct(cls, []);
    this.f = root;
    return this.invoke(method, obj, args);
  }
}

// ---------------------------------------------------------------- input conversion
function convertInput(val, t, I) {
  if (val === null) return null;
  const inferred = (v) => Array.isArray(v) ? new JList("ArrayList", v.map(inferred)) : typeof v === "number" ? (Number.isInteger(v) ? v | 0 : new JD(v)) : typeof v === "string" ? v : v;
  if (t.dims > 0) { if (!Array.isArray(val)) throw new Error(`Expected an array for ${t.name}${"[]".repeat(t.dims)}`); return new JArr(val.map((x) => convertInput(x, { ...t, dims: t.dims - 1 }, I)), t.name, t.dims); }
  switch (t.name) {
    case "int": case "short": case "byte": case "Integer": return coerce(val, { name: "int", dims: 0 });
    case "long": case "Long": return BigInt(val); case "double": case "float": case "Double": case "Float": return new JD(Number(val));
    case "boolean": case "Boolean": return !!val; case "String": return String(val);
    case "char": case "Character": return new JC(String(val).charCodeAt(0));
    case "ListNode": { let head = null; for (let i = val.length - 1; i >= 0; i--) { const n = new JObj(I.classes.get("ListNode")); n.f.val = val[i] | 0; n.f.next = head; head = n; } return head; }
    case "TreeNode": {
      if (!val.length || val[0] === null) return null;
      const mk = (v) => { const n = new JObj(I.classes.get("TreeNode")); n.f.val = v | 0; n.f.left = null; n.f.right = null; return n; };
      const root = mk(val[0]), q = [root]; let i = 1;
      while (q.length && i < val.length) { const n = q.shift(); if (i < val.length && val[i] !== null) { n.f.left = mk(val[i]); q.push(n.f.left); } i++; if (i < val.length && val[i] !== null) { n.f.right = mk(val[i]); q.push(n.f.right); } i++; }
      return root;
    }
    case "List": case "ArrayList": case "LinkedList": case "Collection": case "Queue": case "Deque": case "ArrayDeque": case "Stack":
      return new JList("ArrayList", val.map((x) => convertInput(x, t.args[0] || { name: "Object", dims: 0, args: [] }, I)));
    case "Set": case "HashSet": case "TreeSet": { const s = new JSet(t.name === "TreeSet" ? "TreeSet" : "HashSet"); val.forEach((x) => R.setAdd(s, convertInput(x, t.args[0] || { name: "Object", dims: 0, args: [] }, I))); return s; }
    case "Object": return inferred(val);
  }
  if (I.classes.has(t.name)) throw new Error(`Input of type ${t.name} isn't supported yet`);
  return inferred(val);
}

function describeError(e, interp) {
  if (e instanceof JavaThrow) {
    const v = e.value, line = e.line || interp.curLine;
    const text = v instanceof JEx ? toStr(v) : v instanceof JObj ? (v.f.__msg != null ? `${v.cls.name}: ${v.f.__msg}` : v.cls.name) : toStr(v);
    return { error: `${text}${line ? ` (line ${line})` : ""}`, line };
  }
  if (e instanceof RangeError) return { error: `StackOverflowError: recursion too deep for this tracer (line ${interp.curLine})`, line: interp.curLine };
  if (e instanceof InterpError) return { error: `${e.message} (line ${e.line})`, line: e.line };
  return { error: `Tracer error: ${e.message} (line ${interp.curLine})`, line: interp.curLine };
}

export function traceJava(code, inputText, maxSteps = 1500) {
  const I = new Interpreter({ maxSteps });
  try { I.load(code); } catch (e) { if (e instanceof JavaSyntaxError) return { ok: false, error: `Syntax error: ${e.message}` }; return { ok: false, error: `Could not parse the Java code: ${e.message}` }; }
  let pairs;
  try { pairs = splitInput(inputText).map(([n, raw]) => [n, parseValue(n, raw)]); } catch (e) { return { ok: false, error: e.message }; }
  const names = pairs.map(([n]) => n);
  const user = [...I.classes.values()].filter((c) => !c.quiet && !c.ast.isInterface && !c.name.startsWith("$"));
  const cls = user.find((c) => c.name === "Solution") || user.find((c) => c.ast.methods.length);
  if (!cls) return { ok: false, error: "No class found. Define `class Solution` with a method, as on LeetCode." };
  let best = null;
  for (const m of cls.ast.methods) {
    if (!m.body) continue;
    const params = m.params.map((p) => p.name), score = names.filter((n) => params.includes(n)).length * 10 - Math.abs(params.length - names.length);
    if (!best || score > best.score) best = { m, score };
  }
  if (!best) return { ok: false, error: `Class ${cls.name} has no methods to run.` };
  const m = best.m, params = m.params.map((p) => p.name);
  const missing = params.filter((p) => !names.includes(p)), extra = names.filter((n) => !params.includes(n));
  if (missing.length || extra.length) return { ok: false, error: `\`${m.name}\` takes (${params.join(", ")}). Input has: ${names.join(", ")}. Fix the input field.` };
  let args;
  try { args = m.params.map((p) => convertInput(pairs.find(([n]) => n === p.name)[1], p.type, I)); } catch (e) { return { ok: false, error: e.message }; }

  const result = { ok: true, steps: [], result: null, stdout: "", error: null, truncated: false, function: m.name };
  result.input = Object.fromEntries(m.params.map((p, i) => [p.name, I.snap(args[i])]));
  try { const ret = I.runEntry(cls, m, args); result.result = m.type.name === "void" && m.type.dims === 0 ? null : I.snap(ret); }
  catch (e) {
    if (e instanceof Abort) { result.truncated = true; if (e.reason === "time") result.error = "Stopped: the program ran too many operations (possible infinite loop)."; }
    else { const d = describeError(e, I); result.error = d.error; result.error_line = d.line; }
  }
  result.steps = I.steps; result.stdout = I.out.slice(0, 2000);
  return result;
}

// ---------------------------------------------------------------- static analysis
function walk(node, fn) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
  if (!node || typeof node !== "object") return;
  if (node.k) fn(node);
  for (const key of Object.keys(node)) { if (key === "cls") continue; const v = node[key]; if (v && typeof v === "object") walk(v, fn); }
}
export function analyzeJava(code) {
  let unit;
  try { unit = parse(code); } catch (e) { return { ok: false, error: e instanceof JavaSyntaxError ? `Syntax error: ${e.message}` : e.message }; }
  const tags = [], evidence = {}, tag = (n, why) => { if (!tags.includes(n)) { tags.push(n); evidence[n] = why; } };
  const methods = []; const collect = (c) => { c.methods.forEach((m) => m.body && methods.push(m)); c.inner.forEach(collect); }; unit.classes.forEach(collect);
  let recursive = false, maxLoop = 0; const pointers = new Set(["i", "j", "k", "l", "r", "lo", "hi", "left", "right", "mid", "low", "high", "start", "end", "slow", "fast", "idx", "ptr"]);
  const loopDepth = (node, d) => {
    let best = d;
    if (Array.isArray(node)) { for (const n of node) best = Math.max(best, loopDepth(n, d)); return best; }
    if (!node || typeof node !== "object") return best;
    const isLoop = ["for", "while", "doWhile", "foreach"].includes(node.k), nd = isLoop ? d + 1 : d; best = nd;
    for (const key of Object.keys(node)) { if (key === "cls") continue; const v = node[key]; if (v && typeof v === "object") best = Math.max(best, loopDepth(v, nd)); }
    return best;
  };
  for (const m of methods) {
    maxLoop = Math.max(maxLoop, loopDepth(m.body, 0));
    walk(m.body, (n) => {
      if (n.k === "call" && n.name === m.name && (!n.obj || n.obj.k === "this")) recursive = true;
      if (n.k === "index") walk(n.idx, (x) => { if (x.k === "name") pointers.add(x.id); });
    });
  }
  const src = code;
  if (recursive) tag("Recursion", "a method calls itself");
  if (/\b(memo|cache)\b/.test(src) && recursive) tag("Memoization", "recursion with a memo/cache table");
  if (/\b(mid|m)\s*=\s*[^;]*(\/\s*2|>>>?\s*1)/.test(src)) tag("Binary search", "computes a midpoint of two bounds");
  if (!tags.includes("Binary search") && /while\s*\(\s*\w+\s*<=?\s*\w+\s*\)/.test(src) && /\b(left|l|lo|i|start|slow)\b/.test(src)) tag("Two pointers", "loop moves two indices toward each other");
  if (/\b(left|l)\s*\+\+|\b(left|l)\s*\+=\s*1/.test(src) && /for\s*\(\s*int\s+(right|r|j)\b/.test(src)) tag("Sliding window", "right pointer advances in a for-loop while left moves forward");
  if (/\b(HashMap|TreeMap|LinkedHashMap|Map\s*<)/.test(src)) tag("Hash map", "uses a Map");
  if (/\b(HashSet|TreeSet|LinkedHashSet|Set\s*<)/.test(src)) tag("Hash set", "uses a Set");
  if (/\b(Queue\s*<|ArrayDeque|LinkedList\s*<)/.test(src) && /\.(poll|remove)\(\)/.test(src)) tag("BFS / queue", "uses a queue with poll()");
  if (/\bPriorityQueue\b/.test(src)) tag("Heap / priority queue", "uses PriorityQueue");
  if (/Arrays\.sort|Collections\.sort|\.sort\(/.test(src)) tag("Sorting", "calls sort()");
  if (/\bStack\s*<|Deque\s*<[^;]*>\s*\w+\s*=[^;]*\n?[^;]*;[\s\S]*\.push\(/.test(src)) tag("Stack", "uses a stack (push/pop)");
  if (/\bdp\b|\bdp\[/.test(src)) tag("Dynamic programming", "a dp table");
  if (/Math\.max\(\s*\w+\s*,\s*\w+\s*\+\s*\w+\s*\)/.test(src)) tag("Kadane-style running best", "max(x, running + x) update");
  if (/\bprefix\b|\bpre\[/.test(src)) tag("Prefix sums", "prefix array");
  if (recursive && /\.remove\(\s*\w+\.size\(\)\s*-\s*1\s*\)/.test(src)) tag("Backtracking", "choose → recurse → undo (remove last)");
  const usesSort = tags.includes("Sorting");
  let time;
  if (recursive && !tags.includes("Memoization") && !tags.includes("Dynamic programming")) time = "Depends on recursion (often O(n) for tree/DFS, exponential if branching)";
  else if (maxLoop === 0 && !usesSort) time = "O(1) or O(n) via library calls";
  else if (tags.includes("Binary search") && maxLoop <= 1) time = "O(log n)";
  else if (usesSort && maxLoop <= 1) time = "O(n log n)";
  else time = maxLoop === 1 ? "O(n)" : maxLoop === 2 ? "O(n²)" : `O(n^${maxLoop})`;
  const makesStruct = /new\s+(ArrayList|HashMap|HashSet|LinkedList|ArrayDeque|TreeMap|PriorityQueue|StringBuilder)\b|new\s+\w+\s*\[[^\]]+\]/.test(src);
  return { ok: true, tags, evidence, time, space: makesStruct || recursive ? "O(n) auxiliary" : "O(1) auxiliary", pointers: [...pointers].sort(), recursive };
}
