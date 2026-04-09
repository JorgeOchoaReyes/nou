import path from "path";
import fs from "fs/promises"; 
import shelljs from "shelljs";

export async function readFile(filepath: string): Promise<string> {
  try {
    const fullPath = path.resolve(process.cwd(), filepath);
    const content = await fs.readFile(fullPath, "utf-8");
    return content;
  } catch {
    return "Error: File not found or could not be read.";
  }
};

export async function runCommand(command: string): Promise<string> {
  const result = shelljs.exec(command, { silent: true });
  if (result.code !== 0) {
    return `Error (Exit Code ${result.code}): ${result.stderr}`;
  }
  return result.stdout;
}

export async function createOrUpdateFile(filePath: string, content: string): Promise<string> {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    const directory = path.dirname(fullPath);
 
    await fs.mkdir(directory, { recursive: true });
    
    const cleanedContent = content
      .replace(/\\n/g, "\n") 
      .replace(/^```[a-z]*\n/i, "")  
      .replace(/\n```$/g, "")   
      .trim();
    
    await fs.writeFile(fullPath, cleanedContent, "utf-8");
    
    return `Successfully created/updated ${path.basename(filePath)}`;
  } catch (error: any) {
    return `Failed to create file: ${error.message}`;
  }
}
 
export async function executeTool(name: string, args: any) {
  switch (name) {
  case "run_command":
    return await runCommand(args.command);
  case "read_file":
    return await readFile(args.path);
  case "write_file":
    return await createOrUpdateFile(args.path, args.content); 
  case "get_file_tree":
    return await runCommand("tree -a -I 'node_modules|.git' -L 2");
  default:
    return `Unknown tool: ${name}`;
  }
}