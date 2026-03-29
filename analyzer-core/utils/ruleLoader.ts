import fs from "fs";
import path from "path";

export let universal: any;
export let languages: any;
export let folders: any;

// Allow external callers (e.g., VS Code extension via extensionPath) to override the rules root
let _rulesRoot: string | null = null;
export function setRulesRoot(dir: string) { _rulesRoot = dir; }

function rulesRoot(): string {
    return _rulesRoot ?? path.join(process.cwd(), "rules");
}

export function loadJSON(file: string) {
  const p = path.join(rulesRoot(), file);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function loader() {
    universal = loadJSON("universal.json");
    languages = loadJSON("languages.json");
    folders = loadJSON("folders.json");
}