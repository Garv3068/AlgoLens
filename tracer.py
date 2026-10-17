"""AlgoLens tracer: static analysis + step-by-step execution trace for LeetCode-style Python.

Runs inside Pyodide (WebAssembly) in a Web Worker. Public entry points:
  analyze_code(code)            -> dict (algorithm tags, complexity estimate, pointer names)
  parse_examples(problem_text)  -> list of {"label", "input", "output"}
  run_trace(code, input_text, max_steps) -> dict (steps, result, stdout, error)
"""
import ast
import io
import json
import re
import sys
import traceback
import types

USER_FILE = "<solution>"
MAX_ITEMS = 40       # elements shown per list/dict/set
MAX_STR = 60
MAX_DEPTH = 3


_NID = {}     # id(obj) -> small stable integer (per run)
_KEEP = []    # keeps snapshotted objects alive so id() values are never reused during a run


def _nid(o):
    k = id(o)
    n = _NID.get(k)
    if n is None:
        n = len(_NID) + 1
        _NID[k] = n
        _KEEP.append(o)
    return n


def _is_ll(v):
    return hasattr(v, "val") and hasattr(v, "next") and not isinstance(v, (type, types.ModuleType))


def _is_tree(v):
    return hasattr(v, "val") and hasattr(v, "left") and hasattr(v, "right") and not isinstance(v, (type, types.ModuleType))


def _plain(x):
    return x if isinstance(x, (int, float, str, bool, type(None))) else str(x)


class _Abort(BaseException):
    """Raised from the trace function to stop runaway programs (BaseException so user code can't swallow it)."""


# ---------------------------------------------------------------- LeetCode helper types
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right


def build_list(values):
    head = None
    for v in reversed(values):
        head = ListNode(v, head)
    return head


def build_tree(values):
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue, i = [root], 1
    while queue and i < len(values):
        node = queue.pop(0)
        if i < len(values) and values[i] is not None:
            node.left = TreeNode(values[i])
            queue.append(node.left)
        i += 1
        if i < len(values) and values[i] is not None:
            node.right = TreeNode(values[i])
            queue.append(node.right)
        i += 1
    return root


# ---------------------------------------------------------------- example parsing
def _to_python_literal(text):
    text = text.strip().rstrip(".")
    text = re.sub(r"\bnull\b", "None", text)
    text = re.sub(r"\btrue\b", "True", text)
    text = re.sub(r"\bfalse\b", "False", text)
    return text


def parse_examples(problem_text):
    """Pull 'Input: a = 1, b = [..]' blocks out of the problem statement."""
    examples = []
    pattern = re.compile(r"Input:\s*(.+?)\s*(?:\n+\s*)?Output:\s*(.+?)(?=\n\s*(?:Explanation:|Example\s*\d|Constraints:|Input:)|\Z)",
                         re.S | re.I)
    for m in pattern.finditer(problem_text or ""):
        inp = " ".join(m.group(1).split())
        out = " ".join(m.group(2).split())
        examples.append({"label": f"Example {len(examples) + 1}", "input": inp, "output": out})
    return examples


def parse_input_text(input_text):
    """'nums = [2,7], target = 9' -> {'nums': [2, 7], 'target': 9} (order preserved)."""
    text = input_text.strip()
    matches = list(re.finditer(r"(?:(?<=^)|(?<=,\s)|(?<=,))\s*([A-Za-z_]\w*)\s*=\s*", text))
    # keep only matches that sit at top level (not inside brackets/strings)
    good, depth, in_str, q, pos = [], 0, False, "", 0
    starts = {m.start(1): m for m in matches}
    for idx, ch in enumerate(text):
        if idx in starts and depth == 0 and not in_str:
            good.append(starts[idx])
        if in_str:
            if ch == q and text[idx - 1] != "\\":
                in_str = False
        elif ch in "\"'":
            in_str, q = True, ch
        elif ch in "[({":
            depth += 1
        elif ch in "])}":
            depth -= 1
    if not good:
        raise ValueError("Input must look like:  nums = [1,2,3], target = 6")
    out = {}
    for n, m in enumerate(good):
        end = good[n + 1].start(0) if n + 1 < len(good) else len(text)
        raw = text[m.end():end].strip().rstrip(",").strip()
        try:
            out[m.group(1)] = ast.literal_eval(_to_python_literal(raw))
        except Exception:
            raise ValueError(f"Could not read the value of '{m.group(1)}': {raw[:40]}")
    return out


# ---------------------------------------------------------------- static analysis
def _loop_depth(node, depth=0):
    best = depth
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.For, ast.While, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            best = max(best, _loop_depth(child, depth + 1))
        else:
            best = max(best, _loop_depth(child, depth))
    return best


def analyze_code(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"ok": False, "error": f"Syntax error on line {e.lineno}: {e.msg}"}

    src = code
    tags, evidence = [], {}

    def tag(name, why):
        if name not in tags:
            tags.append(name)
            evidence[name] = why

    funcs = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    names_called = {}
    subscript_names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            f = n.func
            key = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
            if key:
                names_called[key] = names_called.get(key, 0) + 1

    # index-like variables: names used inside subscripts in function bodies (not type annotations)
    for fn in funcs:
        for stmt in fn.body:
            for n in ast.walk(stmt):
                if isinstance(n, ast.Subscript):
                    for sub in ast.walk(n.slice):
                        if isinstance(sub, ast.Name):
                            subscript_names.add(sub.id)

    # recursion
    recursive = False
    for fn in funcs:
        for n in ast.walk(fn):
            if isinstance(n, ast.Call):
                f = n.func
                if (isinstance(f, ast.Name) and f.id == fn.name) or \
                   (isinstance(f, ast.Attribute) and f.attr == fn.name and isinstance(f.value, ast.Name) and f.value.id == "self"):
                    recursive = True
    if recursive:
        tag("Recursion", "a function calls itself")
    if re.search(r"@(?:functools\.)?(?:cache|lru_cache)", src):
        tag("Memoization", "uses @cache / @lru_cache")

    # binary search
    if re.search(r"\b(mid|m)\s*=\s*\(?\s*\w+\s*[+]\s*\w+\s*\)?\s*//\s*2", src) or \
       re.search(r"\bmid\s*=\s*\w+\s*\+\s*\(\s*\w+\s*-\s*\w+\s*\)\s*//\s*2", src) or "bisect" in names_called:
        tag("Binary search", "computes a midpoint of two bounds")

    # two pointers / sliding window
    has_while_lr = False
    for n in ast.walk(tree):
        if isinstance(n, ast.While) and isinstance(n.test, ast.Compare):
            seg = ast.unparse(n.test)
            if re.search(r"\b(l|left|lo|low|i|start|slow)\b\s*<=?\s*\b(r|right|hi|high|j|end|fast)\b", seg):
                has_while_lr = True
    if has_while_lr and "Binary search" not in tags:
        tag("Two pointers", "while loop moves two indices toward each other")
    if re.search(r"\b(left|l)\s*\+=\s*1", src) and re.search(r"for\s+(right|r|j)\b", src):
        tag("Sliding window", "right pointer advances in a for-loop while left is moved forward")

    # data structures
    if re.search(r"\b(dict|defaultdict|Counter)\b|=\s*\{\s*\}|\{[^}]*:[^}]*\}", src):
        tag("Hash map", "uses a dict / Counter")
    if re.search(r"\bset\s*\(|=\s*\{[^:}]+\}", src):
        tag("Hash set", "uses a set")
    if "deque" in names_called or "popleft" in names_called:
        tag("BFS / queue", "uses a deque and popleft()")
    if "heappush" in names_called or "heappop" in names_called or "heapify" in names_called:
        tag("Heap / priority queue", "uses heapq")
    if "sort" in names_called or "sorted" in names_called:
        tag("Sorting", "calls sort()/sorted()")
    if "append" in names_called and "pop" in names_called and "popleft" not in names_called:
        tag("Stack", "append() and pop() on the same list")

    # dp
    if re.search(r"\bdp\b|\bmemo\b|\bcache\b", src):
        tag("Dynamic programming", "a dp / memo table")
    if re.search(r"max\(\s*\w+\s*,\s*\w+\s*\+\s*\w+\s*\)", src):
        tag("Kadane-style running best", "max(x, running + x) update")
    if re.search(r"\bprefix|cumsum|accumulate", src):
        tag("Prefix sums", "prefix / accumulate")
    if recursive and re.search(r"\.append\(.*\)\s*\n\s*.*(?:self\.)?\w+\(.*\)\s*\n\s*.*\.pop\(\)", src):
        tag("Backtracking", "choose → recurse → undo")

    # complexity (heuristic, from structure only)
    depth = _loop_depth(tree)
    uses_sort = "sort" in names_called or "sorted" in names_called
    log_loop = "Binary search" in tags
    if recursive and "Memoization" not in tags and "Dynamic programming" not in tags:
        time = "Depends on recursion (often O(n) tree/DFS or exponential for branching)"
    elif depth == 0 and not uses_sort:
        time = "O(1) or O(n) via built-ins"
    else:
        k = depth
        if log_loop and k <= 1:
            time = "O(log n)"
        else:
            time = "O(n)" if k == 1 else ("O(n²)" if k == 2 else f"O(n^{k})")
            if uses_sort and k <= 1:
                time = "O(n log n)"
    makes_struct = bool(re.search(r"\b(dict|set|list|defaultdict|Counter|deque)\s*\(|=\s*\[\s*\]|=\s*\{\s*\}|\[[^\]\n]*\bfor\b[^\]\n]*\]|\[\s*0\s*\]\s*\*", src)) or "dp" in src
    space = "O(n) auxiliary" if makes_struct or recursive else "O(1) auxiliary"

    pointers = sorted(subscript_names | {"i", "j", "k", "l", "r", "lo", "hi", "left", "right", "mid", "low", "high",
                                         "start", "end", "slow", "fast", "idx", "ptr"})
    return {"ok": True, "tags": tags, "evidence": evidence, "time": time, "space": space,
            "pointers": pointers, "recursive": recursive}


# ---------------------------------------------------------------- value snapshots
def _snap(v, depth=0, seen=None):
    """Convert a runtime value into a small JSON-able description."""
    if seen is None:
        seen = set()
    if v is None or isinstance(v, bool):
        return {"t": "prim", "v": v}
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return {"t": "prim", "v": str(v)}
        return {"t": "prim", "v": v if abs(v) < 10**15 else str(v)}
    if isinstance(v, str):
        return {"t": "str", "v": v[:MAX_STR], "cut": len(v) > MAX_STR}
    if _is_ll(v) or _is_tree(v):
        is_tree = _is_tree(v)
        if depth > 0:   # a node nested inside a list/dict/tuple: show it as a small node reference
            return {"t": "node", "k": "tree" if is_tree else "ll", "v": _plain(v.val), "id": _nid(v)}
        if not is_tree:
            vals, ids, seen_at, cur = [], [], {}, v
            while cur is not None and id(cur) not in seen_at and len(vals) < MAX_ITEMS:
                seen_at[id(cur)] = len(ids)
                ids.append(_nid(cur))
                vals.append(_plain(cur.val))
                cur = getattr(cur, "next", None)
            cto = seen_at.get(id(cur)) if cur is not None else None
            return {"t": "ll", "v": vals, "ids": ids, "cycle": cto is not None, "cto": cto,
                    "cut": cur is not None and cto is None}
        budget = [31]

        def walk(n, d):
            if n is None or budget[0] <= 0 or d > 5:
                return None
            budget[0] -= 1
            return {"v": _plain(n.val), "id": _nid(n),
                    "l": walk(getattr(n, "left", None), d + 1), "r": walk(getattr(n, "right", None), d + 1)}
        return {"t": "tree", "v": walk(v, 0)}
    if id(v) in seen or depth > MAX_DEPTH:
        return {"t": "repr", "v": "…"}
    seen = seen | {id(v)}
    if isinstance(v, (list, tuple)):
        kind = "list" if isinstance(v, list) else "tuple"
        items = [_snap(x, depth + 1, seen) for x in list(v)[:MAX_ITEMS]]
        return {"t": kind, "v": items, "n": len(v), "cut": len(v) > MAX_ITEMS, "oid": _nid(v)}
    if isinstance(v, (set, frozenset)):
        try:
            ordered = sorted(v)
        except Exception:
            ordered = list(v)
        return {"t": "set", "v": [_snap(x, depth + 1, seen) for x in ordered[:MAX_ITEMS]], "n": len(v), "cut": len(v) > MAX_ITEMS, "oid": _nid(v)}
    if isinstance(v, dict):
        items = [[_snap(k, depth + 1, seen), _snap(x, depth + 1, seen)] for k, x in list(v.items())[:MAX_ITEMS]]
        return {"t": "dict", "v": items, "n": len(v), "cut": len(v) > MAX_ITEMS, "oid": _nid(v)}
    cls = type(v).__name__
    if cls == "deque":
        return {"t": "deque", "v": [_snap(x, depth + 1, seen) for x in list(v)[:MAX_ITEMS]], "n": len(v), "cut": len(v) > MAX_ITEMS, "oid": _nid(v)}
    try:
        return {"t": "repr", "v": repr(v)[:MAX_STR]}
    except Exception:
        return {"t": "repr", "v": f"<{cls}>"}


def _snap_locals(frame):
    out = {}
    for k, v in frame.f_locals.items():
        if k.startswith("__") or k == "self":
            continue
        if isinstance(v, (types.FunctionType, types.ModuleType, type, types.MethodType)):
            continue
        out[k] = _snap(v)
    return out


# ---------------------------------------------------------------- tracing
def _find_target(tree, input_names):
    """Pick (class_name|None, FunctionDef) best matching the input names."""
    candidates = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and not item.name.startswith("__"):
                    candidates.append((node.name, item))
        elif isinstance(node, ast.FunctionDef):
            candidates.append((None, node))
    if not candidates:
        raise ValueError("No function found. Define a `class Solution` with a method, as on LeetCode.")
    wanted = set(input_names)
    best = None
    for cls, fn in candidates:
        params = [a.arg for a in fn.args.args if a.arg != "self"]
        score = len(wanted & set(params)) * 10 - abs(len(params) - len(wanted))
        if best is None or score > best[0]:
            best = (score, cls, fn)
    return best[1], best[2]


def _coerce(value, annotation_src):
    ann = annotation_src or ""
    if "TreeNode" in ann and isinstance(value, list):
        return build_tree(value)
    if "ListNode" in ann and isinstance(value, list):
        return build_list(value)
    return value


def run_trace(code, input_text, max_steps=1500):
    result = {"ok": True, "steps": [], "result": None, "stdout": "", "error": None, "truncated": False}
    _NID.clear()
    del _KEEP[:]
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"ok": False, "error": f"Syntax error on line {e.lineno}: {e.msg}"}
    try:
        kwargs = parse_input_text(input_text)
        cls_name, fn = _find_target(tree, list(kwargs))
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    arg_names = [a.arg for a in fn.args.args if a.arg != "self"]
    ann = {a.arg: (ast.unparse(a.annotation) if a.annotation else "") for a in fn.args.args}
    missing = [a for a in arg_names if a not in kwargs]
    extra = [k for k in kwargs if k not in arg_names]
    if missing or extra:
        return {"ok": False, "error": f"`{fn.name}` takes ({', '.join(arg_names)}). "
                                      f"Input has: {', '.join(kwargs)}. Fix the input field."}
    call_args = {k: _coerce(v, ann.get(k)) for k, v in kwargs.items()}
    result["input"] = {k: _snap(v) for k, v in call_args.items()}   # before the run, so mutations don't leak in

    namespace = {"__name__": "__algolens__", "ListNode": ListNode, "TreeNode": TreeNode}
    prelude = ("from typing import *\nimport collections, heapq, bisect, math, itertools, functools, re, string\n"
               "from collections import *\nfrom functools import *\nfrom heapq import *\nfrom bisect import *\n"
               "from itertools import *\nfrom math import *\n")
    exec(prelude, namespace)
    namespace["ListNode"], namespace["TreeNode"] = ListNode, TreeNode

    steps, stack = [], []
    state = {"count": 0}

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != USER_FILE:
            return None
        name = frame.f_code.co_name
        if event == "call":
            if name.startswith("<"):
                return None   # <module>, <lambda>, comprehensions: not shown as their own frames
            args = {k: _snap(frame.f_locals[k]) for k in frame.f_code.co_varnames[:frame.f_code.co_argcount] if k != "self" and k in frame.f_locals}
            stack.append({"fn": name, "args": args})
            if state["count"] >= max_steps:
                raise _Abort()
            state["count"] += 1
            steps.append({"ev": "call", "line": frame.f_lineno, "fn": name, "depth": len(stack),
                          "locals": _snap_locals(frame), "stack": [dict(s) for s in stack]})
            return tracer
        if event == "line":
            if state["count"] >= max_steps:
                raise _Abort()
            state["count"] += 1
            steps.append({"ev": "line", "line": frame.f_lineno, "fn": name, "depth": len(stack),
                          "locals": _snap_locals(frame), "stack": [dict(s) for s in stack]})
        elif event == "return":
            if stack and not name.startswith("<"):
                state["count"] += 1
                steps.append({"ev": "return", "line": frame.f_lineno, "fn": name, "depth": len(stack),
                              "ret": _snap(arg), "locals": _snap_locals(frame), "stack": [dict(s) for s in stack]})
                stack.pop()
        return tracer

    old_stdout, buf = sys.stdout, io.StringIO()
    try:
        compiled = compile(code, USER_FILE, "exec")
        exec(compiled, namespace)
        target = namespace[cls_name]() if cls_name else None
        method = getattr(target, fn.name) if cls_name else namespace[fn.name]
        sys.stdout = buf
        sys.settrace(tracer)
        try:
            value = method(**call_args)
        finally:
            sys.settrace(None)
            sys.stdout = old_stdout
        result["result"] = _snap(value)
    except _Abort:
        result["truncated"] = True
    except BaseException as e:  # user code errors
        tb = traceback.extract_tb(e.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == USER_FILE), None)
        result["error"] = f"{type(e).__name__}: {e}" + (f" (line {line})" if line else "")
        result["error_line"] = line
    finally:
        sys.settrace(None)
        sys.stdout = old_stdout

    result["steps"] = steps
    result["stdout"] = buf.getvalue()[:2000]
    result["function"] = fn.name
    return result


# JSON bridge for the worker
def analyze_json(code):
    return json.dumps(analyze_code(code))


def examples_json(text):
    return json.dumps(parse_examples(text))


def trace_json(code, input_text, max_steps=1500):
    return json.dumps(run_trace(code, input_text, max_steps))
