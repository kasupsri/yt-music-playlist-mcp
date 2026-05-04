import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpOAuthPath } from "../config/paths.js";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "./authState.js";
import { createGoogleAuthUrl, googleAuthStatus } from "./googleOAuth.js";
import { escapeHtml } from "../utils/html.js";

export interface McpOAuthProviderOptions {
  baseUrl: URL;
  googleCallbackPath?: string;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface McpOAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  pending: Record<string, PendingAuthorization>;
  authorizationCodes: Record<string, AuthorizationCode>;
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

const MCP_SCOPES = ["youtube.playlists"];
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const AUTH_CODE_TTL_SECONDS = 60 * 10;

export class LocalMcpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly baseUrl: URL;
  private readonly googleCallbackPath: string;

  constructor(options: McpOAuthProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.googleCallbackPath = options.googleCallbackPath ?? "/oauth2callback";
    this.clientsStore = new JsonClientStore();
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: {
      state?: string;
      scopes?: string[];
      codeChallenge: string;
      redirectUri: string;
      resource?: URL;
    },
    res: Response
  ): Promise<void> {
    const pendingId = randomToken();
    const scopes = normalizeScopes(params.scopes);
    const state = await loadState();
    state.pending[pendingId] = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      state: params.state,
      resource: params.resource?.href,
      expiresAt: nowSeconds() + AUTH_CODE_TTL_SECONDS
    };
    await saveState(pruneExpired(state));

    const google = await googleAuthStatus();
    if (google.configured && google.hasRefreshToken) {
      res.redirect(302, await this.completePendingAuthorization(pendingId));
      return;
    }

    try {
      const callbackUrl = new URL(this.googleCallbackPath, this.baseUrl).href;
      res.redirect(302, await createGoogleAuthUrl({ state: pendingId, redirectUri: callbackUrl }));
    } catch (error) {
      res.status(500).type("html").send(renderErrorPage(error));
    }
  }

  async completePendingAuthorization(pendingId: string): Promise<string> {
    const state = pruneExpired(await loadState());
    const pending = state.pending[pendingId];
    if (!pending) {
      throw new InvalidGrantError("Authorization request expired or was not found.");
    }

    const code = randomToken();
    state.authorizationCodes[code] = {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: nowSeconds() + AUTH_CODE_TTL_SECONDS
    };
    delete state.pending[pendingId];
    await saveState(state);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (pending.state) {
      redirectUrl.searchParams.set("state", pending.state);
    }

    return redirectUrl.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const state = pruneExpired(await loadState());
    const code = state.authorizationCodes[authorizationCode];
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code.");
    }

    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const state = pruneExpired(await loadState());
    const code = state.authorizationCodes[authorizationCode];
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code.");
    }

    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match authorization request.");
    }

    if (resource && code.resource && resource.href !== code.resource) {
      throw new InvalidGrantError("resource does not match authorization request.");
    }

    delete state.authorizationCodes[authorizationCode];
    const tokens = issueTokens(state, {
      clientId: client.client_id,
      scopes: code.scopes,
      resource: code.resource
    });
    await saveState(state);
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const state = pruneExpired(await loadState());
    const stored = state.refreshTokens[refreshToken];
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token.");
    }

    if (resource && stored.resource && resource.href !== stored.resource) {
      throw new InvalidGrantError("resource does not match refresh token.");
    }

    const requestedScopes = normalizeScopes(scopes);
    const grantedScopes = requestedScopes.every((scope) => stored.scopes.includes(scope))
      ? requestedScopes
      : stored.scopes;
    const accessToken = randomToken();
    state.accessTokens[accessToken] = {
      clientId: client.client_id,
      scopes: grantedScopes,
      resource: stored.resource,
      expiresAt: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS
    };
    await saveState(state);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: grantedScopes.join(" ")
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const state = pruneExpired(await loadState());
    const stored = state.accessTokens[token];
    if (!stored) {
      await saveState(state);
      throw new InvalidTokenError("Invalid or expired MCP access token.");
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      resource: stored.resource ? new URL(stored.resource) : undefined
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const state = await loadState();
    delete state.accessTokens[request.token];
    delete state.refreshTokens[request.token];
    await saveState(state);
  }
}

export async function resetMcpOAuth(): Promise<boolean> {
  return removeFileIfExists(mcpOAuthPath());
}

class JsonClientStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return (await loadState()).clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const state = await loadState();
    state.clients[client.client_id] = client;
    await saveState(state);
    return client;
  }
}

async function loadState(): Promise<McpOAuthState> {
  return (
    (await readJsonFile<McpOAuthState>(mcpOAuthPath())) ?? {
      clients: {},
      pending: {},
      authorizationCodes: {},
      accessTokens: {},
      refreshTokens: {}
    }
  );
}

async function saveState(state: McpOAuthState): Promise<void> {
  await writeJsonFile(mcpOAuthPath(), state);
}

function issueTokens(
  state: McpOAuthState,
  input: { clientId: string; scopes: string[]; resource?: string }
): OAuthTokens {
  const accessToken = randomToken();
  const refreshToken = randomToken();

  state.accessTokens[accessToken] = {
    clientId: input.clientId,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS
  };
  state.refreshTokens[refreshToken] = {
    clientId: input.clientId,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS
  };

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: input.scopes.join(" ")
  };
}

function pruneExpired(state: McpOAuthState): McpOAuthState {
  const now = nowSeconds();
  for (const [key, value] of Object.entries(state.pending)) {
    if (value.expiresAt <= now) delete state.pending[key];
  }
  for (const [key, value] of Object.entries(state.authorizationCodes)) {
    if (value.expiresAt <= now) delete state.authorizationCodes[key];
  }
  for (const [key, value] of Object.entries(state.accessTokens)) {
    if (value.expiresAt <= now) delete state.accessTokens[key];
  }
  for (const [key, value] of Object.entries(state.refreshTokens)) {
    if (value.expiresAt <= now) delete state.refreshTokens[key];
  }

  return state;
}

function normalizeScopes(scopes?: string[]): string[] {
  const requested = scopes?.length ? scopes : MCP_SCOPES;
  return [...new Set(requested.filter((scope) => MCP_SCOPES.includes(scope)))];
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function renderErrorPage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!doctype html><html><body><h1>YouTube Music MCP auth could not start</h1><p>${escapeHtml(
    message
  )}</p></body></html>`;
}

