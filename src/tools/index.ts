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
      description: "Read a file. Long files come back in pages of up to 1000 lines; the end of each page says how to read on.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to file",
          },
          offset: {
            type: "number",
            description: "First line to read (1-based). Defaults to 1.",
          },
          limit: {
            type: "number",
            description: "How many lines to read. Defaults to 1000.",
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search the contents of the project's files with a regular expression (or plain text). Returns file:line: matching line. Use it to find where something is defined or used before reading files.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression (JavaScript syntax) or plain text to look for",
          },
          path: {
            type: "string",
            description: "File or folder to search in. Defaults to the whole project.",
          },
          glob: {
            type: "string",
            description: "Only search files matching this glob, e.g. \"*.ts\" or \"src/**/*.py\"",
          },
          ignore_case: {
            type: "boolean",
            description: "Match regardless of case",
          },
          context: {
            type: "number",
            description: "Lines to show before and after each match (0-5)",
          },
          files_only: {
            type: "boolean",
            description: "List only the files that match, with match counts",
          }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by name pattern, e.g. \"**/*.test.ts\" or \"*config*\". Newest first. Patterns without a slash match file names anywhere.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern: * and ? within a folder, ** across folders, {a,b} for either",
          },
          path: {
            type: "string",
            description: "Folder to search in. Defaults to the whole project.",
          }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description: "Show a file in the user's code view (the middle panel), scrolled to a line with the given lines highlighted. Use it when the user asks where something is or to show/open/find something: find the exact place first, then open it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the project root",
          },
          line: {
            type: "number",
            description: "First line to show and highlight (1-based)",
          },
          end_line: {
            type: "number",
            description: "Last line to highlight, e.g. the end of the function. Defaults to line.",
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
            description: "The exact text to replace. Must appear exactly once in the file, unless replace_all is true."
          },
          new_string: {
            type: "string",
            description: "The text to put in its place"
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence of old_string (e.g. to rename something throughout the file). Defaults to false."
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
