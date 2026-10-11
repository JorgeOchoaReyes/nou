import type { ToolDef } from "../providers/types.js";

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
      name: "list_files",
      description: "List the files and folders of the project (or a sub folder) as a tree",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Folder to list, relative to the project root. Defaults to the root.",
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit an existing file by replacing one exact snippet of text with new text. Prefer this over write_file for changes to existing files. Read the file first so old_string matches exactly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit"
          },
          old_string: {
            type: "string",
            description: "The exact text to replace. Must appear exactly once in the file."
          },
          new_string: {
            type: "string",
            description: "The text to put in its place"
          }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or fully overwrite a file (TypeScript, JavaScript, Python, etc.). Use this to generate boilerplate, add features, or create scripts.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The relative path including extension (e.g., \"scripts/setup.py\")"
          },
          content: {
            type: "string",
            description: "The RAW source code. Do NOT wrap in markdown code blocks. Use real newlines, not escaped \\n characters."
          }
        },
        required: ["path", "content"]
      }
    }
  }
];

export const toolDefs = tools.map((t) => t.function) as ToolDef[];
