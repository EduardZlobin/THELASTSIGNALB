import fs from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;

const OUT_FILE = "posts.json";
const CHANNEL_NAME = "🅲🅽🅽-breaking-bad-news📰";

// сколько тредов хотим максимум в json
const MAX_THREADS_TOTAL = Number(process.env.MAX_THREADS_TOTAL || 500);
// сколько архива тянуть (active + archived суммарно обрежется MAX_THREADS_TOTAL)
const MAX_ARCHIVED = Number(process.env.MAX_ARCHIVED || 500);
// лимит одной страницы архива (у Discord обычно max 100)
const ARCHIVE_PAGE_LIMIT = 100;

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

  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getActiveThreads(channelId) {
  return api(`/channels/${channelId}/threads/active`);
}

async function getArchivedPublicThreadsPage(channelId, limit = 100, before = null) {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (before) qs.set("before", before);
  return api(`/channels/${channelId}/threads/archived/public?${qs.toString()}`);
}

async function joinThread(threadId) {
  // Иногда без join чтение сообщений возвращает пусто
  try {
    await api(`/channels/${threadId}/thread-members/@me`, { method: "PUT" });
  } catch (e) {
    // не фейлим синк из-за join
    console.warn("joinThread failed:", threadId, e?.message || e);
  }
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
  const disc = a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
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

function uniqById(list) {
  const map = new Map();
  for (const x of list) map.set(x.id, x);
  return [...map.values()];
}

async function fetchArchivedThreadsAll(channelId, maxTotal) {
  const out = [];
  let before = null;

  while (out.length < maxTotal) {
    const page = await getArchivedPublicThreadsPage(channelId, ARCHIVE_PAGE_LIMIT, before);
    const threads = page?.threads || [];
    if (!threads.length) break;

    out.push(...threads);

    // пагинация: "before" = archive_timestamp последнего треда страницы
    // Discord возвращает threads + has_more + иногда thread_metadata.archive_timestamp
    // Берём минимальный archive_timestamp в странице (последний тред)
    const last = threads[threads.length - 1];
    const ts = last?.thread_metadata?.archive_timestamp;
    if (!page?.has_more || !ts) break;

    before = ts;
  }

  return out.slice(0, maxTotal);
}

async function main() {
  // 1) active threads
  let activeThreads = [];
  try {
    const active = await getActiveThreads(FORUM_CHANNEL_ID);
    activeThreads = active?.threads || [];
  } catch (e) {
    console.warn("getActiveThreads failed:", e?.message || e);
  }

  // 2) archived threads with pagination
  let archivedThreads = [];
  try {
    archivedThreads = await fetchArchivedThreadsAll(FORUM_CHANNEL_ID, MAX_ARCHIVED);
  } catch (e) {
    console.warn("fetchArchivedThreadsAll failed:", e?.message || e);
  }

  console.log("ACTIVE THREADS:", activeThreads.length);
  console.log("ARCHIVED THREADS:", archivedThreads.length);

  // merged
  const threads = uniqById([...activeThreads, ...archivedThreads]).slice(0, MAX_THREADS_TOTAL);

  // Если тут мало — значит реально API не отдаёт новые треды
  console.log("MERGED THREADS (capped):", threads.length);
  console.log("TOP 5 THREAD TITLES:", threads.slice(0, 5).map(t => t.name).join(" | "));

  const posts = [];

  for (const th of threads) {
    // даже если контент не получится — тему не выкидываем
    await joinThread(th.id);

    let starter = null;
    let msgList = [];

    // starter
    if (th.message_id) {
      try {
        starter = await getMessage(th.id, th.message_id);
      } catch (e) {
        console.warn("starter fetch failed:", th.id, e?.message || e);
      }
    }

    // messages/comments
    try {
      const msgs = await getMessages(th.id, 100);
      msgList = Array.isArray(msgs) ? msgs : [];
    } catch (e) {
      console.warn("messages fetch failed:", th.id, e?.message || e);
    }

    // fallback starter: oldest message we have
    if (!starter && msgList.length) starter = msgList[msgList.length - 1];

    const a = normAuthor(starter?.author);

    const comments = msgList
      .filter(m => starter && m.id !== starter.id)
      .map(m => {
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
      .filter(c => (c.content && c.content.trim()) || (c.images && c.images.length))
      .reverse();

    const content = starter ? extractText(starter) : "";
    const images = starter ? extractImages(starter) : [];

    posts.push({
      id: th.id,
      title: th.name,

      content,
      images,

      // если starter не доступен — хотя бы время треда
      created_at: toISO(starter?.timestamp) || toISO(th.created_at),

      channel_id: String(FORUM_CHANNEL_ID),
      channel_name: CHANNEL_NAME,
      channel_verified: true,
      channel_avatar: null,

      author: a.name,
      author_tag: a.tag,

      url: th.guild_id ? `https://discord.com/channels/${th.guild_id}/${th.id}` : null,

      comments,
    });

    console.log(
      "THREAD OK",
      th.id,
      "starter_len",
      content.length,
      "imgs",
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
