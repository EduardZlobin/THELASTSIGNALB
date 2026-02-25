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

// 1) Активные треды форума (важно!)
async function getActiveThreads(channelId) {
  // Возвращает { threads: [...], members: [...], has_more: bool }
  return api(`/channels/${channelId}/threads/active`);
}

// 2) Архивные треды форума
async function getArchivedPublicThreads(channelId, limit = 50) {
  return api(`/channels/${channelId}/threads/archived/public?limit=${limit}`);
}

async function getMessages(threadId, limit = 100) {
  return api(`/channels/${threadId}/messages?limit=${limit}`);
}

async function getMessage(threadId, messageId) {
  return api(`/channels/${threadId}/messages/${messageId}`);
}

function toISO(ts) {
  try {
    return ts ? new Date(ts).toISOString() : null;
  } catch {
    return null;
  }
}

function normAuthor(a) {
  if (!a) return { name: "unknown", tag: "unknown" };
  const disc =
    a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
  return { name: a.username || "unknown", tag: `${a.username || "unknown"}${disc}` };
}

function extractText(m) {
  const parts = [];
  const c = (m?.content || "").trim();
  if (c) parts.push(c);

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

function uniqThreads(list) {
  const map = new Map();
  for (const t of list) map.set(t.id, t);
  return [...map.values()];
}

async function main() {
  // Берём и активные, и архивные
  const active = await getActiveThreads(FORUM_CHANNEL_ID);
  const archived = await getArchivedPublicThreads(FORUM_CHANNEL_ID, 50);

  const threads = uniqThreads([
    ...(active?.threads || []),
    ...(archived?.threads || []),
  ]);

  const posts = [];

  for (const th of threads) {
    // 1) Стартер пост (главное)
    let starter = null;
    if (th.message_id) {
      try {
        starter = await getMessage(th.id, th.message_id);
      } catch (e) {
        // бывает, что message_id не даётся — тогда ниже фоллбек
      }
    }

    // 2) Ответы/комменты
    const msgs = await getMessages(th.id, 100);
    const msgList = Array.isArray(msgs) ? msgs : [];

    // фоллбек для starter — самое старое сообщение из пачки
    if (!starter && msgList.length) {
      starter = msgList[msgList.length - 1];
    }

    // если вообще нет ничего — пропускаем
    if (!starter && !msgList.length) continue;

    const a = normAuthor(starter?.author);

    // Комментарии = все кроме starter (и только не пустые по смыслу)
    const comments = msgList
      .filter((m) => starter && m.id !== starter.id)
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
      // выкидываем реально пустые (иногда там системные)
      .filter((c) => (c.content && c.content.trim()) || (c.images && c.images.length))
      .reverse();

    const content = extractText(starter);
    const images = extractImages(starter);

    posts.push({
      id: th.id,
      title: th.name,
      content,
      images,
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
