import fs from "fs";
import path from "path";
import { traverseFolder } from "../src/ruleResolver";
export function getFileStructure(root) {
    var file_paths = [];
    dfs(root, file_paths);
    return file_paths;
}
function dfs(dir, files) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && traverseFolder(entry)) {
            dfs(fullPath, files);
        }
        else if (stat.isFile()) {
            files.push(fullPath);
        }
    }
}
