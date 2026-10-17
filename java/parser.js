// Java-subset lexer + recursive-descent parser (no eval, no dependencies).
// Produces a plain-object AST; every node carries the source `line` of its first token.

export class JavaSyntaxError extends Error {
  constructor(msg, line) { super(`${msg} (line ${line})`); this.line = line; }
}

const PRIMS = new Set(["int", "long", "double", "float", "boolean", "char", "byte", "short", "void"]);
const MODIFIERS = new Set(["public", "private", "protected", "static", "final", "abstract", "synchronized", "native", "transient", "volatile", "strictfp", "default", "sealed"]);
const MULTI_OPS = ["<<=", "...", "->", "::", "++", "--", "&&", "||", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<"];
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="]);

export function lex(src) {
  const toks = []; let i = 0, line = 1; const n = src.length;
  const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0", "\\": "\\", "'": "'", '"': '"' };
  const readEscaped = (quote) => {
    let out = ""; i++;
    while (i < n && src[i] !== quote) {
      if (src[i] === "\n") throw new JavaSyntaxError("Unterminated literal", line);
      if (src[i] === "\\") {
        const e = src[i + 1];
        if (e === "u") { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        out += ESC[e] ?? e; i += 2;
      } else out += src[i++];
    }
    i++; return out;
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2), end = e < 0 ? n : e + 2;
      for (let k = i; k < end; k++) if (src[k] === "\n") line++;
      i = end; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (j < n && /[\w$]/.test(src[j])) j++; toks.push({ t: "id", v: src.slice(i, j), line, s: i, e: j }); i = j; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+[lL]?|0[bB][01_]+[lL]?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[fFdDlL]?)/.exec(src.slice(i, i + 64));
      const text = m[0].replace(/_/g, "");
      const hex = /^0[xXbB]/.test(text);
      const kind = /[lL]$/.test(text) ? "long" : (!hex && (/[.eE]/.test(text) || /[fFdD]$/.test(text))) ? "double" : "int";
      toks.push({ t: "num", v: text, kind, line, s: i, e: i + m[0].length }); i += m[0].length; continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) throw new JavaSyntaxError("Text blocks are not supported", line);
      const s = i; toks.push({ t: "str", v: readEscaped('"'), line, s, e: i }); continue;
    }
    if (c === "'") { const s = i; toks.push({ t: "chr", v: readEscaped("'"), line, s, e: i }); continue; }
    if (c === "@") { // annotation: skip @Name and optional (...)
      i++; while (i < n && /[\w.]/.test(src[i])) i++;
      if (src[i] === "(") { let d = 0; do { if (src[i] === "(") d++; else if (src[i] === ")") d--; i++; } while (i < n && d > 0); }
      continue;
    }
    const op = MULTI_OPS.find((o) => src.startsWith(o, i));
    if (op) { toks.push({ t: "op", v: op, line, s: i, e: i + op.length }); i += op.length; continue; }
    if ("(){}[];,.=<>!~?:+-*/%&|^".includes(c)) { toks.push({ t: "op", v: c, line, s: i, e: i + 1 }); i++; continue; }
    throw new JavaSyntaxError(`Unexpected character '${c}'`, line);
  }
  toks.push({ t: "eof", v: "<end of file>", line, s: n, e: n });
  return toks;
}

export function parse(src) { return new Parser(lex(src)).parseCompilationUnit(); }

class Parser {
  constructor(toks) { this.toks = toks; this.p = 0; }
  get tok() { return this.toks[this.p]; }
  at(k = 0) { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  err(msg, tok = this.tok) { throw new JavaSyntaxError(msg, tok.line); }
  isOp(v, k = 0) { const t = this.at(k); return t.t === "op" && t.v === v; }
  isKw(v, k = 0) { const t = this.at(k); return t.t === "id" && t.v === v; }
  eatOp(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.p++; return true; } return false; }
  expectOp(v) { if (!this.eatOp(v)) this.err(`Expected '${v}' but found '${this.tok.v}'`); }
  ident() { const t = this.tok; if (t.t !== "id") this.err(`Expected a name but found '${t.v}'`); this.p++; return t.v; }

  parseCompilationUnit() {
    const classes = [];
    while (this.tok.t !== "eof") {
      if (this.isKw("import") || this.isKw("package")) { while (!this.isOp(";") && this.tok.t !== "eof") this.p++; this.p++; continue; }
      if (this.eatOp(";")) continue;
      this.skipModifiers();
      if (this.isKw("class") || this.isKw("interface") || this.isKw("enum") || this.isKw("record")) classes.push(this.parseClass());
      else this.err(`Unexpected '${this.tok.v}' at top level`);
    }
    return { classes };
  }
  skipModifiers() { const mods = new Set(); while (this.tok.t === "id" && MODIFIERS.has(this.tok.v) && !(this.tok.v === "default" && (this.isOp(":", 1) || this.isOp("->", 1)))) mods.add(this.tok.v), this.p++; return mods; }

  parseClass() {
    const kind = this.ident(), line = this.at(-1).line;
    if (kind === "enum" || kind === "record") this.err(`'${kind}' declarations are not supported yet`, this.at(-1));
    const name = this.ident();
    if (this.isOp("<")) this.parseTypeArgs(true);
    let parent = null;
    if (this.eatKw("extends")) { parent = this.parseType().name; while (this.eatOp(",")) this.parseType(); }
    if (this.eatKw("implements")) { do this.parseType(); while (this.eatOp(",")); }
    const cls = { k: "class", name, parent, isInterface: kind === "interface", fields: [], methods: [], ctors: [], inits: [], inner: [], line };
    this.parseClassBody(cls);
    return cls;
  }
  parseClassBody(cls) {
    this.expectOp("{");
    while (!this.isOp("}")) {
      if (this.tok.t === "eof") this.err("Unexpected end of file; missing '}'");
      if (this.eatOp(";")) continue;
      const mods = this.skipModifiers(), line = this.tok.line;
      if (this.isKw("class") || this.isKw("interface") || this.isKw("enum") || this.isKw("record")) { const inner = this.parseClass(); inner.isStatic = mods.has("static"); cls.inner.push(inner); continue; }
      if (this.isOp("{")) { cls.inits.push({ static: mods.has("static"), body: this.parseBlock() }); continue; }
      if (this.isOp("<")) this.parseTypeArgs(true); // generic method type params
      if (this.tok.t === "id" && this.tok.v === cls.name && this.isOp("(", 1)) { // constructor
        this.p++; const params = this.parseParams();
        this.skipThrows();
        cls.ctors.push({ params, body: this.parseBlock(), line });
        continue;
      }
      const type = this.parseType(), name = this.ident();
      if (this.isOp("(")) {
        const params = this.parseParams(); this.skipThrows();
        while (this.isOp("[")) { this.p += 2; type.dims++; }
        const body = this.isOp("{") ? this.parseBlock() : (this.expectOp(";"), null);
        cls.methods.push({ name, type, params, body, static: mods.has("static"), line });
      } else {
        this.p--; // re-read the name as a declarator
        for (const d of this.parseDeclarators(type)) cls.fields.push({ name: d.name, type: d.type, init: d.init, static: mods.has("static"), line });
        this.expectOp(";");
      }
    }
    this.expectOp("}");
  }
  skipThrows() { if (this.eatKw("throws")) { do this.parseType(); while (this.eatOp(",")); } }
  parseParams() {
    this.expectOp("("); const params = [];
    while (!this.isOp(")")) {
      this.eatKw("final");
      const type = this.parseType(); let varargs = false;
      if (this.eatOp("...")) { varargs = true; type.dims++; }
      const name = this.ident();
      while (this.isOp("[")) { this.p += 2; type.dims++; }
      params.push({ name, type, varargs });
      if (!this.eatOp(",")) break;
    }
    this.expectOp(")"); return params;
  }

  // ---- types
  parseType() {
    if (this.tok.t !== "id") this.err(`Expected a type but found '${this.tok.v}'`);
    let name = this.ident(), args = [];
    if (this.isOp("<")) args = this.parseTypeArgs();
    while (this.isOp(".") && this.at(1).t === "id") { this.p++; name = this.ident(); if (this.isOp("<")) args = this.parseTypeArgs(); } // Map.Entry<K,V> -> Entry
    let dims = 0;
    while (this.isOp("[") && this.isOp("]", 1)) { this.p += 2; dims++; }
    return { name, args, dims };
  }
  parseTypeArgs(declaring = false) {
    this.expectOp("<"); const args = [];
    if (this.eatOp(">")) return args; // diamond
    do {
      if (this.eatOp("?")) { if (this.eatKw("extends") || this.eatKw("super")) args.push(this.parseType()); else args.push({ name: "Object", args: [], dims: 0 }); }
      else { args.push(this.parseType()); if (declaring && this.eatKw("extends")) { this.parseType(); while (this.eatOp("&")) this.parseType(); } }
    } while (this.eatOp(","));
    this.expectOp(">"); return args;
  }

  // ---- statements
  parseBlock() {
    const line = this.tok.line; this.expectOp("{"); const body = [];
    while (!this.isOp("}")) { if (this.tok.t === "eof") this.err("Unexpected end of file; missing '}'"); body.push(this.parseStatement()); }
    this.p++; return { k: "block", body, line };
  }
  isLocalVarDecl() {
    const save = this.p;
    try {
      while (this.isKw("final")) this.p++;
      const t = this.tok;
      if (t.t !== "id") return false;
      if (PRIMS.has(t.v)) return !this.isOp(".", 1);
      if (["return", "new", "this", "throw", "if", "while", "for", "do", "switch", "break", "continue", "try", "else", "super", "yield", "assert"].includes(t.v)) return false;
      this.parseType();
      const n = this.tok;
      return n.t === "id" && n.v !== "instanceof" && (this.isOp("=", 1) || this.isOp(";", 1) || this.isOp(",", 1) || this.isOp(":", 1) || this.isOp("[", 1));
    } catch { return false; } finally { this.p = save; }
  }
  parseDeclarators(baseType) {
    const decls = [];
    do {
      const name = this.ident(); let dims = baseType.dims;
      while (this.isOp("[")) { this.p += 2; dims++; }
      const type = { ...baseType, dims };
      let init = null;
      if (this.eatOp("=")) init = this.isOp("{") ? this.parseArrayInit(type) : this.parseExpr();
      decls.push({ name, type, init });
    } while (this.eatOp(","));
    return decls;
  }
  parseArrayInit(type) {
    const line = this.tok.line; this.expectOp("{"); const elems = [];
    const inner = { ...type, dims: Math.max(0, type.dims - 1) };
    while (!this.isOp("}")) { elems.push(this.isOp("{") ? this.parseArrayInit(inner) : this.parseExpr()); if (!this.eatOp(",")) break; }
    this.expectOp("}"); return { k: "arrayInit", elems, type, line };
  }
  parseStatement() {
    const t = this.tok, line = t.line;
    if (t.t === "op") {
      if (t.v === "{") return this.parseBlock();
      if (t.v === ";") { this.p++; return { k: "empty", line }; }
    }
    if (t.t === "id") {
      switch (t.v) {
        case "if": { this.p++; this.expectOp("("); const cond = this.parseExpr(); this.expectOp(")"); const then = this.parseStatement(); const els = this.eatKw("else") ? this.parseStatement() : null; return { k: "if", cond, then, els, line }; }
        case "while": { this.p++; this.expectOp("("); const cond = this.parseExpr(); this.expectOp(")"); return { k: "while", cond, body: this.parseStatement(), line }; }
        case "do": { this.p++; const body = this.parseStatement(); if (!this.eatKw("while")) this.err("Expected 'while'"); this.expectOp("("); const cond = this.parseExpr(); this.expectOp(")"); this.expectOp(";"); return { k: "doWhile", cond, body, line }; }
        case "for": return this.parseFor();
        case "return": { this.p++; const e = this.isOp(";") ? null : this.parseExpr(); this.expectOp(";"); return { k: "return", e, line }; }
        case "break": case "continue": { this.p++; const label = this.tok.t === "id" ? this.ident() : null; this.expectOp(";"); return { k: t.v, label, line }; }
        case "throw": { this.p++; const e = this.parseExpr(); this.expectOp(";"); return { k: "throw", e, line }; }
        case "yield": if (!this.isOp("=", 1) && !this.isOp(".", 1)) { this.p++; const e = this.parseExpr(); this.expectOp(";"); return { k: "yield", e, line }; } break;
        case "assert": { this.p++; this.parseExpr(); if (this.eatOp(":")) this.parseExpr(); this.expectOp(";"); return { k: "empty", line }; }
        case "try": return this.parseTry();
        case "switch": { const sw = this.parseSwitch(); return { ...sw, k: "switch" }; }
        case "class": case "interface": return { k: "localClass", cls: this.parseClass(), line };
        default:
          if (this.at(1).t === "op" && this.at(1).v === ":" && !PRIMS.has(t.v)) { this.p += 2; return { k: "labeled", label: t.v, stmt: this.parseStatement(), line }; }
      }
    }
    if (this.isLocalVarDecl()) { const s = this.parseLocalVar(); this.expectOp(";"); return s; }
    const e = this.parseExpr(); this.expectOp(";");
    return { k: "expr", e, line };
  }
  parseLocalVar() {
    const line = this.tok.line; while (this.eatKw("final"));
    const type = this.parseType();
    return { k: "local", type, decls: this.parseDeclarators(type), line };
  }
  parseFor() {
    const line = this.tok.line; this.p++; this.expectOp("(");
    let init = [];
    if (this.isLocalVarDecl()) {
      const save = this.p; while (this.eatKw("final"));
      const type = this.parseType(), name = this.ident();
      if (this.eatOp(":")) { const iter = this.parseExpr(); this.expectOp(")"); return { k: "foreach", type, name, iter, body: this.parseStatement(), line }; }
      this.p = save; init = [this.parseLocalVar()];
    } else if (!this.isOp(";")) { do init.push({ k: "expr", e: this.parseExpr(), line }); while (this.eatOp(",")); }
    this.expectOp(";");
    const cond = this.isOp(";") ? null : this.parseExpr(); this.expectOp(";");
    const update = [];
    if (!this.isOp(")")) do update.push(this.parseExpr()); while (this.eatOp(","));
    this.expectOp(")");
    return { k: "for", init, cond, update, body: this.parseStatement(), line };
  }
  parseTry() {
    const line = this.tok.line; this.p++;
    let resources = [];
    if (this.eatOp("(")) { while (!this.isOp(")")) { resources.push(this.parseLocalVar()); if (!this.eatOp(";")) break; } this.expectOp(")"); }
    const block = this.parseBlock(), catches = []; let fin = null;
    while (this.eatKw("catch")) {
      this.expectOp("("); this.eatKw("final"); const types = [this.parseType().name]; while (this.eatOp("|")) types.push(this.parseType().name);
      const name = this.ident(); this.expectOp(")"); catches.push({ types, name, body: this.parseBlock() });
    }
    if (this.eatKw("finally")) fin = this.parseBlock();
    return { k: "try", resources, block, catches, fin, line };
  }
  parseSwitch() {
    const line = this.tok.line; this.p++; this.expectOp("("); const expr = this.parseExpr(); this.expectOp(")"); this.expectOp("{");
    const cases = [];
    while (!this.isOp("}")) {
      const labels = []; let isDefault = false;
      if (this.eatKw("default")) isDefault = true;
      else if (this.eatKw("case")) { do { if (this.eatKw("default")) isDefault = true; else labels.push(this.parseTernary()); } while (this.eatOp(",")); }
      else this.err(`Expected 'case' or 'default' but found '${this.tok.v}'`);
      let arrow = false, body = [];
      if (this.eatOp("->")) {
        arrow = true;
        if (this.isOp("{")) body = [this.parseBlock()];
        else if (this.isKw("throw")) body = [this.parseStatement()];
        else { const l = this.tok.line, e = this.parseExpr(); this.expectOp(";"); body = [{ k: "arrowExpr", e, line: l }]; }
      } else {
        this.expectOp(":");
        while (!this.isKw("case") && !this.isKw("default") && !this.isOp("}")) body.push(this.parseStatement());
      }
      cases.push({ labels, isDefault, arrow, body });
    }
    this.p++; return { k: "switchExpr", expr, cases, line };
  }

  // ---- expressions
  parseExpr() { return this.parseAssign(); }
  peekOp() { // merges adjacent '>' tokens (the lexer never fuses them so generics like List<List<X>> parse)
    const t = this.tok; if (t.t !== "op") return null;
    if (t.v !== ">") return { op: t.v, len: 1 };
    const a = this.at(1), b = this.at(2), c = this.at(3);
    const adj = (x, y) => x.e === y.s;
    if (a.t === "op" && a.v === ">" && adj(t, a)) {
      if (b.t === "op" && b.v === ">" && adj(a, b)) return c.t === "op" && c.v === ">=" && adj(b, c) ? { op: ">>>=", len: 4 } : { op: ">>>", len: 3 };
      if (b.t === "op" && b.v === ">=" && adj(a, b)) return { op: ">>>=", len: 3 };
      return { op: ">>", len: 2 };
    }
    if (a.t === "op" && a.v === ">=" && adj(t, a)) return { op: ">>=", len: 2 };
    return { op: ">", len: 1 };
  }
  parseAssign() {
    const line = this.tok.line, left = this.parseTernary(), pk = this.peekOp();
    if (pk && ASSIGN_OPS.has(pk.op)) {
      if (!["name", "field", "index"].includes(left.k)) this.err("Invalid assignment target");
      this.p += pk.len; return { k: "assign", op: pk.op, target: left, value: this.parseAssign(), line };
    }
    return left;
  }
  parseTernary() {
    const line = this.tok.line, c = this.parseBinary(0);
    if (this.eatOp("?")) { const a = this.parseAssign(); this.expectOp(":"); const b = this.parseTernary(); return { k: "cond", c, a, b, line }; }
    return c;
  }
  parseBinary(level) {
    const LEVELS = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">=", "instanceof"], ["<<", ">>", ">>>"], ["+", "-"], ["*", "/", "%"]];
    if (level >= LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const line = this.tok.line; let op, len = 1;
      if (this.tok.t === "id" && this.tok.v === "instanceof" && LEVELS[level].includes("instanceof")) {
        this.p++; const type = this.parseType(); if (this.tok.t === "id" && !this.isKw("instanceof")) this.p++;
        left = { k: "instanceof", e: left, type, line }; continue;
      }
      const pk = this.peekOp(); if (!pk || ASSIGN_OPS.has(pk.op) || !LEVELS[level].includes(pk.op)) return left;
      op = pk.op; len = pk.len; this.p += len;
      left = { k: "binary", op, l: left, r: this.parseBinary(level + 1), line };
    }
  }
  parseUnary() {
    const t = this.tok, line = t.line;
    if (t.t === "op") {
      if (t.v === "++" || t.v === "--") { this.p++; return { k: "update", op: t.v, prefix: true, target: this.parseUnary(), line }; }
      if (["+", "-", "!", "~"].includes(t.v)) {
        this.p++;
        if (t.v === "-" && this.tok.t === "num" && !/[xXbB]/.test(this.tok.v.slice(0, 2))) { /* keep generic path: unary minus on literal */ }
        return { k: "unary", op: t.v, e: this.parseUnary(), line };
      }
      if (t.v === "(") { const cast = this.tryCast(); if (cast) return cast; }
    }
    return this.parsePostfix(this.parsePrimary());
  }
  tryCast() {
    const save = this.p, line = this.tok.line;
    this.p++;
    try {
      if (this.tok.t !== "id") { this.p = save; return null; }
      const isPrim = PRIMS.has(this.tok.v);
      if (!isPrim && !/^[A-Z]/.test(this.tok.v)) { this.p = save; return null; }
      const type = this.parseType();
      while (this.eatOp("&")) this.parseType();
      if (!this.eatOp(")")) { this.p = save; return null; }
      const n = this.tok;
      const startsOperand = n.t === "id" || n.t === "num" || n.t === "str" || n.t === "chr" || (n.t === "op" && ["(", "!", "~"].includes(n.v)) || (isPrim && n.t === "op" && ["-", "+", "++", "--"].includes(n.v));
      if (!startsOperand || (n.t === "id" && n.v === "instanceof")) { this.p = save; return null; }
      return { k: "cast", type, e: this.parseUnary(), line };
    } catch { this.p = save; return null; }
  }
  parsePostfix(e) {
    for (;;) {
      const line = this.tok.line;
      if (this.isOp(".")) {
        this.p++;
        if (this.isOp("<")) this.parseTypeArgs();
        const name = this.ident();
        e = this.isOp("(") ? { k: "call", obj: e, name, args: this.parseArgs(), line } : { k: "field", obj: e, name, line };
      } else if (this.isOp("[")) { this.p++; const idx = this.parseExpr(); this.expectOp("]"); e = { k: "index", obj: e, idx, line }; }
      else if (this.isOp("++") || this.isOp("--")) { const op = this.tok.v; this.p++; e = { k: "update", op, prefix: false, target: e, line }; }
      else if (this.isOp("::")) { this.p++; const name = this.isKw("new") ? (this.p++, "new") : this.ident(); e = { k: "methodRef", obj: e, name, line }; }
      else return e;
    }
  }
  parseArgs() {
    this.expectOp("("); const args = [];
    while (!this.isOp(")")) { args.push(this.parseExpr()); if (!this.eatOp(",")) break; }
    this.expectOp(")"); return args;
  }
  isLambdaAhead() {
    if (this.tok.t === "id" && this.isOp("->", 1)) return true;
    if (!this.isOp("(")) return false;
    let d = 0, k = 0;
    for (;; k++) { const t = this.at(k); if (t.t === "eof") return false; if (t.t === "op" && t.v === "(") d++; if (t.t === "op" && t.v === ")") { d--; if (d === 0) break; } }
    return this.isOp("->", k + 1);
  }
  parseLambda() {
    const line = this.tok.line, params = [];
    if (this.tok.t === "id") params.push(this.ident());
    else {
      this.expectOp("(");
      while (!this.isOp(")")) { let last = null; while (!this.isOp(",") && !this.isOp(")")) { if (this.tok.t === "id") last = this.tok.v; this.p++; } params.push(last); if (!this.eatOp(",")) break; }
      this.expectOp(")");
    }
    this.expectOp("->");
    const body = this.isOp("{") ? this.parseBlock() : this.parseExpr();
    return { k: "lambda", params, body, line };
  }
  parsePrimary() {
    const t = this.tok, line = t.line;
    if (t.t === "num") { this.p++; return { k: "lit", kind: t.kind, text: t.v, line }; }
    if (t.t === "str") { this.p++; return { k: "lit", kind: "string", v: t.v, line }; }
    if (t.t === "chr") { this.p++; return { k: "lit", kind: "char", v: t.v, line }; }
    if (this.isLambdaAhead()) return this.parseLambda();
    if (t.t === "op" && t.v === "(") { this.p++; const e = this.parseExpr(); this.expectOp(")"); return { k: "paren", e, line }; }
    if (t.t === "id") {
      switch (t.v) {
        case "true": case "false": this.p++; return { k: "lit", kind: "bool", v: t.v === "true", line };
        case "null": this.p++; return { k: "lit", kind: "null", line };
        case "this": this.p++; return this.isOp("(") ? { k: "ctorCall", args: this.parseArgs(), line } : { k: "this", line };
        case "super": this.p++; return this.isOp("(") ? { k: "superCall", args: this.parseArgs(), line } : { k: "name", id: "super", line };
        case "new": return this.parseNew();
        case "switch": return this.parseSwitch();
      }
      if (PRIMS.has(t.v) && (this.isOp("[", 1) || this.isOp("::", 1))) { // int[]::new etc. (unsupported) 
        this.err("Method references on primitive types are not supported");
      }
      this.p++;
      if (this.isOp("(")) return { k: "call", obj: null, name: t.v, args: this.parseArgs(), line };
      return { k: "name", id: t.v, line };
    }
    this.err(`Unexpected '${t.v}'`);
  }
  parseNew() {
    const line = this.tok.line; this.p++;
    let name = this.ident(), args = [];
    while (this.isOp(".") && this.at(1).t === "id") { this.p++; name = this.ident(); }
    if (this.isOp("<")) args = this.parseTypeArgs();
    const type = { name, args, dims: 0 };
    if (this.isOp("[")) {
      const dimExprs = []; let extra = 0;
      while (this.isOp("[")) { this.p++; if (this.eatOp("]")) extra++; else { dimExprs.push(this.parseExpr()); this.expectOp("]"); } }
      const total = dimExprs.length + extra;
      let init = null;
      if (this.isOp("{")) init = this.parseArrayInit({ ...type, dims: total });
      return { k: "newArray", type, dimExprs, total, init, line };
    }
    const cargs = this.parseArgs();
    let body = null;
    if (this.isOp("{")) { body = { k: "class", name: "$anon", parent: name, fields: [], methods: [], ctors: [], inits: [], inner: [], line }; this.parseClassBody(body); }
    return { k: "new", type, args: cargs, body, line };
  }
}
