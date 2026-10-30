import type { ToolDef } from "../providers/types.js";

export const tools = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project folder: tests, builds, type checks, git, package scripts. Returns its output (stdout and stderr together) and, when it fails, its exit code. Use grep, glob and read_file rather than grep/find/cat here. Quote paths with spaces. Don't start interactive programs or servers that never exit.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run",
          },
          timeout: {
            type: "number",
            description: "Seconds to wait before stopping it. Defaults to 120, at most 600.",
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
      description: "Read a file. Lines come back numbered (\"  12\\tcode\"); the numbers aren't part of the file. Long files come back in pages of up to 1000 lines; the end of each page says how to read on.",
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
      name: "multi_edit",
      description: "Make several edits to one file at once, shown to the user as one change. Each edit works like edit_file, applied in order to the result of the one before; if any fails, none are made. Use it instead of several edit_file calls on the same file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit"
          },
          edits: {
            type: "array",
            description: "The edits, in order",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string", description: "The exact text to replace" },
                new_string: { type: "string", description: "The text to put in its place" },
                replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." }
              },
              required: ["old_string", "new_string"]
            }
          }
        },
        required: ["path", "edits"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description: "Keep a short checklist for a task with several steps: send the whole list each time, with each step's status. The user sees it. Use it for anything with three or more steps; skip it for quick questions and one-line fixes.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Every step, in order",
            items: {
              type: "object",
              properties: {
                step: { type: "string", description: "What the step does, in a few words" },
                status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Where it's at" }
              },
              required: ["step", "status"]
            }
          }
        },
        required: ["steps"]
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
