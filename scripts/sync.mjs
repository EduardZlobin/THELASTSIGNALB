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

async function getMessages(threadId, limit = 100) {
  return api(`/channels/${threadId}/messages?limit=${limit}`);
}

async function getMessage(threadId, messageId) {
  return api(`/channels/${threadId}/messages/${messageId}`);
}

async function getActiveThreads(channelId) {
  return api(`/channels/${channelId}/threads/active`);
}

async function getAllThreads(channelId) {
  const active = await getActiveThreads(channelId);
  const archived = await getArchivedPublicThreads(channelId);
  return {
    threads: [...(active?.threads || []), ...(archived?.threads || [])],
  };
}

function extractText(m) {
  const parts = [];

  const content = (m?.content || "").trim();
  if (content) parts.push(content);

  const embeds = Array.isArray(m?.embeds) ? m.embeds : [];
  for (const e of embeds) {
    if (e?.title) parts.push(String(e.title).trim());
    if (e?.description) parts.push(String(e.description).trim());

    const fields = Array.isArray(e?.fields) ? e.fields : [];
    for (const f of fields) {
      const name = (f?.name || "").trim();
      const value = (f?.value || "").trim();
      if (name && value) parts.push(`${name}: ${value}`);
      else if (name) parts.push(name);
      else if (value) parts.push(value);
    }
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

function extractImages(m) {
  const urls = [];

  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  for (const a of atts) if (a?.url) urls.push(a.url);

  const embeds = Array.isArray(m?.embeds) ? m.embeds : [];
  for (const e of embeds) {
    if (e?.image?.url) urls.push(e.image.url);
    if (e?.thumbnail?.url) urls.push(e.thumbnail.url);
  }

  return [...new Set(urls)];
}

function normAuthor(a) {
  if (!a) return { name: "unknown", tag: "unknown" };
  const disc =
    a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
  return { name: a.username || "unknown", tag: `${a.username || "unknown"}${disc}` };
}

function toISO(ts) {
  try { return ts ? new Date(ts).toISOString() : null; } catch { return null; }
}

async function main() {
  const all = await getAllThreads(FORUM_CHANNEL_ID);
  const threads = all?.threads || [];

  const posts = [];

  for (const th of threads) {
    let starter = null;
    if (th.message_id) {
      try {
        starter = await getMessage(th.id, th.message_id);
      } catch (e) {
        console.warn("Failed to fetch starter by message_id for thread", th.id);
      }
    }

    const msgs = await getMessages(th.id, 100);
    if (!Array.isArray(msgs) || !msgs.length) continue;

    if (!starter) {
      starter = msgs[msgs.length - 1];
    }

    const a = normAuthor(starter?.author);

    const comments = msgs
      .filter((m) => starter && m.id !== starter.id)
      .slice(0, 80)
      .map((m) => {
        const au = normAuthor(m.author);
        return {
          id: m.id,
          author: au.name,
          author_tag: au.tag,
          created_at: toISO(m.timestamp),
          content: extractText(m),
          images: extractImages(m),
        };
      })
      .reverse();

    posts.push({
      id: th.id,
      title: th.name,

      content: extractText(starter),
      images: extractImages(starter),

      created_at: toISO(starter?.timestamp) || toISO(th.created_at),

      channel_id: String(FORUM_CHANNEL_ID),
      channel_name: CHANNEL_NAME,
      channel_verified: true,
      channel_avatar: null,

      author: a.name,
      author_tag: a.tag,

      url: th.guild_id
        ? `https://discord.com/channels/${th.guild_id}/${th.id}`
        : null,

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
