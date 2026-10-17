// Java runtime values and a standard-library subset (String, StringBuilder, Math, boxed types,
// ArrayList/LinkedList/Deque/Stack, HashMap/TreeMap/LinkedHashMap, HashSet/TreeSet, PriorityQueue, Arrays, Collections).
// Value model: int/short/byte = JS number, long = BigInt, double = JD, char = JC, boolean/String = JS primitives.

export class JD { constructor(v) { this.v = v; } }
export class JC { constructor(c) { this.c = c; } }
export class JArr { constructor(a, et, dims) { this.a = a; this.et = et; this.dims = dims; } }
export class JList { constructor(kind, a = []) { this.kind = kind; this.a = a; } }
export class JMap { constructor(kind, cmp = null) { this.kind = kind; this.m = new Map(); this.seq = 0; this.cmp = cmp; } }
export class JSet { constructor(kind, cmp = null) { this.kind = kind; this.m = new Map(); this.seq = 0; this.cmp = cmp; } }
export class JPQ { constructor(cmp = null) { this.a = []; this.cmp = cmp; } }
export class JSB { constructor(s = "") { this.s = s; } }
export class JEntry { constructor(k, v, owner) { this.k = k; this.v = v; this.owner = owner; } }
export class JObj { constructor(cls) { this.cls = cls; this.f = {}; } }
export class JEx { constructor(name, message = null, cause = null) { this.name = name; this.message = message; this.cause = cause; } }
export class JLambda { constructor(params, body, scope, thisObj, cls, native = null) { Object.assign(this, { params, body, scope, thisObj, cls, native }); } }
export class JavaThrow { constructor(value, line) { this.value = value; this.line = line; } }

export const hooks = { callFn: null, userToString: null, userEquals: null, userHash: null };

const EX_PARENT = { Throwable: null, Exception: "Throwable", Error: "Throwable", RuntimeException: "Exception", IOException: "Exception", InterruptedException: "Exception",
  IllegalArgumentException: "RuntimeException", NumberFormatException: "IllegalArgumentException", IllegalStateException: "RuntimeException",
  ArithmeticException: "RuntimeException", NullPointerException: "RuntimeException", IndexOutOfBoundsException: "RuntimeException",
  ArrayIndexOutOfBoundsException: "IndexOutOfBoundsException", StringIndexOutOfBoundsException: "IndexOutOfBoundsException",
  ClassCastException: "RuntimeException", UnsupportedOperationException: "RuntimeException", NoSuchElementException: "RuntimeException",
  EmptyStackException: "RuntimeException", ConcurrentModificationException: "RuntimeException", NegativeArraySizeException: "RuntimeException",
  InputMismatchException: "NoSuchElementException", StackOverflowError: "Error", OutOfMemoryError: "Error" };
export const isExceptionName = (n) => n in EX_PARENT;
export function exInherits(name, ancestor) { for (let n = name; n; n = EX_PARENT[n]) if (n === ancestor) return true; return false; }
export const jthrow = (name, msg = null) => { throw new JavaThrow(new JEx(name, msg), 0); };

// ---------------------------------------------------------------- numbers
export const isNum = (x) => typeof x === "number" || typeof x === "bigint" || x instanceof JD || x instanceof JC;
export const toNum = (x) => typeof x === "number" ? x : x instanceof JC ? x.c : x instanceof JD ? x.v : typeof x === "bigint" ? Number(x) : (x === null ? jthrow("NullPointerException", "Cannot unbox null value") : NaN);
export const i32 = (x) => x | 0;
const d2i = (d) => Number.isNaN(d) ? 0 : d >= 2147483647 ? 2147483647 : d <= -2147483648 ? -2147483648 : Math.trunc(d);
const d2l = (d) => Number.isNaN(d) ? 0n : d >= 9.223372036854776e18 ? 2n ** 63n - 1n : d <= -9.223372036854776e18 ? -(2n ** 63n) : BigInt(Math.trunc(d));

export function coerce(v, t) { // assignment/cast conversion to a declared type
  if (!t || t.dims > 0 || v === null || v === undefined) return v;
  switch (t.name) {
    case "int": case "short": case "byte": case "Integer": case "Short": case "Byte":
      return typeof v === "number" ? v : v instanceof JC ? v.c : v instanceof JD ? d2i(v.v) : typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : v;
    case "long": case "Long": return typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : v instanceof JC ? BigInt(v.c) : v instanceof JD ? d2l(v.v) : v;
    case "double": case "float": case "Double": case "Float": return v instanceof JD ? v : isNum(v) ? new JD(typeof v === "bigint" ? Number(v) : toNum(v)) : v;
    case "char": case "Character": return v instanceof JC ? v : typeof v === "number" ? new JC(v & 0xffff) : v;
    default: return v;
  }
}
export function castTo(v, t) { // explicit (T) cast: like coerce, but narrowing is allowed
  if (t.dims === 0 && ["int", "short", "byte"].includes(t.name)) {
    const x = coerce(v, t);
    if (t.name === "short") return (x << 16) >> 16; if (t.name === "byte") return (x << 24) >> 24; return x;
  }
  return coerce(v, t);
}
export function defaultValue(name, dims) {
  if (dims > 0) return null;
  switch (name) { case "int": case "short": case "byte": return 0; case "long": return 0n; case "double": case "float": return new JD(0); case "boolean": return false; case "char": return new JC(0); default: return null; }
}

export function arith(op, a, b) {
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return toStr(a) + toStr(b);
  if (typeof a === "boolean" && typeof b === "boolean") { if (op === "&") return a && b; if (op === "|") return a || b; if (op === "^") return a !== b; }
  if (a === null || b === null || a === undefined || b === undefined) jthrow("NullPointerException", "Cannot unbox null value");
  if (a instanceof JD || b instanceof JD) {
    const x = toNum(a), y = toNum(b);
    switch (op) { case "+": return new JD(x + y); case "-": return new JD(x - y); case "*": return new JD(x * y); case "/": return new JD(x / y); case "%": return new JD(x % y); }
  } else if (typeof a === "bigint" || typeof b === "bigint") {
    const x = typeof a === "bigint" ? a : BigInt(toNum(a)), y = typeof b === "bigint" ? b : BigInt(toNum(b));
    switch (op) {
      case "+": return BigInt.asIntN(64, x + y); case "-": return BigInt.asIntN(64, x - y); case "*": return BigInt.asIntN(64, x * y);
      case "/": if (y === 0n) jthrow("ArithmeticException", "/ by zero"); return BigInt.asIntN(64, x / y);
      case "%": if (y === 0n) jthrow("ArithmeticException", "/ by zero"); return x % y;
      case "&": return x & y; case "|": return x | y; case "^": return x ^ y;
    }
    if (op === "<<" || op === ">>" || op === ">>>") { // shift count is the right operand; result type is the left operand's
      const n = BigInt(toNum(b) & 63); if (typeof a !== "bigint") return shiftInt(op, toNum(a), toNum(b));
      return op === "<<" ? BigInt.asIntN(64, a << n) : op === ">>" ? a >> n : BigInt.asIntN(64, BigInt.asUintN(64, a) >> n);
    }
  } else {
    const x = toNum(a), y = toNum(b);
    switch (op) {
      case "+": return (x + y) | 0; case "-": return (x - y) | 0; case "*": return Math.imul(x, y);
      case "/": if (y === 0) jthrow("ArithmeticException", "/ by zero"); return Math.trunc(x / y) | 0;
      case "%": if (y === 0) jthrow("ArithmeticException", "/ by zero"); return x % y | 0;
      case "&": return x & y; case "|": return x | y; case "^": return x ^ y;
      case "<<": case ">>": case ">>>": return shiftInt(op, x, y);
    }
  }
  throw new Error(`Unsupported operator ${op}`);
}
function shiftInt(op, x, y) { const n = y & 31; return op === "<<" ? x << n : op === ">>" ? x >> n : (x >>> n) | 0; }
export function compareNums(op, a, b) {
  const x = typeof a === "bigint" && typeof b === "bigint" ? a : toNum(a), y = typeof a === "bigint" && typeof b === "bigint" ? b : toNum(b);
  switch (op) { case "<": return x < y; case ">": return x > y; case "<=": return x <= y; case ">=": return x >= y; }
}
export function jeq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (isNum(a) && isNum(b)) return typeof a === "bigint" && typeof b === "bigint" ? a === b : toNum(a) === toNum(b);
  return false; // objects/arrays: identity; strings and booleans were handled by ===
}

export function jdStr(v) {
  if (Number.isNaN(v)) return "NaN"; if (v === Infinity) return "Infinity"; if (v === -Infinity) return "-Infinity";
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return Object.is(v, -0) ? "-0.0" : v.toFixed(1);
  const a = Math.abs(v);
  if (a >= 1e7 || a < 1e-3) { const [m, e] = v.toExponential().split("e"); return (m.includes(".") ? m : m + ".0") + "E" + parseInt(e, 10); }
  return String(v);
}
export function toStr(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (v instanceof JD) return jdStr(v.v);
  if (v instanceof JC) return String.fromCharCode(v.c);
  if (v instanceof JSB) return v.s;
  if (v instanceof JList) return "[" + v.a.map(toStr).join(", ") + "]";
  if (v instanceof JSet) return "[" + orderedKeys(v).map(toStr).join(", ") + "]";
  if (v instanceof JPQ) return "[" + v.a.map(toStr).join(", ") + "]";
  if (v instanceof JMap) return "{" + orderedEntries(v).map((e) => `${toStr(e.k)}=${toStr(e.v)}`).join(", ") + "}";
  if (v instanceof JEntry) return `${toStr(v.k)}=${toStr(v.v)}`;
  if (v instanceof JArr) return `[${v.dims > 1 ? "[" : ""}${{ int: "I", long: "J", double: "D", char: "C", boolean: "Z", byte: "B", short: "S", float: "F" }[v.et] || "L" + v.et + ";"}@1b6d3586`;
  if (v instanceof JEx) return v.message === null ? v.name : `${v.name}: ${v.message}`;
  if (v instanceof JObj) return hooks.userToString ? hooks.userToString(v) : `${v.cls.name}@1b6d3586`;
  if (v instanceof JLambda) return "Main$$Lambda@1b6d3586";
  return String(v);
}

// ---------------------------------------------------------------- hashing / keys / ordering
let idCounter = 0; const ids = new WeakMap();
const objId = (o) => { let i = ids.get(o); if (!i) { i = ++idCounter; ids.set(o, i); } return i; };
export function keyOf(k) {
  if (k === null) return "z"; if (typeof k === "string") return "s" + k; if (typeof k === "number" || typeof k === "bigint") return "n" + k;
  if (typeof k === "boolean") return "b" + k; if (k instanceof JC) return "c" + k.c; if (k instanceof JD) return "d" + k.v;
  if (k instanceof JList) return "l[" + k.a.map(keyOf).join(",") + "]";
  if (k instanceof JArr) return "a" + objId(k);
  if (k instanceof JObj) { const h = hooks.userHash && hooks.userHash(k); if (h !== undefined && h !== null) return "h" + h; }
  return "o" + objId(k);
}
export function hashOf(k) {
  if (typeof k === "number") return k | 0;
  if (typeof k === "bigint") return Number(BigInt.asIntN(32, k ^ (k >> 32n)));
  if (typeof k === "string") { let h = 0; for (let i = 0; i < k.length; i++) h = (Math.imul(31, h) + k.charCodeAt(i)) | 0; return h; }
  if (k instanceof JC) return k.c; if (typeof k === "boolean") return k ? 1231 : 1237;
  if (k instanceof JList) { let h = 1; for (const e of k.a) h = (Math.imul(31, h) + (hashOf(e) ?? 0)) | 0; return h; }
  return null;
}
export function compareValues(a, b) { // natural ordering (Comparable)
  if (isNum(a) && isNum(b)) { const x = typeof a === "bigint" && typeof b === "bigint" ? a : toNum(a), y = typeof a === "bigint" && typeof b === "bigint" ? b : toNum(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === "string" && typeof b === "string") return strCompare(a, b);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (a instanceof JObj && hooks.callFn) { const m = a.cls.findMethod && a.cls.findMethod("compareTo"); if (m) return toNum(hooks.callFn(new JLambda(null, null, null, a, a.cls, (args) => hooks.invokeMethod(m, a, args)), [b])); }
  if (a === null || b === null) jthrow("NullPointerException");
  jthrow("ClassCastException", "class cannot be cast to class java.lang.Comparable");
}
export function strCompare(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) - b.charCodeAt(i); return a.length - b.length; }
const cmpFn = (cmp) => cmp ? (a, b) => toNum(hooks.callFn(cmp, [a, b])) : compareValues;

function hashOrder(entries, size) {
  let cap = 16; while (size > cap * 0.75) cap *= 2;
  const keyed = entries.map((e) => { const h = hashOf(e.k); return { e, idx: h === null ? cap : ((h ^ (h >>> 16)) & (cap - 1)) >>> 0 }; });
  keyed.sort((x, y) => x.idx - y.idx || x.e.seq - y.e.seq);
  return keyed.map((x) => x.e);
}
export function orderedEntries(m) {
  const all = [...m.m.values()];
  if (m.kind === "TreeMap") return all.sort((a, b) => cmpFn(m.cmp)(a.k, b.k));
  if (m.kind === "HashMap" || m.kind === "Map") return hashOrder(all, all.length);
  return all;
}
export function orderedKeys(s) {
  const all = [...s.m.values()];
  if (s.kind === "TreeSet") return all.sort((a, b) => cmpFn(s.cmp)(a.k, b.k)).map((e) => e.k);
  if (s.kind === "HashSet" || s.kind === "Set") return hashOrder(all, all.length).map((e) => e.k);
  return all.map((e) => e.k);
}

// ---------------------------------------------------------------- collections helpers
export function iterate(v) { // for-each source -> JS array
  if (v instanceof JArr || v instanceof JList || v instanceof JPQ) return v.a.slice();
  if (v instanceof JSet) return orderedKeys(v);
  if (v instanceof JMap) return orderedEntries(v).map((e) => new JEntry(e.k, e.v, v));
  if (v === null) jthrow("NullPointerException", "Cannot iterate over null");
  jthrow("ClassCastException", "Value is not iterable");
}
const copyList = (kind, arr) => new JList(kind, arr);
function outOfBounds(i, n, name = "IndexOutOfBoundsException") { jthrow(name, `Index ${i} out of bounds for length ${n}`); }
const idx = (x) => typeof x === "number" ? x : toNum(x);
export const callFn = (f, args) => hooks.callFn(f, args);

function sortWith(arr, cmp) { const f = cmpFn(cmp); return arr.sort(f); }
function heapUp(q, k, x, cmp) { const f = cmpFn(cmp); while (k > 0) { const p = (k - 1) >>> 1, e = q[p]; if (f(x, e) >= 0) break; q[k] = e; k = p; } q[k] = x; }
function heapDown(q, k, x, n, cmp) {
  const f = cmpFn(cmp), half = n >>> 1;
  while (k < half) { let c = 2 * k + 1, o = q[c]; const r = c + 1; if (r < n && f(o, q[r]) > 0) o = q[c = r]; if (f(x, o) <= 0) break; q[k] = o; k = c; }
  q[k] = x;
}

export function newCollection(name, args) {
  const a0 = args[0];
  switch (name) {
    case "ArrayList": case "LinkedList": case "ArrayDeque": case "Stack": case "Vector": case "CopyOnWriteArrayList": {
      const l = new JList(name === "Vector" ? "ArrayList" : name, []);
      if (a0 && typeof a0 === "object" && !(a0 instanceof JLambda)) l.a = iterate(a0);
      return l;
    }
    case "HashMap": case "LinkedHashMap": case "TreeMap": case "ConcurrentHashMap": case "Hashtable": {
      const kind = name === "ConcurrentHashMap" || name === "Hashtable" ? "HashMap" : name;
      const m = new JMap(kind, a0 instanceof JLambda || a0 instanceof JObj ? a0 : null);
      if (a0 instanceof JMap) for (const e of orderedEntries(a0)) mapPut(m, e.k, e.v);
      return m;
    }
    case "HashSet": case "LinkedHashSet": case "TreeSet": {
      const s = new JSet(name, a0 instanceof JLambda || a0 instanceof JObj ? a0 : null);
      if (a0 && typeof a0 === "object" && !(a0 instanceof JLambda) && !(a0 instanceof JObj)) for (const x of iterate(a0)) setAdd(s, x);
      return s;
    }
    case "PriorityQueue": case "PriorityBlockingQueue": {
      const cmp = args.find((x) => x instanceof JLambda || x instanceof JObj) || null, q = new JPQ(cmp);
      const src = args.find((x) => x instanceof JList || x instanceof JSet || x instanceof JPQ);
      if (src) for (const x of iterate(src)) pqOffer(q, x);
      return q;
    }
    case "StringBuilder": case "StringBuffer": return new JSB(typeof a0 === "string" ? a0 : a0 instanceof JSB ? a0.s : "");
    case "Object": return new JObj({ name: "Object" });
    case "String": return a0 instanceof JArr ? new String(a0.a.map(toStr).join("")).toString() : typeof a0 === "string" ? a0 : "";
    case "int": return 0;
    case "Integer": case "Long": case "Double": return a0;
    case "Random": case "Scanner": jthrow("UnsupportedOperationException", `${name} is not supported by the tracer`);
  }
  return undefined;
}
export const mapPut = (m, k, v) => { const key = keyOf(k), e = m.m.get(key); if (e) { const old = e.v; e.v = v; return old; } m.m.set(key, { k, v, seq: m.seq++ }); return null; };
export const mapGet = (m, k) => { const e = m.m.get(keyOf(k)); return e ? e.v : null; };
export const setAdd = (s, k) => { const key = keyOf(k); if (s.m.has(key)) return false; s.m.set(key, { k, seq: s.seq++ }); return true; };
export const pqOffer = (q, x) => { if (x === null) jthrow("NullPointerException"); q.a.push(x); heapUp(q.a, q.a.length - 1, x, q.cmp); return true; };
export function pqPoll(q) {
  if (!q.a.length) return null; const res = q.a[0], last = q.a.pop();
  if (q.a.length) heapDown(q.a, 0, last, q.a.length, q.cmp);
  return res;
}
function sortedKeys(c) { return c instanceof JSet ? orderedKeys(c) : orderedEntries(c).map((e) => e.k); }
function navigate(c, kind, key) { // floor/ceiling/lower/higher on TreeMap/TreeSet; returns key or null
  const f = cmpFn(c.cmp), keys = sortedKeys(c);
  switch (kind) {
    case "floor": return [...keys].reverse().find((k) => f(k, key) <= 0) ?? null;
    case "lower": return [...keys].reverse().find((k) => f(k, key) < 0) ?? null;
    case "ceiling": return keys.find((k) => f(k, key) >= 0) ?? null;
    case "higher": return keys.find((k) => f(k, key) > 0) ?? null;
  }
}

// ---------------------------------------------------------------- instance methods
const stackLike = (l) => l.kind === "Stack";
function listMethod(l, name, args, node) {
  const a = l.a, [x, y] = args;
  const noElem = () => jthrow(l.kind === "Stack" ? "EmptyStackException" : "NoSuchElementException");
  switch (name) {
    case "add": case "addLast": case "offer": case "offerLast": case "addElement":
      if (name === "add" && args.length === 2) { const i = idx(x); if (i < 0 || i > a.length) outOfBounds(i, a.length); a.splice(i, 0, y); return null; }
      a.push(x); return name === "addLast" ? null : true;
    case "addFirst": case "offerFirst": a.unshift(x); return name === "addFirst" ? null : true;
    case "push": if (stackLike(l)) { a.push(x); return x; } a.unshift(x); return null;
    case "pop": if (!a.length) noElem(); return stackLike(l) ? a.pop() : a.shift();
    case "peek": if (stackLike(l)) { if (!a.length) noElem(); return a[a.length - 1]; } return a.length ? a[0] : null;
    case "empty": case "isEmpty": return a.length === 0;
    case "size": return a.length;
    case "get": case "elementAt": { const i = idx(x); if (i < 0 || i >= a.length) outOfBounds(i, a.length); return a[i]; }
    case "set": { const i = idx(x); if (i < 0 || i >= a.length) outOfBounds(i, a.length); const old = a[i]; a[i] = y; return old; }
    case "getFirst": case "element": case "firstElement": if (!a.length) noElem(); return a[0];
    case "getLast": case "lastElement": if (!a.length) noElem(); return a[a.length - 1];
    case "peekFirst": return a.length ? a[0] : null;
    case "peekLast": return a.length ? a[a.length - 1] : null;
    case "poll": case "pollFirst": return a.length ? a.shift() : null;
    case "pollLast": return a.length ? a.pop() : null;
    case "removeFirst": if (!a.length) noElem(); return a.shift();
    case "removeLast": if (!a.length) noElem(); return a.pop();
    case "remove": {
      if (args.length === 0) { if (!a.length) noElem(); return a.shift(); }
      if (typeof x === "number" && !node?.removeObject && l.kind !== "ArrayDeque") { if (x < 0 || x >= a.length) outOfBounds(x, a.length); return a.splice(x, 1)[0]; }
      const i = a.findIndex((e) => equalsObj(e, x)); if (i < 0) return false; a.splice(i, 1); return true;
    }
    case "contains": return a.some((e) => equalsObj(e, x));
    case "indexOf": return a.findIndex((e) => equalsObj(e, x));
    case "lastIndexOf": { for (let i = a.length - 1; i >= 0; i--) if (equalsObj(a[i], x)) return i; return -1; }
    case "clear": a.length = 0; return null;
    case "addAll": if (args.length === 2) { a.splice(idx(x), 0, ...iterate(y)); return true; } { const items = iterate(x); a.push(...items); return items.length > 0; }
    case "removeAll": { const rm = iterate(x); const before = a.length; l.a = a.filter((e) => !rm.some((r) => equalsObj(r, e))); return l.a.length !== before; }
    case "retainAll": { const keep = iterate(x); const before = a.length; l.a = a.filter((e) => keep.some((r) => equalsObj(r, e))); return l.a.length !== before; }
    case "containsAll": return iterate(x).every((r) => a.some((e) => equalsObj(e, r)));
    case "removeIf": { const before = a.length; l.a = a.filter((e) => !callFn(x, [e])); return l.a.length !== before; }
    case "sort": sortWith(a, x); return null;
    case "forEach": for (const e of a.slice()) callFn(x, [e]); return null;
    case "subList": { const from = idx(x), to = idx(y); if (from < 0 || to > a.length || from > to) outOfBounds(from < 0 ? from : to, a.length); return copyList("ArrayList", a.slice(from, to)); }
    case "toArray": return new JArr(a.slice(), "Object", 1);
    case "reversed": return copyList(l.kind, a.slice().reverse());
    case "equals": return x instanceof JList && x.a.length === a.length && a.every((e, i) => equalsObj(e, x.a[i]));
    case "hashCode": return hashOf(l) ?? 0;
    case "toString": return toStr(l);
    case "iterator": case "listIterator": return copyList("ArrayList", a.slice());
    case "descendingIterator": return copyList("ArrayList", a.slice().reverse());
    case "search": { for (let i = a.length - 1; i >= 0; i--) if (equalsObj(a[i], x)) return a.length - i; return -1; }
    case "stream": case "parallelStream": jthrow("UnsupportedOperationException", "Streams are not supported by the tracer");
  }
  return undefined;
}
export function equalsObj(a, b) {
  if (a === b) return true; if (a === null || b === null) return false;
  if (isNum(a) && isNum(b)) return (typeof a === "bigint") === (typeof b === "bigint") || a instanceof JD === b instanceof JD ? toNum(a) === toNum(b) : false;
  if (a instanceof JList && b instanceof JList) return a.a.length === b.a.length && a.a.every((e, i) => equalsObj(e, b.a[i]));
  if (a instanceof JObj && hooks.userEquals) { const r = hooks.userEquals(a, b); if (r !== undefined) return r; }
  if ((a instanceof JSet && b instanceof JSet) || (a instanceof JMap && b instanceof JMap)) return a.m.size === b.m.size && [...a.m.keys()].every((k) => b.m.has(k));
  return false;
}
function mapMethod(m, name, args, node) {
  const [x, y] = args;
  switch (name) {
    case "put": return mapPut(m, x, y);
    case "get": return mapGet(m, x);
    case "getOrDefault": { const e = m.m.get(keyOf(x)); return e ? e.v : y; }
    case "containsKey": return m.m.has(keyOf(x));
    case "containsValue": return [...m.m.values()].some((e) => equalsObj(e.v, x));
    case "remove": { const key = keyOf(x), e = m.m.get(key); if (!e) return null; m.m.delete(key); return e.v; }
    case "size": return m.m.size;
    case "isEmpty": return m.m.size === 0;
    case "clear": m.m.clear(); return null;
    case "putIfAbsent": { const e = m.m.get(keyOf(x)); if (e && e.v !== null) return e.v; mapPut(m, x, y); return null; }
    case "putAll": for (const e of orderedEntries(x)) mapPut(m, e.k, e.v); return null;
    case "computeIfAbsent": { const e = m.m.get(keyOf(x)); if (e && e.v !== null) return e.v; const v = callFn(y, [x]); if (v !== null) mapPut(m, x, v); return v; }
    case "computeIfPresent": { const e = m.m.get(keyOf(x)); if (!e || e.v === null) return null; const v = callFn(y, [x, e.v]); if (v === null) m.m.delete(keyOf(x)); else e.v = v; return v; }
    case "compute": { const e = m.m.get(keyOf(x)); const v = callFn(y, [x, e ? e.v : null]); if (v === null) m.m.delete(keyOf(x)); else mapPut(m, x, v); return v; }
    case "merge": { const e = m.m.get(keyOf(x)); const v = e && e.v !== null ? callFn(args[2], [e.v, y]) : y; if (v === null) m.m.delete(keyOf(x)); else mapPut(m, x, v); return v; }
    case "keySet": case "navigableKeySet": { const s = new JSet(m.kind === "TreeMap" ? "TreeSet" : "LinkedHashSet", m.cmp); for (const e of orderedEntries(m)) setAdd(s, e.k); return s; }
    case "values": return copyList("ArrayList", orderedEntries(m).map((e) => e.v));
    case "entrySet": return copyList("ArrayList", orderedEntries(m).map((e) => new JEntry(e.k, e.v, m)));
    case "forEach": for (const e of orderedEntries(m)) callFn(x, [e.k, e.v]); return null;
    case "firstKey": case "lastKey": { const es = orderedEntries(m); if (!es.length) jthrow("NoSuchElementException"); return es[name === "firstKey" ? 0 : es.length - 1].k; }
    case "firstEntry": case "lastEntry": { const es = orderedEntries(m); if (!es.length) return null; const e = es[name === "firstEntry" ? 0 : es.length - 1]; return new JEntry(e.k, e.v, m); }
    case "pollFirstEntry": case "pollLastEntry": { const es = orderedEntries(m); if (!es.length) return null; const e = es[name === "pollFirstEntry" ? 0 : es.length - 1]; m.m.delete(keyOf(e.k)); return new JEntry(e.k, e.v, null); }
    case "floorKey": case "ceilingKey": case "lowerKey": case "higherKey": return navigate(m, name.slice(0, -3), x);
    case "floorEntry": case "ceilingEntry": case "lowerEntry": case "higherEntry": { const k = navigate(m, name.slice(0, -5), x); return k === null ? null : new JEntry(k, mapGet(m, k), m); }
    case "equals": return x instanceof JMap && x.m.size === m.m.size && [...m.m].every(([k, e]) => x.m.has(k) && equalsObj(x.m.get(k).v, e.v));
    case "toString": return toStr(m);
    case "hashCode": return 0;
  }
  return undefined;
}
function setMethod(s, name, args) {
  const [x] = args;
  switch (name) {
    case "add": return setAdd(s, x);
    case "contains": return s.m.has(keyOf(x));
    case "remove": return s.m.delete(keyOf(x));
    case "size": return s.m.size;
    case "isEmpty": return s.m.size === 0;
    case "clear": s.m.clear(); return null;
    case "addAll": { let ch = false; for (const e of iterate(x)) ch = setAdd(s, e) || ch; return ch; }
    case "removeAll": { let ch = false; for (const e of iterate(x)) ch = s.m.delete(keyOf(e)) || ch; return ch; }
    case "retainAll": { const keep = new Set(iterate(x).map(keyOf)); let ch = false; for (const k of [...s.m.keys()]) if (!keep.has(k)) { s.m.delete(k); ch = true; } return ch; }
    case "containsAll": return iterate(x).every((e) => s.m.has(keyOf(e)));
    case "forEach": for (const e of orderedKeys(s)) callFn(x, [e]); return null;
    case "first": case "last": { const ks = orderedKeys(s); if (!ks.length) jthrow("NoSuchElementException"); return ks[name === "first" ? 0 : ks.length - 1]; }
    case "pollFirst": case "pollLast": { const ks = orderedKeys(s); if (!ks.length) return null; const k = ks[name === "pollFirst" ? 0 : ks.length - 1]; s.m.delete(keyOf(k)); return k; }
    case "floor": case "ceiling": case "lower": case "higher": return navigate(s, name, x);
    case "removeIf": { let ch = false; for (const k of orderedKeys(s)) if (callFn(x, [k])) { s.m.delete(keyOf(k)); ch = true; } return ch; }
    case "toArray": return new JArr(orderedKeys(s), "Object", 1);
    case "iterator": return copyList("ArrayList", orderedKeys(s));
    case "equals": return x instanceof JSet && x.m.size === s.m.size && [...s.m.keys()].every((k) => x.m.has(k));
    case "toString": return toStr(s);
    case "hashCode": return 0;
    case "stream": jthrow("UnsupportedOperationException", "Streams are not supported by the tracer");
  }
  return undefined;
}
function pqMethod(q, name, args) {
  const [x] = args;
  switch (name) {
    case "add": case "offer": return pqOffer(q, x);
    case "poll": return pqPoll(q);
    case "remove": if (args.length === 0) { if (!q.a.length) jthrow("NoSuchElementException"); return pqPoll(q); } { const i = q.a.findIndex((e) => equalsObj(e, x)); if (i < 0) return false; const all = q.a.filter((_, j) => j !== i); q.a = []; for (const e of all) pqOffer(q, e); return true; }
    case "peek": return q.a.length ? q.a[0] : null;
    case "element": if (!q.a.length) jthrow("NoSuchElementException"); return q.a[0];
    case "size": return q.a.length;
    case "isEmpty": return q.a.length === 0;
    case "clear": q.a.length = 0; return null;
    case "contains": return q.a.some((e) => equalsObj(e, x));
    case "addAll": for (const e of iterate(x)) pqOffer(q, e); return true;
    case "toString": return toStr(q);
    case "iterator": return copyList("ArrayList", q.a.slice());
  }
  return undefined;
}
function stringMethod(s, name, args) {
  const [x, y] = args;
  const sioobe = (msg) => jthrow("StringIndexOutOfBoundsException", msg);
  switch (name) {
    case "length": return s.length;
    case "charAt": { const i = idx(x); if (i < 0 || i >= s.length) sioobe(`Index ${i} out of bounds for length ${s.length}`); return new JC(s.charCodeAt(i)); }
    case "isEmpty": return s.length === 0;
    case "isBlank": return s.trim().length === 0;
    case "substring": case "subSequence": { const a = idx(x), b = args.length > 1 ? idx(y) : s.length; if (a < 0 || b > s.length || a > b) sioobe(`begin ${a}, end ${b}, length ${s.length}`); return s.slice(a, b); }
    case "indexOf": return s.indexOf(toStr(x), args.length > 1 ? idx(y) : 0);
    case "lastIndexOf": return s.lastIndexOf(toStr(x));
    case "contains": return s.includes(toStr(x));
    case "startsWith": return s.startsWith(toStr(x), args.length > 1 ? idx(y) : 0);
    case "endsWith": return s.endsWith(toStr(x));
    case "equals": return typeof x === "string" && s === x;
    case "equalsIgnoreCase": return typeof x === "string" && s.toLowerCase() === x.toLowerCase();
    case "compareTo": return strCompare(s, x);
    case "compareToIgnoreCase": return strCompare(s.toLowerCase(), x.toLowerCase());
    case "toCharArray": return new JArr([...s].map((c) => new JC(c.charCodeAt(0))), "char", 1);
    case "toLowerCase": return s.toLowerCase();
    case "toUpperCase": return s.toUpperCase();
    case "trim": case "strip": return s.trim();
    case "concat": return s + x;
    case "repeat": return s.repeat(Math.max(0, idx(x)));
    case "replace": return s.split(toStr(x)).join(toStr(y));
    case "replaceAll": return s.replace(new RegExp(x, "g"), toStr(y).replace(/\$(\d)/g, "$$$1"));
    case "matches": return new RegExp("^(?:" + x + ")$").test(s);
    case "split": { let parts = s.split(new RegExp(x)); if (parts.length > 1 && parts[0] === "" && s.length > 0 && new RegExp("^(?:" + x + ")").exec(s)?.[0] === "") parts.shift(); while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); return new JArr(parts, "String", 1); }
    case "hashCode": return hashOf(s);
    case "toString": case "intern": return s;
    case "chars": jthrow("UnsupportedOperationException", "Streams are not supported by the tracer");
  }
  return undefined;
}
function sbMethod(sb, name, args) {
  const [x, y, z] = args;
  switch (name) {
    case "append": sb.s += toStr(x); return sb;
    case "toString": return sb.s;
    case "length": return sb.s.length;
    case "isEmpty": return sb.s.length === 0;
    case "charAt": { const i = idx(x); if (i < 0 || i >= sb.s.length) jthrow("StringIndexOutOfBoundsException", `index ${i},length ${sb.s.length}`); return new JC(sb.s.charCodeAt(i)); }
    case "reverse": sb.s = [...sb.s].reverse().join(""); return sb;
    case "insert": { const i = idx(x); if (i < 0 || i > sb.s.length) jthrow("StringIndexOutOfBoundsException", `offset ${i}, length ${sb.s.length}`); sb.s = sb.s.slice(0, i) + toStr(y) + sb.s.slice(i); return sb; }
    case "deleteCharAt": { const i = idx(x); if (i < 0 || i >= sb.s.length) jthrow("StringIndexOutOfBoundsException", `index ${i},length ${sb.s.length}`); sb.s = sb.s.slice(0, i) + sb.s.slice(i + 1); return sb; }
    case "delete": sb.s = sb.s.slice(0, idx(x)) + sb.s.slice(Math.min(idx(y), sb.s.length)); return sb;
    case "replace": sb.s = sb.s.slice(0, idx(x)) + toStr(z) + sb.s.slice(Math.min(idx(y), sb.s.length)); return sb;
    case "setCharAt": { const i = idx(x); if (i < 0 || i >= sb.s.length) jthrow("StringIndexOutOfBoundsException", `index ${i},length ${sb.s.length}`); sb.s = sb.s.slice(0, i) + toStr(y) + sb.s.slice(i + 1); return null; }
    case "setLength": { const n = idx(x); sb.s = n <= sb.s.length ? sb.s.slice(0, n) : sb.s + "\0".repeat(n - sb.s.length); return null; }
    case "indexOf": return sb.s.indexOf(toStr(x)); case "lastIndexOf": return sb.s.lastIndexOf(toStr(x));
    case "substring": return stringMethod(sb.s, "substring", args);
    case "equals": return sb === x; case "hashCode": return 0;
    case "compareTo": return strCompare(sb.s, toStr(x));
    case "chars": jthrow("UnsupportedOperationException", "Streams are not supported by the tracer");
  }
  return undefined;
}
function lambdaMethod(f, name, args) {
  const [x] = args;
  const compose = (g) => new JLambda(null, null, null, null, null, (a) => g(a));
  switch (name) {
    case "reversed": return compose(([a, b]) => callFn(f, [b, a]));
    case "thenComparing": case "thenComparingInt": case "thenComparingLong": case "thenComparingDouble": {
      const second = args.length === 1 && x instanceof JLambda && (x.native?.arity === 2 || (x.params && x.params.length === 2)) ? x : null;
      return compose(([a, b]) => { const r = toNum(callFn(f, [a, b])); if (r !== 0) return r; return second ? callFn(second, [a, b]) : compareValues(callFn(x, [a]), callFn(x, [b])); });
    }
    case "negate": return compose((a) => !callFn(f, a));
    case "and": return compose((a) => callFn(f, a) && callFn(x, a));
    case "or": return compose((a) => callFn(f, a) || callFn(x, a));
    case "equals": return f === x;
    default: return callFn(f, args); // apply/test/accept/get/compare/run/applyAsInt/...
  }
}
function entryMethod(e, name, args) {
  switch (name) {
    case "getKey": return e.k; case "getValue": return e.v;
    case "setValue": { const old = e.v; e.v = args[0]; if (e.owner) mapPut(e.owner, e.k, args[0]); return old; }
    case "toString": return toStr(e); case "equals": return args[0] instanceof JEntry && equalsObj(e.k, args[0].k) && equalsObj(e.v, args[0].v);
  }
  return undefined;
}
export function callBuiltinMethod(recv, name, args, node) {
  if (typeof recv === "string") return stringMethod(recv, name, args);
  if (recv instanceof JList) return listMethod(recv, name, args, node);
  if (recv instanceof JMap) return mapMethod(recv, name, args, node);
  if (recv instanceof JSet) return setMethod(recv, name, args);
  if (recv instanceof JPQ) return pqMethod(recv, name, args);
  if (recv instanceof JSB) return sbMethod(recv, name, args);
  if (recv instanceof JEntry) return entryMethod(recv, name, args);
  if (recv instanceof JLambda) return lambdaMethod(recv, name, args);
  if (recv instanceof JArr) { if (name === "clone") return new JArr(recv.a.slice(), recv.et, recv.dims); if (name === "length") return recv.a.length; if (name === "equals") return recv === args[0]; if (name === "hashCode") return 0; }
  if (recv instanceof JEx) {
    if (name === "getMessage" || name === "getLocalizedMessage") return recv.message; if (name === "toString") return toStr(recv);
    if (name === "printStackTrace") return null; if (name === "getCause") return recv.cause;
  }
  if (recv instanceof JC) { if (name === "equals") return args[0] instanceof JC && args[0].c === recv.c; if (name === "charValue") return recv; if (name === "toString") return toStr(recv); if (name === "compareTo") return recv.c - toNum(args[0]); if (name === "hashCode") return recv.c; }
  if (typeof recv === "number" || typeof recv === "bigint" || recv instanceof JD) {
    switch (name) {
      case "equals": return equalsObj(recv, args[0]); case "intValue": return coerce(recv, { name: "int", dims: 0 }); case "longValue": return coerce(recv, { name: "long", dims: 0 });
      case "doubleValue": return coerce(recv, { name: "double", dims: 0 }); case "compareTo": return compareValues(recv, args[0]); case "toString": return toStr(recv); case "hashCode": return hashOf(recv) ?? 0;
    }
  }
  if (typeof recv === "boolean") { if (name === "equals") return recv === args[0]; if (name === "toString") return String(recv); if (name === "booleanValue") return recv; }
  return undefined;
}

// ---------------------------------------------------------------- static methods
const I = { name: "int", dims: 0 };
const lng = (x) => coerce(x, { name: "long", dims: 0 });
function arithmeticExact(op, a, b) {
  if (typeof a === "bigint" || typeof b === "bigint") { const r = op === "+" ? lng(a) + lng(b) : op === "-" ? lng(a) - lng(b) : lng(a) * lng(b); if (BigInt.asIntN(64, r) !== r) jthrow("ArithmeticException", "long overflow"); return r; }
  const r = op === "+" ? a + b : op === "-" ? a - b : a * b;
  if (r > 2147483647 || r < -2147483648) jthrow("ArithmeticException", "integer overflow"); return r;
}
function numMinMax(isMax, a, b) {
  if (a instanceof JD || b instanceof JD) { const x = toNum(a), y = toNum(b); return new JD(isMax ? Math.max(x, y) : Math.min(x, y)); }
  if (typeof a === "bigint" || typeof b === "bigint") { const x = lng(a), y = lng(b); return isMax ? (x > y ? x : y) : (x < y ? x : y); }
  const x = toNum(a), y = toNum(b); return isMax ? Math.max(x, y) : Math.min(x, y);
}
function formatJava(fmt, args) {
  let i = 0;
  return fmt.replace(/%(-?)(0?)(\d*)(?:\.(\d+))?([dsfcbxXn%])/g, (m, left, zero, width, prec, conv) => {
    if (conv === "%") return "%"; if (conv === "n") return "\n";
    const v = args[i++]; let s;
    switch (conv) { case "d": s = String(typeof v === "bigint" ? v : toNum(v)); break; case "f": s = toNum(v).toFixed(prec === undefined ? 6 : Number(prec)); break;
      case "x": s = (toNum(v) >>> 0).toString(16); break; case "X": s = (toNum(v) >>> 0).toString(16).toUpperCase(); break; case "c": s = toStr(v); break; default: s = toStr(v); if (prec !== undefined) s = s.slice(0, Number(prec)); }
    if (width) { const w = Number(width); s = left ? s.padEnd(w) : s.padStart(w, zero && conv !== "s" ? "0" : " "); }
    return s;
  });
}
const lambdaN = (fn, arity = 1) => { const l = new JLambda(null, null, null, null, null, fn); l.native.arity = arity; return fn.arity = arity, l; };
function parseIntStrict(s, radix = 10) {
  if (typeof s !== "string") jthrow("NumberFormatException", `Cannot parse null string: null`);
  const ok = radix === 10 ? /^[+-]?\d+$/.test(s) : s !== "" && !Number.isNaN(parseInt(s, radix));
  const v = ok ? parseInt(s, radix) : NaN;
  if (!ok || v > 2147483647 || v < -2147483648) jthrow("NumberFormatException", `For input string: "${s}"${radix !== 10 ? ` under radix ${radix}` : ""}`);
  return v;
}
export function callStaticBuiltin(cls, name, args, ctx) {
  const [x, y, z] = args;
  switch (cls) {
    case "Math": case "StrictMath":
      switch (name) {
        case "abs": return x instanceof JD ? new JD(Math.abs(x.v)) : typeof x === "bigint" ? (x < 0n ? -x : x) : Math.abs(toNum(x)) | 0;
        case "max": return numMinMax(true, x, y); case "min": return numMinMax(false, x, y);
        case "pow": return new JD(Math.pow(toNum(x), toNum(y))); case "sqrt": return new JD(Math.sqrt(toNum(x))); case "cbrt": return new JD(Math.cbrt(toNum(x)));
        case "floor": return new JD(Math.floor(toNum(x))); case "ceil": return new JD(Math.ceil(toNum(x))); case "rint": return new JD(Math.round(toNum(x)));
        case "round": return x instanceof JD ? d2l(Math.floor(x.v + 0.5)) : Math.round(toNum(x));
        case "random": return new JD(Math.random()); case "log": return new JD(Math.log(toNum(x))); case "log10": return new JD(Math.log10(toNum(x))); case "exp": return new JD(Math.exp(toNum(x)));
        case "sin": case "cos": case "tan": case "atan": case "asin": case "acos": return new JD(Math[name](toNum(x))); case "atan2": return new JD(Math.atan2(toNum(x), toNum(y)));
        case "hypot": return new JD(Math.hypot(toNum(x), toNum(y))); case "signum": return new JD(Math.sign(toNum(x)));
        case "floorDiv": case "floorMod": {
          if (typeof x === "bigint" || typeof y === "bigint") { const a = lng(x), b = lng(y); if (b === 0n) jthrow("ArithmeticException", "/ by zero"); let q = a / b; if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; return name === "floorDiv" ? q : a - q * b; }
          const a = toNum(x), b = toNum(y); if (b === 0) jthrow("ArithmeticException", "/ by zero"); const q = Math.floor(a / b); return name === "floorDiv" ? q | 0 : (a - q * b) | 0;
        }
        case "addExact": return arithmeticExact("+", x, y); case "subtractExact": return arithmeticExact("-", x, y); case "multiplyExact": return arithmeticExact("*", x, y);
        case "toIntExact": { const v = Number(x); if (v > 2147483647 || v < -2147483648) jthrow("ArithmeticException", "integer overflow"); return v; }
        case "PI": return new JD(Math.PI); case "E": return new JD(Math.E);
      } break;
    case "Integer": case "Short": case "Byte":
      switch (name) {
        case "parseInt": case "valueOf": return typeof x === "string" ? parseIntStrict(x, args.length > 1 ? toNum(y) : 10) : coerce(x, I);
        case "toString": return args.length > 1 ? toNum(x).toString(toNum(y)) : String(toNum(x));
        case "compare": return Math.sign(toNum(x) - toNum(y)); case "max": return Math.max(toNum(x), toNum(y)); case "min": return Math.min(toNum(x), toNum(y)); case "sum": return (toNum(x) + toNum(y)) | 0;
        case "signum": return Math.sign(toNum(x)); case "abs": return Math.abs(toNum(x)) | 0; case "hashCode": return toNum(x);
        case "bitCount": { let v = toNum(x) >>> 0, c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }
        case "toBinaryString": return (toNum(x) >>> 0).toString(2); case "toHexString": return (toNum(x) >>> 0).toString(16);
        case "numberOfTrailingZeros": { const v = toNum(x); return v === 0 ? 32 : 31 - Math.clz32(v & -v); } case "numberOfLeadingZeros": return Math.clz32(toNum(x));
        case "highestOneBit": { const v = toNum(x); return v === 0 ? 0 : (1 << (31 - Math.clz32(v))) | 0; }
        case "MAX_VALUE": return 2147483647; case "MIN_VALUE": return -2147483648;
      } break;
    case "Long":
      switch (name) {
        case "parseLong": case "valueOf": return typeof x === "string" ? (/^[+-]?\d+$/.test(x) ? BigInt(x) : jthrow("NumberFormatException", `For input string: "${x}"`)) : lng(x);
        case "toString": return String(x); case "compare": { const a = lng(x), b = lng(y); return a < b ? -1 : a > b ? 1 : 0; }
        case "max": { const a = lng(x), b = lng(y); return a > b ? a : b; } case "min": { const a = lng(x), b = lng(y); return a < b ? a : b; } case "sum": return BigInt.asIntN(64, lng(x) + lng(y));
        case "abs": return lng(x) < 0n ? -lng(x) : lng(x); case "hashCode": return hashOf(lng(x));
        case "bitCount": { let v = BigInt.asUintN(64, lng(x)), c = 0; while (v) { c += Number(v & 1n); v >>= 1n; } return c; }
        case "MAX_VALUE": return 2n ** 63n - 1n; case "MIN_VALUE": return -(2n ** 63n);
      } break;
    case "Double": case "Float":
      switch (name) {
        case "parseDouble": case "valueOf": case "parseFloat": { if (typeof x !== "string") return coerce(x, { name: "double", dims: 0 }); const v = Number(x.trim()); if (x.trim() === "" || Number.isNaN(v)) jthrow("NumberFormatException", `For input string: "${x}"`); return new JD(v); }
        case "compare": return Math.sign(toNum(x) - toNum(y)); case "isNaN": return Number.isNaN(toNum(x)); case "isInfinite": return !Number.isFinite(toNum(x)) && !Number.isNaN(toNum(x));
        case "max": return new JD(Math.max(toNum(x), toNum(y))); case "min": return new JD(Math.min(toNum(x), toNum(y))); case "sum": return new JD(toNum(x) + toNum(y));
        case "toString": return toStr(x instanceof JD ? x : new JD(toNum(x)));
        case "MAX_VALUE": return new JD(Number.MAX_VALUE); case "MIN_VALUE": return new JD(Number.MIN_VALUE); case "POSITIVE_INFINITY": return new JD(Infinity); case "NEGATIVE_INFINITY": return new JD(-Infinity); case "NaN": return new JD(NaN);
      } break;
    case "Boolean": if (name === "parseBoolean" || name === "valueOf") return typeof x === "string" ? x.toLowerCase() === "true" : x; if (name === "toString") return String(x); if (name === "TRUE") return true; if (name === "FALSE") return false; break;
    case "Character": {
      const code = x instanceof JC ? x.c : toNum(x), ch = String.fromCharCode(code), wrap = (c) => (x instanceof JC ? new JC(c.charCodeAt(0)) : c.charCodeAt(0));
      switch (name) {
        case "isDigit": return /[0-9]/.test(ch); case "isLetter": case "isAlphabetic": return /\p{L}/u.test(ch); case "isLetterOrDigit": return /[\p{L}0-9]/u.test(ch);
        case "isUpperCase": return /\p{Lu}/u.test(ch); case "isLowerCase": return /\p{Ll}/u.test(ch); case "isWhitespace": case "isSpaceChar": return /\s/.test(ch);
        case "toUpperCase": return wrap(ch.toUpperCase()); case "toLowerCase": return wrap(ch.toLowerCase());
        case "getNumericValue": return /[0-9]/.test(ch) ? code - 48 : /[a-zA-Z]/.test(ch) ? ch.toLowerCase().charCodeAt(0) - 87 : -1;
        case "digit": return /[0-9]/.test(ch) ? code - 48 : -1; case "forDigit": return new JC(toNum(x) < 10 ? 48 + toNum(x) : 87 + toNum(x));
        case "valueOf": return x instanceof JC ? x : new JC(code); case "toString": return ch; case "compare": return code - toNum(y); case "hashCode": return code; case "toChars": return new JArr([new JC(code)], "char", 1);
        case "MAX_VALUE": return new JC(65535); case "MIN_VALUE": return new JC(0);
      } break;
    }
    case "String":
      switch (name) {
        case "valueOf": case "copyValueOf": return x instanceof JArr ? x.a.map(toStr).join("") : toStr(x);
        case "join": { const items = args.length === 2 && (y instanceof JList || y instanceof JSet || y instanceof JArr) ? iterate(y) : args.slice(1); return items.map(toStr).join(toStr(x)); }
        case "format": return formatJava(x, args.slice(1)); case "CASE_INSENSITIVE_ORDER": return lambdaN(([a, b]) => strCompare(a.toLowerCase(), b.toLowerCase()), 2);
      } break;
    case "Arrays": return arraysStatic(name, args);
    case "Collections": return collectionsStatic(name, args);
    case "List": case "Set": case "Map":
      if (name === "of" || name === "copyOf") { const items = name === "copyOf" ? iterate(x) : args.length === 1 && x instanceof JArr ? x.a : args; if (cls === "Set") { const s = new JSet("LinkedHashSet"); items.forEach((e) => setAdd(s, e)); return s; } if (cls === "Map") { const m = new JMap("LinkedHashMap"); for (let i = 0; i + 1 < args.length; i += 2) mapPut(m, args[i], args[i + 1]); return m; } return copyList("ArrayList", items.slice()); }
      if (cls === "Map" && name === "entry") return new JEntry(x, y, null);
      break;
    case "Objects":
      switch (name) { case "equals": return equalsObj(x, y) || (x === null && y === null); case "hash": return args.reduce((h, v) => (Math.imul(31, h) + (hashOf(v) ?? 0)) | 0, 1); case "hashCode": return hashOf(x) ?? 0; case "requireNonNull": if (x === null) jthrow("NullPointerException"); return x; case "isNull": return x === null; case "nonNull": return x !== null; case "toString": return toStr(x); }
      break;
    case "Comparator": case "Entry":
      switch (name) {
        case "naturalOrder": return lambdaN(([a, b]) => compareValues(a, b), 2); case "reverseOrder": return lambdaN(([a, b]) => compareValues(b, a), 2);
        case "comparingInt": case "comparingLong": case "comparingDouble": case "comparing": return lambdaN(([a, b]) => y ? callFn(y, [callFn(x, [a]), callFn(x, [b])]) : compareValues(callFn(x, [a]), callFn(x, [b])), 2);
        case "comparingByKey": return lambdaN(([a, b]) => y ? callFn(y, [a.k, b.k]) : compareValues(a.k, b.k), 2);
        case "comparingByValue": return lambdaN(([a, b]) => y ? callFn(y, [a.v, b.v]) : compareValues(a.v, b.v), 2);
      } break;
    case "System":
      switch (name) {
        case "currentTimeMillis": return BigInt(Date.now()); case "nanoTime": return BigInt(Math.round(performance.now() * 1e6));
        case "arraycopy": { const [src, sp, dst, dp, len] = args.map((v, i) => i === 0 || i === 2 ? v : toNum(v)); if (src === null || dst === null) jthrow("NullPointerException"); if (sp < 0 || dp < 0 || len < 0 || sp + len > src.a.length || dp + len > dst.a.length) jthrow("ArrayIndexOutOfBoundsException", `arraycopy: last source index ${sp + len} out of bounds for length ${src.a.length}`); const tmp = src.a.slice(sp, sp + len); for (let i = 0; i < len; i++) dst.a[dp + i] = tmp[i]; return null; }
        case "lineSeparator": return "\n"; case "exit": case "gc": return null; case "identityHashCode": return 0;
      } break;
    case "Thread": if (name === "sleep") return null; break;
    case "Optional": break;
  }
  return undefined;
}
function arraysStatic(name, args) {
  const [x, y, z, w] = args;
  const chk = (a) => { if (a === null) jthrow("NullPointerException"); return a; };
  switch (name) {
    case "fill": if (args.length === 4) { for (let i = toNum(y); i < toNum(z); i++) x.a[i] = coerce(w, { name: x.et, dims: x.dims - 1 }); } else chk(x).a.fill(coerce(y, { name: x.et, dims: x.dims - 1 })); return null;
    case "sort": {
      chk(x); let from = 0, to = x.a.length, cmp = null;
      if (args.length >= 3 && isNum(y)) { from = toNum(y); to = toNum(z); cmp = w || null; if (from < 0 || to > x.a.length) jthrow("ArrayIndexOutOfBoundsException", `Array index out of range: ${to}`); } else cmp = y || null;
      const part = x.a.slice(from, to).sort(cmpFn(cmp)); for (let i = 0; i < part.length; i++) x.a[from + i] = part[i]; return null;
    }
    case "toString": return x === null ? "null" : "[" + x.a.map(toStr).join(", ") + "]";
    case "deepToString": { const d = (v) => v instanceof JArr ? "[" + v.a.map(d).join(", ") + "]" : toStr(v); return d(x); }
    case "asList": return copyList("ArrayList", args.length === 1 && x instanceof JArr ? x.a.slice() : args.slice());
    case "copyOf": { const n = toNum(y); const out = x.a.slice(0, n); while (out.length < n) out.push(defaultValue(x.et, x.dims - 1)); return new JArr(out, x.et, x.dims); }
    case "copyOfRange": { const from = toNum(y), to = toNum(z); if (from > x.a.length || from < 0) jthrow("ArrayIndexOutOfBoundsException", `Array index out of range: ${from}`); const out = x.a.slice(from, to); while (out.length < to - from) out.push(defaultValue(x.et, x.dims - 1)); return new JArr(out, x.et, x.dims); }
    case "equals": return x === y || (x !== null && y !== null && x.a.length === y.a.length && x.a.every((e, i) => equalsObj(e, y.a[i])));
    case "deepEquals": { const d = (a, b) => a instanceof JArr && b instanceof JArr ? a.a.length === b.a.length && a.a.every((e, i) => d(e, b.a[i])) : equalsObj(a, b); return d(x, y); }
    case "hashCode": return x === null ? 0 : x.a.reduce((h, v) => (Math.imul(31, h) + (hashOf(v) ?? 0)) | 0, 1);
    case "binarySearch": { let lo = 0, hi = x.a.length - 1; while (lo <= hi) { const mid = (lo + hi) >>> 1, c = compareValues(x.a[mid], y); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return mid; } return -(lo + 1); }
    case "setAll": for (let i = 0; i < x.a.length; i++) x.a[i] = callFn(y, [i]); return null;
    case "stream": jthrow("UnsupportedOperationException", "Streams are not supported by the tracer");
  }
  return undefined;
}
function collectionsStatic(name, args) {
  const [x, y, z] = args;
  switch (name) {
    case "sort": sortWith(x.a, y || null); return null;
    case "reverse": x.a.reverse(); return null;
    case "shuffle": return null;
    case "swap": { const i = toNum(y), j = toNum(z); if (i < 0 || j < 0 || i >= x.a.length || j >= x.a.length) outOfBounds(Math.max(i, j), x.a.length); [x.a[i], x.a[j]] = [x.a[j], x.a[i]]; return null; }
    case "max": case "min": { const items = iterate(x); if (!items.length) jthrow("NoSuchElementException"); const f = cmpFn(y || null); return items.reduce((m, v) => (name === "max" ? f(v, m) > 0 : f(v, m) < 0) ? v : m); }
    case "unmodifiableList": case "unmodifiableSet": case "unmodifiableMap": case "synchronizedList": return x;
    case "emptyList": return new JList("ArrayList"); case "emptySet": return new JSet("HashSet"); case "emptyMap": return new JMap("HashMap");
    case "singletonList": case "singleton": return copyList("ArrayList", [x]);
    case "reverseOrder": return x ? lambdaN(([a, b]) => callFn(x, [b, a]), 2) : lambdaN(([a, b]) => compareValues(b, a), 2);
    case "frequency": return iterate(x).filter((e) => equalsObj(e, y)).length;
    case "nCopies": return copyList("ArrayList", Array(toNum(x)).fill(y));
    case "addAll": for (const e of args.slice(1)) listMethod(x, "add", [e]); return true;
    case "binarySearch": return arraysStatic("binarySearch", [{ a: x.a }, y]);
  }
  return undefined;
}
export { lambdaN, formatJava };
