import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPlaylistPrompts } from "./prompts.js";
import { registerPlaylistResources } from "./resources.js";
import { registerPlaylistTools } from "./tools.js";

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "youtube-music-playlist-mcp",
    version: "0.1.0"
  });

  registerPlaylistTools(server);
  registerPlaylistResources(server);
  registerPlaylistPrompts(server);
  return server;
}

export async function runServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
