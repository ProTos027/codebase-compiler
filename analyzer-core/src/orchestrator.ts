// used to control the flow of the analysis
import { z } from "zod";
import { loader } from "../utils/ruleLoader"
import { resolveFile } from "../analyzer-extension/src/vscodeResolver";
import { FileNodeSchema } from "../schemas/fileStruct";
import { getFileStructure } from "../utils/fileStructure";

class Orchestrator {

    root: string
    cur_state: number
    files: z.infer<typeof FileNodeSchema>[]
    constructor(root: string) {
        this.root = root;
        this.cur_state= 0
        this.files = [];
    }
    async analyze(state: number) {
        switch(state){
            case 0:
// step 1: get the file structure of the project
                loader()
                 var file_paths= getFileStructure(this.root)
                 this.cur_state= 1
// step 2: get the extension of each file through analyzer-extension, and group them by language
            case 1:
                var lang_ids= await Promise.all(file_paths.map(async (path: string) => {
                    var lang_id= await resolveFile(path)
                    return {path, lang_id}
                }));
                this.cur_state= 2
// step 3: pass to respective lsp server for analysis through analyzer-extension
            case 2:

// step 4: get the res, pass to respective language adapter
//  step 4a: use language adapter to resolve libraries
//  step 4b: ask user for help if fail to resolve

// step 5: take language adapter res, and use DSL for generalization of res
// step 6: gather definitions, references and other connections
// step 7: resolve dependencies
// step 8: build graph
// step 9: store in graph database
// step 10: detect entry points
// step 11: trace execution flow
// step 12: visualize results
        }
    }
}
