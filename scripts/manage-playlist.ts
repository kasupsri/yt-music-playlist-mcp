import { YTProvider } from "../src/providers/ytProvider.js";

const provider = new YTProvider();

async function main() {
  const cmd = process.argv[2];

  if (cmd === "list") {
    const playlists = await provider.listPlaylists();
    console.log(JSON.stringify(playlists, null, 2));
  } else if (cmd === "get") {
    const id = process.argv[3];
    const playlist = await provider.getPlaylist(id);
    console.log(JSON.stringify(playlist, null, 2));
  } else if (cmd === "remove") {
    const playlistId = process.argv[3];
    const videoIds = process.argv.slice(4);
    const result = await provider.removeTracks({ playlistId, videoIds, confirm: true });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "add") {
    const playlistId = process.argv[3];
    const videoId = process.argv[4];
    const result = await provider.addTracks({
      playlistId,
      tracks: [{ videoId }],
      dryRun: false
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "search") {
    const query = process.argv.slice(3).join(" ");
    const results = await provider.searchTracks({ query }, 5);
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch(console.error);
