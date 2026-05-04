import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { google, type youtube_v3 } from "googleapis";
import open from "open";

const AUTH_DIR = path.join(os.homedir(), ".youtube-music-playlist-mcp");
const CLIENT_SECRET_PATH = path.join(AUTH_DIR, "client_secret.json");
const TOKEN_PATH = path.join(AUTH_DIR, "token.json");
const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth2callback`;
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

interface DesktopClientSecretFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
}

interface DesktopClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DesktopAuthStatus {
  authenticated: boolean;
  message: string;
  channelTitle?: string;
  channelId?: string;
}

export function authPaths(): {
  authDir: string;
  clientSecretPath: string;
  tokenPath: string;
  redirectUri: string;
  scope: string;
} {
  return {
    authDir: AUTH_DIR,
    clientSecretPath: CLIENT_SECRET_PATH,
    tokenPath: TOKEN_PATH,
    redirectUri: REDIRECT_URI,
    scope: YOUTUBE_SCOPE
  };
}

export async function authLogin(): Promise<void> {
  await ensureAuthDir();
  if (!(await exists(CLIENT_SECRET_PATH))) {
    throw new Error(
      "Missing Google OAuth client file. Save your Desktop App credential JSON to ~/.youtube-music-playlist-mcp/client_secret.json"
    );
  }

  const oauth2Client = await createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [YOUTUBE_SCOPE],
    redirect_uri: REDIRECT_URI
  });

  const codePromise = waitForOAuthCode();
  await open(authUrl, { wait: false }).catch(() => {
    process.stderr.write(`Open this URL manually:\n${authUrl}\n`);
  });

  process.stderr.write("Waiting for Google OAuth callback...\n");
  const code = await codePromise;
  const { tokens } = await oauth2Client.getToken({
    code,
    redirect_uri: REDIRECT_URI
  });

  if (!tokens.refresh_token) {
    process.stderr.write(
      "Warning: Google did not return a refresh token. If status fails later, revoke app access and run auth login again.\n"
    );
  }

  await saveToken(tokens);
}

export async function authStatus(): Promise<DesktopAuthStatus> {
  if (!(await exists(TOKEN_PATH))) {
    return {
      authenticated: false,
      message: "Not authenticated. Run `youtube-music-playlist-mcp auth login`."
    };
  }

  try {
    const youtube = await getYouTubeClient();
    const response = await youtube.channels.list({
      part: ["snippet"],
      mine: true
    });
    const channel = response.data.items?.[0];

    return {
      authenticated: true,
      message: "Authenticated with YouTube Data API.",
      channelTitle: channel?.snippet?.title ?? undefined,
      channelId: channel?.id ?? undefined
    };
  } catch (error) {
    return {
      authenticated: false,
      message: `Could not validate YouTube credentials: ${errorMessage(error)}. Run \`youtube-music-playlist-mcp auth login\`.`
    };
  }
}

export async function authLogout(): Promise<boolean> {
  try {
    await rm(TOKEN_PATH);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function getYouTubeClient(): Promise<youtube_v3.Youtube> {
  const oauth2Client = await getAuthorizedOAuth2Client();
  return google.youtube({
    version: "v3",
    auth: oauth2Client
  });
}

export async function getAuthorizedOAuth2Client(): Promise<OAuth2Client> {
  const oauth2Client = await createOAuthClient();
  const token = await loadToken();

  oauth2Client.setCredentials(token);
  oauth2Client.on("tokens", (tokens) => {
    void saveToken({ ...token, ...tokens });
  });

  try {
    const accessToken = await oauth2Client.getAccessToken();
    if (!accessToken.token) {
      throw new Error("Google did not return an access token.");
    }
  } catch (error) {
    if (!token.refresh_token) {
      throw new Error("Refresh token is missing or expired.");
    }

    throw error;
  }

  return oauth2Client;
}

async function createOAuthClient(): Promise<OAuth2Client> {
  const credentials = await loadDesktopClientCredentials();
  return new OAuth2Client(credentials.clientId, credentials.clientSecret, REDIRECT_URI);
}

async function loadDesktopClientCredentials(): Promise<DesktopClientCredentials> {
  let parsed: DesktopClientSecretFile;
  try {
    parsed = JSON.parse(await readFile(CLIENT_SECRET_PATH, "utf8")) as DesktopClientSecretFile;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        "Missing Google OAuth client file. Save your Desktop App credential JSON to ~/.youtube-music-playlist-mcp/client_secret.json"
      );
    }

    throw new Error(`Invalid client_secret.json: ${errorMessage(error)}`);
  }

  const clientId = parsed.installed?.client_id;
  const clientSecret = parsed.installed?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Invalid client_secret.json: expected Desktop App credentials with installed.client_id and installed.client_secret."
    );
  }

  return { clientId, clientSecret };
}

async function loadToken(): Promise<Credentials> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as Credentials;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("Missing token.json. Run `youtube-music-playlist-mcp auth login`.");
    }

    throw new Error(`Invalid token.json: ${errorMessage(error)}`);
  }
}

async function saveToken(token: Credentials): Promise<void> {
  await ensureAuthDir();
  await writeFile(TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600).catch(() => undefined);
}

async function ensureAuthDir(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await chmod(AUTH_DIR, 0o700).catch(() => undefined);
}

function waitForOAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", REDIRECT_URI);
      if (requestUrl.pathname !== "/oauth2callback") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found.");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(`Authentication failed: ${error}`);
        finish(new Error(`OAuth callback returned error: ${error}`));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("OAuth callback missing code.");
        finish(new Error("OAuth callback missing code."));
        return;
      }

      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Authentication complete. You can close this tab.");
      finish(undefined, code);
    });

    server.on("error", (error) => {
      if (isNodeError(error) && error.code === "EADDRINUSE") {
        finish(new Error(`Port ${CALLBACK_PORT} is already in use. Stop that process and run auth login again.`));
        return;
      }

      finish(error);
    });

    server.listen(CALLBACK_PORT, "localhost");

    function finish(error?: Error, code?: string): void {
      if (settled) {
        return;
      }

      settled = true;
      server.close();
      if (error) {
        reject(error);
        return;
      }

      resolve(code ?? "");
    }
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
