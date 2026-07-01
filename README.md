# Codebase Compiler

A VS Code extension that statically analyzes any codebase and renders it as an interactive, architectural graph — without requiring a language server or runtime execution.

---

## How It Works

The tool is split into two packages that work in tandem:

```
codebase_compiler/
├── analyzer-core/        # Pure Node.js parsing engine (no VS Code dependency)
│   ├── src/
│   │   ├── orchestrator.ts       # Central pipeline controller
│   │   ├── ruleResolver.ts       # Maps files to roles (code, config, vendor…)
│   │   └── language-adapters/
│   │       └── engine.ts         # JSON-driven regex parsing engine
│   ├── rules/
│   │   ├── universal.json        # Extension → role mappings
│   │   └── adapters/             # Per-language parsing specs
│   │       ├── typescript.json
│   │       ├── javascript.json
│   │       └── python.json
│   └── utils/                    # File-system traversal, rule loader
│
└── analyzer-extension/   # VS Code extension (webview + graph UI)
    ├── src/
    │   ├── extension.ts              # Extension entry point & command handler
    │   ├── visualizer/
    │   │   └── GraphVisualizer.ts    # Cytoscape.js webview renderer
    │   ├── graph-engine/
    │   │   ├── FlowAnalyzer.ts       # BFS execution-flow tracer
    │   │   ├── NodeResolver.ts       # LSP-based node flattener (legacy path)
    │   │   └── Neo4jStorage.ts       # Optional Neo4j graph persistence
    │   └── framework-resolvers/
    │       └── FrameworkDetector.ts  # Detects VS Code / Express / React / Django
    └── rules/                        # Bundled copy of adapter specs
```

### Pipeline

```
Workspace files
     │
     ▼
1. File Discovery   (getFileStructure)
     │  walks the workspace, respects .gitignore-style exclusions
     ▼
2. Role Resolution  (ruleResolver + universal.json)
     │  maps each file to: code | config | vendor | build | asset
     │  config/build files are excluded from structural parsing
     ▼
3. Regex Parsing    (engine.ts + *.json adapters)
     │  produces raw nodes (FILE, CLASS, INTERFACE, ENUM, FUNCTION)
     │  and raw edges (DEFINED_IN, LOCAL_IMPORT, THIRD_PARTY_IMPORT,
     │                 CALLS, INHERITS)
     ▼
4. Heuristic Resolution  (orchestrator.resolveHeuristicEdges)
     │  rewires [CALL_HEURISTIC]:: and [INHERIT_HEURISTIC]:: placeholders
     │  to real graph nodes using a local-first lookup strategy
     ▼
5. Local Import Wiring   (orchestrator.resolveLocalImports)
     │  resolves ./relative paths to their actual FILE nodes
     ▼
6. Framework Detection   (FrameworkDetector)
     │  labels SOURCE (entry points) and SINK (endpoints) nodes
     ▼
7. Flow Tracing          (FlowAnalyzer)
     │  BFS from SOURCE nodes along CALLS/DYNAMIC_TRIGGER edges
     │  produces the "Execution Flow" edge overlay
     ▼
8. Render                (GraphVisualizer → Cytoscape.js webview)
```

---

## Features

- **Zero-runtime analysis** — pure regex + JSON rules, no language server required
- **Multi-language support** — TypeScript, JavaScript, Python (extensible via JSON adapters)
- **Hierarchical graph** — files contain classes/interfaces/enums which contain functions
- **Execution Flow tracing** — green edges show the live call chain from entry points
- **Dead code visibility** — isolated nodes are kept on canvas so unused modules are obvious
- **Interactive UI**
  - Physics / Hierarchy layout toggle
  - Expand / Collapse all compound nodes
  - Click any node to inspect its raw source code
  - Legend checkboxes to show/hide node and edge types
- **Framework-aware semantic labels** — SOURCE / SINK distinction for VS Code, Express, React, Django
- **Optional Neo4j persistence** — push the final graph to a Neo4j instance for deeper queries

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- VS Code ≥ 1.110

### Install & Build

```bash
# From the repo root
cd analyzer-core
npm install

cd ../analyzer-extension
npm install
npm run compile
```

### Run in VS Code

1. Open the `analyzer-extension` folder in VS Code.
2. Press **F5** to launch the Extension Development Host.
3. In the new window, open any workspace you want to analyze.
4. Open the Command Palette (`Ctrl+Shift+P`) and run **Compile Codebase Graph**.
5. The interactive graph renders in a side panel.

---

## Language Adapters

Each language adapter is a plain JSON file in `analyzer-core/rules/adapters/`.  
You can add a new language by creating a new JSON file following this schema:

```jsonc
{
  "language": "rust",
  "scopeTracking": "brace",      // "brace" | "indent"
  "patterns": [
    {
      "id": "struct",
      "nodeType": "CLASS",       // FILE | CLASS | INTERFACE | ENUM | FUNCTION | EXTERNAL_NODE
      "regex": "\\bstruct\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\{",
      "groups": { "name": 1 },
      "beginsScope": true
    }
    // …more patterns
  ],
  "ignoreWords": ["if", "for", "while", "match"],
  "skipLinePatterns": ["^\\s*//", "^\\s*#"]
}
```

---

## Node & Edge Types

| Node Type      | Color        | Description                              |
|---------------|--------------|------------------------------------------|
| `FILE`        | Green        | Source file                              |
| `CLASS`       | Purple       | Class declaration                        |
| `INTERFACE`   | Blue         | Interface declaration (TS/JS)            |
| `ENUM`        | Rust Orange  | Enum declaration                         |
| `FUNCTION`    | Dark Blue    | Function or method                       |
| `EXTERNAL_NODE` | Red        | Third-party or stdlib import             |
| `LOCAL_MODULE`| Teal         | Local relative import (unresolved path)  |

| Edge Type            | Style          | Description                            |
|---------------------|----------------|----------------------------------------|
| `LOCAL_IMPORT`      | Dashed cyan    | Import from a local file               |
| `THIRD_PARTY_IMPORT`| Dashed red     | Import from node_modules / stdlib      |
| `CALLS`             | Dotted grey    | Function call heuristic                |
| `INHERITS`          | Dashed purple  | Class/Interface inheritance            |
| `FLOW`              | Solid green    | Traced execution flow (BFS result)     |

---

## Configuration

### `framework.config.json` (extension root)

Restrict which framework detectors are active:

```json
{
  "enabledFrameworks": ["vscode-extension"]
}
```

Leave empty or omit the file to auto-detect all supported frameworks.

### Neo4j (optional)

Set credentials in `analyzer-extension/.env`:

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=yourpassword
```

---

## Architecture Notes

- **Node IDs** use `::` as a separator (not `#`) because Cytoscape.js treats `#` as a CSS selector.
- **Dead code detection** — isolated nodes are intentionally kept visible. Modules with no incoming or outgoing connections are "dead code" candidates.
- **Config/build file exclusion** — files classified as `config` or `build` by `universal.json` are excluded from structural parsing but do not block the graph render.

---

## License

MIT
