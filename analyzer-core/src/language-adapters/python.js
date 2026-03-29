export function parsePythonFile(filePath, rawCode) {
    const nodes = [];
    const edges = [];
    const lines = rawCode.split(/\r?\n/);
    // Create FILE anchor node
    const fileNodeId = `${filePath}#FILE`;
    nodes.push({
        id: fileNodeId,
        type: 'FILE',
        name: filePath.split('/').pop() || filePath,
        fileUri: filePath
    });
    const stack = [
        { id: fileNodeId, indent: -1, type: 'FILE' } // Root element
    ];
    let currentParent = fileNodeId;
    // Regex Definitions
    const classRegex = /^(\s*)class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*?)\))?\s*:/;
    const funcRegex = /^(\s*)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\)(?:\s*->\s*(.*?))?\s*:/;
    const importRegex = /^(\s*)import\s+([a-zA-Z0-9_.,\s]+)/;
    const fromImportRegex = /^(\s*)from\s+([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_.,\s*]+)/;
    const callSiteRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g;
    const ignoreWords = new Set(["if", "for", "while", "return", "elif", "print", "super", "range", "len", "dict", "str", "int", "float", "list", "set", "map", "filter", "zip", "enumerate", "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr", "property", "classmethod", "staticmethod"]);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('#') || line.trim() === '')
            continue; // Skip pure comments/empty
        // Calculate visual indent based on spaces (tabs = 4 spaces heuristic)
        const rawIndentStr = line.match(/^(\s*)/)?.[1] || '';
        const indentLength = rawIndentStr.replace(/\t/g, '    ').length;
        // Pop the stack until we find a parent that encompasses this line's indentation
        while (stack.length > 1 && indentLength <= stack[stack.length - 1].indent) {
            stack.pop();
        }
        currentParent = stack[stack.length - 1].id;
        // 1. Check Classes
        const classMatch = line.match(classRegex);
        if (classMatch) {
            const className = classMatch[2];
            const inheritance = classMatch[3]?.trim();
            const nodeId = `${filePath}#${className}_${i}`;
            nodes.push({
                id: nodeId,
                type: 'CLASS',
                name: className,
                fileUri: filePath,
                metadata: {
                    extends: inheritance || undefined
                }
            });
            edges.push({ sourceId: nodeId, targetId: currentParent, type: 'DEFINED_IN' });
            stack.push({ id: nodeId, indent: indentLength, type: 'CLASS' });
            continue;
        }
        // 2. Check Functions/Methods
        const funcMatch = line.match(funcRegex);
        if (funcMatch) {
            const funcName = funcMatch[2];
            const params = funcMatch[3]?.trim();
            const retType = funcMatch[4]?.trim();
            const isMethod = stack[stack.length - 1].type === 'CLASS';
            const nodeId = `${filePath}#${funcName}_${i}`;
            nodes.push({
                id: nodeId,
                type: isMethod ? 'METHOD' : 'FUNCTION',
                name: funcName,
                fileUri: filePath,
                metadata: {
                    params: `(${params || ''})`,
                    returnType: retType || undefined
                }
            });
            edges.push({ sourceId: nodeId, targetId: currentParent, type: 'DEFINED_IN' });
            stack.push({ id: nodeId, indent: indentLength, type: 'FUNCTION' });
            continue;
        }
        // 3. Check Imports
        const fromMatch = line.match(fromImportRegex);
        if (fromMatch) {
            const lib = fromMatch[2]; // e.g., django.db
            const targetId = `[EXTERNAL_NODE]::${lib}`;
            if (!nodes.some(n => n.id === targetId)) {
                nodes.push({ id: targetId, type: 'EXTERNAL_NODE', name: lib, fileUri: targetId });
            }
            edges.push({ sourceId: fileNodeId, targetId: targetId, type: 'IMPORTS' });
            continue;
        }
        const impMatch = line.match(importRegex);
        if (impMatch) {
            const libs = impMatch[2].split(',').map(s => s.trim().split(' ')[0]);
            for (const lib of libs) {
                if (!lib)
                    continue;
                const targetId = `[EXTERNAL_NODE]::${lib}`;
                if (!nodes.some(n => n.id === targetId)) {
                    nodes.push({ id: targetId, type: 'EXTERNAL_NODE', name: lib, fileUri: targetId });
                }
                edges.push({ sourceId: fileNodeId, targetId: targetId, type: 'IMPORTS' });
            }
            continue;
        }
        // 4. Check Call Sites (Regex heuristic flow extraction)
        // We only map calls to the ENCLOSING parent scope, ignoring microscopic line control flow
        let callMatch;
        while ((callMatch = callSiteRegex.exec(line)) !== null) {
            const word = callMatch[1];
            if (ignoreWords.has(word) || word.length <= 2)
                continue;
            // In our scalable architecture, we push an 'UNRESOLVED_CALL' edge.
            // The Graph Normalizer (Phase 5) will pattern-match 'word' globally later.
            // For now, we bind it heuristically as a string target.
            edges.push({
                sourceId: currentParent,
                targetId: `[CALL_HEURISTIC]::${word}`,
                type: 'CALLS'
            });
        }
    }
    return { nodes, edges };
}
