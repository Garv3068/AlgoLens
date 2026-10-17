# AlgoLens — LeetCode Visualizer (v0.2.1)

A Chrome (Manifest V3) side-panel extension that reads the LeetCode problem and **your Python or Java solution**, runs it on a test input, and lets you step through the real execution.


## What's new in 0.4.0

- **Highlight lives only in LeetCode's editor**: green rules above/below the running line with a ◀ marker (blue on calls, purple on returns, red on errors). Hover the line to see the variables. The side panel no longer repeats your code.
- **Python Tutor-style scene**: *Main Block* (your inputs; click one to edit it and re-run) → dashed arrows labelled "Calls … with arguments …" → one box per function call with its variables. Return values flow back ("↩ received 6 from fact()").
- **Pointers**: index variables (`i`, `j`, `lo`, `hi`, `mid`, `left`, `right`…) are drawn above array cells, with the search/sliding window shaded; row/col cursors on grids; linked-list and tree nodes are labelled with the variables pointing at them (cycles shown).
- **Stacks, queues, heaps, DP tables, dicts, sets**: detected from how your code uses them; pushes glow, pops leave a struck-through ghost.
- **Interactive variables**: click any variable or cell for its full history and sparkline, click a history row to time-travel, ★ to pin it to a Watch list.
- **Recursion**: call tree (repeated calls flagged for memoization), tree DFS state (running / on stack / finished).
- **Navigation**: step into (→), over (↓/O), out (U), back over (↑), space to play.

## What it does
- Reads the problem title, difficulty, statement and your editor code from the LeetCode tab (a small read-only script in the page's JS world reaches Monaco).
- Parses `Input: ... Output: ...` examples from the statement; pick one or type your own (`nums = [2,7,11,15], target = 9`).
- Runs your code in **Pyodide** (CPython in WebAssembly) inside a Web Worker, recording every line, call and return with `sys.settrace`.
- Highlights the executing line **directly in LeetCode's own code editor** (red on the line where an error occurs) while the side panel shows the visualization: call stack and variables drawn by type — arrays with index pointers (`i`, `left`, `mid`…), strings as characters, matrices as grids, dicts, sets, queues, linked lists, binary trees. Changed values are highlighted and each step lists what changed.
- Shows a static algorithm/complexity hint (hash map, two pointers, binary search, DP, recursion…).

## Java support
Java runs on a built-in **Java-subset interpreter written in JavaScript** (`java/`), not a real JVM, so nothing needs to be downloaded and it works under Chrome's extension security rules. It emits the same trace format as Python, so the visualizer is shared.

Supported: classes/methods/constructors/static + inner + anonymous classes, `int/long/double/char/boolean` with Java semantics (32-bit overflow, integer division, `long` as 64-bit, char arithmetic), arrays and multi-dimensional arrays, `String`/`StringBuilder`, `ArrayList/LinkedList/ArrayDeque/Stack`, `HashMap/TreeMap/LinkedHashMap` (with Java's real `HashMap` iteration order), `HashSet/TreeSet`, `PriorityQueue` (same heap layout as Java), lambdas and common method references, `Comparator`, `Arrays`/`Collections`/`Math`/`Integer`/`Long`/`Character`, `ListNode`/`TreeNode` inputs, `switch` (old and arrow), labeled loops, `try/catch/finally`, exceptions with Java-style messages.

Not supported yet: streams, `enum`/`record`/interfaces with default methods, generics-dependent overloads, text blocks, `Scanner`/`Random`, threads. Unsupported calls fail with a clear message naming the method. Recursion deeper than 400 frames reports `StackOverflowError`.

## Line highlighting
The side panel sends the current step's line to the LeetCode tab, where a small script uses Monaco's decoration API to tint that line and scroll it into view. It is visual only and never edits your code. Highlights are cleared when you re-run, switch problems or close the panel. If you edit your code after tracing, click Visualize again so line numbers match.

## Install
1. Unzip, open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (needs Chrome 116+).
3. Open a LeetCode problem, set the language to **Python3**, click the AlgoLens icon.

## Safety and limits
- Everything runs locally; no server, no API key. Code runs in a worker with no DOM access.
- Traces stop at 1,500 steps; runs are killed after 10 s (the worker is terminated and restarted).
- Pyodide is bundled (~13 MB in `pyodide/`), so there are no remote scripts.
- Complexity and pattern labels are heuristics from code structure, not proofs.

## Known limitations
- Python and Java only. C++/JavaScript would need their own tracers.
- Test inputs come from the statement's examples; very long inputs are truncated in the display (first 40 items).
- Editor/problem scraping depends on LeetCode's DOM and may need selector updates when the site changes. If the editor isn't read, paste code manually.
- Design-problem style solutions (constructor plus many methods) aren't supported yet; the tracer calls one method.
- The Java interpreter is a re-implementation, so rare library behaviours may differ from a real JVM. Tell me about any solution that behaves differently.

## Files
`manifest.json` · `logo.png` (extension icon + side-panel logo) · `service-worker.js` · `page-bridge.js` (MAIN world, reads Monaco) · `content.js` · `sidepanel.html/css/js` · `render.js` (value → HTML) · `worker.js` + `tracer.py` (Pyodide engine) · `java-worker.js` + `java/` (parser, runtime, interpreter) · `inputs.js` (example parsing) · `pyodide/` (runtime)

## Ideas for next steps
Optional AI explanations of each phase, more algorithm-specific views (graph/BFS, DP table, heap), shareable trace export, Java/JS tracers.
