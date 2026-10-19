// Lexer + recursive-descent parser for a C++ subset (LeetCode-style solutions).
// Produces an AST in the same spirit as java/parser.js: every node has `k` (kind) and `line`.
export class CppSyntaxError extends Error {
  constructor(msg, line) { super(line ? `${msg} (line ${line})` : msg); this.line = line || 0; }
}

const BUILTIN_KW = new Set(["int", "long", "short", "char", "double", "float", "bool", "void", "unsigned", "signed", "auto", "wchar_t"]);
const TEMPLATE_TYPES = new Set(["vector", "map", "unordered_map", "set", "unordered_set", "multiset", "multimap", "unordered_multiset", "unordered_multimap",
  "stack", "queue", "deque", "priority_queue", "pair", "tuple", "array", "list", "function", "less", "greater", "plus", "minus", "multiplies",
  "equal_to", "not_equal_to", "greater_equal", "less_equal", "hash", "optional", "bitset", "initializer_list", "numeric_limits"]);
const PLAIN_TYPES = new Set(["string", "size_t", "ssize_t", "int64_t", "uint64_t", "int32_t", "uint32_t", "int16_t", "uint16_t", "int8_t", "uint8_t",
  "ptrdiff_t", "intptr_t", "uintptr_t", "istream", "ostream", "stringstream", "ostringstream", "istringstream", "exception", "runtime_error",
  "logic_error", "out_of_range", "invalid_argument", "length_error", "bad_alloc", "string_view"]);
const ALIAS_BASE = { size_t: "ull", ssize_t: "ll", int64_t: "ll", uint64_t: "ull", int32_t: "int", uint32_t: "uint", int16_t: "short", uint16_t: "ushort",
  int8_t: "char", uint8_t: "uchar", ptrdiff_t: "ll", intptr_t: "ll", uintptr_t: "ull", wchar_t: "int" };
const QUALS = new Set(["const", "volatile", "static", "extern", "inline", "constexpr", "mutable", "register", "typename", "virtual", "explicit", "friend", "thread_local"]);
const RESERVED = new Set(["return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "new", "delete", "throw", "try", "catch",
  "sizeof", "this", "true", "false", "nullptr", "operator", "goto", "using", "typedef", "namespace", "template", "struct", "class", "enum", "union", "public", "private", "protected"]);

function baseName(words) {
  const has = (w) => words.includes(w), longs = words.filter((w) => w === "long").length, uns = has("unsigned");
  if (has("double")) return "double"; if (has("float")) return "float"; if (has("bool")) return "bool"; if (has("void")) return "void"; if (has("auto")) return "auto";
  if (has("wchar_t")) return "int";
  if (has("char")) return uns ? "uchar" : "char";
  if (has("short")) return uns ? "ushort" : "short";
  if (longs >= 1) return uns ? "ull" : "ll";
  return uns ? "uint" : "int";
}

// ---------------------------------------------------------------- lexer
const OPS3 = ["<<=", "..."], OPS2 = ["->", "++", "--", "&&", "||", "==", "!=", "<=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", "::"];
// NOTE: '>' is always a single token (so `vector<vector<int>>` works); the expression parser glues '>' '>' / '>' '=' back together.
const ESC = { n: 10, t: 9, r: 13, "0": 0, a: 7, b: 8, f: 12, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63 };

export function lex(src, baseLine = 1) {
  const toks = [], macros = new Map(); let i = 0, line = baseLine, lineStart = true; const n = src.length;
  const push = (t, v, start) => toks.push({ t, v, line, pos: start, end: i });
  const readEscape = () => { // src[i] is the char after the backslash
    const c = src[i];
    if (c === "x") { let j = i + 1, h = ""; while (/[0-9a-fA-F]/.test(src[j] || "")) h += src[j++]; i = j; return parseInt(h || "0", 16); }
    if (/[0-7]/.test(c)) { let o = ""; while (o.length < 3 && /[0-7]/.test(src[i] || "")) o += src[i++]; return parseInt(o, 8); }
    i++; return c in ESC ? ESC[c] : c.charCodeAt(0);
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; lineStart = true; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2), end = e < 0 ? n : e + 2; for (let k = i; k < end; k++) if (src[k] === "\n") line++; i = end; continue; }
    if (c === "#" && lineStart) {
      let j = i, text = "", dirLine = line;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\" && (src[j + 1] === "\n" || (src[j + 1] === "\r" && src[j + 2] === "\n"))) { j += src[j + 1] === "\n" ? 2 : 3; line++; text += " "; continue; }
        text += src[j++];
      }
      text = text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, " ").trim();
      const m = /^#\s*define\s+([A-Za-z_]\w*)(\()?(.*)$/.exec(text);
      if (m) {
        if (m[2]) macros.set(m[1], { fn: true });
        else { const body = lex(m[3].trim(), dirLine).toks; body.pop(); macros.set(m[1], { toks: body }); }
      }
      i = j; continue;
    }
    lineStart = false;
    const start = i;
    if (/[A-Za-z_]/.test(c)) { while (i < n && /\w/.test(src[i])) i++; push("id", src.slice(start, i), start); continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let isFloat = false;
      if (c === "0" && /[xX]/.test(src[i + 1] || "")) { i += 2; while (/[0-9a-fA-F']/.test(src[i] || "")) i++; }
      else if (c === "0" && /[bB]/.test(src[i + 1] || "")) { i += 2; while (/[01']/.test(src[i] || "")) i++; }
      else {
        while (/[0-9']/.test(src[i] || "")) i++;
        if (src[i] === "." ) { isFloat = true; i++; while (/[0-9']/.test(src[i] || "")) i++; }
        if (/[eE]/.test(src[i] || "") && /[0-9+-]/.test(src[i + 1] || "")) { isFloat = true; i += 2; while (/[0-9]/.test(src[i] || "")) i++; }
      }
      const body = src.slice(start, i).replace(/'/g, "");
      let sfx = ""; while (/[uUlLfF]/.test(src[i] || "")) sfx += src[i++];
      push("num", { text: body, sfx: sfx.toLowerCase(), isFloat }, start); continue;
    }
    if (c === "'") {
      i++; let code;
      if (src[i] === "\\") { i++; code = readEscape(); } else code = src.codePointAt(i), i += code > 0xffff ? 2 : 1;
      if (src[i] !== "'") throw new CppSyntaxError("Unterminated character literal", line);
      i++; push("chr", code, start); continue;
    }
    if (c === '"' || (c === "R" && src[i + 1] === '"')) {
      if (c === "R") throw new CppSyntaxError("Raw string literals aren't supported", line);
      i++; let s = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\n") throw new CppSyntaxError("Unterminated string literal", line);
        if (src[i] === "\\") { i++; s += String.fromCharCode(readEscape()); } else s += src[i++];
      }
      i++; push("str", s, start); continue;
    }
    const three = src.substr(i, 3), two = src.substr(i, 2);
    if (OPS3.includes(three)) { i += 3; push("op", three, start); continue; }
    if (OPS2.includes(two)) { i += 2; push("op", two, start); continue; }
    if ("+-*/%=<>!&|^~?:;,.(){}[]".includes(c)) { i++; push("op", c, start); continue; }
    throw new CppSyntaxError(`Unexpected character '${c}'`, line);
  }
  toks.push({ t: "eof", v: "<eof>", line, pos: n, end: n });
  return { toks, macros };
}

function preprocess({ toks, macros }) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "id" && t.v === "std" && toks[i + 1]?.v === "::") { i++; continue; }
    if (t.t === "op" && t.v === "::" && (i === 0 || !(toks[i - 1].t === "id" || toks[i - 1].v === ">")) && toks[i + 1]?.t === "id") continue; // leading ::name
    if (t.t === "id" && macros.has(t.v)) {
      const m = macros.get(t.v);
      if (m.fn) throw new CppSyntaxError(`Function-like macro '${t.v}' isn't supported`, t.line);
      for (const b of m.toks) out.push({ ...b, line: t.line });
      continue;
    }
    out.push(t);
  }
  // merge adjacent string literals
  const merged = [];
  for (const t of out) { const p = merged[merged.length - 1]; if (t.t === "str" && p && p.t === "str") p.v += t.v; else merged.push(t); }
  return merged;
}

// ---------------------------------------------------------------- parser
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<="]);
const BIN_PREC = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

class Parser {
  constructor(toks) {
    this.toks = toks; this.p = 0; this.types = new Set(); this.aliases = new Map(); this.templateNames = new Set(); this.tmplParams = new Set(); this.templateFuncs = new Set();
    this.classes = []; this.funcs = []; this.globals = []; this.enums = [];
    for (let i = 0; i < toks.length - 1; i++) { // pre-scan: user type names, so declarations are recognised before their definition order matters
      const t = toks[i], nx = toks[i + 1];
      if ((t.v === "struct" || t.v === "class" || t.v === "enum" || t.v === "union") && nx.t === "id" && nx.v !== "class" && nx.v !== "struct") this.types.add(nx.v);
      if (t.v === "enum" && (nx.v === "class" || nx.v === "struct") && toks[i + 2]?.t === "id") this.types.add(toks[i + 2].v);
      if (t.v === "using" && nx.t === "id" && toks[i + 2]?.v === "=") this.types.add(nx.v);
      if (t.v === "typedef") { let j = i + 1; while (toks[j] && toks[j].v !== ";") j++; if (toks[j - 1]?.t === "id") this.types.add(toks[j - 1].v); }
    }
  }
  peek(o = 0) { return this.toks[Math.min(this.p + o, this.toks.length - 1)]; }
  next() { return this.toks[this.p++]; }
  isOp(v, o = 0) { const t = this.peek(o); return t.t === "op" && t.v === v; }
  isId(v, o = 0) { const t = this.peek(o); return t.t === "id" && t.v === v; }
  accept(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  acceptId(v) { if (this.isId(v)) { this.p++; return true; } return false; }
  fail(msg, t = this.peek()) { throw new CppSyntaxError(msg, t.line); }
  expect(v) { if (!this.accept(v)) this.fail(`Expected '${v}' but found '${this.peek().t === "eof" ? "end of file" : this.peek().v}'`); }
  ident() { const t = this.next(); if (t.t !== "id") this.fail(`Expected a name but found '${t.v}'`, t); return t.v; }
  adjacent(o = 0) { const a = this.peek(o), b = this.peek(o + 1); return a.end === b.pos && a.line === b.line; }

  // ------------------------------------------------ types
  isTypeName(id, nextIsLt) {
    if (BUILTIN_KW.has(id)) return true;
    if (this.aliases.has(id) || this.types.has(id) || this.tmplParams.has(id)) return true;
    if (PLAIN_TYPES.has(id)) return true;
    if (TEMPLATE_TYPES.has(id) || this.templateNames.has(id)) return nextIsLt;
    return false;
  }
  typeOpt() { const save = this.p; try { return this.parseType(); } catch (e) { if (!(e instanceof CppSyntaxError)) throw e; this.p = save; return null; } }
  parseType() {
    let isConst = false, isStatic = false;
    while (this.peek().t === "id" && QUALS.has(this.peek().v)) { if (this.peek().v === "const") isConst = true; if (this.peek().v === "static") isStatic = true; this.p++; }
    const t = this.peek(); if (t.t !== "id" || RESERVED.has(t.v) && !["struct", "class", "enum", "union"].includes(t.v)) this.fail("Type expected");
    let name, args = [], base = null;
    if (BUILTIN_KW.has(t.v)) {
      const words = [];
      while (this.peek().t === "id" && (BUILTIN_KW.has(this.peek().v) || this.peek().v === "const")) { const w = this.next().v; if (w === "const") isConst = true; else words.push(w); }
      name = baseName(words);
    } else if (t.v === "decltype") {
      this.p++; this.expect("("); let d = 1; while (d > 0 && this.peek().t !== "eof") { if (this.isOp("(")) d++; else if (this.isOp(")")) d--; this.p++; }
      name = "decltype";
    } else {
      if (["struct", "class", "enum", "union"].includes(t.v)) this.p++;
      name = this.ident();
      while (this.isOp("::") && this.peek(1).t === "id") { this.p++; name = this.next().v; }
      const lt = this.isOp("<");
      if (this.aliases.has(name) && !lt) base = this.aliases.get(name);
      else if (TEMPLATE_TYPES.has(name) || this.templateNames.has(name)) { if (!lt) this.fail("Template arguments expected"); args = this.parseTypeArgs(); }
      else if (name in ALIAS_BASE) name = ALIAS_BASE[name];
      else if (!(this.types.has(name) || PLAIN_TYPES.has(name) || this.tmplParams.has(name))) this.fail(`'${name}' is not a type`);
      while (this.isOp("::") && this.peek(1).t === "id" && !this.isOp("(", 2)) { this.p += 2; base = null; name = "iterator"; args = []; } // vector<int>::iterator etc.
    }
    let type = base ? { ...base, args: base.args } : { name, args, ptr: 0, ref: false, isConst: false, dims: null };
    for (;;) {
      if (this.isId("const")) { this.p++; isConst = true; }
      else if (this.isOp("*")) { this.p++; type = { ...type, ptr: type.ptr + 1 }; }
      else if (this.isOp("&") || this.isOp("&&")) { this.p++; type = { ...type, ref: true }; }
      else break;
    }
    if (isConst) type = { ...type, isConst: true };
    if (isStatic) type = { ...type, isStatic: true };
    return type;
  }
  parseTypeArgs() {
    this.expect("<"); const args = [];
    if (this.accept(">")) return args;
    for (;;) {
      let a = this.typeOpt();
      if (a) { if (this.isOp("(")) { let d = 0; do { if (this.isOp("(")) d++; else if (this.isOp(")")) d--; this.p++; } while (d > 0 && this.peek().t !== "eof"); } }
      else a = { name: "$const", expr: this.parseUnary(), args: [], ptr: 0, ref: false, dims: null };
      args.push(a);
      if (this.accept(",")) continue;
      this.expect(">"); return args;
    }
  }
  /** Is the upcoming token sequence `Type name ...` (a declaration)? Does not consume. */
  isDeclStart() {
    const save = this.p;
    try {
      const t = this.typeOpt(); if (!t) return false;
      const nx = this.peek();
      if (nx.t === "id" && !RESERVED.has(nx.v)) { const n2 = this.peek(1); return n2.t === "op" && ["=", ";", ",", "(", "{", "[", ":", ")"].includes(n2.v); }
      if (t.name === "auto" && nx.t === "op" && nx.v === "[") return true;
      return false;
    } finally { this.p = save; }
  }

  // ------------------------------------------------ top level
  parseUnit() {
    while (this.peek().t !== "eof") this.parseTop();
    return { classes: this.classes, funcs: this.funcs, globals: this.globals, enums: this.enums };
  }
  skipTo(ch) { let d = 0; while (this.peek().t !== "eof") { if (this.isOp("{") || this.isOp("(") || this.isOp("[")) d++; else if (this.isOp("}") || this.isOp(")") || this.isOp("]")) d--; else if (d <= 0 && this.isOp(ch)) { this.p++; return; } this.p++; } }
  skipBalanced(open, close) { this.expect(open); let d = 1; while (d > 0 && this.peek().t !== "eof") { if (this.isOp(open)) d++; else if (this.isOp(close)) d--; this.p++; } }
  parseAliasDecl() {
    if (this.acceptId("using")) {
      if (this.acceptId("namespace")) { this.skipTo(";"); return true; }
      if (this.peek().t === "id" && this.isOp("=", 1)) { const name = this.ident(); this.p++; const t = this.parseType(); this.aliases.set(name, t); this.types.add(name); this.accept(";"); return true; }
      this.skipTo(";"); return true;
    }
    if (this.acceptId("typedef")) {
      const t = this.parseType(); const name = this.ident(); let ty = t;
      if (this.isOp("[")) { this.skipBalanced("[", "]"); }
      this.aliases.set(name, ty); this.types.add(name); this.accept(";"); return true;
    }
    return false;
  }
  parseTop() {
    if (this.accept(";")) return;
    if (this.parseAliasDecl()) return;
    if (this.isId("namespace")) { this.p++; if (this.peek().t === "id") this.p++; this.expect("{"); while (!this.isOp("}") && this.peek().t !== "eof") this.parseTop(); this.expect("}"); return; }
    if (this.isId("extern") && this.peek(1).t === "str") { this.p += 2; if (this.isOp("{")) { this.p++; while (!this.isOp("}") && this.peek().t !== "eof") this.parseTop(); this.expect("}"); } return; }
    let tmpl = null;
    if (this.isId("template")) tmpl = this.parseTemplateHeader();
    try {
      if (this.isId("enum")) return this.parseEnum();
      if ((this.isId("struct") || this.isId("class") || this.isId("union")) && this.peek(1).t === "id" && (this.isOp("{", 2) || this.isOp(":", 2) || this.isOp(";", 2))) {
        const c = this.parseClass(); if (c) this.classes.push(c, ...c.allInner); return;
      }
      this.parseMember(null);
    } finally { if (tmpl) for (const n of tmpl) this.tmplParams.delete(n); }
  }
  parseTemplateHeader() {
    this.p++; this.expect("<"); const names = [];
    let d = 1;
    while (d > 0 && this.peek().t !== "eof") {
      if (this.isOp("<")) d++; else if (this.isOp(">")) d--;
      else if ((this.isId("typename") || this.isId("class")) && this.peek(1).t === "id") { names.push(this.peek(1).v); }
      this.p++;
    }
    for (const n of names) this.tmplParams.add(n);
    return names;
  }
  parseEnum() {
    const line = this.next().line; this.acceptId("class") || this.acceptId("struct");
    const name = this.peek().t === "id" ? this.ident() : null; this.types.add(name);
    if (this.accept(":")) this.parseType();
    const items = [];
    if (this.accept("{")) { while (!this.isOp("}")) { const n = this.ident(); let e = null; if (this.accept("=")) e = this.parseAssign(); items.push({ name: n, expr: e }); if (!this.accept(",")) break; } this.expect("}"); }
    this.accept(";"); this.enums.push({ name, items, line });
  }
  parseClass() {
    const kw = this.next(), isStruct = kw.v !== "class", line = kw.line, name = this.ident();
    if (this.accept(";")) return null; // forward declaration
    let parent = null;
    if (this.accept(":")) { while (this.peek().t === "id" && ["public", "private", "protected", "virtual"].includes(this.peek().v)) this.p++; parent = this.ident(); if (this.isOp("<")) this.parseTypeArgs(); while (this.accept(",")) { this.p++; } }
    this.types.add(name);
    const cls = { k: "class", name, parent, isStruct, line, fields: [], methods: [], ctors: [], inner: [], allInner: [] };
    this.expect("{");
    while (!this.isOp("}")) {
      if (this.peek().t === "eof") this.fail("Unterminated class body");
      if ((this.isId("public") || this.isId("private") || this.isId("protected")) && this.isOp(":", 1)) { this.p += 2; continue; }
      if (this.accept(";")) continue;
      this.parseMember(cls);
    }
    this.expect("}");
    // optional declarators: `} name;`
    if (this.peek().t === "id") { while (!this.isOp(";") && this.peek().t !== "eof") this.p++; }
    this.accept(";");
    return cls;
  }
  parseParams() {
    this.expect("("); const params = [];
    if (this.isId("void") && this.isOp(")", 1)) { this.p += 2; return params; }
    while (!this.isOp(")")) {
      if (this.accept("...")) { params.push({ name: "...", type: { name: "auto", args: [], ptr: 0, ref: false, dims: null }, varargs: true }); break; }
      const type = this.parseType(); let name = null, def = null;
      if (this.peek().t === "id" && !this.isOp(",") ) name = this.ident();
      let ty = type;
      while (this.isOp("[")) { this.skipBalanced("[", "]"); ty = { ...ty, ptr: ty.ptr + 1 }; }
      if (this.accept("=")) def = this.parseAssign();
      params.push({ name: name || `$p${params.length}`, type: ty, def });
      if (!this.accept(",")) break;
    }
    this.expect(")"); return params;
  }
  parseOperatorName() {
    this.p++; // 'operator'
    if (this.isOp("(") && this.isOp(")", 1)) { this.p += 2; return "operator()"; }
    if (this.isOp("[") && this.isOp("]", 1)) { this.p += 2; return "operator[]"; }
    const t = this.next();
    if (t.t === "id") { let s = t.v; while (this.peek().t === "id" || this.isOp("*") || this.isOp("&")) s += this.next().v; return "operator " + s; }
    let op = t.v;
    if (op === ">") { if (this.isOp(">") && this.adjacent(-0)) { /* handled below */ } }
    if (op === ">") { let k = 0; while (this.isOp(">") && this.toks[this.p - 1].end === this.peek().pos) { this.p++; op += ">"; if (++k > 1) break; } if (this.isOp("=") && this.toks[this.p - 1].end === this.peek().pos) { this.p++; op += "="; } }
    return "operator" + op;
  }
  /** A member of a class (cls != null) or a top-level function / variable declaration (cls == null). */
  parseMember(cls) {
    if (this.parseAliasDecl()) return;
    let tmpl = null; if (this.isId("template")) tmpl = this.parseTemplateHeader();
    try { this.parseMemberInner(cls); } finally { if (tmpl) for (const n of tmpl) this.tmplParams.delete(n); }
  }
  parseMemberInner(cls) {
    const line = this.peek().line;
    if (cls && this.isId("friend")) { this.skipTo(";"); return; }
    if (this.isId("enum")) return this.parseEnum();
    if ((this.isId("struct") || this.isId("class") || this.isId("union")) && this.peek(1).t === "id" && (this.isOp("{", 2) || this.isOp(":", 2) || this.isOp(";", 2))) {
      const c = this.parseClass(); if (c) { if (cls) { cls.inner.push(c); cls.allInner.push(c, ...c.allInner); } else this.classes.push(c, ...c.allInner); } return;
    }
    if (this.isId("static_assert")) { this.skipTo(";"); return; }
    // destructor
    if (cls && this.isOp("~")) { this.p++; this.ident(); this.parseParams(); while (!this.isOp("{") && !this.isOp(";") && this.peek().t !== "eof") this.p++; if (this.isOp("{")) this.parseBlock(); else this.p++; return; }
    // constructor
    const flags = { static: false, virtual: false };
    while (this.peek().t === "id" && ["static", "virtual", "inline", "explicit", "constexpr", "extern", "mutable", "thread_local"].includes(this.peek().v)) { const w = this.next().v; if (w === "static") flags.static = true; }
    const nm = this.peek();
    if (cls && nm.t === "id" && nm.v === cls.name && this.isOp("(", 1)) {
      this.p++; const params = this.parseParams(); const initList = [];
      if (this.accept(":")) {
        do { const n = this.ident(); while (this.accept("::")) { /* qualified base */ this.ident(); } const brace = this.isOp("{"); this.p++; const args = [];
          while (!this.isOp(brace ? "}" : ")")) { args.push(this.parseAssign()); if (!this.accept(",")) break; } this.expect(brace ? "}" : ")"); initList.push({ name: n, args, brace }); } while (this.accept(","));
      }
      let body = null;
      if (this.isOp("{")) body = this.parseBlock(); else { if (this.accept("=")) { this.p++; } this.accept(";"); }
      if (body) cls.ctors.push({ k: "ctor", name: cls.name, params, body, initList, line });
      return;
    }
    // out-of-class constructor `Solution::Solution(...)`: unusual, not supported
    const type = this.parseType();
    let name, qual = null;
    if (this.isId("operator")) name = this.parseOperatorName();
    else {
      name = this.ident();
      while (this.isOp("::")) { this.p++; qual = name; if (this.isId("operator")) { name = this.parseOperatorName(); break; } name = this.ident(); }
    }
    if (this.isOp("(")) { // function / method
      const params = this.parseParams();
      while (this.peek().t === "id" && ["const", "noexcept", "override", "final", "volatile"].includes(this.peek().v)) this.p++;
      let ret = type;
      if (this.accept("->")) ret = this.parseType();
      if (this.isOp("=")) { this.p++; this.next(); this.accept(";"); return; }
      if (!this.isOp("{")) { this.accept(";"); return; } // prototype
      const body = this.parseBlock();
      if (this.tmplParams.size) this.templateFuncs.add(name);
      const fn = { k: "method", name, type: ret, params, body, static: flags.static, line, qual };
      if (cls) cls.methods.push(fn); else this.funcs.push(fn);
      return;
    }
    // variable(s)
    const decls = this.parseDeclarators(type, name, line);
    this.expect(";");
    if (cls) for (const d of decls) cls.fields.push({ ...d, static: flags.static, line });
    else for (const d of decls) this.globals.push({ ...d, line });
  }
  /** After `Type name`: parse the rest of the first declarator and any further `, name = init`. */
  parseDeclarators(type, firstName, line) {
    const decls = []; let name = firstName, ty = type;
    for (;;) {
      let t = ty; const dims = [];
      while (this.isOp("[")) { this.p++; dims.push(this.isOp("]") ? null : this.parseAssign()); this.expect("]"); }
      if (dims.length) t = { ...t, dims };
      let init = null, mode = null, args = null;
      if (this.accept("=")) { init = this.parseInitializer(); mode = "eq"; }
      else if (this.isOp("{")) { args = this.parseBraceArgs(); mode = "brace"; }
      else if (this.isOp("(")) { this.p++; args = []; while (!this.isOp(")")) { args.push(this.parseAssign()); if (!this.accept(",")) break; } this.expect(")"); mode = "paren"; }
      decls.push({ name, type: t, init, mode, args, line });
      if (!this.accept(",")) break;
      const base = { ...type, ptr: 0, ref: false };
      ty = base;
      for (;;) { if (this.accept("*")) ty = { ...ty, ptr: ty.ptr + 1 }; else if (this.accept("&")) ty = { ...ty, ref: true }; else break; }
      name = this.ident();
    }
    return decls;
  }
  parseBraceArgs() { this.expect("{"); const args = []; while (!this.isOp("}")) { args.push(this.parseInitializer()); if (!this.accept(",")) break; } this.expect("}"); return args; }
  parseInitializer() { return this.isOp("{") ? { k: "initList", elems: this.parseBraceArgs(), line: this.peek().line } : this.parseAssign(); }

  // ------------------------------------------------ statements
  parseBlock() {
    const line = this.peek().line; this.expect("{"); const body = [];
    while (!this.isOp("}")) { if (this.peek().t === "eof") this.fail("Missing closing '}'"); body.push(this.parseStmt()); }
    this.expect("}"); return { k: "block", body, line };
  }
  parseLocalDecl(line) {
    const type = this.parseType();
    if (type.name === "auto" && this.isOp("[")) { // structured binding
      this.p++; const names = []; while (!this.isOp("]")) { names.push(this.ident()); if (!this.accept(",")) break; } this.expect("]");
      let init = null; if (this.accept("=")) init = this.parseAssign(); else if (this.isOp("{")) init = this.parseInitializer();
      return { k: "local", decls: [{ name: null, names, type, init, mode: "eq", args: null, line }], line };
    }
    const name = this.ident();
    return { k: "local", decls: this.parseDeclarators(type, name, line), line };
  }
  parseStmt() {
    const t = this.peek(), line = t.line;
    if (t.t === "op") {
      if (t.v === "{") return this.parseBlock();
      if (t.v === ";") { this.p++; return { k: "empty", line }; }
    }
    if (t.t === "id") {
      switch (t.v) {
        case "if": { this.p++; this.acceptId("constexpr"); this.expect("("); const cond = this.parseCondExpr(); this.expect(")"); const then = this.parseStmt(); let els = null; if (this.acceptId("else")) els = this.parseStmt(); return { k: "if", cond, then, els, line }; }
        case "while": { this.p++; this.expect("("); const cond = this.parseCondExpr(); this.expect(")"); return { k: "while", cond, body: this.parseStmt(), line }; }
        case "do": { this.p++; const body = this.parseStmt(); if (!this.acceptId("while")) this.fail("Expected 'while' after do-body"); this.expect("("); const cond = this.parseExpr(); this.expect(")"); this.expect(";"); return { k: "doWhile", cond, body, line }; }
        case "for": return this.parseFor();
        case "return": { this.p++; let e = null; if (!this.isOp(";")) e = this.parseInitializer(); this.expect(";"); return { k: "return", e, line }; }
        case "break": this.p++; this.expect(";"); return { k: "break", line };
        case "continue": this.p++; this.expect(";"); return { k: "continue", line };
        case "goto": this.fail("goto isn't supported");
        case "switch": return this.parseSwitch();
        case "try": return this.parseTry();
        case "throw": { this.p++; let e = null; if (!this.isOp(";")) e = this.parseAssign(); this.expect(";"); return { k: "throw", e, line }; }
        case "using": case "typedef": this.parseAliasDecl(); return { k: "empty", line };
        case "static_assert": this.skipTo(";"); return { k: "empty", line };
        case "struct": case "class": case "union":
          if (this.peek(1).t === "id" && (this.isOp("{", 2) || this.isOp(":", 2))) { const c = this.parseClass(); return { k: "localClass", cls: c, inner: c.allInner, line }; }
          break;
        case "enum": this.parseEnum(); return { k: "empty", line };
      }
      if (this.isDeclStart()) { const s = this.parseLocalDecl(line); this.expect(";"); return s; }
    }
    const e = this.parseExpr(); this.expect(";");
    return { k: "expr", e, line };
  }
  parseCondExpr() { // allows `if (int x = f())` declarations
    const line = this.peek().line;
    if (this.isDeclStart()) { const s = this.parseLocalDecl(line); return { k: "declCond", decl: s, line }; }
    return this.parseExpr();
  }
  parseFor() {
    const line = this.next().line; this.expect("(");
    // range-for?
    const save = this.p;
    if (this.isDeclStart()) {
      const type = this.typeOpt();
      let names = null, name = null;
      if (type && this.isOp("[")) { this.p++; names = []; while (!this.isOp("]")) { names.push(this.ident()); if (!this.accept(",")) break; } this.expect("]"); }
      else if (type && this.peek().t === "id") name = this.ident();
      if (type && (names || name) && this.accept(":")) { const iter = this.parseInitializer(); this.expect(")"); return { k: "foreach", type, name, names, iter, body: this.parseStmt(), line }; }
      this.p = save;
    }
    const init = [];
    if (!this.isOp(";")) {
      if (this.isDeclStart()) init.push(this.parseLocalDecl(line));
      else { init.push({ k: "expr", e: this.parseExpr(), line }); }
    }
    this.expect(";");
    const cond = this.isOp(";") ? null : this.parseExpr(); this.expect(";");
    const update = []; if (!this.isOp(")")) { do update.push(this.parseAssign()); while (this.accept(",")); }
    this.expect(")");
    return { k: "for", init, cond, update, body: this.parseStmt(), line };
  }
  parseSwitch() {
    const line = this.next().line; this.expect("("); const expr = this.parseExpr(); this.expect(")"); this.expect("{");
    const cases = []; let cur = null;
    while (!this.isOp("}")) {
      if (this.peek().t === "eof") this.fail("Unterminated switch");
      if (this.isId("case")) { this.p++; const l = this.parseCond(); this.expect(":"); if (cur && !cur.body.length) cur.labels.push(l); else { cur = { labels: [l], isDefault: false, body: [] }; cases.push(cur); } continue; }
      if (this.isId("default")) { this.p++; this.expect(":"); if (cur && !cur.body.length) cur.isDefault = true; else { cur = { labels: [], isDefault: true, body: [] }; cases.push(cur); } continue; }
      if (!cur) this.fail("Statement before first case");
      cur.body.push(this.parseStmt());
    }
    this.expect("}"); return { k: "switch", expr, cases, line };
  }
  parseTry() {
    const line = this.next().line; const block = this.parseBlock(); const catches = [];
    while (this.isId("catch")) {
      this.p++; this.expect("(");
      let type = null, name = null;
      if (this.accept("...")) { /* catch-all */ } else { type = this.parseType(); if (this.peek().t === "id") name = this.ident(); }
      this.expect(")"); catches.push({ type, name, body: this.parseBlock() });
    }
    return { k: "try", block, catches, line };
  }

  // ------------------------------------------------ expressions
  parseExpr() {
    const line = this.peek().line; let e = this.parseAssign();
    if (this.isOp(",")) { const list = [e]; while (this.accept(",")) list.push(this.parseAssign()); return { k: "comma", list, line }; }
    return e;
  }
  /** Reads an assignment operator at the cursor (gluing '>' '>' '=' together). Returns {op, n} or null. */
  peekAssignOp() {
    const t = this.peek(); if (t.t !== "op") return null;
    if (ASSIGN_OPS.has(t.v)) return { op: t.v, n: 1 };
    if (t.v === ">" && this.isOp(">", 1) && this.adjacent() && this.isOp("=", 2) && this.adjacent(1)) return { op: ">>=", n: 3 };
    return null;
  }
  parseAssign() {
    const line = this.peek().line;
    if (this.isId("throw")) { this.p++; return { k: "throwE", e: this.isOp(")") || this.isOp(";") ? null : this.parseAssign(), line }; }
    const lhs = this.parseCond(); const a = this.peekAssignOp();
    if (a) { this.p += a.n; const value = this.parseInitializer(); return { k: "assign", op: a.op, target: lhs, value, line }; }
    return lhs;
  }
  parseCond() {
    const line = this.peek().line; const c = this.parseBin(1);
    if (this.accept("?")) { const a = this.parseAssign(); this.expect(":"); const b = this.parseAssign(); return { k: "cond", c, a, b, line }; }
    return c;
  }
  peekBinOp() { // -> {op, n} or null
    const t = this.peek(); if (t.t !== "op") return null;
    if (t.v === ">") {
      if (this.isOp(">", 1) && this.adjacent()) { if (this.isOp("=", 2) && this.adjacent(1)) return null; return { op: ">>", n: 2 }; }
      if (this.isOp("=", 1) && this.adjacent()) { if (this.isOp("=", 2) && this.adjacent(1)) return { op: ">", n: 1 }; return { op: ">=", n: 2 }; }
      return { op: ">", n: 1 };
    }
    if (t.v in BIN_PREC) return { op: t.v, n: 1 };
    return null;
  }
  parseBin(minPrec) {
    let l = this.parseUnary();
    for (;;) {
      const o = this.peekBinOp(); if (!o) return l;
      const prec = BIN_PREC[o.op]; if (prec < minPrec) return l;
      const line = this.peek().line; this.p += o.n;
      const r = this.parseBin(prec + 1); l = { k: "binary", op: o.op, l, r, line };
    }
  }
  parseUnary() {
    const t = this.peek(), line = t.line;
    if (t.t === "op") {
      switch (t.v) {
        case "!": case "~": case "-": case "+": this.p++; return { k: "unary", op: t.v, e: this.parseUnary(), line };
        case "*": this.p++; return { k: "deref", e: this.parseUnary(), line };
        case "&": this.p++; return { k: "addr", e: this.parseUnary(), line };
        case "++": case "--": this.p++; return { k: "update", op: t.v, prefix: true, target: this.parseUnary(), line };
        case "(": { // C-style cast?
          const save = this.p; this.p++;
          const ty = this.typeOpt();
          if (ty && this.isOp(")")) {
            const nx = this.peek(1);
            if (nx.t === "id" || nx.t === "num" || nx.t === "chr" || nx.t === "str" || (nx.t === "op" && ["(", "!", "~", "-", "+", "*", "&", "++", "--"].includes(nx.v))) {
              if (!(nx.t === "id" && ["const"].includes(nx.v))) { this.p++; return { k: "cast", type: ty, e: this.parseUnary(), line }; }
            }
          }
          this.p = save; break;
        }
      }
    } else if (t.t === "id") {
      if (t.v === "sizeof") {
        this.p++;
        if (this.isOp("(")) { const save = this.p; this.p++; const ty = this.typeOpt(); if (ty && this.isOp(")")) { this.p++; return { k: "sizeof", type: ty, line }; } this.p = save; }
        return { k: "sizeof", e: this.parseUnary(), line };
      }
      if (t.v === "new") return this.parseNew();
      if (t.v === "delete") { this.p++; if (this.isOp("[")) { this.p++; this.expect("]"); } return { k: "delete", e: this.parseUnary(), line }; }
    }
    return this.parsePostfix(this.parsePrimary());
  }
  parseNew() {
    const line = this.next().line; const type = this.parseType();
    if (this.isOp("[")) { const dims = []; while (this.isOp("[")) { this.p++; dims.push(this.parseAssign()); this.expect("]"); } let init = null; if (this.isOp("{")) init = this.parseInitializer(); return { k: "newArr", type, dims, init, line }; }
    let args = [], brace = false;
    if (this.isOp("(")) { this.p++; while (!this.isOp(")")) { args.push(this.parseAssign()); if (!this.accept(",")) break; } this.expect(")"); }
    else if (this.isOp("{")) { args = this.parseBraceArgs(); brace = true; }
    return { k: "new", type, args, brace, line };
  }
  parseArgs() { this.expect("("); const args = []; while (!this.isOp(")")) { args.push(this.parseInitializer()); if (!this.accept(",")) break; } this.expect(")"); return args; }
  parsePostfix(e) {
    for (;;) {
      const t = this.peek(), line = t.line;
      if (t.t !== "op") return e;
      if (t.v === "(") { e = { k: "call", fn: e, args: this.parseArgs(), line }; }
      else if (t.v === "[") { this.p++; const idx = this.parseExpr(); this.expect("]"); e = { k: "index", obj: e, idx, line }; }
      else if (t.v === "." || t.v === "->") { this.p++; this.acceptId("template"); const name = this.ident(); e = { k: "member", obj: e, name, arrow: t.v === "->", line }; }
      else if (t.v === "++" || t.v === "--") { this.p++; e = { k: "update", op: t.v, prefix: false, target: e, line }; }
      else return e;
    }
  }
  parseLambda() {
    const line = this.peek().line; this.expect("["); let byRef = false, byVal = false;
    while (!this.isOp("]")) { if (this.isOp("&") && (this.isOp(",", 1) || this.isOp("]", 1))) byRef = true; if (this.isOp("=") ) byVal = true; this.p++; }
    this.expect("]");
    let params = []; if (this.isOp("(")) params = this.parseParams();
    while (this.peek().t === "id" && ["mutable", "noexcept", "constexpr"].includes(this.peek().v)) this.p++;
    let ret = null; if (this.accept("->")) ret = this.parseType();
    const body = this.parseBlock();
    return { k: "lambda", params, body, ret, byRef, byVal, line };
  }
  parsePrimary() {
    const t = this.peek(), line = t.line;
    switch (t.t) {
      case "num": { this.p++; return this.numLit(t); }
      case "str": this.p++; return { k: "lit", kind: "string", v: t.v, line };
      case "chr": this.p++; return { k: "lit", kind: "char", v: t.v, line };
      case "op":
        if (t.v === "(") { this.p++; const e = this.parseExpr(); this.expect(")"); return e.k === "name" || e.k === "lit" ? { k: "paren", e, line } : { k: "paren", e, line }; }
        if (t.v === "{") return { k: "initList", elems: this.parseBraceArgs(), line };
        if (t.v === "[") return this.parseLambda();
        this.fail(`Unexpected '${t.v}'`);
      case "id": break;
      default: this.fail(`Unexpected ${t.v}`);
    }
    // identifiers
    switch (t.v) {
      case "true": case "false": this.p++; return { k: "lit", kind: "bool", v: t.v === "true", line };
      case "nullptr": case "NULL": this.p++; return { k: "lit", kind: "null", v: null, line };
      case "this": this.p++; return { k: "this", line };
      case "static_cast": case "reinterpret_cast": case "const_cast": case "dynamic_cast": {
        this.p++; this.expect("<"); const type = this.parseType(); this.expect(">"); this.expect("("); const e = this.parseExpr(); this.expect(")");
        return { k: "cast", type, e, line };
      }
      case "numeric_limits": {
        this.p++; const args = this.parseTypeArgs(); this.expect("::"); const which = this.ident(); this.expect("("); this.expect(")");
        return { k: "numlim", type: args[0], which, line };
      }
      case "get": if (this.isOp("<", 1) && this.peek(2).t === "num" && this.isOp(">", 3)) { this.p += 2; const n = Number(this.next().v.text); this.p++; return { k: "name", id: "get", targ: n, line }; } break;
    }
    // type-constructed expression: vector<int>(n), pair<int,int>{1,2}, TreeNode(5), int(x), string::npos ...
    if (this.isTypeName(t.v, this.isOp("<", 1))) {
      const save = this.p; const ty = this.typeOpt();
      if (ty && !ty.ref) {
        if (this.isOp("(")) {
          const args = this.parseArgs();
          return BUILTIN_KW.has(t.v) || ["int", "ll", "uint", "ull", "double", "float", "char", "bool", "short", "uchar", "ushort"].includes(ty.name) && ty.args.length === 0 && !this.types.has(ty.name) ? { k: "cast", type: ty, e: args[0] || { k: "lit", kind: "int", v: 0, line }, line } : { k: "construct", type: ty, args, brace: false, line };
        }
        if (this.isOp("{")) return { k: "construct", type: ty, args: this.parseBraceArgs(), brace: true, line };
        if (this.isOp("::") && ty.args.length === 0) { this.p++; const name = this.ident(); return { k: "scope", cls: ty.name, name, line }; }
      }
      this.p = save;
    }
    if ((this.templateFuncs.has(t.v) || ["max", "min", "swap", "abs", "make_pair", "accumulate", "to_string", "pow"].includes(t.v)) && this.isOp("<", 1)) {
      const save = this.p; this.p++;
      try { this.parseTypeArgs(); if (this.isOp("(")) return { k: "name", id: t.v, line }; } catch (e) { if (!(e instanceof CppSyntaxError)) throw e; }
      this.p = save;
    }
    this.p++;
    if (this.isOp("::") && this.peek(1).t === "id") {
      let cls = t.v, name = t.v;
      while (this.isOp("::") && this.peek(1).t === "id") { this.p++; cls = name; name = this.ident(); }
      return { k: "scope", cls, name, line };
    }
    return { k: "name", id: t.v, line };
  }
  numLit(t) {
    const { text, sfx, isFloat } = t.v, line = t.line;
    if (isFloat || (!/^0[xXbB]/.test(text) && /[eE]/.test(text) && !/^0[xX]/.test(text))) {
      return { k: "lit", kind: sfx.includes("f") ? "float" : "double", v: parseFloat(text), line };
    }
    let big;
    if (/^0[xX]/.test(text)) big = BigInt(text); else if (/^0[bB]/.test(text)) big = BigInt(text); else if (/^0\d/.test(text)) big = BigInt("0o" + text.slice(1)); else big = BigInt(text);
    const dec = !/^0[xXbB0-9]/.test(text) || /^[1-9]/.test(text), uns = sfx.includes("u"), longs = (sfx.match(/l/g) || []).length;
    let kind;
    if (!uns && !longs) kind = big <= 2147483647n ? "int" : (!dec && big <= 4294967295n) ? "uint" : big <= 9223372036854775807n ? "ll" : "ull";
    else if (uns && !longs) kind = big <= 4294967295n ? "uint" : "ull";
    else if (!uns) kind = big <= 9223372036854775807n ? "ll" : "ull";
    else kind = "ull";
    return { k: "lit", kind, v: kind === "int" ? Number(big) : big, line };
  }
}

export function parse(src, extraTypes = ["ListNode", "TreeNode"]) {
  const toks = preprocess(lex(src));
  const p = new Parser(toks);
  for (const t of extraTypes) p.types.add(t);
  return p.parseUnit();
}
