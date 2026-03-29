import fs from "fs";
import path from "path";

// === Types for the JSON Adapter Schema ===

interface PatternGroup {
    indent?: number;
    name?: number;
    [key: string]: number | undefined; // meta_extends, meta_params, meta_returnType, etc.
}

interface AdapterPattern {
    id: string;
    nodeType: string;
    regex: string;
    groups: PatternGroup;
    beginsScope?: boolean;
    edgeType?: string;
    sourceIsFile?: boolean;
    nameIsList?: boolean;       // e.g., `import os, sys` splits into multiple nodes
    isGlobal?: boolean;         // e.g., call sites: run regex on full line not line-start
    onlyInScope?: string[];     // e.g., METHOD only matches inside CLASS scope
    promoteInScope?: Record<string, string>; // e.g., FUNCTION -> METHOD inside CLASS
}

interface AdapterSpec {
    language: string;
    scopeTracking: "indent" | "brace";
    patterns: AdapterPattern[];
    ignoreWords: string[];
    skipLinePatterns: string[];
}

interface StackFrame {
    id: string;
    type: string;
    indent?: number;    // for python
    braceLevel?: number; // for typescript
}

// ==============================
// Generic Regex Parsing Engine
// ==============================

export function loadAdapterSpec(adapterName: string): AdapterSpec {
    const adapterPath = path.join(process.cwd(), "rules", "adapters", `${adapterName}.json`);
    const raw = fs.readFileSync(adapterPath, "utf-8");
    return JSON.parse(raw) as AdapterSpec;
}

export function runAdapter(filePath: string, rawCode: string, spec: AdapterSpec): { nodes: any[], edges: any[] } {
    const nodes: any[] = [];
    const edges: any[] = [];
    const lines = rawCode.split(/\r?\n/);

    const ignore = new Set(spec.ignoreWords);
    const skipPatterns = spec.skipLinePatterns.map(p => new RegExp(p));

    // Compile each pattern's regex once
    const compiledPatterns = spec.patterns.map(p => ({
        ...p,
        compiledRegex: new RegExp(p.regex, p.isGlobal ? "g" : "")
    }));

    // File anchor node
    const fileNodeId = `${filePath}#FILE`;
    nodes.push({ id: fileNodeId, type: "FILE", name: path.basename(filePath), fileUri: filePath });

    const stack: StackFrame[] = [{ id: fileNodeId, type: "FILE", indent: -1, braceLevel: 0 }];

    let braceLevel = 0; // only meaningful for brace-tracking languages

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];

        // Skip lines matching the skip line patterns (comment lines, blank lines, etc.)
        if (skipPatterns.some(re => re.test(line))) {
            if (spec.scopeTracking === "brace") {
                const opens = (line.match(/\{/g) || []).length;
                const closes = (line.match(/\}/g) || []).length;
                braceLevel += opens;
                for (let b = 0; b < closes; b++) {
                    braceLevel--;
                    if (stack.length > 1 && braceLevel < stack[stack.length - 1].braceLevel!) {
                        stack.pop();
                    }
                }
            }
            continue;
        }

        // --- Indent Tracking (Python) ---
        let indentLength = 0;
        if (spec.scopeTracking === "indent") {
            const rawIndent = line.match(/^(\s*)/)?.[1] || "";
            indentLength = rawIndent.replace(/\t/g, "    ").length;
            // Pop stack frames that were at a deeper or equal indent 
            while (stack.length > 1 && indentLength <= stack[stack.length - 1].indent!) {
                stack.pop();
            }
        }

        const currentParent = stack[stack.length - 1];

        let matchedStructuralPattern = false;

        // --- Run Each Structural Pattern (non-global) ---
        for (const pat of compiledPatterns) {
            if (pat.isGlobal) continue; // Call sites are handled separately below

            const m = line.match(pat.compiledRegex);
            if (!m) continue;

            // Get name from capture group
            let rawName = pat.groups.name !== undefined ? m[pat.groups.name] : undefined;
            if (!rawName) continue;

            // onlyInScope check
            if (pat.onlyInScope && !pat.onlyInScope.includes(currentParent.type)) continue;

            // Collect metadata from any group key starting with "meta_"
            const metadata: Record<string, string> = {};
            for (const [key, groupIdx] of Object.entries(pat.groups)) {
                if (key.startsWith("meta_") && groupIdx !== undefined && m[groupIdx]) {
                    metadata[key.replace("meta_", "")] = m[groupIdx].trim();
                }
            }

            // Handle IMPORTS/EXTERNAL_NODE patterns (no scope push)
            if (pat.edgeType === "IMPORTS") {
                const libNames = pat.nameIsList
                    ? rawName.split(",").map((s: string) => s.trim().split(/\s+/)[0]).filter(Boolean)
                    : [rawName.trim()];

                for (const lib of libNames) {
                    const libId = `[EXTERNAL_NODE]::${lib}`;
                    if (!nodes.some(n => n.id === libId)) {
                        nodes.push({ id: libId, type: pat.nodeType, name: lib, fileUri: libId });
                    }
                    const srcId = pat.sourceIsFile ? fileNodeId : currentParent.id;
                    if (!edges.some(e => e.sourceId === srcId && e.targetId === libId)) {
                        edges.push({ sourceId: srcId, targetId: libId, type: "IMPORTS" });
                    }
                }
                matchedStructuralPattern = true;
                break;
            }

            // Resolve node type via promotion (e.g., FUNCTION -> METHOD inside CLASS)
            let nodeType = pat.nodeType;
            if (pat.promoteInScope?.[currentParent.type]) {
                nodeType = pat.promoteInScope[currentParent.type];
            }

            // Handle lists (e.g., import os, sys)
            const allNames = pat.nameIsList
                ? rawName.split(",").map((s: string) => s.trim()).filter(Boolean)
                : [rawName.trim()];

            for (const name of allNames) {
                const nodeId = `${filePath}#${name}_${lineIdx}`;
                nodes.push({ id: nodeId, type: nodeType, name, fileUri: filePath, metadata });
                edges.push({ sourceId: nodeId, targetId: currentParent.id, type: "DEFINED_IN" });

                if (pat.beginsScope) {
                    const frame: StackFrame = { id: nodeId, type: pat.nodeType };
                    if (spec.scopeTracking === "indent") {
                        frame.indent = indentLength;
                    } else {
                        frame.braceLevel = braceLevel + 1;
                    }
                    stack.push(frame);
                }
            }

            matchedStructuralPattern = true;
            break; // First matching pattern wins per line
        }

        // --- Brace Tracking Update (TypeScript) ---
        if (spec.scopeTracking === "brace") {
            const opens = (line.match(/\{/g) || []).length;
            const closes = (line.match(/\}/g) || []).length;
            braceLevel += opens;
            for (let b = 0; b < closes; b++) {
                braceLevel--;
                if (stack.length > 1 && braceLevel < stack[stack.length - 1].braceLevel!) {
                    stack.pop();
                }
            }
        }

        // --- Call Site Extraction (Global, only if no structural match) ---
        if (!matchedStructuralPattern) {
            const callPat = compiledPatterns.find(p => p.isGlobal);
            if (callPat) {
                let m: RegExpExecArray | null;
                const globalRe = new RegExp(callPat.compiledRegex.source, "g");
                while ((m = globalRe.exec(line)) !== null) {
                    const word = callPat.groups.name !== undefined ? m[callPat.groups.name] : undefined;
                    if (!word || ignore.has(word) || word.length <= 2) continue;
                    edges.push({
                        sourceId: currentParent.id,
                        targetId: `[CALL_HEURISTIC]::${word}`,
                        type: "CALLS"
                    });
                }
            }
        }
    }

    return { nodes, edges };
}
