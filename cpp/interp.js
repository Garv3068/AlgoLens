// Tree-walking interpreter for a C++ subset with step tracing in the same schema as tracer.py / java/interp.js.
import { parse, CppSyntaxError } from "./parser.js";
import * as R from "./runtime.js";
import { splitInput, parseValue } from "../inputs.js";
const { CSStream, JD, JC, JU, CStr, CVec, CPair, CTuple, CMap, CAdapter, CIter, CObj, CFn, CInit, CStream, CManip, CThrow, CppError, T,
  coerce, copyVal, copyInto, isClassValue, isNum, kindOf, truthy, arith, cmp3, ceq, compareNums, inferType, defaultValue, sval, isStr, ix, toText } = R;

const MAX_DEPTH = 400, MAX_OPS = 4_000_000, MAX_ITEMS = 40, MAX_STR = 60;
class Abort extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class InterpError extends Error { constructor(msg, line) { super(msg); this.line = line; } }
class CExc { constructor(name, msg) { this.name = name; this.msg = msg; } }
class PtrRef { constructor(loc) { this.loc = loc; } }
const EXC_PARENT = { exception: null, runtime_error: "exception", logic_error: "exception", out_of_range: "logic_error", invalid_argument: "logic_error", length_error: "logic_error", bad_alloc: "exception", domain_error: "logic_error", overflow_error: "runtime_error", underflow_error: "runtime_error", range_error: "runtime_error" };

const PRELUDE = `
struct ListNode { int val; ListNode *next; ListNode() : val(0), next(nullptr) {} ListNode(int x) : val(x), next(nullptr) {} ListNode(int x, ListNode *next) : val(x), next(next) {} };
struct TreeNode { int val; TreeNode *left; TreeNode *right; TreeNode() : val(0), left(nullptr), right(nullptr) {} TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
  TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {} };`;

// ---------------------------------------------------------------- locations (lvalues)
class Slot { constructor(v, t) { this.v = v; this.t = t; this.ref = null; this.unset = false; }
  get() { return this.ref ? this.ref.get() : this.v; } set(x) { if (this.ref) this.ref.set(x); else { this.v = x; this.unset = false; } } }
class TempLoc { constructor(v) { this.v = v; this.t = null; } get() { return this.v; } set(x) { this.v = x; } }
class IdxLoc { constructor(c, i, t) { this.c = c; this.i = i; this.t = t; } get() { return this.c.a[this.i]; } set(x) { this.c.a[this.i] = x; } }
class CharLoc { constructor(s, i) { this.s = s; this.i = i; this.t = T("char"); } get() { return new JC(this.s.s.charCodeAt(this.i)); } set(x) { this.s.s = this.s.s.slice(0, this.i) + String.fromCharCode(ix(x instanceof JC ? x.c : x)) + this.s.s.slice(this.i + 1); } }
class PropLoc { constructor(o, k, t) { this.o = o; this.k = k; this.t = t; } get() { return this.o[this.k]; } set(x) { this.o[this.k] = x; } }
class FieldLoc { constructor(o, k, t) { this.o = o; this.k = k; this.t = t; } get() { return this.o.f[this.k]; } set(x) { this.o.f[this.k] = x; } }
class IterLoc { constructor(it) { this.it = it; this.t = null; } get() { return R.iterGet(this.it); } set(x) { R.iterSet(this.it, x); } }

class Scope { constructor(parent = null) { this.vars = new Map(); this.parent = parent; }
  lookup(n) { for (let s = this; s; s = s.parent) { const r = s.vars.get(n); if (r) return r; } return undefined; } }
class Frame { constructor(scope, thisObj, cls, name, quiet) { Object.assign(this, { scope, root: scope, thisObj, cls, name, quiet }); } }

class ClassInfo {
  constructor(ast, quiet) {
    this.ast = ast; this.name = ast.name; this.parent = ast.parent; this.quiet = quiet; this.statics = {}; this.methods = new Map(); this.interp = null; this.staticsReady = false;
    for (const m of ast.methods) this.addMethod(m);
  }
  addMethod(m) { m.cls = this; if (!this.methods.has(m.name)) this.methods.set(m.name, []); this.methods.get(m.name).push(m); }
  findMethods(name) { for (let c = this; c; c = this.interp.classes.get(c.parent)) { const l = c.methods.get(name); if (l) return l; } return null; }
  isSubclassOf(name) { for (let c = this; c; c = this.interp.classes.get(c.parent)) { if (c.name === name) return true; if (c.parent === name) return true; } return false; }
}

function typeMatch(v, t) { // overload scoring: -1 = incompatible
  if (t.ptr > 0) return v === null || v instanceof CObj || v instanceof CVec || v instanceof CIter || v instanceof PtrRef ? 2 : -1;
  const k = kindOf(v);
  switch (t.name) {
    case "int": case "short": case "ushort": case "uchar": return k === 1 && !(v instanceof JC) && typeof v !== "boolean" ? 3 : k ? 1 : -1;
    case "ll": return k === 3 ? 3 : k ? 1 : -1; case "uint": return k === 2 ? 3 : k ? 1 : -1; case "ull": return k === 4 ? 3 : k ? 1 : -1;
    case "double": case "float": return k === 5 ? 3 : k ? 1 : -1;
    case "char": return v instanceof JC ? 3 : k ? 1 : -1; case "bool": return typeof v === "boolean" ? 3 : k ? 1 : -1;
    case "string": return v instanceof CStr ? 3 : typeof v === "string" ? 2 : -1;
    case "vector": case "deque": case "list": case "array": return v instanceof CVec ? 3 : v instanceof CInit ? 1 : -1;
    case "pair": return v instanceof CPair ? 3 : v instanceof CInit ? 1 : -1;
    case "map": case "unordered_map": case "set": case "unordered_set": case "multiset": case "multimap": return v instanceof CMap ? 3 : v instanceof CInit ? 1 : -1;
    case "auto": case "decltype": case "function": return 1;
    default: if (k && /^[A-Z]/.test(t.name) && t.name.length > 1) return -1; return 1;
  }
}

export class Interpreter {
  constructor({ maxSteps = 1500, trace = true } = {}) {
    this.maxSteps = maxSteps; this.trace = trace; this.steps = []; this.stack = []; this.classes = new Map(); this.funcs = new Map(); this.globals = new Map(); this.enumConsts = new Map();
    this.globalDecls = []; this.enumDecls = []; this.out = ""; this.ops = 0; this.depth = 0; this.f = null; this.curLine = 0; this.cout = new CStream("out"); this.cerr = new CStream("err");
    R.hooks.callFn = (fn, args) => this.callFn(fn, args, null, false);
    R.hooks.out = (s) => this.write(s);
    R.hooks.userLess = (a, b) => { const m = a.cls.findMethods("operator<"); if (!m) throw new CppError(`No operator< for ${a.cls.name}`); return truthy(this.invoke(m[0], a, [b], { quiet: true })); };
    R.hooks.userEq = (a, b) => { const m = a.cls.findMethods("operator=="); return m ? truthy(this.invoke(m[0], a, [b], { quiet: true })) : undefined; };
    R.hooks.constructUser = (t, args) => this.constructType(t, args);
    R.hooks.defaultUser = (t) => this.constructType(t, []);
    R.hooks.fromInitUser = (t, init) => this.aggregateInit(t, init);
    R.hooks.isUserClass = (n) => this.classes.has(n);
  }
  write(s) { this.out += s; if (this.out.length > 20000) this.out = this.out.slice(0, 20000); }

  // ---------------------------------------------------------------- setup
  load(src) {
    for (const [source, quiet] of [[PRELUDE, true], [src, false]]) {
      const unit = parse(source);
      for (const c of unit.classes) { const ci = new ClassInfo(c, quiet); ci.interp = this; this.classes.set(c.name, ci); }
      for (const fn of unit.funcs) {
        fn.quiet = quiet;
        if (fn.qual && this.classes.has(fn.qual)) { this.classes.get(fn.qual).addMethod(fn); continue; }
        fn.cls = null; if (!this.funcs.has(fn.name)) this.funcs.set(fn.name, []); this.funcs.get(fn.name).push(fn);
      }
      this.globalDecls.push(...unit.globals.map((g) => ({ ...g, quiet }))); this.enumDecls.push(...unit.enums);
    }
  }
  initStatics() {
    const qf = new Frame(new Scope(), null, null, "<static>", true); this.f = qf;
    for (const e of this.enumDecls) { let n = 0; for (const it of e.items) { if (it.expr) n = ix(this.ev(it.expr)); this.enumConsts.set(it.name, n); n++; } }
    for (const g of this.globalDecls) { const slot = this.makeSlot(g); this.globals.set(g.name, slot); }
    for (const ci of this.classes.values()) {
      if (ci.staticsReady) continue; ci.staticsReady = true; qf.cls = ci;
      for (const fld of ci.ast.fields) if (fld.static) ci.statics[fld.name] = this.makeSlot(fld);
    }
  }

  // ---------------------------------------------------------------- types / values
  resolveType(t) { // evaluates array dimensions of a declarator type into a nested array type; returns the value type
    if (!t || !t.dims || !t.dims.length) return t;
    const base = { ...t, dims: null }; const sizes = t.dims.map((d) => (d ? ix(this.ev(d)) : null));
    let cur = base; for (let i = sizes.length - 1; i >= 0; i--) { const a = T("array", [cur]); a.size = sizes[i]; cur = a; } return cur;
  }
  makeSlot(d) { // for globals / static fields / fields: returns Slot with initial value
    const t = this.resolveType(d.type); const s = new Slot(null, t);
    s.v = this.initValue(d, t, s); return s;
  }
  /** Value for a declarator with initializer (also used for fields). May bind references onto `slot`. */
  initValue(d, t, slot) {
    if (t.name === "array" && t.size !== undefined || (t.name === "array" && d.type.dims)) {
      if (t.size === null) { const n = d.init && d.init.k === "initList" ? d.init.elems.length : 0; t.size = n; }
      const arr = R.construct(t, []);
      if (d.init) { const v = this.ev(d.init); this.fillArray(arr, v); }
      return arr;
    }
    if (t.ref && d.init) { const loc = this.evLoc(d.init); const cur = loc.get(); if (isClassValue(cur) || cur instanceof CIter) return cur; if (slot) { slot.ref = loc; slot.t = loc.t; } return undefined; }
    const auto = t.name === "auto" || t.name === "decltype";
    if (d.mode === "eq" && d.init) {
      const v = this.ev(d.init);
      if (auto) { const c = t.ref ? v : copyVal(v); if (slot && !t.ref) slot.t = inferType(c) || null; return c; }
      if (v instanceof CInit && this.classes.has(t.name) && t.ptr === 0) return this.constructType(t, v.elems);
      return coerce(v, t);
    }
    if (d.mode === "paren" || d.mode === "brace") {
      const args = d.args.map((a) => this.ev(a));
      if (auto) return args[0];
      if (d.mode === "brace" && !this.classes.has(t.name) && t.ptr === 0) return R.fromInit(t, new CInit(args));
      if (t.ptr > 0) return coerce(args[0], t);
      return R.construct(t, args);
    }
    if (t.ptr > 0) return null;
    const dv = t.name === "auto" ? 0 : defaultValue(t);
    if (slot) slot.unset = !isClassValue(dv) && t.name !== "auto";
    return dv;
  }
  fillArray(arr, v) {
    if (v instanceof CInit) { v.elems.forEach((e, i) => { if (i >= arr.a.length) return; const et = R.elemType(arr); if (arr.a[i] instanceof CVec && (e instanceof CInit)) this.fillArray(arr.a[i], e); else arr.a[i] = coerce(e, et?.name === "array" ? et : et); }); }
    else if (isStr(v) && arr.t.args[0].name === "char") { const s = sval(v); for (let i = 0; i < arr.a.length; i++) arr.a[i] = new JC(i < s.length ? s.charCodeAt(i) : 0); }
  }
  constructType(t, args) {
    if (t.name in EXC_PARENT) return new CExc(t.name, args.length ? sval(args[0]) : t.name);
    const ci = this.classes.get(t.name);
    if (!ci) throw new CppError(`Unsupported type '${t.name}'`);
    return this.construct(ci, args);
  }
  initialField(fld) { const t = this.resolveType(fld.type); if (fld.mode === null && t.ptr === 0 && t.name !== "array" && ["int", "ll", "uint", "ull", "double", "float", "bool", "char", "short"].includes(t.name)) return defaultValue(t); const d = fld; return this.initValue(d, t, null); }
  construct(ci, args) {
    const obj = new CObj(ci); const saved = this.f;
    const chain = []; for (let c = ci; c; c = this.classes.get(c.parent)) chain.unshift(c);
    const tmp = new Frame(new Scope(), obj, ci, "<init>", true); this.f = tmp;
    try { for (const c of chain) { tmp.cls = c; for (const fld of c.ast.fields) if (!fld.static) obj.f[fld.name] = this.initialField(fld); } } finally { this.f = saved; }
    this.runCtor(ci, obj, args);
    return obj;
  }
  aggregateInit(t, init) {
    const ci = this.classes.get(t.name); if (!ci) throw new CppError(`Cannot initialize ${t.name} from a braced list`);
    return this.construct(ci, init.elems);
  }
  runCtor(ci, obj, args) {
    const ctors = ci.ast.ctors;
    if (!ctors.length) {
      const parent = this.classes.get(ci.parent);
      if (args.length) { // aggregate initialisation: assign fields in declaration order
        const fields = ci.ast.fields.filter((f) => !f.static); args.forEach((a, i) => { if (fields[i]) obj.f[fields[i].name] = coerce(a instanceof CInit ? R.fromInit(this.resolveType(fields[i].type), a) : a, this.resolveType(fields[i].type)); }); return;
      }
      if (parent) this.runCtor(parent, obj, []);
      return;
    }
    const m = this.pickMethod(ctors.map((c) => ({ ...c, cls: ci, isCtor: true })), args);
    if (!m) throw new InterpError(`No matching constructor for ${ci.name} with ${args.length} argument(s)`, this.curLine);
    this.invoke(m, obj, args, { ctor: true });
  }

  // ---------------------------------------------------------------- tracing
  nid(o) { if (!this.nids) this.nids = new Map(); let n = this.nids.get(o); if (!n) { n = this.nids.size + 1; this.nids.set(o, n); } return n; }
  plain(v) { return v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : v instanceof JC ? String.fromCharCode(v.c) : kindOf(v) ? (kindOf(v) === 5 ? v.v : Number(v instanceof JU ? v.v : v)) : isStr(v) ? sval(v) : "?"; }
  snap(v, depth = 0, seen = new Set()) {
    if (v === null || v === undefined) return { t: "prim", v: null };
    if (typeof v === "boolean" || typeof v === "number") return { t: "prim", v };
    if (typeof v === "bigint") return { t: "prim", v: v > -(2n ** 53n) && v < 2n ** 53n ? Number(v) : String(v) };
    if (v instanceof JU) return { t: "prim", v: v.v < 2n ** 53n ? Number(v.v) : String(v.v) };
    if (v instanceof JD) return { t: "prim", v: Number.isFinite(v.v) ? v.v : String(v.v) };
    if (v instanceof JC) return { t: "prim", v: String.fromCharCode(v.c) };
    if (typeof v === "string") return { t: "str", v: v.slice(0, MAX_STR), cut: v.length > MAX_STR };
    if (v instanceof CStr) return { t: "str", v: v.s.slice(0, MAX_STR), cut: v.s.length > MAX_STR };
    if (v instanceof PtrRef) return this.snap(v.loc.get(), depth, seen);
    if (v instanceof CObj) {
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
    if (v instanceof CVec) { const deq = v.kind === "deque" || v.kind === "list"; return { t: deq ? "deque" : "list", v: kids(v.a), n: v.a.length, cut: v.a.length > MAX_ITEMS, oid: this.nid(v), kind: v.kind }; }
    if (v instanceof CAdapter) {
      const kind = v.kind === "priority_queue" ? "PriorityQueue" : v.kind;
      return { t: v.kind === "queue" ? "deque" : "list", v: kids(v.a), n: v.a.length, cut: v.a.length > MAX_ITEMS, oid: this.nid(v), kind };
    }
    if (v instanceof CPair) return { t: "tuple", v: [this.snap(v.first, depth + 1, seen2), this.snap(v.second, depth + 1, seen2)] };
    if (v instanceof CTuple) return { t: "tuple", v: kids(v.a) };
    if (v instanceof CMap) {
      if (v.isSet) return { t: "set", v: kids(v.ents.map((e) => e.first)), n: v.ents.length, cut: v.ents.length > MAX_ITEMS, oid: this.nid(v) };
      return { t: "dict", v: v.ents.slice(0, MAX_ITEMS).map((e) => [this.snap(e.first, depth + 1, seen2), this.snap(e.second, depth + 1, seen2)]), n: v.ents.length, cut: v.ents.length > MAX_ITEMS, oid: this.nid(v) };
    }
    if (v instanceof CIter) { let d = "end()"; try { const e = R.iterGet(v); d = this.short(e); } catch { /* end iterator */ } return { t: "repr", v: `iterator → ${d}` }; }
    if (v instanceof CObj) return { t: "repr", v: `${v.cls.name}{${Object.entries(v.f).filter(([k]) => !k.startsWith("__")).map(([k, x]) => `${k}=${this.short(x)}`).join(", ")}}`.slice(0, MAX_STR) };
    if (v instanceof CFn) return { t: "repr", v: v.name ? `${v.name} (lambda)` : "lambda" };
    if (v instanceof CExc) return { t: "repr", v: `${v.name}("${v.msg}")` };
    if (v instanceof CSStream) return { t: "repr", v: `stringstream("${v.buf.slice(0, 40)}")` };
    return { t: "repr", v: toText(v).slice(0, MAX_STR) };
  }
  short(v) { const s = this.snap(v, 3); return s.t === "prim" ? String(s.v) : s.t === "str" ? JSON.stringify(s.v) : s.t === "ll" ? "list" : s.t === "tree" ? "tree" : s.t === "tuple" ? `(${s.v.map((x) => (x.t === "prim" ? x.v : "…")).join(", ")})` : s.t === "repr" ? s.v : `${s.t}[${s.n ?? "?"}]`; }
  snapLocals(frame) {
    const scopes = []; for (let s = frame.scope; s; s = s.parent) { scopes.push(s); if (s === frame.root) break; }
    const out = {};
    for (const s of scopes.reverse()) for (const [k, rec] of s.vars) if (!rec.unset && !k.startsWith("$")) out[k] = this.snap(rec.get());
    if (frame.cls?.quiet) return out;
    if (frame.thisObj) for (const [k, v] of Object.entries(frame.thisObj.f)) if (!k.startsWith("__") && !(k in out)) out[k] = this.snap(v);
    for (let c = frame.cls; c; c = this.classes.get(c.parent)) for (const [k, rec] of Object.entries(c.statics)) if (!(k in out)) out[k] = this.snap(rec.get());
    for (const [k, rec] of this.globals) if (!(k in out) && !rec.t?.isConst && !rec.unset) out[k] = this.snap(rec.get());
    return out;
  }
  record(ev, line, extra = {}) {
    const f = this.f; if (!this.trace || f.quiet) return;
    if (this.steps.length >= this.maxSteps) throw new Abort("steps");
    this.steps.push({ ev, line, fn: f.name, depth: this.stack.length, locals: this.snapLocals(f), stack: this.stack.slice(), ...extra });
  }
  step(line) { this.curLine = line; this.record("line", line); }
  err(msg, line = this.curLine) { throw new InterpError(msg, line); }

  // ---------------------------------------------------------------- calls
  pickMethod(list, args) {
    let best = null, bestScore = -1;
    for (const m of list) {
      const ps = m.params, minArgs = ps.filter((p) => !p.def && !p.varargs).length;
      if (args.length > ps.length && !ps.some((p) => p.varargs)) continue; if (args.length < minArgs) continue;
      let score = args.length === ps.length ? 1 : 0, ok = true;
      args.forEach((a, i) => { const p = ps[i]; if (!p || !ok) return; const s = typeMatch(a, p.type); if (s < 0) ok = false; else score += s; });
      if (ok && score > bestScore) { best = m; bestScore = score; }
    }
    return best;
  }
  bindParams(params, scope, args, locs) {
    params.forEach((p, i) => {
      const slot = new Slot(undefined, p.type); scope.vars.set(p.name, slot);
      if (i >= args.length) { slot.v = p.def ? coerce(this.ev(p.def), p.type) : defaultValue(p.type); return; }
      const a = args[i], t = p.type;
      if (t.ref) {
        if (a instanceof CInit) { slot.v = coerce(a, { ...t, ref: false }); return; }
        if (isClassValue(a) || a instanceof CIter || a instanceof CFn) { slot.v = a; return; }
        if (locs && locs[i]) { slot.ref = locs[i]; slot.t = locs[i].t; return; }
        slot.v = a; slot.t = { ...t, ref: false }; return;
      }
      slot.t = t.name === "auto" || t.name === "decltype" ? inferType(a) : t;
      slot.v = t.name === "auto" || t.name === "decltype" || t.name === "function" ? copyVal(a) : coerce(a, t);
    });
  }
  /** Runs a function-like (method / ctor / lambda). */
  invoke(m, thisObj, args, opts = {}) {
    if (this.depth >= MAX_DEPTH) throw new CppError("Stack overflow: recursion too deep");
    const cls = m.cls || null, scope = new Scope(opts.parentScope || null);
    const quiet = !!opts.quiet || (cls ? cls.quiet : !!m.quiet);
    const saved = this.f; this.depth++;
    const name = opts.name || (m.isCtor ? cls.name : m.name);
    const frame = new Frame(scope, thisObj, cls, name, quiet); this.f = frame;
    try {
      this.bindParams(m.params, scope, args, opts.locs);
      if (!quiet) {
        const argSnaps = {}; for (const p of m.params) argSnaps[p.name] = this.snap(scope.vars.get(p.name).get());
        this.stack.push({ fn: name, args: argSnaps }); this.f = frame; this.record("call", m.line);
      }
      if (opts.ctor) this.runInitList(m, thisObj, scope);
      let ret = null, sig; const stmts = m.body.body;
      for (let i = 0; i < stmts.length; i++) { sig = this.ex(stmts[i]); if (sig) break; }
      if (sig && sig.s === "return") ret = sig.v;
      if (!opts.ctor) { const rt = m.type || m.ret; if (rt && rt.name !== "void" && rt.name !== "auto" && !rt.ref) ret = coerce(ret, rt); else if (rt && rt.name === "auto" && !rt.ref) ret = copyVal(ret); }
      if (sig && sig.s === "return" && sig.line) this.curLine = sig.line;
      if (!quiet) this.record("return", this.curLine, { ret: this.snap(opts.ctor ? null : ret), ...(sig && sig.s === "return" && this.retLocals ? { locals: this.retLocals } : {}) });
      return opts.ctor ? null : ret;
    } finally { this.depth--; this.f = saved; if (!quiet) this.stack.pop(); }
  }
  runInitList(m, obj, scope) {
    const ci = m.cls;
    if (!m.initList || !m.initList.length) { const parent = this.classes.get(ci.parent); if (parent) this.runCtor(parent, obj, []); return; }
    const parent = this.classes.get(ci.parent);
    if (parent && !m.initList.some((e) => e.name === ci.parent)) this.runCtor(parent, obj, []);
    for (const e of m.initList) {
      if (e.name === ci.parent && parent) { this.runCtor(parent, obj, e.args.map((a) => this.ev(a))); continue; }
      if (e.name === ci.name && false) continue;
      const fld = ci.ast.fields.find((f) => f.name === e.name); if (!fld) { this.err(`Unknown member '${e.name}' in initializer list`); }
      const t = this.resolveType(fld.type), args = e.args.map((a) => this.ev(a));
      if (t.ptr > 0 || t.name === "auto") obj.f[fld.name] = coerce(args[0], t);
      else if (!e.brace && ["int", "ll", "uint", "ull", "double", "float", "bool", "char", "short", "string"].includes(t.name) && t.name !== "string") obj.f[fld.name] = coerce(args[0], t);
      else if (e.brace && !this.classes.has(t.name)) obj.f[fld.name] = R.fromInit(t, new CInit(args));
      else obj.f[fld.name] = R.construct(t, args);
    }
  }
  callFn(fn, args, locs, traced) {
    if (fn === null || fn === undefined) throw new CppError("Segmentation fault: called a null function pointer");
    if (fn instanceof CFn) {
      if (fn.native) return fn.native(args);
      const m = fn.ast; return this.invoke({ params: m.params, body: m.body, type: m.ret, line: m.line, cls: fn.cls, quiet: !traced }, fn.thisObj, args, { parentScope: fn.scope, locs, quiet: !traced, name: fn.name || "lambda" });
    }
    if (fn instanceof CObj) {
      const ms = fn.cls.findMethods("operator()"); if (!ms) this.err("Object is not callable");
      const m = this.pickMethod(ms, args) || ms[0]; return this.invoke(m, fn, args, { quiet: !traced, locs });
    }
    this.err("Value is not callable");
  }
  userFunc(name, args) { const l = this.funcs.get(name); return l ? this.pickMethod(l, args) : null; }
  findUserMethod(cls, name, args) { const l = cls.findMethods(name); return l ? this.pickMethod(l, args) : null; }

  // ---------------------------------------------------------------- name resolution
  lookupVar(id) {
    const r = this.f.scope.lookup(id); if (r) return r;
    const o = this.f.thisObj; if (o && id in o.f) return new FieldLoc(o, id, this.fieldType(o.cls, id));
    for (let c = this.f.cls; c; c = this.classes.get(c.parent)) if (id in c.statics) return c.statics[id];
    const g = this.globals.get(id); if (g) return g;
    return null;
  }
  fieldType(cls, id) { for (let c = cls; c; c = this.classes.get(c.parent)) { const f = c.ast.fields.find((x) => x.name === id); if (f) return f.type.dims ? null : f.type; } return null; }

  // ---------------------------------------------------------------- statements
  runBlockBody(stmts) { for (const s of stmts) { const sig = this.ex(s); if (sig) return sig; } return undefined; }
  withScope(fn) { const f = this.f, saved = f.scope; f.scope = new Scope(saved); try { return fn(); } finally { f.scope = saved; } }
  loopSignal(sig) { if (!sig) return undefined; if (sig.s === "break") return "break"; if (sig.s === "continue") return "continue"; return sig; }
  cond(node) {
    if (node.k === "declCond") { this.declareLocal(node.decl); const d = node.decl.decls[0]; return truthy(this.f.scope.vars.get(d.name).get()); }
    return truthy(this.ev(node));
  }
  declareLocal(node) {
    for (const d of node.decls) {
      if (d.names) { this.bindStructured(d); continue; }
      if (d.type.isStatic) { // function-local static: initialised once, shared by every call
        this.staticSlots ||= new Map(); const ex = this.staticSlots.get(d);
        if (ex) { this.f.scope.vars.set(d.name, ex); continue; }
      }
      const t = this.resolveType(d.type); const slot = new Slot(undefined, t.ref ? { ...t } : t);
      const v = this.initValue(d, t, slot);
      if (d.type.isStatic) this.staticSlots.set(d, slot);
      if (!slot.ref) slot.v = v; this.f.scope.vars.set(d.name, slot);
      if (d.init && d.init.k === "lambda" && slot.v instanceof CFn && !slot.v.name) slot.v.name = d.name;
    }
  }
  bindStructured(d) {
    const v = this.ev(d.init), byRef = d.type.ref;
    const mk = (name, val, loc) => { const s = new Slot(undefined, null); if (byRef && loc) { s.ref = loc; } else s.v = copyVal(val); this.f.scope.vars.set(name, s); };
    if (v instanceof CPair) { mk(d.names[0], v.first, new PropLoc(v, "first", null)); mk(d.names[1], v.second, new PropLoc(v, "second", null)); }
    else if (v instanceof CTuple) d.names.forEach((n, i) => mk(n, v.a[i], new IdxLoc({ a: v.a }, i, null)));
    else if (v instanceof CVec) d.names.forEach((n, i) => mk(n, v.a[i], new IdxLoc(v, i, null)));
    else if (v instanceof CObj) { const fields = v.cls.ast.fields.filter((f) => !f.static); d.names.forEach((n, i) => mk(n, v.f[fields[i].name], new FieldLoc(v, fields[i].name, null))); }
    else this.err("Structured binding needs a pair, tuple, array or struct");
  }
  ex(node) {
    if (++this.ops > MAX_OPS) throw new Abort("time");
    switch (node.k) {
      case "block": return this.withScope(() => this.runBlockBody(node.body));
      case "empty": return undefined;
      case "local": this.step(node.line); this.declareLocal(node); return undefined;
      case "expr": this.step(node.line); this.ev(node.e); return undefined;
      case "if": return this.withScope(() => { this.step(node.line); if (this.cond(node.cond)) return this.ex(node.then); return node.els ? this.ex(node.els) : undefined; });
      case "while":
        for (;;) {
          const r0 = this.withScope(() => { this.step(node.line); if (!this.cond(node.cond)) return "stop"; const r = this.loopSignal(this.ex(node.body)); return r; });
          if (r0 === "stop" || r0 === "break") break; if (r0 && r0 !== "continue") return r0;
        }
        return undefined;
      case "doWhile":
        do {
          const r = this.loopSignal(this.ex(node.body)); if (r === "break") break; if (r && r !== "continue") return r;
          this.step(node.line);
        } while (truthy(this.ev(node.cond)));
        return undefined;
      case "for":
        return this.withScope(() => {
          for (const s of node.init) { if (s.k === "local") this.declareLocal(s); else this.ev(s.e); }
          for (;;) {
            this.step(node.line);
            if (node.cond && !truthy(this.ev(node.cond))) break;
            const r = this.loopSignal(this.ex(node.body)); if (r === "break") break; if (r && r !== "continue") return r;
            for (const u of node.update) this.ev(u);
          }
          return undefined;
        });
      case "foreach": return this.execForeach(node);
      case "return": {
        this.step(node.line); const v = node.e ? this.ev(node.e) : null;
        this.retLocals = this.trace && !this.f.quiet ? this.snapLocals(this.f) : null; return { s: "return", v, line: node.line };
      }
      case "break": case "continue": this.step(node.line); return { s: node.k };
      case "throw": { this.step(node.line); if (!node.e) throw new CThrow(this.currentExc ?? null, node.line); const v = this.ev(node.e); throw new CThrow(v, node.line); }
      case "localClass": for (const c of [node.cls, ...node.inner]) { const ci = new ClassInfo(c, false); ci.interp = this; this.classes.set(c.name, ci); ci.staticsReady = true; } return undefined;
      case "switch": { this.step(node.line); const r = this.runSwitch(node); return r && r.s === "break" ? undefined : r; }
      case "try": return this.runTry(node);
      default: this.err(`Unsupported statement: ${node.k}`, node.line);
    }
  }
  execForeach(node) {
    const coll = this.ev(node.iter); const t = node.type;
    const body = (bind) => this.withScope(() => { bind(); this.step(node.line); return this.loopSignal(this.ex(node.body)); });
    const mkSlot = (name, val, loc) => { const s = new Slot(undefined, null); const auto = t.name === "auto" || t.name === "decltype";
      if (t.ref && loc) { s.ref = loc; s.t = loc.t; } else if (t.ref) s.v = val; else { s.v = auto ? copyVal(val) : coerce(val, t); s.t = auto ? inferType(val) : t; } this.f.scope.vars.set(name, s); };
    const bindOne = (item, loc) => {
      if (node.names) {
        const parts = item instanceof CPair ? [item.first, item.second] : item instanceof CTuple ? item.a : item instanceof CVec ? item.a : this.err("Structured binding needs a pair or tuple");
        node.names.forEach((n, i) => { const s = new Slot(undefined, null); if (t.ref && !(item instanceof CPair && false)) s.ref = item instanceof CPair ? new PropLoc(item, i === 0 ? "first" : "second", null) : new IdxLoc({ a: parts }, i, null); else s.v = copyVal(parts[i]); this.f.scope.vars.set(n, s); });
      } else mkSlot(node.name, item, loc);
    };
    if (coll instanceof CVec && !node.names) {
      for (let i = 0; i < coll.a.length; i++) { const r = body(() => bindOne(coll.a[i], new IdxLoc(coll, i, R.elemType(coll)))); if (r === "break") break; if (r && r !== "continue") return r; }
      return undefined;
    }
    const items = R.iterItems(coll).slice();
    for (const item of items) { const r = body(() => bindOne(item, null)); if (r === "break") break; if (r && r !== "continue") return r; }
    return undefined;
  }
  runSwitch(node) {
    const sel = this.ev(node.expr);
    const matches = (c) => c.labels.some((l) => ceq(sel, this.ev(l)));
    let idx = node.cases.findIndex(matches); if (idx < 0) idx = node.cases.findIndex((c) => c.isDefault); if (idx < 0) return undefined;
    return this.withScope(() => { for (let i = idx; i < node.cases.length; i++) for (const s of node.cases[i].body) { const sig = this.ex(s); if (sig) return sig; } return undefined; });
  }
  excMatches(val, t) {
    if (!t) return true;
    if (val instanceof CExc) { for (let n = val.name; n; n = EXC_PARENT[n]) if (n === t.name) return true; return false; }
    if (val instanceof CObj) return val.cls.isSubclassOf(t.name);
    if (t.name === "string" && isStr(val)) return true; if (t.name === "char" && t.ptr > 0 && typeof val === "string") return true;
    if (isNum(val) && ["int", "ll", "double", "char", "bool", "uint", "ull", "float", "short"].includes(t.name) && t.ptr === 0) return kindOf(val) === kindOf(coerce(val, t)) || true;
    return false;
  }
  runTry(node) {
    let sig, pending = null;
    try {
      try { sig = this.withScope(() => this.ex(node.block)); }
      catch (e) {
        if (!(e instanceof CThrow)) throw e;
        const c = node.catches.find((cc) => this.excMatches(e.value, cc.type)); if (!c) throw e;
        const saved = this.currentExc; this.currentExc = e.value;
        try { sig = this.withScope(() => { if (c.name) this.f.scope.vars.set(c.name, new Slot(e.value, c.type)); return this.ex(c.body); }); } finally { this.currentExc = saved; }
      }
    } catch (e) { pending = e; }
    if (pending) throw pending;
    return sig;
  }

  // ---------------------------------------------------------------- lvalues
  evLoc(node) {
    switch (node.k) {
      case "name": { if (node.targ !== undefined) break; const r = this.lookupVar(node.id); if (r) return r; break; }
      case "paren": return this.evLoc(node.e);
      case "cond": return truthy(this.ev(node.c)) ? this.evLoc(node.a) : this.evLoc(node.b);
      case "index": {
        const base = this.ev(node.obj), i = this.ev(node.idx);
        if (base instanceof CVec) { const n = ix(i); if (n < 0 || n >= base.a.length) throw new CppError(`Index ${n} is out of range for a container of size ${base.a.length} (undefined behaviour in C++)`); return new IdxLoc(base, n, R.elemType(base)); }
        if (base instanceof CStr) { const n = ix(i); if (n < 0 || n >= base.s.length + (n === base.s.length ? 1 : 0) ) throw new CppError(`Index ${n} is out of range for a string of size ${base.s.length}`); return n === base.s.length ? new TempLoc(new JC(0)) : new CharLoc(base, n); }
        if (base instanceof CMap) { if (base.isSet) this.err("operator[] on a set"); return new PropLoc(R.mapIndex(base, i), "second", base.t?.args?.[1] ?? null); }
        if (base instanceof CObj) { const m = this.findUserMethod(base.cls, "operator[]", [i]); if (m) return new TempLoc(this.invoke(m, base, [i])); }
        if (base === null) throw new CppError("Segmentation fault: indexing a null pointer");
        if (typeof base === "string") return new TempLoc(new JC(base.charCodeAt(ix(i))));
        if (base instanceof CIter) return new IterLoc(new CIter(base.c, base.i + ix(i), base.rev));
        this.err("Indexing a value that isn't an array, vector, string or map");
        break;
      }
      case "member": {
        const o = this.ev(node.obj);
        if (o === null || o === undefined) throw new CppError(`Segmentation fault: accessing member '${node.name}' through a null pointer`);
        if (o instanceof PtrRef) return this.evLocMember(o.loc.get(), node);
        if (o instanceof CIter) return this.evLocMember(R.iterGet(o), node);
        return this.evLocMember(o, node);
      }
      case "deref": {
        const v = this.ev(node.e);
        if (v instanceof CIter) return new IterLoc(v);
        if (v instanceof PtrRef) return v.loc;
        if (v === null) throw new CppError("Segmentation fault: dereferenced a null pointer");
        if (v instanceof CVec && v.kind === "array") return new IdxLoc(v, 0, R.elemType(v));
        return new TempLoc(v);
      }
      case "scope": { const c = this.scopeStatic(node); if (c) return c; break; }
    }
    return new TempLoc(this.ev(node));
  }
  scopeStatic(node) {
    const ci = this.classes.get(node.cls); if (ci) for (let c = ci; c; c = this.classes.get(c.parent)) if (node.name in c.statics) return c.statics[node.name];
    return null;
  }
  evLocMember(o, node) {
    if (o instanceof CObj) {
      if (node.name in o.f) return new FieldLoc(o, node.name, this.fieldType(o.cls, node.name));
      for (let c = o.cls; c; c = this.classes.get(c.parent)) if (node.name in c.statics) return c.statics[node.name];
      this.err(`'${o.cls.name}' has no member named '${node.name}'`, node.line);
    }
    if (o instanceof CPair && (node.name === "first" || node.name === "second")) return new PropLoc(o, node.name, null);
    this.err(`No member named '${node.name}'`, node.line);
  }
  assignValue(loc, v) {
    const t = loc.t, cur = loc.get();
    if (t && t.ptr > 0) { loc.set(v); return; }
    if (isClassValue(cur) && !(cur instanceof CObj && cur.heap) && !(v === null)) { if (copyInto(cur, v) !== undefined) return; }
    loc.set(t ? coerce(v, t.ref ? { ...t, ref: false } : t) : kindOf(cur) && kindOf(v) ? coerce(v, inferType(cur)) : (isClassValue(v) ? copyVal(v) : v));
  }

  // ---------------------------------------------------------------- expressions
  evArgs(nodes) {
    const vals = new Array(nodes.length); let locs = null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.k === "name" || n.k === "index" || n.k === "member" || n.k === "deref") { const l = this.evLoc(n); (locs ||= [])[i] = l; vals[i] = l.get(); }
      else vals[i] = this.ev(n);
    }
    return { vals, locs };
  }
  ev(node) {
    if (++this.ops > MAX_OPS) throw new Abort("time");
    switch (node.k) {
      case "lit": switch (node.kind) {
        case "int": return node.v; case "uint": return new JU(node.v, 32); case "ll": return BigInt.asIntN(64, node.v); case "ull": return new JU(node.v, 64);
        case "double": return new JD(node.v); case "float": return new JD(Math.fround(node.v)); case "char": return new JC((node.v << 24) >> 24);
        case "string": case "bool": case "null": return node.v;
      } break;
      case "paren": return this.ev(node.e);
      case "name": return this.evName(node);
      case "scope": return this.evScope(node);
      case "this": return this.f.thisObj;
      case "index": return this.evLoc(node).get();
      case "member": return this.evLoc(node).get();
      case "deref": return this.evLoc(node).get();
      case "addr": { const l = this.evLoc(node.e); const v = l.get(); return isClassValue(v) || v === null || v instanceof CIter || v instanceof CFn ? v : new PtrRef(l); }
      case "call": return this.evCall(node);
      case "construct": { const args = node.args.map((a) => this.ev(a)); const t = node.type; if (node.brace && !this.classes.has(t.name)) return R.fromInit(t, new CInit(args)); return R.construct(t, args); }
      case "new": {
        const args = node.args.map((a) => this.ev(a)), t = node.type;
        if (this.classes.has(t.name) || t.name in EXC_PARENT) { const o = R.construct(t, args); if (o instanceof CObj) o.heap = true; return o; }
        return new PtrRef(new Slot(args.length ? coerce(args[0], t) : defaultValue(t), t));
      }
      case "newArr": { const sizes = node.dims.map((d) => ix(this.ev(d))); const at = this.resolveType({ ...node.type, dims: sizes.map((n) => ({ k: "lit", kind: "int", v: n })) }); const arr = R.construct(at, []); if (node.init) this.fillArray(arr, this.ev(node.init)); return arr; }
      case "delete": this.ev(node.e); return null;
      case "initList": return new CInit(node.elems.map((e) => this.ev(e)));
      case "lambda": return new CFn({ ast: node, scope: this.f.scope, thisObj: this.f.thisObj, cls: this.f.cls, name: null });
      case "sizeof": { if (node.type) return R.U64(({ char: 1, uchar: 1, bool: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, ll: 8, ull: 8, double: 8 })[node.type.name] ?? 8); const v = this.ev(node.e); return R.U64(v instanceof CVec ? v.a.length * 4 : kindOf(v) === 1 ? 4 : 8); }
      case "numlim": return R.numLimits(node.type, node.which);
      case "throwE": { if (!node.e) throw new CThrow(this.currentExc ?? null, node.line); throw new CThrow(this.ev(node.e), node.line); }
      case "unary": return this.evUnary(node);
      case "update": {
        const loc = this.evLoc(node.target), cur = loc.get(), d = node.op === "++" ? "+" : "-";
        let next;
        if (cur instanceof CIter) next = new CIter(cur.c, cur.i + (d === "+" ? 1 : -1), cur.rev);
        else if (typeof cur === "boolean") next = true;
        else { next = arith(d, cur, 1); next = coerce(next, loc.t && !loc.t.ref ? loc.t : inferType(cur)); }
        loc.set(next); return node.prefix ? next : cur;
      }
      case "binary": return this.evBinary(node);
      case "assign": {
        if (node.op === "=") {
          const v = this.ev(node.value); const loc = this.evLoc(node.target); this.assignValue(loc, v); return loc.get();
        }
        const loc = this.evLoc(node.target), cur = loc.get(), rhs = this.ev(node.value), op = node.op.slice(0, -1);
        const res = this.binop(op, cur, rhs, node);
        if (isClassValue(cur)) { this.assignValue(loc, res); return loc.get(); }
        if (cur instanceof CIter) { loc.set(res); return res; }
        loc.set(coerce(res, loc.t && !loc.t.ref ? loc.t : inferType(cur))); return loc.get();
      }
      case "cond": return truthy(this.ev(node.c)) ? this.ev(node.a) : this.ev(node.b);
      case "comma": { let v; for (const e of node.list) v = this.ev(e); return v; }
      case "cast": { const v = this.ev(node.e); if (node.type.ptr > 0 || node.type.ref) return v; if (node.type.name === "string" && node.type.args.length === 0) return coerce(v, node.type); return coerce(v, node.type); }
    }
    this.err(`Unsupported expression: ${node.k}${node.kind ? " " + node.kind : ""}`, node.line);
  }
  evName(node) {
    if (node.targ === undefined) { const r = this.lookupVar(node.id); if (r) { const v = r.get(); return v; } }
    const id = node.id;
    if (this.enumConsts.has(id)) return this.enumConsts.get(id);
    switch (id) {
      case "cin": return (this.cin ||= new CStream("in"));
      case "cout": return this.cout; case "cerr": case "clog": return this.cerr; case "endl": return new CManip("endl"); case "fixed": return new CManip("fixed"); case "flush": case "ends": return new CManip("noop");
      case "boolalpha": return new CManip("boolalpha"); case "left": case "right": case "scientific": return new CManip("noop");
    }
    const c = R.lookupConst(id); if (c !== undefined) return c;
    if (this.funcs.has(id)) return new CFn({ native: (args) => { const m = this.userFunc(id, args); return this.invoke(m, null, args); }, name: id });
    if (this.f.thisObj) { const ms = this.f.thisObj.cls.findMethods(id); if (ms) { const o = this.f.thisObj; return new CFn({ native: (args) => this.invoke(this.pickMethod(ms, args) || ms[0], o, args), name: id }); } }
    this.err(`'${id}' was not declared in this scope`, node.line);
  }
  evScope(node) {
    const st = this.scopeStatic(node); if (st) return st.get();
    if (this.enumConsts.has(node.name)) return this.enumConsts.get(node.name);
    if (node.name === "npos") return R.NPOS;
    const c = R.lookupConst(node.name); if (c !== undefined) return c;
    const ci = this.classes.get(node.cls);
    if (ci && ci.findMethods(node.name)) { const ms = ci.findMethods(node.name); return new CFn({ native: (args) => this.invoke(this.pickMethod(ms, args) || ms[0], null, args), name: node.name }); }
    this.err(`Cannot resolve ${node.cls}::${node.name}`, node.line);
  }
  evUnary(node) {
    const v = this.ev(node.e);
    switch (node.op) {
      case "!": return !truthy(v);
      case "-": { const k = kindOf(v); if (!k) this.err("Invalid operand to unary '-'", node.line); return k === 5 ? new JD(-v.v) : arith("-", k >= 3 ? coerce(0, k === 3 ? T("ll") : k === 4 ? T("ull") : T("uint")) : 0, v); }
      case "+": return v instanceof JC || typeof v === "boolean" ? ix(v) : v;
      case "~": { const k = kindOf(v); if (k === 1) return ~ix(v); return arith("^", v, k === 2 ? new JU(0xffffffffn, 32) : k === 3 ? -1n : new JU((1n << 64n) - 1n, 64)); }
    }
    this.err(`Unsupported operator ${node.op}`, node.line);
  }
  evBinary(node) {
    const op = node.op;
    if (op === "&&") return truthy(this.ev(node.l)) && truthy(this.ev(node.r));
    if (op === "||") return truthy(this.ev(node.l)) || truthy(this.ev(node.r));
    const a = this.ev(node.l);
    if (op === ">>" && a instanceof CSStream) return this.extract(a, this.evLoc(node.r));
    const b = this.ev(node.r);
    return this.binop(op, a, b, node);
  }
  extract(ss, loc) { // `stream >> variable`
    if (ss.failed) return ss;
    const cur = loc.get(), t = loc.t && !loc.t.ref ? loc.t : cur instanceof CStr ? T("string") : inferType(cur);
    const s = ss.buf; let p = ss.pos; while (p < s.length && /\s/.test(s[p])) p++;
    if (p >= s.length) { ss.failed = true; ss.pos = p; return ss; }
    if (cur instanceof CStr || t?.name === "string") { let q = p; while (q < s.length && !/\s/.test(s[q])) q++; ss.pos = q; this.assignValue(loc, new CStr(s.slice(p, q))); return ss; }
    if (t?.name === "char") { ss.pos = p + 1; loc.set(new JC(s.charCodeAt(p))); return ss; }
    const isF = t && (t.name === "double" || t.name === "float");
    const m = (isF ? /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/ : /^[+-]?\d+/).exec(s.slice(p));
    if (!m) { ss.failed = true; return ss; }
    ss.pos = p + m[0].length; loc.set(coerce(isF ? new JD(parseFloat(m[0])) : BigInt(m[0]), t || T("int"))); return ss;
  }
  binop(op, a, b, node) {
    if (a instanceof CSStream) { if (op === "<<") { if (b instanceof CManip) return a; a.buf += toText(b); return a; } this.err(`Unsupported stringstream operator ${op}`, node?.line); }
    if (a instanceof CStream) return this.streamWrite(a, b, op);
    if (a instanceof CObj && !a.heap || (a instanceof CObj && op !== "==" && op !== "!=" && this.userOp(a, op))) {
      const ms = a.cls.findMethods("operator" + op); if (ms) { const m = this.pickMethod(ms, [b]) || ms[0]; return this.invoke(m, a, [b], { quiet: false }); }
    }
    switch (op) {
      case "==": return ceq(a, b); case "!=": return !ceq(a, b);
      case "<": case ">": case "<=": case ">=": {
        let c;
        if (isNum(a) && isNum(b)) { c = compareNums(a, b); if (c === 2) return false; } else c = cmp3(a, b);
        return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
      }
    }
    try { return arith(op, a, b); } catch (e) { if (e instanceof CppError && !e.line) e.line = node?.line || this.curLine; throw e; }
  }
  userOp(a, op) { return !!a.cls.findMethods("operator" + op); }
  streamWrite(st, v, op) {
    if (op === ">>") this.err("Reading from cin isn't supported: AlgoLens runs your function directly on the test input");
    if (op !== "<<") this.err(`Unsupported stream operator ${op}`);
    if (v instanceof CManip) {
      switch (v.kind) { case "endl": if (st.kind === "out") this.write("\n"); break; case "precision": st.prec = v.n; break; case "fixed": st.fixed = true; break; case "setw": st.width = v.n; break; case "setfill": st.fill = v.n instanceof JC ? String.fromCharCode(v.n.c) : " "; break; case "boolalpha": st.boolalpha = true; break; }
      return st;
    }
    let s = typeof v === "boolean" && st.boolalpha ? String(v) : v instanceof CFn || v instanceof CObj && false ? "<fn>" : toText(v, st);
    if (st.width) { s = s.padStart(st.width, st.fill || " "); st.width = 0; }
    if (st.kind === "out") this.write(s);
    return st;
  }

  // ---------------------------------------------------------------- calls
  evCall(node) {
    const fn = node.fn;
    if (fn.k === "member") return this.evMethodCall(node, fn);
    if (fn.k === "name") {
      const id = fn.id;
      if (fn.targ !== undefined) { const a = node.args.map((x) => this.ev(x)); return R.tupleGet(a[0], fn.targ); }
      const lv = this.lookupVar(id);
      if (lv) { const { vals, locs } = this.evArgs(node.args); return this.callFn(lv.get(), vals, locs, true); }
      if (id === "swap" || id === "iter_swap") return this.doSwap(node);
      if (id === "getline") {
        const ss = this.ev(node.args[0]); if (!(ss instanceof CSStream)) this.err("Reading input isn't supported: AlgoLens runs your function directly on the test input", node.line);
        const loc = this.evLoc(node.args[1]), delim = node.args[2] ? String.fromCharCode(ix(this.ev(node.args[2]))) : "\n";
        if (ss.pos >= ss.buf.length) { ss.failed = true; return ss; }
        const q = ss.buf.indexOf(delim, ss.pos), piece = q < 0 ? ss.buf.slice(ss.pos) : ss.buf.slice(ss.pos, q);
        ss.pos = q < 0 ? ss.buf.length : q + 1; this.assignValue(loc, new CStr(piece)); return ss;
      }
      const { vals, locs } = this.evArgs(node.args);
      // method on the current object, or a free user function
      if (this.f.thisObj || this.f.cls) {
        for (let c = this.f.thisObj ? this.f.thisObj.cls : this.f.cls; c; ) {
          const m = this.findUserMethod(c, id, vals);
          if (m) return this.invoke(m, m.static ? null : this.f.thisObj, vals, { locs });
          break;
        }
        if (this.f.cls && !this.f.thisObj) { const m = this.findUserMethod(this.f.cls, id, vals); if (m) return this.invoke(m, null, vals, { locs }); }
      }
      const um = this.userFunc(id, vals); if (um) return this.invoke(um, null, vals, { locs });
      if (id === "move" || id === "forward" || id === "ref" || id === "cref") return vals[0];
      if (this.classes.has(id)) return this.constructType(T(id), vals);
      const r = R.callFree(id, vals); if (r !== undefined) return r;
      this.err(`Unsupported function: ${id}()`, node.line);
    }
    if (fn.k === "scope") {
      const { vals, locs } = this.evArgs(node.args); const ci = this.classes.get(fn.cls);
      if (ci) { const m = this.findUserMethod(ci, fn.name, vals); if (m) return this.invoke(m, m.static ? null : this.f.thisObj, vals, { locs }); }
      const r = R.callFree(fn.name, vals); if (r !== undefined) return r;
      this.err(`Unsupported function: ${fn.cls}::${fn.name}()`, node.line);
    }
    const f = this.ev(fn); const { vals, locs } = this.evArgs(node.args); return this.callFn(f, vals, locs, true);
  }
  doSwap(node) {
    if (node.args.length !== 2) this.err("swap needs two arguments", node.line);
    const a = this.evLoc(node.args[0]), b = this.evLoc(node.args[1]);
    if (node.fn.id === "iter_swap") { const x = a.get(), y = b.get(); const ia = x, ib = y; const t = R.iterGet(ia); R.iterSet(ia, R.iterGet(ib)); R.iterSet(ib, t); return null; }
    const x = a.get(), y = b.get();
    if (isClassValue(x) && isClassValue(y)) R.swapContents(x, y); else { a.set(y); b.set(x); }
    return null;
  }
  evMethodCall(node, fn) {
    const recvRaw = this.ev(fn.obj);
    if (recvRaw === null || recvRaw === undefined) throw new CppError(`Segmentation fault: calling '${fn.name}()' through a null pointer`);
    const recv = recvRaw instanceof PtrRef ? recvRaw.loc.get() : (recvRaw instanceof CIter && fn.arrow ? R.iterGet(recvRaw) : recvRaw), name = fn.name;
    if (recv instanceof CObj) {
      const { vals, locs } = this.evArgs(node.args);
      const m = this.findUserMethod(recv.cls, name, vals);
      if (m) return this.invoke(m, m.static ? null : recv, vals, { locs });
      this.err(`'${recv.cls.name}' has no member function '${name}'`, node.line);
    }
    if (recv instanceof CStream) {
      const vals = node.args.map((a) => this.ev(a));
      if (name === "precision") { recv.prec = ix(vals[0]); return null; } if (name === "flush") return recv;
      this.err(`Unsupported stream method ${name}`, node.line);
    }
    if (recv instanceof CExc) { if (name === "what") return recv.msg; }
    if (recv instanceof CSStream) {
      const a = node.args.map((x) => this.ev(x));
      switch (name) { case "str": if (a.length) { recv.buf = sval(a[0]); recv.pos = 0; return null; } return new CStr(recv.buf); case "clear": recv.failed = false; return null; case "fail": return recv.failed; case "eof": return recv.pos >= recv.buf.length; case "good": return !recv.failed; }
      this.err(`Unsupported stringstream method ${name}`, node.line);
    }
    if (recv instanceof CFn && (name === "operator()" || name === "call")) return this.callFn(recv, node.args.map((a) => this.ev(a)), null, true);
    const vals = node.args.map((a) => this.ev(a));
    if (recv instanceof CMap || recv instanceof CVec || recv instanceof CAdapter) { /* fallthrough to builtin */ }
    if (recv instanceof CPair && (name === "first" || name === "second")) this.err("pair.first is a field, not a function");
    let r;
    try { r = R.callMethod(recv, name, vals); } catch (e) { if (e instanceof CppError && !e.line) e.line = node.line; throw e; }
    if (r === undefined) this.err(`Unsupported method: ${name}() on ${recv === null ? "null" : recv.constructor.name}`, node.line);
    return r;
  }

  // ---------------------------------------------------------------- run
  runEntry(cls, method, args) {
    this.initStatics();
    const root = new Frame(new Scope(), null, cls, "<entry>", true); this.f = root;
    const obj = !cls || method.static ? null : this.construct(cls, []);
    this.f = root;
    return this.invoke(method, obj, args);
  }
}

// ---------------------------------------------------------------- input conversion
function convertInput(val, t, I) {
  if (t.ptr > 0 && (t.name === "ListNode" || t.name === "TreeNode")) {
    if (val === null) return null;
    if (t.name === "ListNode") {
      if (!Array.isArray(val)) throw new Error("Expected an array for a linked list");
      let head = null; for (let i = val.length - 1; i >= 0; i--) { const n = new CObj(I.classes.get("ListNode")); n.heap = true; n.f.val = val[i] | 0; n.f.next = head; head = n; } return head;
    }
    if (!Array.isArray(val)) throw new Error("Expected an array (level order) for a tree");
    if (!val.length || val[0] === null) return null;
    const mkn = (v) => { const n = new CObj(I.classes.get("TreeNode")); n.heap = true; n.f.val = v | 0; n.f.left = null; n.f.right = null; return n; };
    const root = mkn(val[0]), q = [root]; let i = 1;
    while (q.length && i < val.length) { const n = q.shift(); if (i < val.length && val[i] !== null) { n.f.left = mkn(val[i]); q.push(n.f.left); } i++; if (i < val.length && val[i] !== null) { n.f.right = mkn(val[i]); q.push(n.f.right); } i++; }
    return root;
  }
  if (t.ptr > 0) throw new Error(`Input of type ${t.name}* isn't supported`);
  const base = { ...t, ref: false, isConst: false };
  switch (t.name) {
    case "int": case "short": case "ushort": case "uchar": case "uint": case "ull": case "ll": case "bool": case "float": case "double":
      if (typeof val === "string" && t.name !== "bool") throw new Error(`Expected a number for ${t.name} but got a string`);
      return t.name === "ll" ? BigInt(Math.trunc(Number(val))) : t.name === "bool" ? !!val : coerce(t.name === "double" || t.name === "float" ? new JD(Number(val)) : typeof val === "number" ? val : Number(val), base);
    case "char": return new JC(String(val).charCodeAt(0) || 0);
    case "string": return new CStr(String(val));
    case "vector": case "deque": case "list": case "array": {
      if (!Array.isArray(val)) throw new Error(`Expected an array for ${t.name}<…>`);
      const et = t.args[0] || T("int"); return new CVec(val.map((x) => convertInput(x, et, I)), t.name, base);
    }
    case "set": case "unordered_set": case "multiset": {
      if (!Array.isArray(val)) throw new Error("Expected an array for a set");
      const m = new CMap(t.name, base, null); const et = t.args[0] || T("int"); for (const x of val) R.mapInsert(m, convertInput(x, et, I), undefined); return m;
    }
    case "pair": { if (!Array.isArray(val) || val.length !== 2) throw new Error("Expected [a, b] for a pair"); return new CPair(convertInput(val[0], t.args[0], I), convertInput(val[1], t.args[1], I)); }
    case "auto": throw new Error("Cannot infer the input type for 'auto' parameters");
  }
  throw new Error(`Input of type ${t.name} isn't supported yet`);
}

function describeError(e, I) {
  if (e instanceof CThrow) {
    const v = e.value, line = e.line || I.curLine;
    const what = v instanceof CExc ? `std::${v.name}: ${v.msg}` : v instanceof CObj ? v.cls.name : isStr(v) ? `"${sval(v)}"` : toText(v);
    return { error: `terminate called after throwing an exception: ${what} (line ${line})`, line };
  }
  if (e instanceof CppError) { const line = e.line || I.curLine; return { error: `${e.message} (line ${line})`, line }; }
  if (e instanceof RangeError) return { error: `Stack overflow: recursion too deep for this tracer (line ${I.curLine})`, line: I.curLine };
  if (e instanceof InterpError) return { error: `${e.message} (line ${e.line})`, line: e.line };
  return { error: `Tracer error: ${e.message} (line ${I.curLine})`, line: I.curLine };
}

export function traceCpp(code, inputText, maxSteps = 1500) {
  const I = new Interpreter({ maxSteps });
  try { I.load(code); } catch (e) { if (e instanceof CppSyntaxError) return { ok: false, error: `Syntax error: ${e.message}` }; return { ok: false, error: `Could not parse the C++ code: ${e.message}` }; }
  let pairs;
  try { pairs = splitInput(inputText).map(([n, raw]) => [n, parseValue(n, raw)]); } catch (e) { return { ok: false, error: e.message }; }
  const names = pairs.map(([n]) => n);
  const user = [...I.classes.values()].filter((c) => !c.quiet);
  const cls = user.find((c) => c.name === "Solution") || user.find((c) => c.ast.methods.some((m) => m.body && !m.static && c.ast.ctors.length === 0 && true)) || null;
  let candidates = cls ? cls.ast.methods.filter((m) => m.body) : [];
  if (!candidates.length) candidates = [...I.funcs.values()].flat().filter((m) => !m.quiet && m.name !== "main");
  if (!candidates.length) return { ok: false, error: "No function found. Define `class Solution` with a public method, as on LeetCode." };
  let best = null;
  for (const m of candidates) {
    const params = m.params.map((p) => p.name), score = names.filter((n) => params.includes(n)).length * 10 - Math.abs(params.length - names.length);
    if (!best || score > best.score) best = { m, score };
  }
  const m = best.m, params = m.params.map((p) => p.name), owner = m.cls && m.cls.name === (cls && cls.name) ? cls : (m.cls || null);
  const missing = params.filter((p) => !names.includes(p)), extra = names.filter((n) => !params.includes(n));
  if (missing.length || extra.length) return { ok: false, error: `\`${m.name}\` takes (${params.join(", ")}). Input has: ${names.join(", ")}. Fix the input field.` };
  let args;
  try { I.initStatics(); args = m.params.map((p) => convertInput(pairs.find(([n]) => n === p.name)[1], p.type, I)); } catch (e) { if (e instanceof CppError || e instanceof InterpError) return { ok: false, error: e.message }; return { ok: false, error: e.message }; }
  const result = { ok: true, steps: [], result: null, stdout: "", error: null, truncated: false, function: m.name };
  result.input = Object.fromEntries(m.params.map((p, i) => [p.name, I.snap(args[i])]));
  try { const ret = I.runEntry(owner, m, args); result.result = m.type.name === "void" && m.type.ptr === 0 ? null : I.snap(ret); }
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
  for (const key of Object.keys(node)) { if (key === "cls" || key === "type") continue; const v = node[key]; if (v && typeof v === "object") walk(v, fn); }
}
export function analyzeCpp(code) {
  let unit;
  try { unit = parse(code); } catch (e) { return { ok: false, error: e instanceof CppSyntaxError ? `Syntax error: ${e.message}` : e.message }; }
  const tags = [], evidence = {}, tag = (n, why) => { if (!tags.includes(n)) { tags.push(n); evidence[n] = why; } };
  const methods = [...unit.funcs]; for (const c of unit.classes) methods.push(...c.methods);
  let recursive = false, maxLoop = 0; const pointers = new Set(["i", "j", "k", "l", "r", "lo", "hi", "left", "right", "mid", "low", "high", "start", "end", "slow", "fast", "idx", "ptr"]);
  const loopDepth = (node, d) => {
    let best = d;
    if (Array.isArray(node)) { for (const n of node) best = Math.max(best, loopDepth(n, d)); return best; }
    if (!node || typeof node !== "object") return best;
    const isLoop = ["for", "while", "doWhile", "foreach"].includes(node.k), nd = isLoop ? d + 1 : d; best = nd;
    for (const key of Object.keys(node)) { if (key === "cls" || key === "type") continue; const v = node[key]; if (v && typeof v === "object") best = Math.max(best, loopDepth(v, nd)); }
    return best;
  };
  const lambdaNames = new Set();
  for (const m of methods) {
    if (!m.body) continue;
    maxLoop = Math.max(maxLoop, loopDepth(m.body, 0));
    walk(m.body, (n) => {
      if (n.k === "call" && n.fn.k === "name" && n.fn.id === m.name) recursive = true;
      if (n.k === "local") for (const d of n.decls) if (d.init && d.init.k === "lambda") lambdaNames.add(d.name);
      if (n.k === "index") walk(n.idx, (x) => { if (x.k === "name") pointers.add(x.id); });
    });
    walk(m.body, (n) => { if (n.k === "lambda") walk(n.body, (x) => { if (x.k === "call" && x.fn.k === "name" && lambdaNames.has(x.fn.id)) recursive = true; }); });
  }
  const src = code;
  if (recursive) tag("Recursion", "a function calls itself");
  if (/\b(memo|cache|dp)\b/.test(src) && recursive) tag("Memoization", "recursion with a memo/cache table");
  if (/\b(mid|m)\s*=\s*[^;]*(\/\s*2|>>\s*1)/.test(src)) tag("Binary search", "computes a midpoint of two bounds");
  if (!tags.includes("Binary search") && /while\s*\(\s*\w+\s*<=?\s*\w+\s*\)/.test(src) && /\b(left|l|lo|i|start|slow)\b/.test(src)) tag("Two pointers", "loop moves two indices toward each other");
  if (/\b(left|l)\s*\+\+|\b(left|l)\s*\+=\s*1/.test(src) && /for\s*\(\s*int\s+(right|r|j)\b/.test(src)) tag("Sliding window", "right pointer advances in a for-loop while left moves forward");
  if (/\b(unordered_map|map)\s*</.test(src)) tag("Hash map", "uses a map / unordered_map");
  if (/\b(unordered_set|set)\s*</.test(src)) tag("Hash set", "uses a set / unordered_set");
  if (/\bqueue\s*<|\bdeque\s*</.test(src) && /\.(pop|pop_front)\(\)/.test(src)) tag("BFS / queue", "uses a queue with pop()");
  if (/\bpriority_queue\b/.test(src)) tag("Heap / priority queue", "uses priority_queue");
  if (/\bsort\s*\(|stable_sort\s*\(/.test(src)) tag("Sorting", "calls sort()");
  if (/\bstack\s*</.test(src)) tag("Stack", "uses a stack (push/pop/top)");
  if (/\bdp\b|\bdp\[/.test(src)) tag("Dynamic programming", "a dp table");
  if (/max\(\s*\w+\s*,\s*\w+\s*\+\s*\w+\s*\)/.test(src)) tag("Kadane-style running best", "max(x, running + x) update");
  if (/\bprefix\b|\bpre\[/.test(src)) tag("Prefix sums", "prefix array");
  if (recursive && /\.pop_back\(\)/.test(src)) tag("Backtracking", "choose → recurse → undo (pop_back)");
  const usesSort = tags.includes("Sorting");
  let time;
  if (recursive && !tags.includes("Memoization") && !tags.includes("Dynamic programming")) time = "Depends on recursion (often O(n) for tree/DFS, exponential if branching)";
  else if (maxLoop === 0 && !usesSort) time = "O(1) or O(n) via library calls";
  else if (tags.includes("Binary search") && maxLoop <= 1) time = "O(log n)";
  else if (usesSort && maxLoop <= 1) time = "O(n log n)";
  else time = maxLoop === 1 ? "O(n)" : maxLoop === 2 ? "O(n²)" : `O(n^${maxLoop})`;
  const makesStruct = /\b(vector|unordered_map|map|set|unordered_set|deque|queue|stack|priority_queue|string)\s*</.test(src) || /new\s+\w+\s*\[/.test(src);
  return { ok: true, tags, evidence, time, space: makesStruct || recursive ? "O(n) auxiliary" : "O(1) auxiliary", pointers: [...pointers].sort(), recursive };
}
