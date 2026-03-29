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

            if (["binary", "asset", "unknown", "generated"].includes(role)) {
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

        // Step 4: Resolve Heuristic Cross-file Connections
        this.resolveHeuristicEdges();
        this.cur_state = 3;

        console.log(
            `Successfully extracted ${this.graph.nodes.length} nodes` +
            ` and ${this.graph.edges.length} edges via Regex.`
        );
    }

    private resolveHeuristicEdges() {
        this.graph.edges = this.graph.edges.map((edge: any) => {
            if (!edge.targetId.startsWith("[CALL_HEURISTIC]::")) return edge;

            const word = edge.targetId.split("::")[1];
            const match = this.graph.nodes.find((n: any) =>
                n.name === word && ["CLASS", "FUNCTION", "METHOD"].includes(n.type)
            );

            if (match) return { ...edge, targetId: match.id, type: "CALLS" };

            const extId = `[EXT]::${word}`;
            if (!this.graph.nodes.some((n: any) => n.id === extId)) {
                this.graph.nodes.push({ id: extId, type: "EXTERNAL_NODE", name: word, fileUri: extId });
            }
            return { ...edge, targetId: extId, type: "CALLS" };
        });
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
