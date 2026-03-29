// used to control the flow of the analysis
import { z } from "zod";
import fs from "fs";
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
            return null; // No adapter for this language yet
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
        this.files = file_paths.map(fp => {
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
        }).filter(f => f.include);

        this.cur_state = 2;

        // Step 3: Dispatch to JSON-driven Language Adapters via the generic engine
        for (const file of this.files) {
            if (file.visibility === "blackbox" || file.visibility === "hidden") continue;

            const spec = getAdapterSpec(file.language);
            if (!spec) {
                // No adapter for this language yet — it still appears as a FILE node
                this.graph.nodes.push({
                    id: `${file.path}#FILE`,
                    type: "FILE",
                    name: file.path.split(/[\\/]/).pop() || file.path,
                    fileUri: file.path
                });
                continue;
            }

            const rawCode = fs.readFileSync(file.path, "utf8");
            const parsedData = runAdapter(file.path, rawCode, spec);
            this.graph.nodes.push(...parsedData.nodes);
            this.graph.edges.push(...parsedData.edges);
        }

        // Step 4: Resolve Heuristic Cross-file Connections (Global name matching)
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

            if (match) {
                return { ...edge, targetId: match.id, type: "CALLS" };
            }

            const extId = `[EXTERNAL_NODE]::${word}`;
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
