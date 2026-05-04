#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import {
  authLogin,
  authLogout,
  authPaths,
  authStatus as desktopAuthStatus
} from "./auth/desktopGoogleOAuth.js";
import { googleAuthStatus, resetGoogleAuth, runGoogleAuthFlow } from "./auth/googleOAuth.js";
import { resetMcpOAuth } from "./auth/mcpOAuthProvider.js";
import {
  resetYouTubeMusicAuth,
  runYouTubeMusicAuthFlow,
  youtubeMusicAuthStatus
} from "./auth/ytmusicAuth.js";
import { loadDotEnv } from "./config/env.js";
import { runHttpServer } from "./httpServer.js";
import { runServer } from "./server.js";
import { jsonText } from "./utils/json.js";

loadDotEnv();

const program = new Command();
program
  .name("yt-music-playlist-mcp")
  .description("MCP server and auth CLI for AI-assisted YouTube Music playlist management.")
  .version("0.1.0");

program
  .command("serve")
  .description("Run the MCP server over stdio.")
  .action(async () => {
    await runServer();
  });

program
  .command("serve-http")
  .description("Run the MCP server over local streamable HTTP with OAuth for Codex /mcp login.")
  .option("--port <port>", "Port to listen on. Defaults to MCP_HTTP_PORT, GOOGLE_REDIRECT_PORT, or 3987.")
  .option("--host <host>", "Host to bind. Defaults to 127.0.0.1.")
  .action(async (options: { port?: string; host?: string }) => {
    await runHttpServer({
      port: options.port ? Number(options.port) : undefined,
      host: options.host
    });
  });

program
  .command("setup")
  .description("Start the local HTTP MCP server and open the browser setup page.")
  .option("--port <port>", "Port to listen on. Defaults to MCP_HTTP_PORT, GOOGLE_REDIRECT_PORT, or 3987.")
  .option("--host <host>", "Host to bind. Defaults to 127.0.0.1.")
  .action(async (options: { port?: string; host?: string }) => {
    const port = options.port ? Number(options.port) : Number(process.env.MCP_HTTP_PORT ?? process.env.GOOGLE_REDIRECT_PORT ?? "3987");
    const host = options.host ?? "127.0.0.1";
    await runHttpServer({ port, host });
    const setupUrl = `http://${host}:${port}/setup`;
    await open(setupUrl, { wait: false }).catch(() => {
      console.log(`Open ${setupUrl}`);
    });
  });

const auth = program.command("auth").description("Manage local YouTube auth state.");

auth
  .command("login")
  .description("Authenticate with Google OAuth using ~/.ytmusic-mcp/client_secret.json.")
  .action(async () => {
    try {
      await authLogin();
      console.log(`Authentication complete. Token saved to ${authPaths().tokenPath}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

auth
  .command("google")
  .description("Open a browser and authenticate Google OAuth for YouTube Data API writes.")
  .action(async () => {
    console.log(jsonText(await runGoogleAuthFlow()));
  });

auth
  .command("ytmusic")
  .description("Open YouTube Music and store optional browser headers for the unofficial adapter.")
  .option("--headers-file <path>", "Import a JSON object of music.youtube.com request headers.")
  .action(async (options: { headersFile?: string }) => {
    console.log(jsonText(await runYouTubeMusicAuthFlow(options.headersFile)));
  });

auth
  .command("status")
  .description("Validate Google OAuth token and show authenticated YouTube channel.")
  .action(async () => {
    const status = await desktopAuthStatus();
    if (!status.authenticated) {
      console.log(status.message);
      process.exitCode = 1;
      return;
    }

    console.log(status.message);
    if (status.channelTitle) {
      console.log(`Channel: ${status.channelTitle}`);
    }
    if (status.channelId) {
      console.log(`Channel ID: ${status.channelId}`);
    }
  });

auth
  .command("logout")
  .description("Remove ~/.ytmusic-mcp/token.json without deleting client_secret.json.")
  .action(async () => {
    const removed = await authLogout();
    console.log(
      removed
        ? `Logged out. Removed ${authPaths().tokenPath}.`
        : `Already logged out. ${authPaths().tokenPath} does not exist.`
    );
  });

auth
  .command("paths")
  .description("Show auth file paths without printing secrets.")
  .action(() => {
    console.log(jsonText(authPaths()));
  });

auth
  .command("reset")
  .description("Remove locally stored auth state.")
  .option("--google", "Reset only Google OAuth.")
  .option("--ytmusic", "Reset only YouTube Music auth.")
  .option("--mcp", "Reset only Codex MCP OAuth tokens issued by the local HTTP server.")
  .option("--all", "Reset all auth state.")
  .action(async (options: { google?: boolean; ytmusic?: boolean; mcp?: boolean; all?: boolean }) => {
    const noSpecificTarget = !options.google && !options.ytmusic && !options.mcp;
    const resetGoogle = options.all || options.google || noSpecificTarget;
    const resetYtMusic = options.all || options.ytmusic || noSpecificTarget;
    const resetMcp = options.all || options.mcp || noSpecificTarget;
    const result: Record<string, unknown> = {};

    if (resetGoogle) {
      result.googleRemoved = await resetGoogleAuth();
    }

    if (resetYtMusic) {
      result.ytmusic = await resetYouTubeMusicAuth();
    }

    if (resetMcp) {
      result.mcpOAuthRemoved = await resetMcpOAuth();
    }

    console.log(jsonText(result));
  });

if (process.argv.length <= 2) {
  await runServer();
} else {
  await program.parseAsync(process.argv);
}
