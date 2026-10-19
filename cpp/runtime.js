// C++ runtime values and a standard-library subset for the AlgoLens C++ interpreter.
// Value model: int/short = JS number, long long = BigInt, unsigned = JU, double/float = JD, char = JC, bool = boolean,
// std::string = CStr (mutable), string literal = JS string, vector/array/deque/list = CVec, map/set family = CMap,
// stack/queue/priority_queue = CAdapter, pair = CPair, tuple = CTuple, iterator = CIter, class instance = CObj, pointer = CObj/null.
export class JD { constructor(v) { this.v = v; } }
export class JC { constructor(c) { this.c = c; } }
export class JU { constructor(v, bits) { this.v = v; this.bits = bits; } }
export class CStr { constructor(s = "") { this.s = s; } }
export class CVec { constructor(a = [], kind = "vector", t = null) { this.a = a; this.kind = kind; this.t = t; } }
export class CPair { constructor(first, second) { this.first = first; this.second = second; } }
export class CTuple { constructor(a) { this.a = a; } }
export class CMap {
  constructor(kind, t = null, cmp = null) {
    this.kind = kind; this.t = t; this.cmp = cmp; this.isSet = /set/.test(kind); this.ordered = !/^unordered/.test(kind); this.multi = /multi/.test(kind);
    this.ents = []; this.idx = new Map(); this.nb = 1; this.nextResize = 0;
  }
}
export class CAdapter { constructor(kind, t = null, cmp = null) { this.kind = kind; this.t = t; this.cmp = cmp; this.a = []; } }
export class CIter { constructor(c, i, rev = false) { this.c = c; this.i = i; this.rev = rev; } }
export class CObj { constructor(cls) { this.cls = cls; this.f = {}; this.heap = false; } }
export class CFn { constructor(o) { Object.assign(this, o); } }
export class CInit { constructor(elems) { this.elems = elems; } }
export class CStream { constructor(kind) { this.kind = kind; this.prec = 6; this.fixed = false; } }
export class CSStream { constructor(buf = "") { this.buf = buf; this.pos = 0; this.failed = false; } }
export class CManip { constructor(kind, n) { this.kind = kind; this.n = n; } }
export class CThrow { constructor(value, line) { this.value = value; this.line = line; } }
export class CppError extends Error { constructor(msg, line) { super(msg); this.line = line || 0; } }

export const hooks = { callFn: null, userLess: null, userEq: null, constructUser: null, defaultUser: null, fromInitUser: null, isUserClass: null, out: null };
export const fail = (msg) => { throw new CppError(msg); };
export const T = (name, args = []) => ({ name, args, ptr: 0, ref: false, dims: null });

// ---------------------------------------------------------------- numbers
const M64 = (1n << 64n) - 1n;
export const isStr = (v) => typeof v === "string" || v instanceof CStr;
export const sval = (v) => (typeof v === "string" ? v : v instanceof CStr ? v.s : v instanceof JC ? String.fromCharCode(v.c) : fail("Expected a string"));
export function kindOf(v) { // 1 int, 2 uint, 3 long long, 4 ull, 5 double, 0 not a number
  if (typeof v === "number" || typeof v === "boolean" || v instanceof JC) return 1;
  if (v instanceof JU) return v.bits === 32 ? 2 : 4;
  if (typeof v === "bigint") return 3;
  if (v instanceof JD) return 5;
  return 0;
}
export const isNum = (v) => kindOf(v) !== 0;
export const big = (v) => typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : v instanceof JC ? BigInt(v.c) : typeof v === "boolean" ? (v ? 1n : 0n) : v instanceof JU ? v.v : v instanceof JD ? d2l(v.v) : fail("Expected an integer");
export const dbl = (v) => v instanceof JD ? v.v : typeof v === "number" ? v : v instanceof JC ? v.c : typeof v === "boolean" ? +v : v instanceof JU || typeof v === "bigint" ? Number(v instanceof JU ? v.v : v) : fail("Expected a number");
export const ix = (v) => typeof v === "number" ? v : v instanceof JC ? v.c : v instanceof JU || typeof v === "bigint" ? Number(v instanceof JU ? v.v : v) : v instanceof JD ? Math.trunc(v.v) : typeof v === "boolean" ? +v : fail("Expected an integer index");
function d2i(d) { return Number.isNaN(d) ? -2147483648 : d >= 2147483648 || d <= -2147483649 ? -2147483648 : Math.trunc(d); }
function d2l(d) { return Number.isNaN(d) || Math.abs(d) >= 9.223372036854776e18 ? -(2n ** 63n) : BigInt(Math.trunc(d)); }
const mk = (k, b) => k === 1 ? Number(BigInt.asIntN(32, b)) : k === 2 ? new JU(BigInt.asUintN(32, b), 32) : k === 3 ? BigInt.asIntN(64, b) : new JU(BigInt.asUintN(64, b), 64);
export const U64 = (b) => new JU(BigInt.asUintN(64, BigInt(b)), 64);
export const NPOS = new JU(M64, 64);
const normBig = (k, v) => k === 2 ? BigInt.asUintN(32, big(v)) : k === 4 ? BigInt.asUintN(64, big(v)) : k === 3 ? BigInt.asIntN(64, big(v)) : big(v);
export function truthy(v) {
  if (typeof v === "boolean") return v; if (typeof v === "number") return v !== 0; if (v === null || v === undefined) return false;
  if (typeof v === "bigint") return v !== 0n; if (v instanceof JU) return v.v !== 0n; if (v instanceof JC) return v.c !== 0; if (v instanceof JD) return v.v !== 0; if (v instanceof CSStream) return !v.failed; return true;
}
export function arith(op, a, b) {
  if (a instanceof CIter || b instanceof CIter) return iterArith(op, a, b);
  if (op === "+" && (isStr(a) || isStr(b))) {
    const part = (x) => (isStr(x) || x instanceof JC ? sval(x) : kindOf(x) === 1 ? String.fromCharCode(ix(x)) : sval(x));
    return new CStr(part(a) + part(b));
  }
  if (a instanceof CVec && a.kind === "array" && a.decay !== false && (op === "+" || op === "-") && isNum(b)) return new CIter(a, op === "+" ? ix(b) : -ix(b));
  const ka = kindOf(a), kb = kindOf(b);
  if (!ka || !kb) { if (a === null && kb && (op === "+" || op === "-")) fail("Pointer arithmetic isn't supported"); fail(`Invalid operands to binary '${op}'`); }
  if (op === "<<" || op === ">>") {
    const k = ka === 5 ? fail("Shift of a floating-point value") : ka, y = Number(big(b));
    if (k === 1) return op === "<<" ? a << y : a >> y;
    const x = normBig(k, a); return mk(k, op === "<<" ? x << BigInt(y) : x >> BigInt(y));
  }
  const k = Math.max(ka, kb);
  if (k === 5) {
    const x = dbl(a), y = dbl(b);
    switch (op) { case "+": return new JD(x + y); case "-": return new JD(x - y); case "*": return new JD(x * y); case "/": return new JD(x / y); case "%": fail("Invalid operands to '%' (double)"); }
  } else if (k === 1) {
    const x = typeof a === "number" ? a : ix(a), y = typeof b === "number" ? b : ix(b);
    switch (op) {
      case "+": return (x + y) | 0; case "-": return (x - y) | 0; case "*": return Math.imul(x, y);
      case "/": if (y === 0) fail("Floating point exception: integer division by zero"); return (x / y) | 0;
      case "%": if (y === 0) fail("Floating point exception: integer modulo by zero"); return (x % y) | 0;
      case "&": return x & y; case "|": return x | y; case "^": return x ^ y;
    }
  } else {
    const x = normBig(k, a), y = normBig(k, b);
    switch (op) {
      case "+": return mk(k, x + y); case "-": return mk(k, x - y); case "*": return mk(k, x * y);
      case "/": if (y === 0n) fail("Floating point exception: integer division by zero"); return mk(k, x / y);
      case "%": if (y === 0n) fail("Floating point exception: integer modulo by zero"); return mk(k, x % y);
      case "&": return mk(k, x & y); case "|": return mk(k, x | y); case "^": return mk(k, x ^ y);
    }
  }
  fail(`Unsupported operator '${op}'`);
}
function iterArith(op, a, b) {
  if (a instanceof CIter && b instanceof CIter) { if (op === "-") return BigInt(a.i - b.i); fail("Invalid iterator arithmetic"); }
  if (a instanceof CIter && isNum(b)) { if (op === "+") return new CIter(a.c, a.i + ix(b), a.rev); if (op === "-") return new CIter(a.c, a.i - ix(b), a.rev); }
  if (b instanceof CIter && isNum(a) && op === "+") return new CIter(b.c, b.i + ix(a), b.rev);
  fail("Invalid iterator arithmetic");
}
export function compareNums(a, b) { // -1/0/1, NaN -> 2
  const ka = kindOf(a), kb = kindOf(b), k = Math.max(ka, kb);
  if (k === 5) { const x = dbl(a), y = dbl(b); return Number.isNaN(x) || Number.isNaN(y) ? 2 : x < y ? -1 : x > y ? 1 : 0; }
  if (k === 1) { const x = ix(a), y = ix(b); return x < y ? -1 : x > y ? 1 : 0; }
  const x = normBig(k, a), y = normBig(k, b); return x < y ? -1 : x > y ? 1 : 0;
}
export const objId = (() => { let n = 0; return (o) => (o.__id ??= ++n); })();
export function cmp3(a, b) {
  if (isNum(a) && isNum(b)) { const c = compareNums(a, b); return c === 2 ? 0 : c; }
  if (isStr(a) && isStr(b)) { const x = sval(a), y = sval(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (a instanceof CPair && b instanceof CPair) return cmp3(a.first, b.first) || cmp3(a.second, b.second);
  if ((a instanceof CVec && b instanceof CVec) || (a instanceof CTuple && b instanceof CTuple)) {
    const x = a.a, y = b.a; for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = cmp3(x[i], y[i]); if (c) return c; } return x.length - y.length;
  }
  if (a instanceof CObj && !a.heap && hooks.userLess) { if (hooks.userLess(a, b)) return -1; if (hooks.userLess(b, a)) return 1; return 0; }
  if (a === null || b === null || a instanceof CObj) { const x = a === null ? 0 : objId(a), y = b === null ? 0 : objId(b); return x - y; }
  if (a instanceof CIter && b instanceof CIter) return a.i - b.i;
  fail("Values can't be compared with '<'");
}
export const lt = (a, b) => cmp3(a, b) < 0;
export function ceq(a, b) {
  if (isNum(a) && isNum(b)) return compareNums(a, b) === 0;
  if (isStr(a) && isStr(b)) return sval(a) === sval(b);
  if (a === null || b === null) return a === b || (a === null && isNum(b) && !truthy(b)) || (b === null && isNum(a) && !truthy(a));
  if (a instanceof CPair && b instanceof CPair) return ceq(a.first, b.first) && ceq(a.second, b.second);
  if ((a instanceof CVec && b instanceof CVec) || (a instanceof CTuple && b instanceof CTuple)) return a.a.length === b.a.length && a.a.every((x, i) => ceq(x, b.a[i]));
  if (a instanceof CIter && b instanceof CIter) return a.c === b.c && a.i === b.i;
  if (a instanceof CObj && !a.heap && hooks.userEq) { const r = hooks.userEq(a, b); if (r !== undefined) return r; }
  return a === b;
}
export function inferType(v) {
  switch (kindOf(v)) { case 1: return typeof v === "boolean" ? T("bool") : v instanceof JC ? T("char") : T("int"); case 2: return T("uint"); case 3: return T("ll"); case 4: return T("ull"); case 5: return T("double"); }
  return null;
}

// ---------------------------------------------------------------- conversion / copying
const CONTAINER_NAMES = new Set(["vector", "deque", "list", "array", "map", "unordered_map", "multimap", "unordered_multimap", "set", "unordered_set", "multiset", "unordered_multiset", "stack", "queue", "priority_queue", "pair", "tuple"]);
export const isClassValue = (v) => v instanceof CVec || v instanceof CStr || v instanceof CMap || v instanceof CAdapter || v instanceof CPair || v instanceof CTuple || (v instanceof CObj && !v.heap);
export function copyVal(v) {
  if (v instanceof CVec) { const c = new CVec(v.a.map(copyVal), v.kind, v.t); return c; }
  if (v instanceof CStr) return new CStr(v.s);
  if (v instanceof CPair) return new CPair(copyVal(v.first), copyVal(v.second));
  if (v instanceof CTuple) return new CTuple(v.a.map(copyVal));
  if (v instanceof CMap) { const m = new CMap(v.kind, v.t, v.cmp); m.nb = v.nb; m.nextResize = v.nextResize; for (const e of v.ents) { const n = new CPair(copyVal(e.first), copyVal(e.second)); n.h = e.h; m.ents.push(n); if (m.idx && !m.multi) m.idx.set(keyStr(n.first), n); } return m; }
  if (v instanceof CAdapter) { const c = new CAdapter(v.kind, v.t, v.cmp); c.a = v.a.map(copyVal); return c; }
  if (v instanceof CIter) return new CIter(v.c, v.i, v.rev);
  if (v instanceof CObj && !v.heap) { const o = new CObj(v.cls); for (const k of Object.keys(v.f)) o.f[k] = copyVal(v.f[k]); return o; }
  return v;
}
export function copyInto(dst, src) {
  if (src instanceof CInit) src = fromInit(dst.t || (dst instanceof CStr ? T("string") : null), src, dst);
  if (dst instanceof CVec && src instanceof CVec) { dst.a = src.a.map(copyVal); return dst; }
  if (dst instanceof CStr && isStr(src)) { dst.s = sval(src); return dst; }
  if (dst instanceof CPair && src instanceof CPair) { dst.first = copyVal(src.first); dst.second = copyVal(src.second); return dst; }
  if (dst instanceof CTuple && src instanceof CTuple) { dst.a = src.a.map(copyVal); return dst; }
  if (dst instanceof CMap && src instanceof CMap) { const c = copyVal(src); dst.ents = c.ents; dst.idx = c.idx; dst.nb = c.nb; dst.nextResize = c.nextResize; return dst; }
  if (dst instanceof CAdapter && src instanceof CAdapter) { dst.a = src.a.map(copyVal); return dst; }
  if (dst instanceof CObj && src instanceof CObj) { for (const k of Object.keys(src.f)) dst.f[k] = copyVal(src.f[k]); return dst; }
  return undefined;
}
export function swapContents(a, b) {
  const tmp = copyVal(a); copyInto(a, b); copyInto(b, tmp);
}
export function coerce(v, t) {
  if (!t || t.ptr > 0 || v === undefined) return v;
  if (t.ref) return v;
  if (v instanceof CInit) return fromInit(t, v);
  const name = t.name;
  switch (name) {
    case "int": return typeof v === "number" ? v : v instanceof JC ? v.c : typeof v === "boolean" ? +v : v instanceof JD ? d2i(v.v) : typeof v === "bigint" || v instanceof JU ? Number(BigInt.asIntN(32, big(v))) : v;
    case "short": return isNum(v) ? (ix(v instanceof JD ? Math.trunc(v.v) : kindOf(v) >= 3 ? Number(BigInt.asIntN(32, big(v))) : v) << 16) >> 16 : v;
    case "ushort": return isNum(v) ? ix(kindOf(v) >= 3 ? Number(BigInt.asIntN(32, big(v))) : v) & 0xffff : v;
    case "uchar": return isNum(v) ? ix(kindOf(v) >= 3 ? Number(BigInt.asIntN(32, big(v))) : v) & 0xff : v;
    case "char": return v instanceof JC ? v : isNum(v) ? new JC(((v instanceof JD ? d2i(v.v) : kindOf(v) >= 3 ? Number(BigInt.asIntN(32, big(v))) : ix(v)) << 24) >> 24) : v;
    case "bool": return typeof v === "boolean" ? v : truthy(v);
    case "ll": return typeof v === "bigint" ? v : isNum(v) ? BigInt.asIntN(64, big(v)) : v;
    case "uint": return v instanceof JU && v.bits === 32 ? v : isNum(v) ? new JU(BigInt.asUintN(32, big(v)), 32) : v;
    case "ull": return v instanceof JU && v.bits === 64 ? v : isNum(v) ? new JU(BigInt.asUintN(64, big(v)), 64) : v;
    case "double": return v instanceof JD ? v : isNum(v) ? new JD(dbl(v)) : v;
    case "float": return isNum(v) ? new JD(Math.fround(dbl(v))) : v;
    case "string": return v instanceof CStr ? new CStr(v.s) : typeof v === "string" ? new CStr(v) : v;
    case "auto": case "decltype": case "iterator": case "function": case "void": return v;
    case "pair": if (v instanceof CPair) return new CPair(coerce(v.first, t.args[0]), coerce(v.second, t.args[1])); return v;
  }
  if (CONTAINER_NAMES.has(name)) return copyVal(v);
  if (v instanceof CObj) return v.heap ? v : copyVal(v);
  return v;
}
export const arraySize = (t) => (t.size !== undefined ? t.size : t.args[1]?.expr?.k === "lit" ? Number(t.args[1].expr.v) : undefined);
export function elemType(c) { return c?.t?.args?.[0] ?? null; }
export function defaultValue(t) {
  if (!t) return 0;
  if (t.ptr > 0) return null;
  if (t.dims && t.dims.length) fail("Array default");
  switch (t.name) {
    case "int": case "short": case "ushort": case "uchar": return 0; case "ll": return 0n; case "uint": return new JU(0n, 32); case "ull": return new JU(0n, 64);
    case "double": case "float": return new JD(0); case "bool": return false; case "char": return new JC(0); case "string": return new CStr("");
    case "auto": case "decltype": case "void": case "iterator": return 0;
    case "pair": return new CPair(defaultValue(t.args[0]), defaultValue(t.args[1]));
    case "tuple": return new CTuple(t.args.map(defaultValue));
    case "stringstream": case "istringstream": case "ostringstream": return construct(t, []);
  }
  if (CONTAINER_NAMES.has(t.name)) return construct(t, []);
  return hooks.defaultUser ? hooks.defaultUser(t) : null;
}
export function fromInit(t, init, into = null) {
  const els = init.elems;
  if (!t || t.name === "auto" || t.name === "decltype") return new CVec(els.map((e) => (e instanceof CInit ? fromInit(null, e) : e)), "vector", null);
  switch (t.name) {
    case "vector": case "deque": case "list": case "array": {
      const et = t.args[0], a = els.map((e) => coerce(e, et));
      const asz = arraySize(t); if (t.name === "array" && asz !== undefined) while (a.length < asz) a.push(defaultValue(et));
      return new CVec(a, t.name, t);
    }
    case "set": case "unordered_set": case "multiset": case "unordered_multiset": case "map": case "unordered_map": case "multimap": case "unordered_multimap": {
      const m = into || new CMap(t.name, t, cmpFromType(t, null)); const isSet = m.isSet;
      sizeForRange(m, els.length);
      for (const e of els) { if (isSet) mapInsert(m, coerce(e, t.args[0]), undefined); else { const p = e instanceof CInit ? e.elems : [e.first, e.second]; mapInsert(m, coerce(p[0], t.args[0]), coerce(p[1], t.args[1])); } }
      return m;
    }
    case "pair": return new CPair(coerce(els[0], t.args[0]), coerce(els[1], t.args[1]));
    case "tuple": return new CTuple(els.map((e, i) => coerce(e, t.args[i])));
    case "string": return new CStr(els.map((e) => sval(e)).join(""));
    case "stack": case "queue": case "priority_queue": return construct(t, [new CVec(els.map((e) => coerce(e, t.args[0])))]);
  }
  if (els.length === 1 && isNum(els[0]) && !hooks.isUserClass?.(t.name)) return coerce(els[0], t);
  return hooks.fromInitUser ? hooks.fromInitUser(t, init) : fail(`Cannot initialize ${t.name} from a braced list`);
}

// ---------------------------------------------------------------- hashing / keys
export function keyStr(k) {
  if (typeof k === "number") return "n" + k;
  if (isNum(k) && !(k instanceof JD)) return "n" + (k instanceof JC ? k.c : String(k instanceof JU ? k.v : k === true ? 1 : k === false ? 0 : k));
  if (k instanceof JD) return "d" + k.v;
  if (isStr(k)) return "s" + sval(k);
  if (k instanceof CPair) return "p(" + keyStr(k.first) + "," + keyStr(k.second) + ")";
  if (k instanceof CVec || k instanceof CTuple) return "v[" + k.a.map(keyStr).join(",") + "]";
  if (k === null) return "null";
  if (k instanceof CObj) return k.heap ? "o" + objId(k) : "O{" + Object.values(k.f).map(keyStr).join(",") + "}";
  return "x" + String(k);
}
const MUL = 0xc6a4a7935bd1e995n;
function hashBytes(bytes) {
  const len = BigInt(bytes.length); let h = (0xc70f6907n ^ ((len * MUL) & M64)) & M64; const aligned = bytes.length & ~7;
  for (let i = 0; i < aligned; i += 8) { let d = 0n; for (let j = 7; j >= 0; j--) d = (d << 8n) | BigInt(bytes[i + j]); d = (d * MUL) & M64; d ^= d >> 47n; d = (d * MUL) & M64; h ^= d; h = (h * MUL) & M64; }
  if (bytes.length & 7) { let d = 0n; for (let j = bytes.length - 1; j >= aligned; j--) d = (d << 8n) | BigInt(bytes[j]); h ^= d; h = (h * MUL) & M64; }
  h ^= h >> 47n; h = (h * MUL) & M64; h ^= h >> 47n; return h;
}
export function hashOf(k) {
  if (isStr(k)) { const s = sval(k), b = []; for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 255); return hashBytes(b); }
  if (k instanceof JD) { if (k.v === 0) return 0n; const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, k.v, true); return hashBytes([...new Uint8Array(dv.buffer)]); }
  if (isNum(k)) return BigInt.asUintN(64, big(k));
  if (k === null) return 0n;
  if (k instanceof CObj) return BigInt(objId(k)) * 16n + 0x600000n;
  return BigInt(keyStr(k).length);
}
const FAST_BKT = [1, 2, 2, 3, 5, 5, 7, 7, 11, 11, 11, 11, 13, 13];
const PRIMES = [13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 103, 109, 113, 127, 137, 139, 149, 157, 167, 179, 193, 199, 211, 227, 241, 257, 277, 293, 313, 337, 359, 383, 409, 439, 467, 503, 541, 577, 619, 661, 709, 761, 823, 887, 953, 1031, 1109, 1193, 1289, 1381, 1493, 1613, 1741, 1879, 2029, 2179, 2357, 2549, 2753, 2971, 3209, 3469, 3739, 4027, 4349, 4703, 5087, 5503, 5953, 6427, 6949, 7517, 8123, 8783, 9497, 10273, 11113, 12011, 12983, 14033, 15173, 16411, 17749, 19183, 20753, 22447, 24281, 26267, 28411, 30727, 33223, 35933, 38873, 42043, 45481, 49201, 53201, 57557, 62233, 67307, 72817, 78779, 85229, 92203, 99733, 107897, 116731, 126271, 136607, 147793, 159871, 172933, 187091, 202409, 218971, 236897, 256279, 277261, 299951, 324503, 351061, 379787, 410857, 444487, 480881, 520241, 562841, 608903, 658753, 712697, 771049, 834181, 902483, 976369];
function nextBkt(m, n) { // libstdc++ _Prime_rehash_policy::_M_next_bkt
  let r; if (n < FAST_BKT.length) r = n === 0 ? 1 : FAST_BKT[n]; else { r = PRIMES.find((p) => p >= n); if (r === undefined) r = n | 1; }
  m.nextResize = r; return r;
}
const bucketOf = (m, e) => Number(e.h % BigInt(m.nb));
function placeInList(m, list, e) { // libstdc++ node insertion rule: front of its bucket's group, or global front if the bucket is empty
  const b = bucketOf(m, e); const at = list.findIndex((x) => bucketOf(m, x) === b); list.splice(at < 0 ? 0 : at, 0, e);
}
function rehash(m, nb) { m.nb = nb; const old = m.ents; m.ents = []; for (const e of old) placeInList(m, m.ents, e); }
export function sizeForRange() { /* libstdc++ 12+ inserts range / init-list elements one by one (no bucket pre-sizing) */ }
export function reserveMap(m, n) { if (m.ordered) return; const nb = nextBkt(m, Math.floor(n) + 1); if (nb > m.nb) rehash(m, nb); else m.nextResize = m.nb; }

// ---------------------------------------------------------------- map / set core
const mless = (m, a, b) => (m.cmp ? truthy(hooks.callFn(m.cmp, [a, b])) : lt(a, b));
function lowerIdx(m, k) { let lo = 0, hi = m.ents.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (mless(m, m.ents[mid].first, k)) lo = mid + 1; else hi = mid; } return lo; }
function upperIdx(m, k) { let lo = 0, hi = m.ents.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (!mless(m, k, m.ents[mid].first)) lo = mid + 1; else hi = mid; } return lo; }
export function mapFindEntry(m, k) {
  if (!m.ordered) { if (!m.multi) return m.idx.get(keyStr(k)) || null; return m.ents.find((e) => ceq(e.first, k)) || null; }
  const i = lowerIdx(m, k); const e = m.ents[i]; return e && !mless(m, k, e.first) ? e : null;
}
export function mapInsert(m, k, v) { // returns {e, inserted}
  if (!m.multi) { const ex = mapFindEntry(m, k); if (ex) return { e: ex, inserted: false }; }
  const e = new CPair(k, v);
  if (m.ordered) m.ents.splice(m.multi ? upperIdx(m, k) : lowerIdx(m, k), 0, e);
  else {
    e.h = hashOf(k);
    const need = m.ents.length + 1;
    if (need > m.nextResize) {
      const minb = Math.max(need, m.nextResize ? 0 : 11);
      if (minb >= m.nb) rehash(m, nextBkt(m, Math.max(Math.floor(minb) + 1, m.nb * 2))); else m.nextResize = m.nb;
    }
    placeInList(m, m.ents, e);
    if (!m.multi) m.idx.set(keyStr(k), e);
  }
  return { e, inserted: true };
}
export function mapErase(m, k) {
  if (m.ordered) { const lo = lowerIdx(m, k), hi = m.multi ? upperIdx(m, k) : (mapFindEntry(m, k) ? lo + 1 : lo); m.ents.splice(lo, hi - lo); return hi - lo; }
  let n = 0; for (let i = m.ents.length - 1; i >= 0; i--) if (ceq(m.ents[i].first, k)) { m.ents.splice(i, 1); n++; if (!m.multi) break; }
  if (!m.multi) m.idx.delete(keyStr(k)); return n;
}
function mapEraseAt(m, i) { const e = m.ents[i]; if (!e) fail("Erasing an invalid iterator"); m.ents.splice(i, 1); if (!m.ordered && !m.multi) m.idx.delete(keyStr(e.first)); }
export function mapIndex(m, k) { // operator[]
  const ex = mapFindEntry(m, k); if (ex) return ex;
  return mapInsert(m, copyVal(k), defaultValue(m.t?.args?.[1])).e;
}
export function orderedEntries(m) { return m.ents; }

// ---------------------------------------------------------------- heaps (same layout as libstdc++)
function pushHeap(a, comp) { let hole = a.length - 1; const v = a[hole]; while (hole > 0) { const p = (hole - 1) >> 1; if (!comp(a[p], v)) break; a[hole] = a[p]; hole = p; } a[hole] = v; }
function adjustHeap(a, hole, len, v, comp) {
  const top = hole; let second = hole;
  while (second < ((len - 1) >> 1)) { second = 2 * (second + 1); if (comp(a[second], a[second - 1])) second--; a[hole] = a[second]; hole = second; }
  if ((len & 1) === 0 && second === ((len - 2) >> 1)) { second = 2 * (second + 1); a[hole] = a[second - 1]; hole = second - 1; }
  let p = (hole - 1) >> 1; while (hole > top && comp(a[p], v)) { a[hole] = a[p]; hole = p; p = (hole - 1) >> 1; } a[hole] = v;
}
function popHeap(a, comp) { const n = a.length, v = a[n - 1]; a[n - 1] = a[0]; adjustHeap(a, 0, n - 1, v, comp); }
function makeHeap(a, comp) { const len = a.length; if (len < 2) return; let p = (len - 2) >> 1; for (;;) { adjustHeap(a, p, len, a[p], comp); if (p === 0) return; p--; } }
const compOf = (cmp) => (cmp ? (a, b) => truthy(hooks.callFn(cmp, [a, b])) : lt);

// ---------------------------------------------------------------- construction
const nativeCmp = (f) => new CFn({ native: (args) => f(args[0], args[1]) });
export const FUNCTORS = {
  less: () => nativeCmp((a, b) => lt(a, b)), greater: () => nativeCmp((a, b) => lt(b, a)), less_equal: () => nativeCmp((a, b) => !lt(b, a)), greater_equal: () => nativeCmp((a, b) => !lt(a, b)),
  equal_to: () => nativeCmp((a, b) => ceq(a, b)), not_equal_to: () => nativeCmp((a, b) => !ceq(a, b)),
  plus: () => new CFn({ native: (a) => arith("+", a[0], a[1]) }), minus: () => new CFn({ native: (a) => arith("-", a[0], a[1]) }), multiplies: () => new CFn({ native: (a) => arith("*", a[0], a[1]) }),
};
export function cmpFromType(t, ctorArg) {
  const idx = /map/.test(t.name) ? 2 : /^priority/.test(t.name) ? 2 : 1;
  if (ctorArg && (ctorArg instanceof CFn || ctorArg instanceof CObj)) return ctorArg;
  const a = t.args[idx]; if (!a || a.name === "less" || a.name === "decltype") return null;
  if (FUNCTORS[a.name]) return a.name === "less" ? null : FUNCTORS[a.name]();
  return hooks.constructUser ? hooks.constructUser(a, []) : null;
}
export const iterRange = (first, last) => { const c = first.c; if (first.rev) { const n = lenOf(c); return iterRange(new CIter(c, n - last.i), new CIter(c, n - first.i)).reverse(); } if (c instanceof CVec) return c.a.slice(first.i, last.i); if (c instanceof CStr) return [...c.s.slice(first.i, last.i)].map((ch) => new JC(ch.charCodeAt(0))); if (c instanceof CMap) return c.ents.slice(first.i, last.i).map((e) => (c.isSet ? e.first : e)); fail("Unsupported iterator range"); };
export function construct(t, args) {
  const n = t.name, et = t.args[0];
  switch (n) {
    case "vector": case "deque": case "list": case "array": {
      if (!args.length) { const asz = arraySize(t); return n === "array" && asz !== undefined ? new CVec(Array.from({ length: asz }, () => defaultValue(et)), n, t) : new CVec([], n, t); }
      const a0 = args[0];
      if (a0 instanceof CIter) return new CVec(iterRange(a0, args[1]).map((x) => coerce(x, et)), n, t);
      if (a0 instanceof CVec && a0.kind === "array" && args[1] instanceof CIter) return new CVec(iterRange(new CIter(a0, 0), args[1]).map((x) => coerce(x, et)), n, t);
      if (a0 instanceof CVec) return new CVec(a0.a.map(copyVal), n, t);
      if (a0 instanceof CInit) return fromInit(t, a0);
      const cnt = ix(a0); if (cnt < 0) fail("vector: length_error"); if (cnt > 5e6) fail("Allocation too large for the tracer");
      const out = new Array(cnt); for (let i = 0; i < cnt; i++) out[i] = args.length > 1 ? coerce(args[1], et) : defaultValue(et);
      return new CVec(out, n, t);
    }
    case "string": {
      if (!args.length) return new CStr("");
      const a0 = args[0];
      if (a0 instanceof CIter) return new CStr(iterRange(a0, args[1]).map((c) => String.fromCharCode(c.c)).join(""));
      if (isStr(a0)) { let s = sval(a0); if (args.length >= 2 && isNum(args[1])) { const p = ix(args[1]); if (p > s.length) fail("basic_string: out_of_range"); s = s.substr(p, args.length > 2 ? ix(args[2]) : undefined); } return new CStr(s); }
      if (isNum(a0) && args.length >= 2) return new CStr(String.fromCharCode(ix(args[1] instanceof JC ? args[1].c : args[1])).repeat(Math.max(0, ix(a0))));
      if (a0 instanceof CInit) return fromInit(t, a0);
      fail("Unsupported string constructor");
    }
    case "pair": return new CPair(coerce(args[0], t.args[0]), coerce(args[1], t.args[1]));
    case "tuple": return new CTuple(args.map((a, i) => coerce(a, t.args[i])));
    case "map": case "unordered_map": case "multimap": case "unordered_multimap": case "set": case "unordered_set": case "multiset": case "unordered_multiset": {
      const cmpArg = args.find((a) => a instanceof CFn || a instanceof CObj);
      const m = new CMap(n, t, cmpFromType(t, cmpArg));
      const a0 = args[0];
      if (a0 instanceof CMap) { const c = copyVal(a0); c.t = t; c.cmp = c.cmp || m.cmp; return c; }
      if (a0 instanceof CIter) { const els = iterRange(a0, args[1]); sizeForRange(m, els.length); for (const e of els) { if (m.isSet) mapInsert(m, coerce(e, et), undefined); else mapInsert(m, copyVal(e.first), copyVal(e.second)); } }
      else if (a0 instanceof CInit) return fromInit(t, a0, m);
      else if (!m.ordered && isNum(a0)) reserveMap(m, ix(a0));
      return m;
    }
    case "stack": case "queue": case "priority_queue": {
      const cmpArg = args.find((a) => a instanceof CFn || a instanceof CObj);
      const q = new CAdapter(n, t, n === "priority_queue" ? cmpFromType(t, cmpArg) : null);
      const src = args.find((a) => a instanceof CVec || a instanceof CAdapter);
      if (src) { q.a = src.a.map(copyVal); if (src instanceof CAdapter) { q.cmp = q.cmp || src.cmp; return q; } if (n === "priority_queue") makeHeap(q.a, compOf(q.cmp)); }
      else if (args[0] instanceof CIter) { q.a = iterRange(args[0], args[1]).map((x) => coerce(x, et)); if (n === "priority_queue") makeHeap(q.a, compOf(q.cmp)); }
      return q;
    }
    case "function": return args[0] ?? null;
    case "stringstream": case "istringstream": case "ostringstream": return new CSStream(args.length ? sval(args[0]) : "");
    case "less": case "greater": case "less_equal": case "greater_equal": case "equal_to": case "not_equal_to": case "plus": case "minus": case "multiplies": return FUNCTORS[n]();
    case "hash": return new CFn({ native: (a) => U64(hashOf(a[0])) });
  }
  if (["int", "ll", "uint", "ull", "double", "float", "char", "bool", "short", "uchar", "ushort"].includes(n)) return args.length ? coerce(args[0], t) : defaultValue(t);
  if (hooks.constructUser) return hooks.constructUser(t, args);
  fail(`Unsupported type: ${n}`);
}

// ---------------------------------------------------------------- iterators
export function iterGet(it) {
  const c = it.c; const i = it.rev ? lenOf(c) - 1 - it.i : it.i;
  if (i < 0 || i >= lenOf(c)) fail("Dereferencing an end (or invalid) iterator");
  if (c instanceof CVec) return c.a[i]; if (c instanceof CStr) return new JC(c.s.charCodeAt(i));
  if (c instanceof CMap) return c.isSet ? c.ents[i].first : c.ents[i];
  fail("Unsupported iterator");
}
export function iterSet(it, v) {
  const c = it.c; const i = it.rev ? lenOf(c) - 1 - it.i : it.i;
  if (c instanceof CVec) c.a[i] = v; else if (c instanceof CStr) c.s = c.s.slice(0, i) + sval(v) + c.s.slice(i + 1); else fail("Can't assign through this iterator");
}
export const lenOf = (c) => c instanceof CVec ? c.a.length : c instanceof CStr ? c.s.length : c instanceof CMap ? c.ents.length : c instanceof CAdapter ? c.a.length : 0;
const beginOf = (c) => new CIter(c, 0), endOf = (c) => new CIter(c, lenOf(c));

// ---------------------------------------------------------------- formatting
export function fmtG(x, prec = 6) {
  if (Number.isNaN(x)) return "nan"; if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0"; if (prec === 0) prec = 1;
  const exp = Math.floor(Math.log10(Math.abs(x)));
  let s = Number(x.toPrecision(prec)); const e2 = s === 0 ? exp : Math.floor(Math.log10(Math.abs(s)));
  if (e2 < -4 || e2 >= prec) { let m = x.toExponential(prec - 1).replace(/\.?0+e/, "e"); return m.replace(/e([+-])(\d)$/, "e$10$2"); }
  let out = x.toFixed(Math.max(0, prec - 1 - e2)); if (out.includes(".")) out = out.replace(/\.?0+$/, ""); return out;
}
export function toText(v, stream = null) {
  if (v === null || v === undefined) return stream ? "0" : "0";
  if (typeof v === "string") return v; if (v instanceof CStr) return v.s;
  if (typeof v === "boolean") return v ? "1" : "0"; if (typeof v === "number") return String(v); if (typeof v === "bigint") return String(v);
  if (v instanceof JU) return String(v.v); if (v instanceof JC) return String.fromCharCode(v.c);
  if (v instanceof JD) return stream?.fixed ? v.v.toFixed(stream.prec) : fmtG(v.v, stream ? stream.prec : 6);
  if (v instanceof CObj) return `0x${(0x600000 + objId(v) * 16).toString(16)}`;
  return "<object>";
}
export function formatC(fmt, args) {
  let ai = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|z|j|t|L)?([diouxXfFeEgGcsp%])/g, (m, flags, w, p, len, conv) => {
    if (conv === "%") return "%";
    const wv = w === "*" ? ix(args[ai++]) : w ? Number(w) : 0; const pv = p === "*" ? ix(args[ai++]) : p !== undefined ? Number(p) : undefined;
    const a = args[ai++]; let s;
    switch (conv) {
      case "d": case "i": s = String(isNum(a) && !(a instanceof JD) ? big(a) : Math.trunc(dbl(a))); if (flags.includes("+") && !s.startsWith("-")) s = "+" + s; break;
      case "u": s = String(BigInt.asUintN(len === "l" || len === "ll" || len === "z" ? 64 : 32, big(a))); break;
      case "x": case "X": s = BigInt.asUintN(len === "l" || len === "ll" || len === "z" ? 64 : 32, big(a)).toString(16); if (conv === "X") s = s.toUpperCase(); break;
      case "o": s = BigInt.asUintN(32, big(a)).toString(8); break;
      case "f": case "F": s = dbl(a).toFixed(pv ?? 6); if (flags.includes("+") && !s.startsWith("-")) s = "+" + s; break;
      case "e": case "E": s = dbl(a).toExponential(pv ?? 6).replace(/e([+-])(\d)$/, "e$10$2"); break;
      case "g": case "G": s = fmtG(dbl(a), pv ?? 6); break;
      case "c": s = a instanceof JC ? String.fromCharCode(a.c) : String.fromCharCode(ix(a)); break;
      case "s": s = isStr(a) ? sval(a) : toText(a); if (pv !== undefined) s = s.slice(0, pv); break;
      default: s = toText(a);
    }
    if (wv > s.length) s = flags.includes("-") ? s.padEnd(wv) : flags.includes("0") && conv !== "s" && conv !== "c" ? (s.startsWith("-") || s.startsWith("+") ? s[0] + s.slice(1).padStart(wv - 1, "0") : s.padStart(wv, "0")) : s.padStart(wv);
    return s;
  });
}
export function toStringFn(v) { return new CStr(v instanceof JD ? v.v.toFixed(6) : toText(v)); }

// ---------------------------------------------------------------- member functions of builtin types
const chr = (code) => String.fromCharCode(code);
const sizeVal = (n) => U64(n);
function idxCheck(c, i, what) { if (i < 0 || i >= lenOf(c)) fail(`${what}: index ${i} out of range (size is ${lenOf(c)})`); }
export function callMethod(recv, name, args) {
  if (recv instanceof CVec) return vecMethod(recv, name, args);
  if (recv instanceof CStr) return strMethod(recv, name, args);
  if (recv instanceof CMap) return mapMethod(recv, name, args);
  if (recv instanceof CAdapter) return adapterMethod(recv, name, args);
  if (recv instanceof CIter) return undefined;
  if (recv instanceof CPair && name === "swap") { swapContents(recv, args[0]); return null; }
  if (recv instanceof CFn || recv instanceof CObj) return undefined;
  return undefined;
}
function insertPos(c, it) { return it instanceof CIter ? it.i : ix(it); }
function vecMethod(v, name, args) {
  const a = v.a, et = elemType(v), el = (x) => coerce(x, et);
  switch (name) {
    case "size": return sizeVal(a.length); case "empty": return a.length === 0; case "max_size": return U64(1n << 60n); case "capacity": return sizeVal(Math.max(a.length, 1));
    case "push_back": case "emplace_back": { if (v.kind === "array") return undefined; a.push(name === "emplace_back" ? emplaceElem(et, args) : el(args[0])); return null; }
    case "push_front": case "emplace_front": a.unshift(name === "emplace_front" ? emplaceElem(et, args) : el(args[0])); return null;
    case "pop_back": if (!a.length) fail("pop_back() on an empty container"); a.pop(); return null;
    case "pop_front": if (!a.length) fail("pop_front() on an empty container"); a.shift(); return null;
    case "back": if (!a.length) fail("back() on an empty container"); return a[a.length - 1];
    case "front": if (!a.length) fail("front() on an empty container"); return a[0];
    case "at": { const i = ix(args[0]); if (i < 0 || i >= a.length) fail(`vector::_M_range_check: __n (which is ${i}) >= this->size() (which is ${a.length})`); return a[i]; }
    case "begin": case "cbegin": return beginOf(v); case "end": case "cend": return endOf(v);
    case "rbegin": return new CIter(v, 0, true); case "rend": return new CIter(v, a.length, true);
    case "clear": a.length = 0; return null;
    case "resize": { const n = ix(args[0]); if (n < a.length) a.length = n; else while (a.length < n) a.push(args.length > 1 ? el(args[1]) : defaultValue(et)); return null; }
    case "assign": { if (args[0] instanceof CIter) v.a = iterRange(args[0], args[1]).map(el); else { const n = ix(args[0]); v.a = Array.from({ length: n }, () => el(args[1])); } return null; }
    case "reserve": case "shrink_to_fit": return null;
    case "swap": swapContents(v, args[0]); return null;
    case "fill": for (let i = 0; i < a.length; i++) a[i] = el(args[0]); return null;
    case "data": return beginOf(v);
    case "insert": case "emplace": {
      const p = insertPos(v, args[0]);
      if (p < 0 || p > a.length) fail("insert: invalid position");
      if (args.length === 2 && !(args[1] instanceof CIter) && !(args[1] instanceof CInit && name === "insert" && false)) { a.splice(p, 0, name === "emplace" ? emplaceElem(et, args.slice(1)) : el(args[1])); return new CIter(v, p); }
      if (args.length === 3 && args[1] instanceof CIter) { const items = iterRange(args[1], args[2]).map(el); a.splice(p, 0, ...items); return new CIter(v, p); }
      if (args.length === 3) { const n = ix(args[1]); a.splice(p, 0, ...Array.from({ length: n }, () => el(args[2]))); return new CIter(v, p); }
      if (args[1] instanceof CInit) { a.splice(p, 0, ...args[1].elems.map(el)); return new CIter(v, p); }
      return undefined;
    }
    case "erase": {
      const p = insertPos(v, args[0]);
      if (args.length === 2) { const q = insertPos(v, args[1]); a.splice(p, q - p); return new CIter(v, p); }
      if (p < 0 || p >= a.length) fail("erase: invalid iterator"); a.splice(p, 1); return new CIter(v, p);
    }
    case "remove": return undefined;
    case "sort": a.sort((x, y) => cmp3(x, y)); return null;
  }
  return undefined;
}
function emplaceElem(et, args) {
  if (et && et.name === "pair") return new CPair(coerce(args[0], et.args[0]), coerce(args[1], et.args[1]));
  if (et && et.name === "tuple") return new CTuple(args.map((x, i) => coerce(x, et.args[i])));
  if (et && (CONTAINER_NAMES.has(et.name) || et.name === "string" || (hooks.isUserClass?.(et.name) && !et.ptr))) return construct(et, args);
  return coerce(args[0], et);
}
function strMethod(s, name, args) {
  const str = s.s, n = str.length, a0 = args[0];
  const npos = NPOS;
  const posArg = (i, d) => (args.length > i && args[i] !== undefined ? ix(args[i]) : d);
  const needle = (x) => (x instanceof JC ? chr(x.c) : sval(x));
  const res = (i) => (i < 0 ? npos : sizeVal(i));
  switch (name) {
    case "size": case "length": return sizeVal(n); case "empty": return n === 0; case "capacity": return sizeVal(Math.max(n, 15)); case "c_str": case "data": return str;
    case "push_back": s.s += chr(a0.c ?? ix(a0)); return null;
    case "pop_back": if (!n) fail("pop_back() on an empty string"); s.s = str.slice(0, -1); return null;
    case "back": if (!n) fail("back() on an empty string"); return new JC(str.charCodeAt(n - 1));
    case "front": if (!n) fail("front() on an empty string"); return new JC(str.charCodeAt(0));
    case "at": { const i = ix(a0); if (i < 0 || i >= n) fail(`basic_string::at: __n (which is ${i}) >= this->size() (which is ${n})`); return new JC(str.charCodeAt(i)); }
    case "begin": case "cbegin": return beginOf(s); case "end": case "cend": return endOf(s); case "rbegin": return new CIter(s, 0, true); case "rend": return new CIter(s, n, true);
    case "clear": s.s = ""; return null;
    case "substr": { const p = posArg(0, 0); if (p > n || p < 0) fail(`basic_string::substr: __pos (which is ${p}) > this->size() (which is ${n})`); const l = args.length > 1 ? Number(big(args[1])) : Infinity; return new CStr(str.substr(p, l > n ? n : l)); }
    case "find": { const p = posArg(1, 0); return res(str.indexOf(needle(a0), p)); }
    case "rfind": { const p = args.length > 1 ? posArg(1, n) : n; return res(str.lastIndexOf(needle(a0), p)); }
    case "find_first_of": { const set = needle(a0), p = posArg(1, 0); for (let i = p; i < n; i++) if (set.includes(str[i])) return sizeVal(i); return npos; }
    case "find_last_of": { const set = needle(a0), p = args.length > 1 ? Math.min(posArg(1, n - 1), n - 1) : n - 1; for (let i = p; i >= 0; i--) if (set.includes(str[i])) return sizeVal(i); return npos; }
    case "find_first_not_of": { const set = needle(a0), p = posArg(1, 0); for (let i = p; i < n; i++) if (!set.includes(str[i])) return sizeVal(i); return npos; }
    case "find_last_not_of": { const set = needle(a0); for (let i = n - 1; i >= 0; i--) if (!set.includes(str[i])) return sizeVal(i); return npos; }
    case "append": { if (args.length === 2 && isNum(args[0]) && !(a0 instanceof JC)) s.s += needle(args[1]).repeat(ix(a0)); else if (args.length === 2 && a0 instanceof CIter) s.s += iterRange(a0, args[1]).map((c) => chr(c.c)).join(""); else s.s += a0 instanceof JC ? chr(a0.c) : args.length === 3 ? sval(a0).substr(ix(args[1]), ix(args[2])) : sval(a0); return s; }
    case "assign": s.s = args.length === 2 && isNum(a0) ? needle(args[1]).repeat(ix(a0)) : sval(a0); return s;
    case "insert": { const p = args[0] instanceof CIter ? args[0].i : ix(args[0]); if (p > n || p < 0) fail("basic_string::insert: out_of_range"); const ins = args.length === 3 && isNum(args[1]) && !(args[1] instanceof JC) ? needle(args[2]).repeat(ix(args[1])) : needle(args[1]); s.s = str.slice(0, p) + ins + str.slice(p); return args[0] instanceof CIter ? new CIter(s, p) : s; }
    case "erase": {
      if (args.length === 0) { s.s = ""; return s; }
      if (args[0] instanceof CIter) { const p = args[0].i, q = args.length > 1 ? args[1].i : p + 1; s.s = str.slice(0, p) + str.slice(q); return new CIter(s, p); }
      const p = ix(a0); if (p > n) fail("basic_string::erase: out_of_range"); const l = args.length > 1 ? Number(big(args[1])) : Infinity; s.s = str.slice(0, p) + (l >= n - p ? "" : str.slice(p + l)); return s;
    }
    case "replace": { const p = ix(a0), l = Math.min(ix(args[1]), n - p); s.s = str.slice(0, p) + needle(args[2]) + str.slice(p + l); return s; }
    case "compare": { const o = sval(a0); return str < o ? -1 : str > o ? 1 : 0; }
    case "resize": { const k = ix(a0); s.s = k <= n ? str.slice(0, k) : str + (args.length > 1 ? needle(args[1]) : "\0").repeat(k - n); return null; }
    case "swap": { const t = s.s; s.s = args[0].s; args[0].s = t; return null; }
    case "starts_with": return str.startsWith(needle(a0)); case "ends_with": return str.endsWith(needle(a0)); case "contains": return str.includes(needle(a0));
    case "reserve": case "shrink_to_fit": return null;
    case "copy": return undefined;
  }
  return undefined;
}
function mapMethod(m, name, args) {
  const a0 = args[0], kt = m.t?.args?.[0];
  switch (name) {
    case "size": return sizeVal(m.ents.length); case "empty": return m.ents.length === 0; case "clear": m.ents = []; m.idx = new Map(); return null;
    case "begin": case "cbegin": return beginOf(m); case "end": case "cend": return endOf(m); case "rbegin": return new CIter(m, 0, true); case "rend": return new CIter(m, m.ents.length, true);
    case "count": { if (m.multi) return sizeVal(m.ents.filter((e) => ceq(e.first, a0)).length); return sizeVal(mapFindEntry(m, a0) ? 1 : 0); }
    case "contains": return !!mapFindEntry(m, a0);
    case "find": { const e = mapFindEntry(m, a0); return new CIter(m, e ? m.ents.indexOf(e) : m.ents.length); }
    case "at": { const e = mapFindEntry(m, a0); if (!e) fail("map::at: key not found (std::out_of_range)"); return e.second; }
    case "insert": case "emplace": {
      if (a0 instanceof CIter && args[1] instanceof CIter) { for (const e of iterRange(a0, args[1])) { if (m.isSet) mapInsert(m, coerce(e, kt), undefined); else mapInsert(m, copyVal(e.first), copyVal(e.second)); } return null; }
      if (a0 instanceof CInit && !m.isSet && a0.elems.length === 2 && !(a0.elems[0] instanceof CInit) && !(a0.elems[0] instanceof CPair)) { const r = mapInsert(m, coerce(a0.elems[0], kt), coerce(a0.elems[1], m.t?.args?.[1])); return new CPair(new CIter(m, m.ents.indexOf(r.e)), r.inserted); }
      if (a0 instanceof CInit) { for (const e of a0.elems) { if (m.isSet) mapInsert(m, coerce(e, kt), undefined); else { const p = e instanceof CInit ? e.elems : [e.first, e.second]; mapInsert(m, coerce(p[0], kt), coerce(p[1], m.t?.args?.[1])); } } return null; }
      let k, v; if (m.isSet) k = coerce(a0, kt); else if (a0 instanceof CPair && args.length === 1) { k = coerce(a0.first, kt); v = coerce(a0.second, m.t?.args?.[1]); } else { k = coerce(a0, kt); v = coerce(args[1], m.t?.args?.[1]); }
      const r = mapInsert(m, k, v); return new CPair(new CIter(m, m.ents.indexOf(r.e)), r.inserted);
    }
    case "emplace_hint": return mapMethod(m, "emplace", args.slice(1));
    case "insert_or_assign": { const r = mapInsert(m, coerce(a0, kt), coerce(args[1], m.t?.args?.[1])); if (!r.inserted) r.e.second = coerce(args[1], m.t?.args?.[1]); return new CPair(new CIter(m, m.ents.indexOf(r.e)), r.inserted); }
    case "try_emplace": { const r = mapInsert(m, coerce(a0, kt), coerce(args[1], m.t?.args?.[1])); return new CPair(new CIter(m, m.ents.indexOf(r.e)), r.inserted); }
    case "erase": {
      if (a0 instanceof CIter) { const p = a0.i; if (args.length > 1) { const q = args[1].i; for (let i = q - 1; i >= p; i--) mapEraseAt(m, i); } else mapEraseAt(m, p); return new CIter(m, p); }
      return sizeVal(mapErase(m, a0));
    }
    case "lower_bound": if (!m.ordered) return undefined; return new CIter(m, lowerIdx(m, a0));
    case "upper_bound": if (!m.ordered) return undefined; return new CIter(m, upperIdx(m, a0));
    case "equal_range": return new CPair(new CIter(m, lowerIdx(m, a0)), new CIter(m, upperIdx(m, a0)));
    case "swap": swapContents(m, a0); return null;
    case "reserve": reserveMap(m, ix(a0)); return null; case "rehash": return null;
    case "bucket_count": return sizeVal(m.nb); case "load_factor": return new JD(m.ents.length / m.nb);
  }
  return undefined;
}
function adapterMethod(q, name, args) {
  const a = q.a, et = elemType(q), el = (x) => coerce(x, et), comp = compOf(q.cmp);
  const empty = (w) => { if (!a.length) fail(`${w}() called on an empty ${q.kind}`); };
  switch (name) {
    case "size": return sizeVal(a.length); case "empty": return a.length === 0;
    case "swap": swapContents(q, args[0]); return null;
  }
  if (q.kind === "stack") switch (name) {
    case "push": a.push(el(args[0])); return null; case "emplace": a.push(emplaceElem(et, args)); return null;
    case "pop": empty("pop"); a.pop(); return null; case "top": empty("top"); return a[a.length - 1];
  }
  if (q.kind === "queue") switch (name) {
    case "push": a.push(el(args[0])); return null; case "emplace": a.push(emplaceElem(et, args)); return null;
    case "pop": empty("pop"); a.shift(); return null; case "front": empty("front"); return a[0]; case "back": empty("back"); return a[a.length - 1];
  }
  if (q.kind === "priority_queue") switch (name) {
    case "push": a.push(el(args[0])); pushHeap(a, comp); return null; case "emplace": a.push(emplaceElem(et, args)); pushHeap(a, comp); return null;
    case "pop": empty("pop"); popHeap(a, comp); a.pop(); return null; case "top": empty("top"); return a[0];
  }
  return undefined;
}

// ---------------------------------------------------------------- free functions
const CONSTS = {
  INT_MAX: 2147483647, INT_MIN: -2147483648, UINT_MAX: new JU(4294967295n, 32), LLONG_MAX: 9223372036854775807n, LLONG_MIN: -9223372036854775808n,
  LONG_MAX: 9223372036854775807n, LONG_MIN: -9223372036854775808n, ULLONG_MAX: new JU(M64, 64), ULONG_MAX: new JU(M64, 64), SHRT_MAX: 32767, SHRT_MIN: -32768, CHAR_MAX: 127, CHAR_MIN: -128, UCHAR_MAX: 255,
  INT64_MAX: 9223372036854775807n, INT64_MIN: -9223372036854775808n, INT32_MAX: 2147483647, INT32_MIN: -2147483648, UINT64_MAX: new JU(M64, 64),
  DBL_MAX: new JD(Number.MAX_VALUE), DBL_MIN: new JD(2.2250738585072014e-308), DBL_EPSILON: new JD(Number.EPSILON), FLT_MAX: new JD(3.4028234663852886e38), INFINITY: new JD(Infinity), NAN: new JD(NaN),
  M_PI: new JD(Math.PI), M_E: new JD(Math.E), RAND_MAX: 2147483647, EOF: -1, CHAR_BIT: 8,
};
export const lookupConst = (n) => CONSTS[n];
export function numLimits(t, which) {
  const n = t?.name || "int";
  const tbl = { int: [-2147483648, 2147483647], short: [-32768, 32767], char: [new JC(-128), new JC(127)], ll: [-(2n ** 63n), 2n ** 63n - 1n], uint: [new JU(0n, 32), new JU(4294967295n, 32)], ull: [new JU(0n, 64), new JU(M64, 64)], uchar: [0, 255], ushort: [0, 65535], bool: [false, true] };
  if (n === "double" || n === "float") { const big_ = n === "double" ? Number.MAX_VALUE : 3.4028234663852886e38; return which === "max" ? new JD(big_) : which === "lowest" ? new JD(-big_) : which === "min" ? new JD(n === "double" ? 2.2250738585072014e-308 : 1.17549435e-38) : which === "infinity" ? new JD(Infinity) : which === "epsilon" ? new JD(n === "double" ? Number.EPSILON : 1.1920929e-7) : new JD(NaN); }
  const r = tbl[n] || tbl.int; return which === "max" ? r[1] : which === "min" || which === "lowest" ? r[0] : fail(`numeric_limits::${which} is not supported`);
}
function rangeOps(first, last) {
  const c = first.c;
  if (first.rev) { const n = lenOf(c), inner = rangeOps(new CIter(c, n - last.i), new CIter(c, n - first.i)); return { get: () => inner.get().reverse(), set: (arr) => inner.set(arr.slice().reverse()), n: inner.n }; }
  const lo = first.i, hi = last.i;
  if (c instanceof CVec) return { get: () => c.a.slice(lo, hi), set: (arr) => { for (let i = 0; i < arr.length; i++) c.a[lo + i] = arr[i]; }, n: hi - lo };
  if (c instanceof CStr) return { get: () => [...c.s.slice(lo, hi)].map((ch) => new JC(ch.charCodeAt(0))), set: (arr) => { c.s = c.s.slice(0, lo) + arr.map((x) => chr(x.c)).join("") + c.s.slice(lo + arr.length); }, n: hi - lo };
  if (c instanceof CMap) return { get: () => c.ents.slice(lo, hi).map((e) => (c.isSet ? e.first : e)), set: () => fail("Can't modify a set/map range"), n: hi - lo };
  fail("Unsupported range");
}
const call = (f, args) => hooks.callFn(f, args);
const sortFn = (cmp) => { const less = cmp ? (a, b) => truthy(call(cmp, [a, b])) : lt; return (a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0); };
const MATH1 = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10, floor: Math.floor, ceil: Math.ceil, fabs: Math.abs, cbrt: Math.cbrt, trunc: Math.trunc, round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)), sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh };
const gcdBig = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const DECAY_FUNCS = new Set(["sort", "stable_sort", "reverse", "fill", "iota", "accumulate", "min_element", "max_element", "count", "count_if", "find", "find_if", "lower_bound", "upper_bound", "binary_search", "unique", "rotate", "next_permutation", "prev_permutation", "equal", "is_sorted", "copy", "transform", "for_each", "remove", "remove_if", "partial_sum", "any_of", "all_of", "none_of", "distance", "partial_sort", "memset", "fill_n"]);
export function callFree(name, args) {
  if (DECAY_FUNCS.has(name) && args.some((a) => a instanceof CVec && a.kind === "array")) args = args.map((a) => (a instanceof CVec && a.kind === "array" ? new CIter(a, 0) : a));
  const a0 = args[0], a1 = args[1];
  if (name in MATH1) return new JD(MATH1[name](dbl(a0)));
  switch (name) {
    case "abs": case "llabs": case "labs": return a0 instanceof JD ? new JD(Math.abs(a0.v)) : typeof a0 === "number" ? (a0 < 0 ? (-a0) | 0 : a0) : typeof a0 === "bigint" ? (a0 < 0n ? BigInt.asIntN(64, -a0) : a0) : a0;
    case "pow": return new JD(Math.pow(dbl(a0), dbl(a1))); case "atan2": return new JD(Math.atan2(dbl(a0), dbl(a1))); case "hypot": return new JD(Math.hypot(dbl(a0), dbl(a1))); case "fmod": return new JD(dbl(a0) % dbl(a1));
    case "isnan": return Number.isNaN(dbl(a0)); case "isinf": return !Number.isFinite(dbl(a0)) && !Number.isNaN(dbl(a0));
    case "max": case "min": {
      const list = a0 instanceof CInit ? a0.elems : args; let best = list[0];
      for (let i = 1; i < list.length; i++) if (name === "max" ? lt(best, list[i]) : lt(list[i], best)) best = list[i];
      if (args.length === 3 && !(a0 instanceof CInit)) { /* comparator form: max(a,b,cmp) */ }
      return best;
    }
    case "gcd": case "__gcd": { const r = gcdBig(big(a0), big(a1)); return kindOf(a0) === 1 && kindOf(a1) === 1 ? Number(r) : kindOf(a0) === 3 || kindOf(a1) === 3 ? r : mk(Math.max(kindOf(a0), kindOf(a1)), r); }
    case "lcm": { const x = big(a0), y = big(a1); const g = gcdBig(x, y); const r = g === 0n ? 0n : (x / g) * y; return kindOf(a0) === 1 && kindOf(a1) === 1 ? Number(BigInt.asIntN(32, r < 0n ? -r : r)) : r < 0n ? -r : r; }
    case "make_pair": return new CPair(a0, a1);
    case "make_tuple": return new CTuple(args.slice());
    case "to_string": return toStringFn(a0);
    case "stoi": case "stol": case "stoll": case "stoul": case "stoull": { const s = sval(a0).trim(); const m = /^[+-]?\d+/.exec(s); if (!m) fail("stoi: invalid_argument"); const b = BigInt(m[0]); if (name === "stoi" && (b > 2147483647n || b < -2147483648n)) fail("stoi: out_of_range"); return name === "stoi" ? Number(b) : name === "stoul" || name === "stoull" ? U64(b) : b; }
    case "stod": case "stof": { const x = parseFloat(sval(a0)); if (Number.isNaN(x)) fail("stod: invalid_argument"); return new JD(x); }
    case "atoi": { const x = parseInt(sval(a0), 10); return Number.isNaN(x) ? 0 : x | 0; }
    case "isdigit": return /[0-9]/.test(chr(ix(a0))) ? 1 : 0; case "isalpha": return /[A-Za-z]/.test(chr(ix(a0))) ? 1 : 0; case "isalnum": return /[A-Za-z0-9]/.test(chr(ix(a0))) ? 1 : 0;
    case "isupper": return /[A-Z]/.test(chr(ix(a0))) ? 1 : 0; case "islower": return /[a-z]/.test(chr(ix(a0))) ? 1 : 0; case "isspace": return /[ \t\n\r\f\v]/.test(chr(ix(a0))) ? 1 : 0; case "ispunct": return /[!-\/:-@\[-`{-~]/.test(chr(ix(a0))) ? 1 : 0;
    case "toupper": return chr(ix(a0)).toUpperCase().charCodeAt(0) & 0x7f; case "tolower": return chr(ix(a0)).toLowerCase().charCodeAt(0) & 0x7f;
    case "__builtin_popcount": return [...BigInt.asUintN(32, big(a0)).toString(2)].filter((c) => c === "1").length;
    case "__builtin_popcountll": return [...BigInt.asUintN(64, big(a0)).toString(2)].filter((c) => c === "1").length;
    case "__builtin_clz": return Math.clz32(ix(a0)); case "__builtin_ctz": { const x = ix(a0); return x === 0 ? 32 : 31 - Math.clz32(x & -x); }
    case "__lg": return 31 - Math.clz32(ix(a0));
    case "begin": return beginOf(a0); case "end": return endOf(a0); case "size": return sizeVal(lenOf(a0)); case "empty": return lenOf(a0) === 0;
    case "distance": return BigInt(a1.i - a0.i);
    case "next": return new CIter(a0.c, a0.i + (args.length > 1 ? ix(a1) : 1), a0.rev); case "prev": return new CIter(a0.c, a0.i - (args.length > 1 ? ix(a1) : 1), a0.rev);
    case "advance": a0.i += ix(a1); return null;
    case "sort": case "stable_sort": { const r = rangeOps(a0, a1); r.set(r.get().sort(sortFn(args[2]))); return null; }
    case "partial_sort": { const r = rangeOps(a0, args[2]); r.set(r.get().sort(sortFn(args[3]))); return null; }
    case "reverse": { const r = rangeOps(a0, a1); r.set(r.get().reverse()); return null; }
    case "fill": { const r = rangeOps(a0, a1); r.set(Array.from({ length: r.n }, () => copyVal(a2(args)))); return null; }
    case "fill_n": { const r = rangeOps(a0, new CIter(a0.c, a0.i + ix(a1))); r.set(Array.from({ length: r.n }, () => copyVal(args[2]))); return a0; }
    case "iota": { const r = rangeOps(a0, a1); let v = a2(args); const out = []; for (let i = 0; i < r.n; i++) { out.push(v); v = arith("+", v, 1); } r.set(out); return null; }
    case "accumulate": { let acc = args[2]; const t = inferType(acc); for (const x of rangeOps(a0, a1).get()) { acc = args[3] ? call(args[3], [acc, x]) : arith("+", acc, x); if (t) acc = coerce(acc, t); } return acc; }
    case "reduce": { let acc = args.length > 2 ? args[2] : 0; for (const x of rangeOps(a0, a1).get()) acc = arith("+", acc, x); return acc; }
    case "inner_product": { let acc = args[3]; const x = rangeOps(a0, a1).get(), y = rangeOps(args[2], new CIter(args[2].c, args[2].i + x.length)).get(); x.forEach((v, i) => (acc = arith("+", acc, arith("*", v, y[i])))); return acc; }
    case "partial_sum": { const x = rangeOps(a0, a1).get(); let acc = null; const out = x.map((v, i) => (acc = i ? arith("+", acc, v) : v)); const o = args[2]; rangeOps(o, new CIter(o.c, o.i + out.length)).set(out); return new CIter(o.c, o.i + out.length); }
    case "min_element": case "max_element": { const x = rangeOps(a0, a1).get(); if (!x.length) return a1; const less = args[2] ? (p, q) => truthy(call(args[2], [p, q])) : lt; let b = 0; for (let i = 1; i < x.length; i++) if (name === "min_element" ? less(x[i], x[b]) : less(x[b], x[i])) b = i; return new CIter(a0.c, a0.i + b); }
    case "minmax_element": return undefined;
    case "count": return BigInt(rangeOps(a0, a1).get().filter((x) => ceq(x, args[2])).length);
    case "count_if": return BigInt(rangeOps(a0, a1).get().filter((x) => truthy(call(args[2], [x]))).length);
    case "find": { const x = rangeOps(a0, a1).get(); const i = x.findIndex((v) => ceq(v, args[2])); return new CIter(a0.c, i < 0 ? a1.i : a0.i + i); }
    case "find_if": case "find_if_not": { const x = rangeOps(a0, a1).get(); const i = x.findIndex((v) => truthy(call(args[2], [v])) === (name === "find_if")); return new CIter(a0.c, i < 0 ? a1.i : a0.i + i); }
    case "any_of": return rangeOps(a0, a1).get().some((x) => truthy(call(args[2], [x]))); case "all_of": return rangeOps(a0, a1).get().every((x) => truthy(call(args[2], [x]))); case "none_of": return !rangeOps(a0, a1).get().some((x) => truthy(call(args[2], [x])));
    case "for_each": for (const x of rangeOps(a0, a1).get()) call(args[2], [x]); return args[2];
    case "transform": { const x = rangeOps(a0, a1).get(); const out = x.map((v) => call(args[3], [v])); const o = args[2]; rangeOps(o, new CIter(o.c, o.i + out.length)).set(out); return new CIter(o.c, o.i + out.length); }
    case "copy": { const x = rangeOps(a0, a1).get(); const o = args[2]; rangeOps(o, new CIter(o.c, o.i + x.length)).set(x.map(copyVal)); return new CIter(o.c, o.i + x.length); }
    case "lower_bound": case "upper_bound": { const x = rangeOps(a0, a1).get(); const less = args[3] ? (p, q) => truthy(call(args[3], [p, q])) : lt; let lo = 0, hi = x.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (name === "lower_bound" ? less(x[mid], args[2]) : !less(args[2], x[mid])) lo = mid + 1; else hi = mid; } return new CIter(a0.c, a0.i + lo); }
    case "binary_search": { const x = rangeOps(a0, a1).get(); let lo = 0, hi = x.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (lt(x[mid], args[2])) lo = mid + 1; else hi = mid; } return lo < x.length && !lt(args[2], x[lo]); }
    case "unique": { const r = rangeOps(a0, a1), x = r.get(); const same = args[2] ? (p, q) => truthy(call(args[2], [p, q])) : ceq; if (!x.length) return a1; const out = [x[0]]; for (let i = 1; i < x.length; i++) if (!same(out[out.length - 1], x[i])) out.push(x[i]); r.set(out); return new CIter(a0.c, a0.i + out.length); }
    case "remove": case "remove_if": { const r = rangeOps(a0, a1), x = r.get(); const out = x.filter((v) => !(name === "remove" ? ceq(v, args[2]) : truthy(call(args[2], [v])))); r.set(out); return new CIter(a0.c, a0.i + out.length); }
    case "rotate": { const r = rangeOps(a0, args[2]), x = r.get(); const k = a1.i - a0.i; r.set(x.slice(k).concat(x.slice(0, k))); return new CIter(a0.c, a0.i + x.length - k); }
    case "swap_ranges": return undefined;
    case "next_permutation": case "prev_permutation": {
      const r = rangeOps(a0, a1), x = r.get(), nx = name === "next_permutation"; let i = x.length - 2;
      while (i >= 0 && !(nx ? lt(x[i], x[i + 1]) : lt(x[i + 1], x[i]))) i--;
      if (i < 0) { r.set(x.reverse()); return false; }
      let j = x.length - 1; while (!(nx ? lt(x[i], x[j]) : lt(x[j], x[i]))) j--;
      [x[i], x[j]] = [x[j], x[i]]; r.set(x.slice(0, i + 1).concat(x.slice(i + 1).reverse())); return true;
    }
    case "equal": { const x = rangeOps(a0, a1).get(), y = rangeOps(args[2], new CIter(args[2].c, args[2].i + x.length)).get(); return x.every((v, i) => ceq(v, y[i])); }
    case "is_sorted": { const x = rangeOps(a0, a1).get(); return x.every((v, i) => !i || !lt(v, x[i - 1])); }
    case "memset": { const fill = (c, v) => { for (let i = 0; i < c.a.length; i++) { if (c.a[i] instanceof CVec) fill(c.a[i], v); else c.a[i] = coerce(v === 0 ? 0 : v === -1 ? -1 : v, c.t?.args?.[0] || inferType(c.a[i])); } }; const target = a0 instanceof CIter ? a0.c : a0; const b = ix(a1); if (!(target instanceof CVec)) fail("memset: unsupported target"); if (b !== 0 && b !== -1) fail("memset: only 0 and -1 are supported by the tracer"); fill(target, b); return a0; }
    case "swap": return undefined;
    case "exit": case "abort": fail("Program called exit()");
    case "assert": if (!truthy(a0)) fail("Assertion failed"); return null;
    case "get": return undefined;
    case "setprecision": return new CManip("precision", ix(a0)); case "setw": return new CManip("setw", ix(a0)); case "setfill": return new CManip("setfill", a0);
    case "printf": hooks.out(formatC(sval(a0), args.slice(1))); return 0;
    case "puts": hooks.out(sval(a0) + "\n"); return 0; case "putchar": hooks.out(chr(ix(a0))); return ix(a0);
    case "rand": return Math.floor(Math.random() * 2147483647); case "srand": return null; case "clock": return 0n; case "time": return 0n;
  }
  return undefined;
}
const a2 = (args) => args[2];
export function tupleGet(t, n) { if (t instanceof CPair) return n === 0 ? t.first : t.second; if (t instanceof CTuple) return t.a[n]; fail("get<N> needs a pair or tuple"); }
export function iterItems(v) { // for range-for: returns an array of items (values or entries)
  if (v instanceof CVec) return v.a; if (v instanceof CStr) return [...v.s].map((c) => new JC(c.charCodeAt(0)));
  if (v instanceof CMap) return v.isSet ? v.ents.map((e) => e.first) : v.ents; if (v instanceof CInit) return v.elems;
  if (typeof v === "string") return [...v].map((c) => new JC(c.charCodeAt(0)));
  fail("This value can't be iterated in a range-for");
}
