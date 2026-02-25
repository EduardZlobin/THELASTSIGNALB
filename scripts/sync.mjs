import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;            // секрет!
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;      // "1259105..."
const OUT_FILE = "posts.json";

if (!DISCORD_TOKEN || !FORUM_CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or FORUM_CHANNEL_ID");
  process.exit(1);
}

async function api(path) {
  const res = await fetch("https://discord.com/api/v10" + path, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getArchivedPublicThreads(channelId, limit = 50) {
  return api(`/channels/${channelId}/threads/archived/public?limit=${limit}`);
}

async function getMessages(channelId, limit = 50) {
  return api(`/channels/${channelId}/messages?limit=${limit}`);
}

function normalize(posts) {
  posts.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return posts;
}

async function main() {
  const archived = await getArchivedPublicThreads(FORUM_CHANNEL_ID, 50);
  const threads = archived?.threads || [];

  const posts = [];

  for (const th of threads) {
    // Берём первые сообщения темы (в ответе messages обычно идут от новых к старым)
    const msgs = await getMessages(th.id, 50);
    const starter = msgs[msgs.length - 1]; // самый старый в пачке

    if (!starter) continue;

    posts.push({
      id: th.id,
      title: th.name,
      content: starter.content || "",
      created_at: starter.timestamp || th.created_at || null,

      channel_id: FORUM_CHANNEL_ID,
      channel_name: "DISCORD FORUM",
      channel_verified: true,
      channel_avatar: null,

      author: starter.author?.username ? `${starter.author.username}` : "BOT",
      images: (starter.attachments || []).map(a => a.url),
      url: th.guild_id ? `https://discord.com/channels/${th.guild_id}/${th.id}` : null,
    });
  }

  const out = normalize(posts);
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE}: ${out.length} posts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});