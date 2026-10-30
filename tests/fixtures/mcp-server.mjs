// A tiny MCP server for the tests: one tool that only reads, one that changes something. It writes to
// stderr on purpose, which Nou must keep off the screen.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "test", version: "1" });
server.registerTool("echo", { description: "Echoes text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
server.registerTool("set_flag", { description: "Sets a flag", inputSchema: { value: z.string() } },
  async ({ value }) => ({ content: [{ type: "text", text: `flag set to ${value}` }] }));
process.stderr.write("noisy server log line\n");
await server.connect(new StdioServerTransport());
