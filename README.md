<div align="center">

# AlgoLens

### See your LeetCode code think — one step at a time.

**Trace. Visualize. Understand. Improve.**

AlgoLens is a Chrome extension that turns LeetCode solutions into interactive, step-by-step visual explanations. Follow execution as variables change, function calls unfold, and data structures evolve — directly beside the problem you're solving.

[Repository](https://github.com/Garv3068/AlgoLens) · [Report a bug](https://github.com/Garv3068/AlgoLens/issues) · [Request a feature](https://github.com/Garv3068/AlgoLens/issues)

</div>

---

## 🎬 See AlgoLens in action

<!-- Keep these paths aligned with the files in the assets/ directory. -->
<p align="center">
  <a href="assets/hero.mp4">
    <img src="assets/hero.png" alt="AlgoLens demo preview — click to open the video" width="850">
  </a>
</p>

<p align="center"><em>Click the preview to open the demo video.</em></p>

## 💡 Why AlgoLens?

Reading a solution tells you what the code says. Stepping through it helps you understand **why it works**.

AlgoLens brings code execution closer to the way you learn algorithms: follow the current line, inspect variables, explore function calls, and see the state change as the program runs.

## ✨ Features

- **Four languages:** Python, Java, C++, and JavaScript.
- **Step-by-step tracing:** move through execution instead of seeing only the final result.
- **Live code-line highlighting:** connect a trace step to the corresponding line in the LeetCode editor.
- **Variable inspection:** follow values as they change during execution.
- **Call-stack and recursion views:** understand function calls, returns, and recursive execution.
- **Data-structure visualizations:** inspect supported arrays, collections, pointers, and other structures represented by the trace.
- **Playback and navigation:** move through trace steps and revisit earlier states.
- **LeetCode-focused workflow:** work alongside the problem and your existing editor.
- **Local-first execution:** the tracing engines run in the browser/extension environment; AlgoLens does not require you to configure a paid code-execution API or your own backend.

> **Language support note:** AlgoLens uses language-specific tracing implementations. The depth of syntax and runtime support can differ by language. It is designed for LeetCode-style solutions and is not intended to replace a complete Python, Java, C++, or JavaScript compiler/runtime.

## 🧑‍💻 Supported languages

| Language | Engine approach | Intended use |
|---|---|---|
| Python | Pyodide/WebAssembly with the AlgoLens tracer | Trace supported Python LeetCode solutions |
| Java | JavaScript-based interpreter | Trace supported Java syntax and common solution patterns |
| C++ | JavaScript-based interpreter | Trace supported C++ syntax and common solution patterns |
| JavaScript | JavaScript-based interpreter with parsing support | Trace supported JavaScript solution patterns |

AlgoLens has been tested against a variety of LeetCode question types in all four languages. As with any interpreter-based tool, results depend on the syntax and runtime features used by a particular solution.

## 🚀 Install AlgoLens

### Option 1: Install from the source repository

1. Download or clone this repository.
2. If you downloaded a ZIP, extract it first.
3. Open Google Chrome and navigate to `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the AlgoLens project folder — the folder containing `manifest.json`.
7. Open a LeetCode problem and click the AlgoLens extension icon to open its side panel.

```bash
git clone https://github.com/Garv3068/AlgoLens.git
cd AlgoLens
```

There is no separate application server to start for normal extension use. Keep the project folder in a permanent location while using the unpacked extension.

### Option 2: Install a packaged release

When a ZIP is available under **GitHub → Releases → Assets**:

1. Download the AlgoLens release ZIP (not GitHub's automatically generated source-code archive).
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.

**Note:** This is a developer-mode installation, not a one-click Chrome Web Store installation. Chrome may show a warning because the extension is loaded unpacked.

## 🧭 How to use it

1. Open a LeetCode problem page.
2. Open the AlgoLens side panel from the extension toolbar icon.
3. Select a supported language or use automatic detection if available.
4. Let AlgoLens read the problem/editor context, or paste your solution into the panel if needed.
5. Run the trace using a suitable example input.
6. Step through execution and inspect the highlighted line, variables, call frames, and visualizations.
7. Move backward and forward to revisit important state changes.

**Tip:** Start with a small input. Large inputs and deeply recursive solutions can generate long traces and may take longer to visualize.

## 🧠 How it works

AlgoLens is built around a language-specific tracing layer and a shared visualization model.

```text
LeetCode problem + solution
            │
            ▼
   Language selection
            │
            ▼
  Local tracing engine
  ├── Python: Pyodide + tracer
  ├── Java: Java interpreter
  ├── C++: C++ interpreter
  └── JavaScript: JS interpreter
            │
            ▼
    Trace events / snapshots
            │
            ▼
   Shared execution model
            │
            ▼
  Side-panel visualizations
  ├── Code-line highlighting
  ├── Variables and values
  ├── Call stack / recursion
  └── Data structures + playback
```

The shared model helps keep playback and visualization behavior consistent across languages while each tracing engine handles its supported language syntax.

## 🏗️ Project structure

The main source files are organized around the extension UI, page integration, language engines, and shared visualization logic.

```text
AlgoLens/
├── manifest.json          # Chrome Extension Manifest V3 configuration
├── service-worker.js      # Extension lifecycle and message routing
├── sidepanel.html         # Side-panel interface
├── sidepanel.css          # Side-panel styling
├── sidepanel.js           # UI state, engine selection, trace playback
├── content.js             # LeetCode page integration
├── page-bridge.js         # Page/editor bridge for extraction and highlighting
├── worker.js              # Python tracing worker
├── tracer.py              # Python trace implementation
├── pyodide/               # Local Pyodide runtime
├── java-worker.js         # Java tracing worker
├── java/                  # Java interpreter implementation
├── cpp-worker.js          # C++ tracing worker
├── cpp/                   # C++ interpreter implementation
├── js-worker.js           # JavaScript tracing worker
├── js/                    # JavaScript interpreter implementation
├── model.js               # Shared trace model and execution frames
├── render.js              # Shared value/rendering helpers
├── scene.js               # Execution scene and variable inspector
├── structs.js             # Data-structure and call-tree visualizations
├── inputs.js              # Input parsing helpers
├── assets/                # Screenshots and demo media
├── logo.png               # Extension logo
├── README.md
└── LICENSE
```

The tree above highlights the primary files. The repository may contain additional supporting files and runtime assets required by the extension.

## 🔒 Privacy and execution

AlgoLens is designed for local-first tracing. The core tracing workflow does not require a paid cloud compiler or a developer-hosted backend.

- Code tracing is performed by the extension's local/browser-based engines.
- The extension interacts with LeetCode to obtain problem/editor context and highlight the corresponding code line.
- Treat code you run through any interpreter as untrusted input. AlgoLens uses browser workers and runtime-specific safeguards, but no software sandbox should be considered a guarantee against every possible issue.
- Review the extension permissions in `manifest.json` before installing.
- If you fork or modify AlgoLens, audit any added dependencies, network requests, analytics, or telemetry and update the privacy description accordingly.

This section describes the intended architecture. For a specific release, users should review that version's source code and permissions.

## 🛠️ Troubleshooting

| Issue | Things to try |
|---|---|
| AlgoLens cannot read the problem or editor | Refresh the LeetCode problem tab, then reopen the side panel. |
| The selected language is wrong | Select the language manually in the panel, if available. |
| A trace fails or stops early | Try a smaller input and check whether the solution uses syntax not supported by the selected tracing engine. |
| The extension does not update after pulling changes | Open `chrome://extensions`, reload AlgoLens, and refresh the LeetCode tab. |
| The editor line does not highlight | Refresh the LeetCode tab and try running the trace again. |
| Python takes longer on first use | The local Pyodide runtime may need to initialize. Allow it to finish loading. |

If the issue persists, [open a GitHub issue](https://github.com/Garv3068/AlgoLens/issues). Include the language, a minimal reproducible example, the expected behavior, and what happened instead. **Remove personal information and any private code before sharing logs or snippets.**

## 🗺️ Roadmap

The priorities for future development include:

- [ ] Expand automated regression tests for all four language engines.
- [ ] Improve trace consistency for edge cases, recursion, and backward stepping.
- [ ] Add more visualizations for common algorithmic patterns and data structures.
- [ ] Improve error messages for unsupported syntax and invalid inputs.
- [ ] Make installation and release packaging easier for new users.
- [ ] Prepare the extension for wider distribution, including Chrome Web Store review.

Have an idea? Open an issue and describe the use case.

## 🤝 Contributing

Contributions, bug reports, suggestions, and documentation improvements are welcome.

1. Fork the repository.
2. Create a focused branch for your change.
3. Test your change on the relevant language engine and LeetCode question types.
4. Open a pull request describing the change and how you tested it.

For tracing-engine changes, include a small example solution, input, and expected trace behavior whenever possible. Keep changes to one language from breaking the shared visualization model for the others.

## ⭐ Support the project

If AlgoLens helps you understand a tricky problem:

- ⭐ Star the repository.
- 🐛 Report bugs and suggest features.
- 🔀 Contribute improvements.
- 📣 Share it with fellow learners and developers.

Every bit of feedback helps make algorithm learning more visual and approachable.

## 📄 License

AlgoLens is licensed under the **MIT License**. See [`LICENSE`](https://github.com/Garv3068/AlgoLens/blob/main/MIT%20LICENSE) for details.

---

<div align="center">

**Built to make algorithm execution easier to see, follow, and understand.**

[GitHub Repository](https://github.com/Garv3068/AlgoLens) · [Issues](https://github.com/Garv3068/AlgoLens/issues)

</div>
