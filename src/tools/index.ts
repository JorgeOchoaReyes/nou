
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
      description: "Create or update files (TypeScript, JavaScript, Python, etc.). Use this to generate boilerplate, add features, or create scripts.",
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
