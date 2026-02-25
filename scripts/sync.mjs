import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;

const OUT_FILE = "posts.json";
const CHANNEL_NAME = "🅲🅽🅽-breaking-bad-news📰";

if (!DISCORD_TOKEN || !FORUM_CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or FORUM_CHANNEL_ID");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch("https://discord.com/api/v10" + path, {
    ...init,
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      ...(init.headers || {}),
    },
  });

  // 204 (No Content) — нормальный ответ для joinThread
  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getActiveThreads(channelId) {
  return api(`/channels/${channelId}/threads/active`);
}

async function getArchivedPublicThreads(channelId, limit = 50) {
  return api(`/channels/${channelId}/threads/archived/public?limit=${limit}`);
}

async function joinThread(threadId) {
  // Добавляет бота в тред
  await api(`/channels/${threadId}/thread-members/@me`, { method: "PUT" });
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
  return {
    name: a.username || "unknown",
    tag: `${a.username || "unknown"}${disc}`,
  };
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

async function safeJoin(threadId) {
  try {
    await joinThread(threadId);
    return true;
  } catch (e) {
    // Частые причины: archived/locked, нет прав, rate limit (редко)
    console.warn("Could not join thread:", threadId, e?.message || e);
    return false;
  }
}

async function main() {
  const active = await getActiveThreads(FORUM_CHANNEL_ID).catch((e) => {
    console.warn("Active threads fetch failed:", e?.message || e);
    return { threads: [] };
  });

  const archived = await getArchivedPublicThreads(FORUM_CHANNEL_ID, 50).catch(
    (e) => {
      console.warn("Archived threads fetch failed:", e?.message || e);
      return { threads: [] };
    }
  );

  const threads = uniqThreads([
    ...(active?.threads || []),
    ...(archived?.threads || []),
  ]);

  const posts = [];

  for (const th of threads) {
    // 0) join чтобы читать сообщения
    await safeJoin(th.id);

    // 1) starter message (главный пост)
    let starter = null;

    if (th.message_id) {
      try {
        starter = await getMessage(th.id, th.message_id);
      } catch (e) {
        console.warn(
          "Starter fetch by message_id failed for",
          th.id,
          e?.message || e
        );
      }
    }

    // 2) ответы/комменты
    let msgList = [];
    try {
      const msgs = await getMessages(th.id, 100);
      msgList = Array.isArray(msgs) ? msgs : [];
    } catch (e) {
      console.warn("Messages fetch failed for", th.id, e?.message || e);
    }

    // fallback: если starter не получили — возьмём самое старое из msgList
    if (!starter && msgList.length) {
      starter = msgList[msgList.length - 1];
    }

    if (!starter && !msgList.length) {
      // нечего сохранять
      continue;
    }

    const a = normAuthor(starter?.author);

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

    console.log(
      "OK thread",
      th.id,
      "starter_len",
      content.length,
      "starter_imgs",
      images.length,
      "comments",
      comments.length
    );
  }

  posts.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  fs.writeFileSync(OUT_FILE, JSON.stringify(posts, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE}: ${posts.length} posts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
