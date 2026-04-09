import shelljs from "shelljs";
import fs from "fs/promises";
import path from "path";

export const tools = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a terminal command",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run",
          }
        },
        required: ["command"]
      }


    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to file",
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing file with new content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "The full content to write to the file" }
        },
        required: ["path", "content"]
      }
    }
  }
];

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
  if(result.code !== 0) {
    return `Error (Exit Code ${result.code}): ${result.stderr}`;
  }
  return result.stdout;
}

export async function writeFile(filePath: string, content: string): Promise<string> {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
     
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    
    await fs.writeFile(fullPath, content, "utf-8");
    return `Successfully wrote to ${filePath}`;
  } catch (error: any) {
    return `Error writing file: ${error.message}`;
  }
}

export async function executeTool(name: string, args: any) {
switch (name) {
    case 'run_command':
      return await runCommand(args.command);
    case 'read_file':
      return await readFile(args.path);
    case 'write_file':
      return await writeFile(args.path, args.content);
    default:
      return `Unknown tool: ${name}`;
  } 
}