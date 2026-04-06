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
    startLine?: number;
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
    const nodeById = new Map<string, any>();

    const ignore = new Set(spec.ignoreWords);
    const skipPatterns = spec.skipLinePatterns.map(p => new RegExp(p));

    // Compile each pattern's regex once
    const compiledPatterns = spec.patterns.map(p => ({
        ...p,
        compiledRegex: new RegExp(p.regex, p.isGlobal ? "g" : "")
    }));

    // File anchor node — uses "::" separator to avoid Cytoscape CSS selector conflicts
    const fileNodeId = makeNodeId(filePath, "FILE");
    const fileNode = { id: fileNodeId, type: "FILE", name: path.basename(filePath), fileUri: filePath };
    nodes.push(fileNode);
    nodeById.set(fileNodeId, fileNode);

    const stack: StackFrame[] = [{ id: fileNodeId, type: "FILE", indent: -1, braceLevel: 0, startLine: 0 }];
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
            while (stack.length > 1 && indentLength <= stack[stack.length - 1].indent!) {
                const finished = stack.pop()!;
                const finishedNode = nodeById.get(finished.id);
                if (finishedNode?.range?.end) {
                    finishedNode.range.end.line = Math.max(0, lineIdx - 1);
                    finishedNode.codeLines = lines.slice(finished.startLine, lineIdx);
                }
            }
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

            // IMPORTS → external or local node + typed edge, no scope push
            if (pat.edgeType === "IMPORTS") {
                const libNames = pat.nameIsList
                    ? rawName.split(",").map((s: string) => s.trim().split(/\s+/)[0]).filter(Boolean)
                    : [rawName.trim()];

                for (const lib of libNames) {
                    if (!lib) continue;

                    // Local imports start with . or / (same-codebase); others are third-party
                    const isLocal   = lib.startsWith(".") || lib.startsWith("/");
                    const nodeType  = isLocal ? "LOCAL_MODULE"       : "EXTERNAL_NODE";
                    const edgeType  = isLocal ? "LOCAL_IMPORT"       : "THIRD_PARTY_IMPORT";
                    const prefix    = isLocal ? "[LOCAL]"            : "[EXT]";
                    const libId     = `${prefix}::${lib}`;

                    if (!nodes.some(n => n.id === libId)) {
                        nodes.push({ id: libId, type: nodeType, name: lib, fileUri: libId });
                    }
                    const srcId = pat.sourceIsFile ? fileNodeId : currentParent.id;
                    if (!edges.some(e => e.sourceId === srcId && e.targetId === libId)) {
                        edges.push({ sourceId: srcId, targetId: libId, type: edgeType });
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

            // ── Control Flow Sub-typing ────────────────────────────────────
            // Map generic CONTROL_FLOW keyword → fine-grained type + semantic edges
            const LOOP_KWS   = new Set(["for", "while", "do"]);
            const BRANCH_KWS = new Set(["if", "elif", "else", "switch", "case"]);
            const TRY_KWS    = new Set(["try"]);
            const CATCH_KWS  = new Set(["catch", "except", "finally"]);

            const allNames = pat.nameIsList
                ? rawName.split(",").map((s: string) => s.trim()).filter(Boolean)
                : [rawName.trim()];

            for (const name of allNames) {
                let resolvedType = nodeType;
                let cfEdgeTypes: string[] = [];

                if (nodeType === "CONTROL_FLOW") {
                    if (LOOP_KWS.has(name)) {
                        resolvedType = "LOOP";
                        cfEdgeTypes = ["LOOP_FLOW"];          // self-loop on parent
                    } else if (BRANCH_KWS.has(name)) {
                        resolvedType = "BRANCH";
                        cfEdgeTypes = ["BRANCH_TRUE", "BRANCH_FALSE"];  // forked paths
                    } else if (TRY_KWS.has(name)) {
                        resolvedType = "TRY_CATCH";
                        cfEdgeTypes = ["TRY_FLOW", "CATCH_FLOW"];
                    } else if (CATCH_KWS.has(name)) {
                        resolvedType = "TRY_CATCH";
                        cfEdgeTypes = ["CATCH_FLOW"];
                    }
                }

                const nodeId = makeNodeId(filePath, `${name}::L${lineIdx}`);
                const node = {
                    id: nodeId,
                    type: resolvedType,
                    name,
                    fileUri: filePath,
                    metadata,
                    range: { start: { line: lineIdx }, end: { line: lineIdx } }
                };
                nodes.push(node);
                nodeById.set(nodeId, node);
                // DEFINED_IN: child → parent
                edges.push({ sourceId: nodeId, targetId: currentParent.id, type: "DEFINED_IN" });

                // Class Inheritance Edges
                if (metadata.extends) {
                    const bases = metadata.extends.split(",").map(b => b.trim());
                    for (const base of bases) {
                        if (base) {
                            edges.push({
                                sourceId: nodeId,
                                targetId: `[INHERIT_HEURISTIC]::${base}`,
                                type: "INHERITS"
                            });
                        }
                    }
                }

                // Semantic control-flow edges FROM parent scope → this CF node
                for (const cfEdgeType of cfEdgeTypes) {
                    edges.push({ sourceId: currentParent.id, targetId: nodeId, type: cfEdgeType });
                }

                if (pat.beginsScope) {
                    const frame: StackFrame = { id: nodeId, type: resolvedType, startLine: lineIdx };
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
                if (stack.length > 1 && braceLevel < stack[stack.length - 1].braceLevel!) {
                    const finished = stack.pop()!;
                    const finishedNode = nodeById.get(finished.id);
                    if (finishedNode?.range?.end) {
                        finishedNode.range.end.line = lineIdx;
                        finishedNode.codeLines = lines.slice(finished.startLine, lineIdx + 1);
                    }
                }
            }
        }

        // Call Site Extraction (Global)
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

    // Close any remaining open scopes at EOF
    const lastLine = Math.max(0, lines.length - 1);
    for (const frame of stack) {
        if (frame.id === fileNodeId) continue;
        const finishedNode = nodeById.get(frame.id);
        if (finishedNode?.range?.end) {
            finishedNode.range.end.line = lastLine;
            finishedNode.codeLines = lines.slice(frame.startLine, lastLine + 1);
        }
    }

    return { nodes, edges };
}
