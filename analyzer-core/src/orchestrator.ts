// used to control the flow of the analysis
import { z } from "zod";
import fs from "fs";
import path from "path";
import { loader } from "../utils/ruleLoader";
import { resolveRole } from "./ruleResolver";
import { FileNodeSchema } from "../schemas/fileStruct";
import { getFileStructure } from "../utils/fileStructure";
import { loadAdapterSpec, runAdapter } from "./language-adapters/engine";

// Pre-load adapter specs once at startup — JSON-driven, no TS code per language
const adapterCache = new Map<string, ReturnType<typeof loadAdapterSpec>>();

function getAdapterSpec(langKey: string) {
    if (!adapterCache.has(langKey)) {
        try {
            adapterCache.set(langKey, loadAdapterSpec(langKey));
        } catch {
            return null;
        }
    }
    return adapterCache.get(langKey)!;
}

export class Orchestrator {
    root: string;
    cur_state: number;
    files: z.infer<typeof FileNodeSchema>[];
    graph: any;

    constructor(root: string) {
        this.root = root;
        this.cur_state = 0;
        this.files = [];
        this.graph = { nodes: [], edges: [] };
    }

    async analyze() {
        // Step 1: Initialize rules and get raw file structure
        loader();
        const file_paths = getFileStructure(this.root);
        this.cur_state = 1;

        // Step 2: Classify files using rules (Extension -> Language -> Role -> Visibility)
        // Also build a Set of .ts file basepaths to filter out compiled .js companions
        const tsBasePaths = new Set(
            file_paths
                .filter(fp => fp.endsWith(".ts") || fp.endsWith(".tsx"))
                .map(fp => fp.replace(/\.tsx?$/, ""))
        );

        this.files = file_paths.map(fp => {
            // Skip compiled .js/.js.map files when a .ts source twin exists
            if ((fp.endsWith(".js") || fp.endsWith(".js.map") || fp.endsWith(".d.ts")) &&
                tsBasePaths.has(fp.replace(/\.(js|js\.map|d\.ts)$/, ""))) {
                return null;
            }

            const ext = fp.split(".").pop() || "unknown";
            const language = this.getLanguageFromExtension(ext);
            const role = resolveRole(fp, language);

            let include = true;
            let visibility: "normal" | "hidden" | "external" | "blackbox" = "normal" as any;

            if (["binary", "asset", "unknown", "generated", "config", "build"].includes(role)) {
                include = false;
                visibility = "hidden" as any;
            } else if (role === "vendor") {
                include = true;
                visibility = "blackbox" as any;
            }

            return { path: fp, language, role, include, visibility };
        }).filter((f): f is NonNullable<typeof f> => f !== null && f.include);

        this.cur_state = 2;

        // Step 3: Dispatch to JSON-driven Language Adapters via the generic engine
        const seenNodeIds = new Set<string>();

        for (const file of this.files) {
            if (file.visibility === "hidden") continue;

            const fileNodeId = `${file.path}::FILE`;
            const fileName = path.basename(file.path);

            // Handle Blackbox files (Show the file node, but don't parse internal structure)
            if (file.visibility === "blackbox") {
                if (!seenNodeIds.has(fileNodeId)) {
                    this.graph.nodes.push({ id: fileNodeId, type: "FILE", name: fileName, fileUri: file.path });
                    seenNodeIds.add(fileNodeId);
                }
                continue;
            }

            // Normal visibility: Try to parse using an adapter
            const spec = getAdapterSpec(file.language);
            if (!spec) {
                if (!seenNodeIds.has(fileNodeId)) {
                    this.graph.nodes.push({ id: fileNodeId, type: "FILE", name: fileName, fileUri: file.path });
                    seenNodeIds.add(fileNodeId);
                }
                continue;
            }

            // Full parsing for normal structural files
            try {
                const rawCode = fs.readFileSync(file.path, "utf8");
                const parsedData = runAdapter(file.path, rawCode, spec);

                // Deduplicate nodes by ID
                for (const node of parsedData.nodes) {
                    if (!seenNodeIds.has(node.id)) {
                        this.graph.nodes.push(node);
                        seenNodeIds.add(node.id);
                    }
                }
                this.graph.edges.push(...parsedData.edges);
            } catch (err) {
                console.warn(`Failed to parse ${file.path}:`, err);
                if (!seenNodeIds.has(fileNodeId)) {
                    this.graph.nodes.push({ id: fileNodeId, type: "FILE", name: fileName, fileUri: file.path });
                    seenNodeIds.add(fileNodeId);
                }
            }
        }

        // Step 4: Resolve cross-file connections
        this.resolveHeuristicEdges();
        // Step 5: Wire [LOCAL]:: imports to actual file nodes
        this.resolveLocalImports();
        // Step 6: Prune noisy error/exception branches
        this.pruneErrorBranches();
        // Step 7: Dropping isolated nodes has been disabled so dead code and unused files remain visible.
        // this.removeIsolatedNodes();
        this.cur_state = 3;

        console.log(
            `Successfully extracted ${this.graph.nodes.length} nodes` +
            ` and ${this.graph.edges.length} edges via Regex.`
        );
    }

    private resolveHeuristicEdges() {
        const fileNodeCache = new Map<string, string>();
        for (const e of this.graph.edges) {
            if (e.type === 'DEFINED_IN' && !fileNodeCache.has(e.sourceId)) {
                const parentNode = this.graph.nodes.find((n: any) => n.id === e.targetId);
                if (parentNode?.fileUri) fileNodeCache.set(e.sourceId, parentNode.fileUri);
            }
        }

        this.graph.edges = this.graph.edges.map((edge: any) => {
            if (!edge.targetId.startsWith("[CALL_HEURISTIC]::") && !edge.targetId.startsWith("[INHERIT_HEURISTIC]::")) return edge;

            const isInherit = edge.targetId.startsWith("[INHERIT_HEURISTIC]::");
            const word = edge.targetId.replace(/^\[(?:CALL|INHERIT)_HEURISTIC\]::/, "");
            const edgeType = isInherit ? "INHERITS" : "CALLS";
            const allowedTypes = isInherit ? ["CLASS", "INTERFACE"] : ["CLASS", "INTERFACE", "ENUM", "FUNCTION", "METHOD"];

            const sourceFile = fileNodeCache.get(edge.sourceId) || this.graph.nodes.find((n:any)=>n.id===edge.sourceId)?.fileUri;
            
            // 1. Local Same-File Match
            let match = this.graph.nodes.find((n: any) => 
                n.name === word && allowedTypes.includes(n.type) && n.fileUri === sourceFile && n.id !== edge.sourceId
            );

            // 2. Global Match
            if (!match) {
                match = this.graph.nodes.find((n: any) =>
                    n.name === word && allowedTypes.includes(n.type) && n.id !== edge.sourceId
                );
            }

            if (match) return { ...edge, targetId: match.id, type: edgeType };

            // 3. Fallback External Node
            const extId = `[EXT]::${word}`;
            if (!this.graph.nodes.some((n: any) => n.id === extId)) {
                this.graph.nodes.push({ id: extId, type: "EXTERNAL_NODE", name: word, fileUri: extId });
            }
            return { ...edge, targetId: extId, type: edgeType };
        });
    }

    /**
     * Resolves [LOCAL]::./relative/path imports to the actual file node they reference.
     * If a match is found, the edge is rewired and the ghost [LOCAL]:: placeholder is removed.
     */
    private resolveLocalImports() {
        // Build lookup: normalized absolute path (no extension) → file node ID
        const fileNodeByPath = new Map<string, string>();
        for (const node of this.graph.nodes) {
            if (node.type === 'FILE' && node.fileUri) {
                const withoutExt = node.fileUri.replace(/\.[^.]+$/, '').toLowerCase().replace(/\\/g, '/');
                fileNodeByPath.set(withoutExt, node.id);
                fileNodeByPath.set(node.fileUri.toLowerCase().replace(/\\/g, '/'), node.id);
            }
        }

        const resolvedLocalIds = new Set<string>();

        for (const edge of this.graph.edges) {
            if (edge.type !== 'LOCAL_IMPORT') continue;
            if (!edge.targetId.startsWith('[LOCAL]::')) continue;

            const importPath = edge.targetId.replace('[LOCAL]::', '');

            // Determine the source file's directory from the source node's fileUri
            const sourceNode = this.graph.nodes.find((n: any) => n.id === edge.sourceId);
            const sourceFile = sourceNode?.fileUri;
            if (!sourceFile || !path.isAbsolute(sourceFile)) continue;

            const sourceDir = path.dirname(sourceFile);

            // Try to resolve: join directory + relative import, try common extensions
            const candidates = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '/index.ts', '/index.js'];
            for (const ext of candidates) {
                const raw = path.join(sourceDir, importPath + ext);
                const normalized = raw.toLowerCase().replace(/\\/g, '/');
                if (fileNodeByPath.has(normalized)) {
                    resolvedLocalIds.add(edge.targetId);
                    edge.targetId = fileNodeByPath.get(normalized)!;
                    break;
                }
            }
        }

        // Remove ghost [LOCAL]:: placeholder nodes that were resolved to real file nodes
        this.graph.nodes = this.graph.nodes.filter((n: any) => !resolvedLocalIds.has(n.id));
    }

    /**
     * Drops isolated FILE nodes that have no edges — these are config/asset files
     * with no structural relationship to the codebase (e.g. package-lock.json).
     */
    private removeIsolatedNodes() {
        const connectedIds = new Set<string>();
        for (const edge of this.graph.edges) {
            connectedIds.add(edge.sourceId);
            connectedIds.add(edge.targetId);
        }
        this.graph.nodes = this.graph.nodes.filter((n: any) => {
            if (n.type === 'FILE' && !connectedIds.has(n.id)) return false; // Drop isolated config/asset files
            return true; // structural nodes always kept
        });
    }

    /**
     * Drops completely noisy branches that end in common error types.
     * Removes EXTERNAL_NODEs that look like error classes/exceptions and any edges pointing to them.
     */
    private pruneErrorBranches() {
        // Matches anything ending with Error/Exception, or exactly "reject" (case-insensitive)
        const errorLikePattern = /(?:Error|Exception)$|^reject$/i;
        
        const errorNodeIds = new Set<string>();
        
        // Find external nodes that match error patterns
        this.graph.nodes = this.graph.nodes.filter((n: any) => {
            if (n.type === 'EXTERNAL_NODE' && errorLikePattern.test(n.name)) {
                errorNodeIds.add(n.id);
                return false; // drop node
            }
            return true;
        });
        
        // Remove edges connected to dropped nodes
        if (errorNodeIds.size > 0) {
           this.graph.edges = this.graph.edges.filter((e: any) => 
               !errorNodeIds.has(e.sourceId) && !errorNodeIds.has(e.targetId)
           );
        }
    }

    private getLanguageFromExtension(ext: string): string {
        switch (ext) {
            case "py":  return "python";
            case "js":
            case "jsx": return "javascript";
            case "ts":
            case "tsx": return "typescript";
            case "json": return "json";
            default: return "unknown";
        }
    }
}
