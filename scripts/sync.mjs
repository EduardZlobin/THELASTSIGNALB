import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;

const OUT_FILE = "posts.json";
const CHANNEL_NAME = "🅲🅽🅽-breaking-bad-news📰";

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

async function getThreadMessages(threadId, limit = 100) {
  return api(`/channels/${threadId}/messages?limit=${limit}`);
}

function normAuthor(a) {
  if (!a) return { name: "unknown", tag: "unknown" };
  const disc =
    a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
  return { name: a.username || "unknown", tag: `${a.username || "unknown"}${disc}` };
}

function pickStarterMessage(messages, threadId) {
  // Часто starter message id == thread id
  const byId = messages.find((m) => m.id === threadId);
  if (byId) return byId;

  // иначе самый старый из пачки
  return messages[messages.length - 1] || null;
}

function toISO(ts) {
  try {
    return ts ? new Date(ts).toISOString() : null;
  } catch {
    return null;
  }
}

async function main() {
  const archived = await getArchivedPublicThreads(FORUM_CHANNEL_ID, 50);
  const threads = archived?.threads || [];

  const posts = [];

  for (const th of threads) {
    const msgs = await getThreadMessages(th.id, 100);
    if (!Array.isArray(msgs) || !msgs.length) continue;

    // Discord отдаёт сообщения от новых к старым
    const starter = pickStarterMessage(msgs, th.id);
    if (!starter) continue;

    const a = normAuthor(starter.author);

    // Комментарии = все остальные сообщения
    const comments = msgs
      .filter((m) => m.id !== starter.id)
      .slice(0, 80)
      .map((m) => {
        const au = normAuthor(m.author);
        return {
          id: m.id,
          author: au.name,
          author_tag: au.tag,
          created_at: toISO(m.timestamp),
          content: m.content || "",
          images: (m.attachments || []).map((x) => x.url),
        };
      })
      .reverse(); // чтобы шли от старых к новым

    posts.push({
      id: th.id,
      title: th.name,

      // ✅ описание поста (первое сообщение в теме)
      content: starter.content || "",

      // ✅ картинки в первом сообщении
      images: (starter.attachments || []).map((x) => x.url),

      created_at: toISO(starter.timestamp) || toISO(th.created_at),

      channel_id: String(FORUM_CHANNEL_ID),
      channel_name: CHANNEL_NAME,
      channel_verified: true,
      channel_avatar: null,

      author: a.name,
      author_tag: a.tag,

      // ✅ ссылка на тему
      url: th.guild_id
        ? `https://discord.com/channels/${th.guild_id}/${th.id}`
        : null,

      // ✅ комментарии (чтение)
      comments,
    });
  }

  posts.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  fs.writeFileSync(OUT_FILE, JSON.stringify(posts, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE}: ${posts.length} posts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
