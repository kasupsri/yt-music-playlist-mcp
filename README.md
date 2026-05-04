# YT Music Playlist MCP

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets Claude, Codex, and other LLM clients create and manage your YT Music playlists through natural language.

Tell Claude *"build me a 2-hour lo-fi coding playlist"* and it will propose tracks, let you review them, search YT Music (no API quota used), preview the playlist with estimated duration, and only write to YT after you approve.

**Playback is intentionally out of scope.** This server manages playlists only.

---

## Features

- **Natural-language playlist creation** — describe what you want, Claude does the rest
- **Zero-quota track matching** — uses the unofficial YT Music API for search; the official quota-limited YT Data API is only used for playlist writes
- **Safe-by-default mutations** — every write defaults to `dryRun: true`; destructive operations require `confirm: true`
- **30-day track cache** — resolved `title + artist → videoId` pairs are cached locally so repeated runs skip YT entirely
- **Quota tracker** — the server tracks your daily YT Data API usage locally so Claude can route around limits automatically
- **Full MCP surface** — tools, resources, and prompt templates for optimal LLM workflow

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20.11 |
| npm | ≥ 10 |
| A Google account | — |
| A Google Cloud project | free tier is fine |

---

## Quick Start

```bash
git clone https://github.com/kasupsri/yt-music-playlist-mcp.git
cd yt-music-playlist-mcp
npm install
npm run build
```

After building, complete the [Google Cloud Setup](#google-cloud-setup) below, then add the server to your [MCP client](#mcp-client-setup).

---

## Google Cloud Setup

You need a Google OAuth 2.0 client to authorise writes to your YT playlists. This is a one-time setup.

### 1 — Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com).
2. Click the project selector at the top → **New Project**.
3. Give it any name (e.g. `yt-music-mcp`) and click **Create**.

### 2 — Enable the YT Data API

1. In your project, go to **APIs & Services → Library**.
2. Search for **YT Data API v3** and click **Enable**.

### 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** and click **Create**.
3. Fill in:
   - **App name** — anything (e.g. `YT Music MCP`)
   - **User support email** — your email
   - **Developer contact email** — your email
4. Click **Save and Continue** through Scopes (no extra scopes needed here).
5. On the **Test users** page, click **Add users** and enter your own Google account email. Click **Save and Continue**, then **Back to Dashboard**.

> ⚠️ **This step is required.** If you skip adding yourself as a test user, Google will reject your login with `Error 403: access_denied`. The app must be in "Publishing status: Testing" and your account must be listed as a test user for the OAuth login to work. You can add up to 100 test users — add anyone else who will use this server.

### 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Choose **Web application**.
4. Under **Authorized redirect URIs**, click **Add URI** and enter exactly:
   ```
   http://127.0.0.1:3987/oauth2callback
   ```
5. Click **Create**.
6. Copy the **Client ID** and **Client Secret** — you will need them in the next step.

### 5 — Save credentials and log in

**Option A — Setup page (recommended)**

Start the local HTTP setup server:

```bash
node dist/cli.js setup
```

This opens `http://127.0.0.1:3987/setup` in your browser. Paste your Client ID and Client Secret, click **Save OAuth Client**, then click **Login With Google**.

**Option B — Environment variables**

If you prefer not to use the setup page, set these variables in `.env` or your shell:

```bash
cp .env.example .env
# Edit .env and fill in:
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

Then run the Google auth flow:

```bash
node dist/cli.js auth google
```

This opens your browser for a Google sign-in and saves the token locally.

---

## Credential File Locations

All credentials are stored under `.local/` in the project directory by default. This directory is git-ignored and never committed.

| File | Contents |
|---|---|
| `.local/google-client.json` | OAuth Client ID + Secret (saved by setup page) |
| `.local/google-oauth.json` | OAuth access + refresh tokens |
| `.local/ytmusic-auth.json` | YT Music browser headers (optional) |
| `.local/ytmusic-config.json` | Cached YT Music API config |
| `.local/mcp-oauth.json` | MCP OAuth tokens for Codex (HTTP mode only) |
| `.local/track-cache.json` | `title+artist → videoId` cache (30-day TTL) |
| `.local/quota-usage.json` | Local daily quota usage counter |

**Override the storage directory** with `YOUTUBE_MUSIC_MCP_HOME`:

```bash
YOUTUBE_MUSIC_MCP_HOME=~/.youtube-music-mcp node dist/cli.js
```

This is useful when you add the server to Claude Desktop and want credentials stored in a fixed location regardless of where you run the CLI.

---

## MCP Client Setup

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "yt-music-playlist": {
      "command": "node",
      "args": ["/absolute/path/to/yt-music-playlist-mcp/dist/cli.js"],
      "env": {
        "YOUTUBE_MUSIC_MCP_HOME": "/absolute/path/to/yt-music-playlist-mcp/.local"
      }
    }
  }
}
```

Replace both paths with the actual absolute path where you cloned the repo. The `YOUTUBE_MUSIC_MCP_HOME` env var pins the credential directory so Claude Desktop always finds your saved tokens regardless of working directory.

**Restart Claude Desktop** after saving.

### Claude Code (claude.ai/code)

**Step 1 — Copy `.mcp.json.example`** to `.mcp.json` in your project root and fill in the absolute paths:

```json
{
  "mcpServers": {
    "yt-music-playlist": {
      "command": "node",
      "args": ["/absolute/path/to/yt-music-playlist-mcp/dist/cli.js"],
      "env": {
        "YOUTUBE_MUSIC_MCP_HOME": "/absolute/path/to/yt-music-playlist-mcp/.local"
      }
    }
  }
}
```

**Step 2 — Complete Google auth** (if you haven't already):

```bash
node /absolute/path/to/yt-music-playlist-mcp/dist/cli.js auth google
```

This opens your browser, completes the Google sign-in, and saves the token to `.local/google-oauth.json`.

**Step 3 — Start or restart Claude Code.** The server loads automatically from `.mcp.json`. You can verify it's connected by asking Claude: *"call auth_status"*.

> The `YOUTUBE_MUSIC_MCP_HOME` env var is important here — it pins the `.local/` credential directory to the MCP server's own folder so tokens are found regardless of which project directory Claude Code is opened in.

### Claude Code — HTTP OAuth flow (alternative to stdio)

If you prefer OAuth-based auth over the `.mcp.json` stdio approach, Claude Code also supports connecting to the HTTP server directly. This is useful when you want multiple projects to share one running server instance.

**Step 1 — Keep the HTTP server running in a terminal:**

```bash
node dist/cli.js serve-http
```

**Step 2 — Register the server with Claude Code:**

```bash
claude mcp add --transport http yt-music-playlist http://127.0.0.1:3987/mcp
```

**Step 3 — Authenticate inside Claude Code:**

Start a Claude Code session and run the `/mcp` slash command. Select `yt-music-playlist` and choose the login/authenticate option. Claude Code will open your browser to complete Google OAuth and return a token automatically.

**Step 4 — Verify:**

Ask Claude: *"call auth_status"* — it should return your Google account and channel info.

> Your Google OAuth app must have `http://127.0.0.1:3987/oauth2callback` registered as an authorised redirect URI (covered in [Google Cloud Setup step 4](#4--create-oauth-credentials)).

---

### Codex (`/mcp` auth flow)

Codex uses the same HTTP server with OAuth. Keep the server running in a terminal:

```bash
node dist/cli.js serve-http
```

Then register it in Codex:

```bash
codex mcp add yt-music-playlist --url http://127.0.0.1:3987/mcp
codex mcp login yt-music-playlist
```

Codex will open your browser for Google login on first use. Your Google OAuth app must have this redirect URI registered:

```
http://127.0.0.1:3987/oauth2callback
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | — | OAuth Client ID (alternative to setup page) |
| `GOOGLE_CLIENT_SECRET` | — | OAuth Client Secret (alternative to setup page) |
| `GOOGLE_REDIRECT_PORT` | `3987` | Port for the OAuth callback redirect URI |
| `MCP_HTTP_PORT` | `3987` | Port for the HTTP MCP server |
| `YOUTUBE_MUSIC_MCP_HOME` | `./.local` | Override directory for all credential files |
| `YTMUSIC_USER_AGENT` | Chrome 120 UA string | User-agent for unofficial YT Music requests |

---

## YT Music Auth (optional)

The server works without this. It enables authenticated requests to the unofficial YT Music API, which can improve search quality for some regions.

```bash
node dist/cli.js auth ytmusic
```

This opens `music.youtube.com`. After you log in, press Enter. To import headers from a file:

```bash
node dist/cli.js auth ytmusic --headers-file ./headers.json
```

---

## CLI Reference

```bash
# Start stdio MCP server (used by Claude Desktop / Claude Code)
node dist/cli.js

# Start HTTP MCP server + open browser setup page
node dist/cli.js setup

# Start HTTP MCP server only (for Codex)
node dist/cli.js serve-http [--port 3987] [--host 127.0.0.1]

# Auth management
node dist/cli.js auth google          # Re-run Google OAuth browser flow
node dist/cli.js auth ytmusic         # Set up YT Music browser headers
node dist/cli.js auth status          # Show current auth state and channel info
node dist/cli.js auth reset           # Clear all stored credentials
node dist/cli.js auth reset --google  # Clear only Google OAuth tokens
node dist/cli.js auth reset --ytmusic # Clear only YT Music headers
node dist/cli.js auth reset --mcp     # Clear only Codex MCP OAuth tokens
```

---

## MCP Tools

All tools return JSON. Mutating tools default to `dryRun: true`. Destructive tools require `confirm: true`. The LLM sets `dryRun: false` only after the user approves.

### Read-only

| Tool | Description |
|---|---|
| `auth_status` | Check Google OAuth and YT Music auth state |
| `yt_search_tracks` | Search YT Music / YT for track candidates |
| `playlist_list` | List all playlists owned by your account |
| `playlist_get` | Fetch a playlist with all tracks, positions, and duration |
| `playlist_match_tracks` | Resolve `title + artist` pairs to ranked YT candidates with confidence scores. Returns `summary: { matched, ambiguous, missing }`. Uses YT Music (no quota) by default |
| `playlist_propose` | Present a curated track list for user review before any API call — zero quota cost |
| `playlist_propose_update` | Add or remove individual tracks from a pending proposal without re-stating the full list |
| `playlist_generate_draft` | Build a candidate pool by searching YT by mood/genre/era/prompt. Pass `playlistId` to exclude tracks already in that playlist |
| `playlist_expand` | Generate similar tracks for an existing playlist — uses YT Music (no quota) |
| `playlist_quota_status` | Show estimated daily YT Data API quota usage tracked locally |

### Additive writes (default `dryRun: true`)

| Tool | Description |
|---|---|
| `playlist_create` | Create a playlist, optionally adding matched tracks |
| `playlist_add_tracks` | Add tracks to an existing playlist |
| `playlist_duplicate` | Copy an existing playlist with all its tracks |

### Mutating writes (default `dryRun: true`)

| Tool | Description |
|---|---|
| `playlist_update` | Update playlist title, description, or privacy |
| `playlist_reorder_tracks` | Move tracks to target positions. Use `position: -1` to move to end |
| `playlist_replace_tracks` | Replace all playlist contents — also requires `confirm: true` |

### Destructive writes (require `confirm: true`)

| Tool | Description |
|---|---|
| `playlist_delete` | Delete a playlist permanently |
| `playlist_remove_tracks` | Remove specific tracks from a playlist |

---

## MCP Resources

| URI | Description |
|---|---|
| `ytmusic-mcp://guide/workflows` | Workflow and quota guide loaded by the LLM |
| `ytmusic-mcp://playlists/{playlistId}` | Read a playlist snapshot as JSON |

---

## MCP Prompts

Use these in Claude for structured, safe playlist workflows:

**`curate_playlist`** — general-purpose playlist creation, expansion, or cleanup.

```
goal        — what you want (e.g. "upbeat workout playlist")
playlistId  — (optional) existing playlist to update
writeMode   — preview-only | ask-before-writing | apply-after-user-confirms
```

**`research_focus_playlist`** — builds a focus/work playlist. Adapts genre and lyric guidance based on your goal (coding, reading, gym, meditation, etc.).

```
goal          — type of focus playlist (e.g. "deep work coding session")
targetLength  — (optional) e.g. "2 hours" or "20 tracks"
```

---

## Recommended Workflow

The fastest and lowest-quota path for creating a new playlist:

```
1. playlist_propose            →  LLM proposes tracks from its knowledge (0 API calls, 0 quota)
2. [user reviews / edits]      →  use playlist_propose_update for changes
3. playlist_match_tracks       →  resolve title+artist → videoId via YT Music (0 quota)
4. playlist_create dryRun:true →  preview with track list and estimated duration
5. playlist_create dryRun:false → create (costs ~1 + N quota units for N tracks)
```

### Quota reference

| Operation | Quota cost |
|---|---|
| `playlist_match_tracks` (ytmusic) | 0 |
| `playlist_expand`, `playlist_generate_draft` | 0 (ytmusic default) |
| `yt_search_tracks` (Data API) | 100 per call |
| `playlist_get` | ~3 |
| `playlist_list` | ~1 |
| `playlist_create` / `playlist_add_tracks` | ~1 per track |
| Daily limit | 10,000 units (resets midnight Pacific) |

---

## Development

```bash
npm install
npm run dev       # run via tsx without building
npm run build     # compile TypeScript to dist/
npm run typecheck # type-check without emitting
npm test          # run tests with vitest
```

Run a single test file:

```bash
npx vitest run src/utils/match.test.ts
```

---

## Troubleshooting

**"Google OAuth is not configured"**  
Run `node dist/cli.js auth google` or start `node dist/cli.js setup` and save credentials at `http://127.0.0.1:3987/setup`.

**"YT Music search failed: 403"**  
The unofficial YT Music API rejected your request. Run `node dist/cli.js auth ytmusic` to add browser headers, or set `YTMUSIC_USER_AGENT` to your actual Chrome user-agent string.

**Quota exhausted (403 on playlist writes)**  
Your 10,000-unit daily quota is used up. Call `playlist_quota_status` to check. Quota resets at midnight Pacific. Track matching via `playlist_match_tracks` still works (uses YT Music, no quota) and playlist reads/writes resume after reset.

**Tracks matched to a remix, cover, or wrong version**  
Pass `videoId` directly if you already know it — this bypasses all search at zero quota cost. Otherwise use `playlist_generate_draft` to review all candidates before committing.

**MCP tools not showing in Claude Desktop**  
Restart Claude Desktop after editing `claude_desktop_config.json`. Verify the `args` path is absolute, the `dist/cli.js` file exists, and you have run `npm run build`.

**"Error 403: access_denied" during Google login**
Your Google account is not listed as a test user on the OAuth consent screen. Go to **Google Cloud Console → APIs & Services → OAuth consent screen → Test users**, click **Add users**, and add your Google account email. Then try logging in again.

**Redirect URI mismatch error from Google**  
The redirect URI in your Google Cloud credentials must exactly match `http://127.0.0.1:3987/oauth2callback` (or the port you configured). Edit your OAuth client in Google Cloud Console and add the correct URI.

---

## Security Notes

- All credentials are stored locally under `.local/` and never leave your machine.
- The HTTP server binds to `127.0.0.1` only — not accessible from other machines on your network.
- MCP OAuth tokens issued to Codex are stored in `.local/mcp-oauth.json` with a 90-day refresh window.
- Never commit `.local/`, `.env`, or any `client_secret*.json` file. The `.gitignore` covers all of these.

---

## License

MIT © [Kasup Sri Bandara](https://github.com/kasupsri)
