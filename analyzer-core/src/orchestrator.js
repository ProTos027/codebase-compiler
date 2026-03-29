import fs from "fs";
import { loader } from "../utils/ruleLoader";
import { resolveRole } from "./ruleResolver";
import { getFileStructure } from "../utils/fileStructure";
import { parsePythonFile } from "./language-adapters/python";
export class Orchestrator {
    root;
    cur_state;
    files;
    graph; // The final macroscopic graph
    constructor(root) {
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
        this.files = file_paths.map(path => {
            const ext = path.split('.').pop() || 'unknown';
            const language = this.getLanguageFromExtension(ext);
            const role = resolveRole(path, language);
            // Natively filter what gets parsed/shown based on role rules!
            let include = true;
            let visibility = "normal";
            if (["binary", "asset", "unknown", "generated"].includes(role)) {
                include = false;
                visibility = "hidden";
            }
            else if (role === "vendor") {
                include = true;
                visibility = "blackbox"; // Mapped bounds, but not deep parsed
            }
            return { path, language, role, include, visibility };
        }).filter(f => f.include);
        this.cur_state = 2;
        // Step 3: Dispatch to Plug-n-Play Language Adapters using Regex 
        for (const file of this.files) {
            if (file.visibility === "blackbox" || file.visibility === "hidden") {
                continue; // Skip full structural parsing
            }
            const rawCode = fs.readFileSync(file.path, 'utf8');
            // Plug and Play Router
            if (file.language === "python" || file.language === "py") {
                const parsedData = parsePythonFile(file.path, rawCode);
                this.integrateToGraph(parsedData);
            }
        }
        this.cur_state = 3;
        // Step 4-12
        console.log(`Successfully extracted ${this.graph.nodes.length} nodes via Regex.`);
    }
    getLanguageFromExtension(ext) {
        switch (ext) {
            case 'py': return 'python';
            case 'js': return 'javascript';
            case 'ts': return 'typescript';
            case 'json': return 'json';
            default: return 'unknown';
        }
    }
    integrateToGraph(parsedData) {
        this.graph.nodes.push(...parsedData.nodes);
        this.graph.edges.push(...parsedData.edges);
    }
}
