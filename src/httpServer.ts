import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { LocalMcpOAuthProvider } from "./auth/mcpOAuthProvider.js";
import {
  createGoogleAuthUrl,
  exchangeGoogleCodeAndSave,
  googleAuthStatus,
  saveGoogleOAuthClientConfig
} from "./auth/googleOAuth.js";
import { createServer } from "./server.js";
import { escapeHtml } from "./utils/html.js";

const DEFAULT_MCP_HTTP_PORT = 3987;
const GOOGLE_CALLBACK_PATH = "/oauth2callback";

export interface HttpServerOptions {
  port?: number;
  host?: string;
}

export async function runHttpServer(options: HttpServerOptions = {}): Promise<void> {
  const port = options.port ?? readHttpPort();
  const host = options.host ?? "127.0.0.1";
  const baseUrl = new URL(`http://${host}:${port}`);
  const resourceServerUrl = new URL("/mcp", baseUrl);
  const provider = new LocalMcpOAuthProvider({ baseUrl, googleCallbackPath: GOOGLE_CALLBACK_PATH });
  const app = express();

  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ ok: true, mcp: resourceServerUrl.href });
  });

  app.get("/setup", async (_req, res) => {
    res.type("html").send(renderSetupPage(await googleAuthStatus(), baseUrl));
  });

  app.post("/setup", express.urlencoded({ extended: false }), async (req, res) => {
    try {
      await saveGoogleOAuthClientConfig({
        clientId: String(req.body.clientId ?? ""),
        clientSecret: String(req.body.clientSecret ?? ""),
        redirectPort: port
      });
      res.redirect(303, "/setup?saved=1");
    } catch (error) {
      res.status(400).type("html").send(renderSetupPage(await googleAuthStatus(), baseUrl, error));
    }
  });

  app.get("/setup/login", async (_req, res) => {
    try {
      res.redirect(
        302,
        await createGoogleAuthUrl({
          state: "setup",
          redirectUri: new URL(GOOGLE_CALLBACK_PATH, baseUrl).href
        })
      );
    } catch (error) {
      res.status(400).type("html").send(renderSetupPage(await googleAuthStatus(), baseUrl, error));
    }
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      baseUrl,
      resourceServerUrl,
      resourceName: "YouTube Music Playlist MCP",
      scopesSupported: ["youtube.playlists"],
      authorizationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: false },
      revocationOptions: { rateLimit: false }
    })
  );

  app.get(GOOGLE_CALLBACK_PATH, async (req, res) => {
    try {
      const pendingId = String(req.query.state ?? "");
      const code = String(req.query.code ?? "");
      const error = req.query.error ? String(req.query.error) : undefined;
      if (error) {
        res.status(400).send(renderAuthError(`Google OAuth failed: ${error}`));
        return;
      }

      if (!pendingId || !code) {
        res.status(400).send(renderAuthError("Missing Google OAuth state or code."));
        return;
      }

      await exchangeGoogleCodeAndSave({
        code,
        redirectUri: new URL(GOOGLE_CALLBACK_PATH, baseUrl).href
      });

      if (pendingId === "setup") {
        res.type("html").send(renderSetupCompletePage(await googleAuthStatus(), baseUrl));
        return;
      }

      res.redirect(302, await provider.completePendingAuthorization(pendingId));
    } catch (error) {
      res.status(500).send(renderAuthError(error instanceof Error ? error.message : String(error)));
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    allowedHosts: [`${host}:${port}`, `localhost:${port}`],
    allowedOrigins: [`http://${host}:${port}`, `http://localhost:${port}`]
  });
  const server = await createServer();
  await server.connect(transport);

  app.all(
    "/mcp",
    requireBearerAuth({
      verifier: provider,
      requiredScopes: ["youtube.playlists"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
    }),
    async (req, res) => {
      await transport.handleRequest(req, res, undefined);
    }
  );

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  process.stderr.write(`YouTube Music Playlist MCP HTTP server listening at ${resourceServerUrl.href}\n`);
}

function readHttpPort(): number {
  const raw = process.env.MCP_HTTP_PORT ?? process.env.GOOGLE_REDIRECT_PORT;
  if (!raw) {
    return DEFAULT_MCP_HTTP_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT/GOOGLE_REDIRECT_PORT: ${raw}`);
  }

  return port;
}

function renderAuthError(message: string): string {
  return `<!doctype html><html><body><h1>YouTube Music MCP auth failed</h1><p>${escapeHtml(
    message
  )}</p></body></html>`;
}

function renderSetupPage(
  status: Awaited<ReturnType<typeof googleAuthStatus>>,
  baseUrl: URL,
  error?: unknown
): string {
  const redirectUri = `http://127.0.0.1:${baseUrl.port}/oauth2callback`;
  const errorHtml = error
    ? `<div class="error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`
    : "";
  const configuredHtml = status.configured
    ? `<div class="ok">Google OAuth client config is saved.</div>`
    : `<div class="warn">Google OAuth client config is not saved yet.</div>`;
  const tokenHtml = status.hasRefreshToken
    ? `<div class="ok">Google login is complete. You can use Codex /mcp login or MCP tools.</div>`
    : `<div class="warn">Google login is not complete yet.</div>`;

  return `<!doctype html>
<html>
  <head>
    <title>YouTube Music MCP Setup</title>
    <style>
      body { background: #f7f2e8; color: #241f18; font-family: ui-serif, Georgia, serif; margin: 0; }
      main { max-width: 820px; margin: 48px auto; padding: 32px; background: #fffaf0; border: 1px solid #dfd2bc; border-radius: 18px; box-shadow: 0 18px 60px rgb(57 44 24 / 12%); }
      h1 { margin-top: 0; font-size: 34px; }
      label { display: block; font-weight: 700; margin-top: 18px; }
      input { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #c8b89e; border-radius: 10px; font: inherit; background: white; }
      code { background: #efe3ce; padding: 2px 6px; border-radius: 6px; }
      button, a.button { display: inline-block; margin-top: 18px; padding: 12px 18px; border: 0; border-radius: 999px; background: #1f4d3a; color: white; text-decoration: none; font: inherit; cursor: pointer; }
      .secondary { background: #7b4f28; }
      .ok, .warn, .error { padding: 12px; border-radius: 10px; margin: 12px 0; }
      .ok { background: #dff0df; }
      .warn { background: #fff0c7; }
      .error { background: #ffd7d2; }
      .steps { line-height: 1.55; }
    </style>
  </head>
  <body>
    <main>
      <h1>YouTube Music MCP Setup</h1>
      ${errorHtml}
      ${configuredHtml}
      ${tokenHtml}
      <p>Use this page to save your Google OAuth client once. Values are stored locally in <code>${escapeHtml(status.clientConfigPath)}</code>.</p>
      <p>Required redirect URI in Google Cloud:</p>
      <p><code>${escapeHtml(redirectUri)}</code></p>
      <form method="post" action="/setup">
        <label for="clientId">Google Client ID</label>
        <input id="clientId" name="clientId" autocomplete="off" required />
        <label for="clientSecret">Google Client Secret</label>
        <input id="clientSecret" name="clientSecret" type="password" autocomplete="off" required />
        <button type="submit">Save OAuth Client</button>
      </form>
      <a class="button secondary" href="/setup/login">Login With Google</a>
      <div class="steps">
        <h2>Order</h2>
        <p>1. Create OAuth client in Google Cloud.</p>
        <p>2. Paste Client ID and Client Secret here, then save.</p>
        <p>3. Click Login With Google.</p>
        <p>4. Return to Codex and use <code>/mcp</code>.</p>
      </div>
    </main>
  </body>
</html>`;
}

function renderSetupCompletePage(status: Awaited<ReturnType<typeof googleAuthStatus>>, baseUrl: URL): string {
  return `<!doctype html>
<html>
  <head><title>YouTube Music MCP Setup Complete</title></head>
  <body style="font-family: Georgia, serif; background: #f7f2e8; color: #241f18;">
    <main style="max-width: 720px; margin: 48px auto; padding: 32px; background: #fffaf0; border-radius: 18px;">
      <h1>Google Login Complete</h1>
      <p>${escapeHtml(status.message)}</p>
      <p>MCP URL: <code>${escapeHtml(new URL("/mcp", baseUrl).href)}</code></p>
      <p>You can close this tab and use Codex <code>/mcp</code>.</p>
      <p><a href="/setup">Back to setup</a></p>
    </main>
  </body>
</html>`;
}

