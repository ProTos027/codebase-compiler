import fs from "fs";
import path from "path";
import { rulesRoot } from "../../utils/ruleLoader";

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
    nameIsList?: boolean;
    isGlobal?: boolean;
    onlyInScope?: string[];
    promoteInScope?: Record<string, string>;
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
    indent?: number;
    braceLevel?: number;
}

// ==============================
// Generic Regex Parsing Engine
// ==============================

// NOTE: node IDs use "::" instead of "#" as separator.
// Cytoscape.js treats "#" as a CSS ID selector, which breaks compound parent lookups.
function makeNodeId(filePath: string, suffix: string): string {
    return `${filePath}::${suffix}`;
}

export function loadAdapterSpec(adapterName: string): AdapterSpec {
    const adapterPath = path.join(rulesRoot(), "adapters", `${adapterName}.json`);
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

    // File anchor node — uses "::" separator to avoid Cytoscape CSS selector conflicts
    const fileNodeId = makeNodeId(filePath, "FILE");
    nodes.push({ id: fileNodeId, type: "FILE", name: path.basename(filePath), fileUri: filePath });

    const stack: StackFrame[] = [{ id: fileNodeId, type: "FILE", indent: -1, braceLevel: 0 }];
    let braceLevel = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];

        if (skipPatterns.some(re => re.test(line))) {
            if (spec.scopeTracking === "brace") {
                braceLevel += (line.match(/\{/g) || []).length;
                const closes = (line.match(/\}/g) || []).length;
                for (let b = 0; b < closes; b++) {
                    braceLevel--;
                    if (stack.length > 1 && braceLevel < stack[stack.length - 1].braceLevel!) stack.pop();
                }
            }
            continue;
        }

        // Indent Tracking (Python)
        let indentLength = 0;
        if (spec.scopeTracking === "indent") {
            const rawIndent = line.match(/^(\s*)/)?.[1] || "";
            indentLength = rawIndent.replace(/\t/g, "    ").length;
            while (stack.length > 1 && indentLength <= stack[stack.length - 1].indent!) stack.pop();
        }

        const currentParent = stack[stack.length - 1];
        let matchedStructuralPattern = false;

        // Run Each Structural Pattern (non-global)
        for (const pat of compiledPatterns) {
            if (pat.isGlobal) continue;

            const m = line.match(pat.compiledRegex);
            if (!m) continue;

            let rawName = pat.groups.name !== undefined ? m[pat.groups.name] : undefined;
            if (!rawName) continue;

            // onlyInScope check
            if (pat.onlyInScope && !pat.onlyInScope.includes(currentParent.type)) continue;

            // Collect metadata
            const metadata: Record<string, string> = {};
            for (const [key, groupIdx] of Object.entries(pat.groups)) {
                if (key.startsWith("meta_") && groupIdx !== undefined && m[groupIdx]) {
                    metadata[key.replace("meta_", "")] = m[groupIdx].trim();
                }
            }

            // IMPORTS → external node + edge, no scope push
            if (pat.edgeType === "IMPORTS") {
                const libNames = pat.nameIsList
                    ? rawName.split(",").map((s: string) => s.trim().split(/\s+/)[0]).filter(Boolean)
                    : [rawName.trim()];

                for (const lib of libNames) {
                    if (!lib) continue;
                    const libId = `[EXT]::${lib}`;
                    if (!nodes.some(n => n.id === libId)) {
                        nodes.push({ id: libId, type: "EXTERNAL_NODE", name: lib, fileUri: libId });
                    }
                    const srcId = pat.sourceIsFile ? fileNodeId : currentParent.id;
                    if (!edges.some(e => e.sourceId === srcId && e.targetId === libId)) {
                        edges.push({ sourceId: srcId, targetId: libId, type: "IMPORTS" });
                    }
                }
                matchedStructuralPattern = true;
                break;
            }

            // Resolve node type via promotion
            let nodeType = pat.nodeType;
            if (pat.promoteInScope?.[currentParent.type]) {
                nodeType = pat.promoteInScope[currentParent.type];
            }

            const allNames = pat.nameIsList
                ? rawName.split(",").map((s: string) => s.trim()).filter(Boolean)
                : [rawName.trim()];

            for (const name of allNames) {
                const nodeId = makeNodeId(filePath, `${name}::L${lineIdx}`);
                nodes.push({ id: nodeId, type: nodeType, name, fileUri: filePath, metadata });
                // DEFINED_IN: child → parent (source=child, target=parent)
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
            break;
        }

        // Brace Tracking Update (TypeScript)
        if (spec.scopeTracking === "brace") {
            braceLevel += (line.match(/\{/g) || []).length;
            const closes = (line.match(/\}/g) || []).length;
            for (let b = 0; b < closes; b++) {
                braceLevel--;
                if (stack.length > 1 && braceLevel < stack[stack.length - 1].braceLevel!) stack.pop();
            }
        }

        // Call Site Extraction (Global, only if no structural match)
        if (!matchedStructuralPattern) {
            const callPat = compiledPatterns.find(p => p.isGlobal);
            if (callPat) {
                const globalRe = new RegExp(callPat.compiledRegex.source, "g");
                let m: RegExpExecArray | null;
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
