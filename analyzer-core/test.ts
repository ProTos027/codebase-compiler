import { Orchestrator } from "./src/orchestrator";

async function run() {
    const targetDir = "c:\\Users\\ADITYANSH\\credit-approval-system";
    console.log(`Starting Regex-based Codebase Compilation on: ${targetDir}`);
    
    const orchestrator = new Orchestrator(targetDir);
    await orchestrator.analyze();
    
    console.log("\n--- Extraction Results Summary ---");
    console.log(`Files Processed: ${orchestrator.files.length}`);
    console.log(`Nodes Discovered: ${orchestrator.graph.nodes.length}`);
    console.log(`Edges Discovered: ${orchestrator.graph.edges.length}`);
    
    // Print a sample of nodes and edges to verify parsing worked
    const classes = orchestrator.graph.nodes.filter((n: any) => n.type === 'CLASS');
    const functions = orchestrator.graph.nodes.filter((n: any) => n.type === 'FUNCTION');
    
    console.log(`\nClasses Found: ${classes.length}`);
    console.log(`Top-level Functions: ${functions.length}`);
}

run().catch(console.error);
