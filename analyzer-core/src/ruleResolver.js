import { universal, languages, folders } from "../utils/ruleLoader";
export function resolveRole(filePath, lang) {
    if (!universal || !languages || !folders) {
        throw new Error("Rules not loaded. Please call loader() before resolving roles.");
    }
    var filename = filePath.split("/").pop() || "";
    var ext = filename.split(".").pop() || "";
    // universal ext
    if (universal.names?.[filename])
        return universal.names[filename];
    if (universal.ext?.[ext])
        return universal.ext[ext];
    // language ext
    if (languages[lang]?.names?.[filename])
        return languages[lang].names[filename];
    if (languages[lang]?.ext?.[ext])
        return languages[lang].ext[ext];
    return "unknown";
}
export function traverseFolder(cur_folder) {
    if (folders.includes(cur_folder))
        return false;
    return true;
}
