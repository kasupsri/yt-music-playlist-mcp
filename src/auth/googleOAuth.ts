import http from "node:http";
import { URL } from "node:url";
import { OAuth2Client, type Credentials } from "google-auth-library";
import open from "open";
import { googleClientPath, googleTokenPath } from "../config/paths.js";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "./authState.js";
import { escapeHtml } from "../utils/html.js";

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube"
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
  redirectUri: string;
}

export interface StoredGoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleOAuthState {
  tokens: Credentials;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GoogleAuthStatus {
  configured: boolean;
  tokenFileExists: boolean;
  hasRefreshToken: boolean;
  expiryDate?: string;
  path: string;
  clientConfigPath: string;
  redirectUri?: string;
  message: string;
}

export async function readGoogleOAuthConfig(): Promise<GoogleOAuthConfig | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const stored = await readJsonFile<StoredGoogleOAuthClientConfig>(googleClientPath());
  const redirectPort = Number(process.env.GOOGLE_REDIRECT_PORT ?? stored?.redirectPort ?? "3987");
  const resolvedClientId = clientId || stored?.clientId;
  const resolvedClientSecret = clientSecret || stored?.clientSecret;

  if (!resolvedClientId || !resolvedClientSecret || !Number.isInteger(redirectPort)) {
    return null;
  }

  return {
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
    redirectPort,
    redirectUri: `http://127.0.0.1:${redirectPort}/oauth2callback`
  };
}

export async function saveGoogleOAuthClientConfig(input: {
  clientId: string;
  clientSecret: string;
  redirectPort?: number;
}): Promise<GoogleOAuthConfig> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  const now = new Date().toISOString();
  const current = await readJsonFile<StoredGoogleOAuthClientConfig>(googleClientPath());
  const redirectPort = input.redirectPort ?? current?.redirectPort ?? Number(process.env.GOOGLE_REDIRECT_PORT ?? "3987");

  if (!clientId || !clientSecret) {
    throw new Error("Google client ID and client secret are required.");
  }

  if (!Number.isInteger(redirectPort) || redirectPort <= 0 || redirectPort > 65535) {
    throw new Error(`Invalid redirect port: ${redirectPort}`);
  }

  await writeJsonFile<StoredGoogleOAuthClientConfig>(googleClientPath(), {
    clientId,
    clientSecret,
    redirectPort,
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  });

  const config = await readGoogleOAuthConfig();
  if (!config) {
    throw new Error("Saved Google OAuth client config could not be loaded.");
  }

  return config;
}

export async function createGoogleOAuthClient(redirectUri?: string): Promise<OAuth2Client> {
  const config = await readGoogleOAuthConfig();
  if (!config) {
    throw new Error("Google OAuth is not configured. Open /setup or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }

  return new OAuth2Client(config.clientId, config.clientSecret, redirectUri ?? config.redirectUri);
}

export async function createGoogleAuthUrl(input: { state?: string; redirectUri?: string } = {}): Promise<string> {
  const client = await createGoogleOAuthClient(input.redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: YOUTUBE_SCOPES,
    state: input.state
  });
}

export async function exchangeGoogleCodeAndSave(input: {
  code: string;
  redirectUri?: string;
}): Promise<GoogleAuthStatus> {
  const client = await createGoogleOAuthClient(input.redirectUri);
  const { tokens } = await client.getToken(input.code);
  await saveGoogleTokens(tokens);
  return googleAuthStatus();
}

export async function googleAuthStatus(): Promise<GoogleAuthStatus> {
  const config = await readGoogleOAuthConfig();
  const state = await readJsonFile<GoogleOAuthState>(googleTokenPath());
  const expiryDate =
    typeof state?.tokens.expiry_date === "number"
      ? new Date(state.tokens.expiry_date).toISOString()
      : undefined;

  if (!config) {
    return {
      configured: false,
      tokenFileExists: Boolean(state),
      hasRefreshToken: Boolean(state?.tokens.refresh_token),
      expiryDate,
      path: googleTokenPath(),
      clientConfigPath: googleClientPath(),
      message: "Missing Google OAuth client config. Open /setup to save it."
    };
  }

  if (!state) {
    return {
      configured: true,
      tokenFileExists: false,
      hasRefreshToken: false,
      path: googleTokenPath(),
      clientConfigPath: googleClientPath(),
      redirectUri: config.redirectUri,
      message: "Open /setup or run `youtube-music-playlist-mcp auth google`."
    };
  }

  return {
    configured: true,
    tokenFileExists: true,
    hasRefreshToken: Boolean(state.tokens.refresh_token),
    expiryDate,
    path: googleTokenPath(),
    clientConfigPath: googleClientPath(),
    redirectUri: config.redirectUri,
    message: "Google OAuth token is available."
  };
}

export async function resetGoogleAuth(): Promise<boolean> {
  return removeFileIfExists(googleTokenPath());
}

export async function getAuthenticatedGoogleClient(): Promise<OAuth2Client> {
  const config = await readGoogleOAuthConfig();
  if (!config) {
    throw new Error("Google OAuth is not configured. Open /setup or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }

  const state = await readJsonFile<GoogleOAuthState>(googleTokenPath());
  if (!state) {
    throw new Error("Google OAuth token is missing. Run `youtube-music-playlist-mcp auth google`.");
  }

  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
  client.setCredentials(state.tokens);
  client.on("tokens", (tokens) => {
    void saveGoogleTokens({ ...state.tokens, ...tokens }, state.createdAt);
  });

  return client;
}

export async function runGoogleAuthFlow(): Promise<GoogleAuthStatus> {
  const config = await readGoogleOAuthConfig();
  if (!config) {
    throw new Error("Open /setup or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running auth.");
  }

  const authUrl = await createGoogleAuthUrl();

  const codePromise = waitForOAuthCode(config.redirectPort);
  await open(authUrl, { wait: false }).catch(() => {
    process.stderr.write(`Open this URL manually:\n${authUrl}\n`);
  });

  process.stderr.write("Waiting for Google OAuth callback in your browser...\n");
  const code = await codePromise;
  await exchangeGoogleCodeAndSave({ code });

  return googleAuthStatus();
}

async function saveGoogleTokens(tokens: Credentials, createdAt = new Date().toISOString()): Promise<void> {
  await writeJsonFile<GoogleOAuthState>(googleTokenPath(), {
    tokens,
    scopes: YOUTUBE_SCOPES,
    createdAt,
    updatedAt: new Date().toISOString()
  });
}

function waitForOAuthCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        if (requestUrl.pathname !== "/oauth2callback") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        if (error) {
          response.writeHead(400, { "content-type": "text/html" });
          response.end(`<h1>Authentication failed</h1><p>${escapeHtml(error)}</p>`);
          server.close();
          reject(new Error(`Google OAuth failed: ${error}`));
          return;
        }

        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.writeHead(400);
          response.end("Missing code.");
          return;
        }

        response.writeHead(200, { "content-type": "text/html" });
        response.end("<h1>Authentication complete</h1><p>You can close this tab.</p>");
        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

