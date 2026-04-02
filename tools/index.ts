import shelljs from "shelljs";
import fs from "fs/promises";

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
    }
];

export async function executeTool(name: string, args: any) {
    if (name === "run_command") {
        const result = shelljs.exec(args.command, { silent: true });

        if (result.code !== 0) {
            return `Error (Exit Code ${result.code}): ${result.stderr}`;
        }

        return result.stdout;
    }
    if (name === "read_file") {
        return await fs.readFile(args.path, "utf-8");
    }
    return "Unknown tool";
}