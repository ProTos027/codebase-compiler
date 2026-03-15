import fs from "fs";
import path from "path";

export let universal: any;
export let languages: any;
export let folders: any;
export function loadJSON(file: string) {
  const p = path.join(__dirname, "..", "rules", file);

  return JSON.parse(
    fs.readFileSync(p, "utf-8")
  );
}
export function loader() {
    universal = loadJSON("universal.json");
    languages = loadJSON("languages.json");
    folders = loadJSON("folders.json");
}