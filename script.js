const CONFIG = {
  POSTS_JSON_URL: "posts.json",
  CACHE_BUST: true,
  AUTO_REFRESH_MS: 60_000,

  // Discord rendering limits
  MAX_DISCORD_POSTS: 250,
  MAX_IMAGES_PER_POST: 8,
  MAX_COMMENTS_RENDER: 120,

  // Supabase rendering limits
  MAX_DB_POSTS: 250,

  // If you want to force Supabase off for debugging
  FORCE_DISABLE_SUPABASE: false,
};

// ====== SUPABASE CONFIG (set these) ======
const SUPABASE_URL = window.SUPABASE_URL || "";       // "https://xxxxx.supabase.co"
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || ""; // "eyJhbGciOi..."

let sb = null;
function canUseSupabase() {
  return !CONFIG.FORCE_DISABLE_SUPABASE && !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
}
function initSupabase() {
  if (!canUseSupabase()) return null;
  try {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn("Supabase init failed:", e);
    return null;
  }
}

// ====== STATE ======
const state = {
  // normalized posts in one shape
  posts: [],          // combined
  postsDiscord: [],   // only discord
  postsDb: [],        // only db
  channels: [],       // combined channels list

  view: "global",     // global | subs | discovery | channel
  channelId: null,    // normalized channel id: d_<id> or p_<id>

  // local subscriptions fallback (discord channels)
  localSubs: new Set(loadLocalSubs()),

  // supabase session & user
  session: null,
  profile: null,

  // supabase-side subscriptions: Set("p_<publicId>")
  dbSubs: new Set(),

  // misc
  lastLoadedAt: null,
  selectedUserFile: null,
};

// ====== DOM ======
const el = {
  posts: document.getElementById("posts-container"),
  publics: document.getElementById("publics-list"),
  status: document.getElementById("sync-status"),

  btnGlobal: document.getElementById("btn-global"),
  btnSubs: document.getElementById("btn-subs"),
  btnDiscovery: document.getElementById("btn-discovery"),

  // optional (supabase-ui version)
  authSection: document.getElementById("auth-section"),
  adminBtn: document.getElementById("admin-btn"),
  userPostArea: document.getElementById("user-post-area"),
  userPostTitle: document.getElementById("user-post-title"),
  userPostContent: document.getElementById("user-post-content"),
  userFileInfo: document.getElementById("user-file-info"),
};

// Expose functions for onclick="" from your supabase HTML version
window.loadPosts = (publicIdOrNull) => {
  // In your supabase version, this is called with null for global.
  // We'll map it to view switches:
  if (publicIdOrNull == null) {
    state.view = "global";
    state.channelId = null;
  } else {
    state.view = "channel";
    // assume DB public id passed => channel is p_<id>
    state.channelId = normalizePublicChannelId(publicIdOrNull);
  }
  render();
};

window.loadSubscriptionsFeed = () => {
  state.view = "subs";
  state.channelId = null;
  render();
};

window.loadDiscoveryView = () => {
  state.view = "discovery";
  state.channelId = null;
  render();
};

window.createUserPost = async () => {
  // Works only if Supabase available + logged in
  if (!supabase) {
    toast("Supabase не подключен. Юзер-посты недоступны.");
    return;
  }
  if (!state.session?.user) {
    toast("Сначала авторизация, агент.");
    return;
  }
  if (!el.userPostTitle || !el.userPostContent) {
    toast("UI для поста не найден (нет полей в HTML).");
    return;
  }

  const title = (el.userPostTitle.value || "").trim();
  const content = (el.userPostContent.value || "").trim();

  if (!title && !content) {
    toast("Пустой сигнал. Заполни хотя бы заголовок или текст.");
    return;
  }

  // Determine target public: if currently in a DB public channel, post there; else reject.
  const targetPublic = currentDbPublicId();
  if (!targetPublic) {
    toast("Юзер-пост можно отправлять только внутри DB-паблика (p_<id>).");
    return;
  }

  setStatus("SYNC: SENDING…", true);

  try {
    // 1) upload image (optional)
    let imageUrl = null;

    if (state.selectedUserFile) {
      // You can implement Supabase Storage bucket "post_images"
      // If you don't have it, comment this block and use direct links only.
      const file = state.selectedUserFile;
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${state.session.user.id}/${Date.now()}_${rand(6)}.${ext}`;

      const bucket = "post_images";

      const up = await supabase.storage.from(bucket).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      });

      if (up.error) {
        console.warn(up.error);
        toast("Не смог загрузить картинку в Storage. Пост всё равно отправлю без неё.");
      } else {
        const pub = supabase.storage.from(bucket).getPublicUrl(path);
        imageUrl = pub?.data?.publicUrl || null;
      }
    }

    // 2) insert post
    const payload = {
      title,
      content,
      image_url: imageUrl,
      public_id: targetPublic,
      author_name: state.profile?.username || state.session.user.email || "USER",
      show_author: true,
      likes_count: 0,
      is_user_post: true,
      // created_at default on db side is better; but we allow fallback:
      created_at: new Date().toISOString(),
    };

    const ins = await supabase.from("posts").insert(payload).select("*").single();
    if (ins.error) throw ins.error;

    // clear inputs
    el.userPostTitle.value = "";
    el.userPostContent.value = "";
    state.selectedUserFile = null;
    if (el.userFileInfo) el.userFileInfo.textContent = "No file selected";

    toast("Сигнал отправлен.");
    await refresh(false); // reload combined feed
  } catch (e) {
    console.error(e);
    toast("Ошибка отправки. Проверь RLS/таблицы/Storage.");
  } finally {
    setStatusOk();
  }
};

window.handleUserFileSelect = (ev) => {
  const file = ev?.target?.files?.[0];
  if (!file) return;
  state.selectedUserFile = file;
  if (el.userFileInfo) el.userFileInfo.textContent = `${file.name} (${prettyBytes(file.size)})`;
};

// ====== BOOT ======
boot().catch(console.error);

async function boot() {
  wireUI();

  supabase = initSupabase();

  if (supabase) {
    await bootSupabaseAuth();
    await loadDbSubscriptions();
  }

  await refresh(true);

  setInterval(() => refresh(false), CONFIG.AUTO_REFRESH_MS);
}

function wireUI() {
  el.btnGlobal?.addEventListener("click", () => {
    state.view = "global";
    state.channelId = null;
    render();
  });

  el.btnSubs?.addEventListener("click", () => {
    state.view = "subs";
    state.channelId = null;
    render();
  });

  el.btnDiscovery?.addEventListener("click", () => {
    state.view = "discovery";
    state.channelId = null;
    render();
  });
}

// ====== SUPABASE AUTH (minimal) ======
async function bootSupabaseAuth() {
  try {
    const { data } = await supabase.auth.getSession();
    state.session = data?.session || null;

    // listen
    supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      // refresh profile/subs on login/logout
      bootSupabaseUser().finally(() => render());
    });

    await bootSupabaseUser();
  } catch (e) {
    console.warn("Auth boot failed:", e);
  }
}

async function bootSupabaseUser() {
  state.profile = null;
  state.dbSubs = new Set();

  if (!state.session?.user) {
    toggleUserPostPanel(false);
    return;
  }

  toggleUserPostPanel(true);

  // Load profile (optional)
  // schema screenshot shows `profiles` has `id (uuid)`, `username`, etc.
  try {
    const uid = state.session.user.id;
    const p = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (!p.error) state.profile = p.data || null;
  } catch (e) {
    console.warn("Profile load:", e);
  }

  await loadDbSubscriptions();
}

async function loadDbSubscriptions() {
  if (!supabase || !state.session?.user) return;

  // schema screenshot shows user_subscriptions: user_id (uuid) + public_id (int)
  try {
    const uid = state.session.user.id;
    const res = await supabase
      .from("user_subscriptions")
      .select("public_id")
      .eq("user_id", uid);

    if (res.error) throw res.error;

    const set = new Set();
    for (const row of res.data || []) {
      set.add(normalizePublicChannelId(row.public_id));
    }
    state.dbSubs = set;
  } catch (e) {
    console.warn("Subs load:", e);
  }
}

function toggleUserPostPanel(show) {
  if (!el.userPostArea) return;
  el.userPostArea.classList.toggle("hidden", !show);
}

// ====== REFRESH (Discord + DB) ======
async function refresh(firstLoad) {
  try {
    setStatus("SYNC: LOADING…", true);

    // 1) Discord posts.json
    const discordUrl = CONFIG.CACHE_BUST
      ? `${CONFIG.POSTS_JSON_URL}?t=${Date.now()}`
      : CONFIG.POSTS_JSON_URL;

    const [discordPosts, dbPosts] = await Promise.all([
      loadDiscordPosts(discordUrl),
      loadDbPostsSafe(),
    ]);

    state.postsDiscord = discordPosts.slice(0, CONFIG.MAX_DISCORD_POSTS);
    state.postsDb = dbPosts.slice(0, CONFIG.MAX_DB_POSTS);

    // 2) combine & sort
    state.posts = [...state.postsDb, ...state.postsDiscord].sort((a, b) => {
      const ta = a.created_at || "";
      const tb = b.created_at || "";
      return tb.localeCompare(ta);
    });

    // 3) channels
    state.channels = buildChannels(state.posts);

    state.lastLoadedAt = new Date();
    setStatusOk();

    // guard: if channel disappeared
    if (
      state.view === "channel" &&
      state.channelId &&
      !state.channels.find((c) => c.id === state.channelId)
    ) {
      state.view = "global";
      state.channelId = null;
    }

    render();
  } catch (e) {
    console.error(e);
    setStatus("SYNC: ERROR", false);
    if (firstLoad && el.posts) {
      el.posts.innerHTML =
        `<div class="empty-state">Не могу загрузить ленту. Проверь: posts.json рядом с index.html, и Supabase (если включён).</div>`;
    }
  }
}

async function loadDiscordPosts(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`posts.json ${res.status}`);
    const json = await res.json();
    return normalizeDiscordPosts(json);
  } catch (e) {
    console.warn("Discord posts load failed:", e);
    return [];
  }
}

function normalizeDiscordPosts(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((p) => {
      const created = p.created_at ? new Date(p.created_at).toISOString() : null;
      return {
        // unified
        id: `d_${String(p.id ?? rnd())}`,
        source: "discord",

        title: String(p.title ?? "Untitled"),
        content: String(p.content ?? ""),
        created_at: created,

        channel_id: `d_${String(p.channel_id ?? "unknown")}`,
        channel_name: String(p.channel_name ?? "UNKNOWN CHANNEL"),
        channel_avatar: p.channel_avatar ?? null,
        channel_verified: Boolean(p.channel_verified ?? false),

        author: String(p.author ?? "BOT"),
        author_tag: String(p.author_tag ?? ""),

        images: Array.isArray(p.images) ? p.images : [],
        url: p.url ?? null,

        comments: Array.isArray(p.comments) ? p.comments : [],
        likes_count: 0,
        is_user_post: false,
      };
    })
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

async function loadDbPostsSafe() {
  if (!supabase) return [];
  try {
    // Minimal select (your schema: posts has content/title/image_url/public_id/author_name/show_author/likes_count/created_at/is_user_post)
    const res = await supabase
      .from("posts")
      .select("id,title,content,image_url,public_id,author_name,show_author,likes_count,created_at,is_user_post")
      .order("created_at", { ascending: false })
      .limit(CONFIG.MAX_DB_POSTS);

    if (res.error) throw res.error;

    // Optional: join publics table for name/avatar/verified
    const publicIds = [...new Set((res.data || []).map((p) => p.public_id).filter((x) => x != null))];
    const publicsById = await loadPublicsMap(publicIds);

    return (res.data || []).map((p) => {
      const pub = publicsById.get(String(p.public_id)) || null;
      return {
        id: `u_${String(p.id)}`,
        source: "user",

        title: String(p.title ?? "Untitled"),
        content: String(p.content ?? ""),
        created_at: p.created_at ? new Date(p.created_at).toISOString() : null,

        channel_id: normalizePublicChannelId(p.public_id),
        channel_name: pub?.name || `PUBLIC #${p.public_id}`,
        channel_avatar: pub?.avatar_url || null,
        channel_verified: Boolean(pub?.is_verified ?? false),

        author: String(p.author_name ?? "USER"),
        author_tag: "",

        images: p.image_url ? [p.image_url] : [],
        url: null,

        comments: [], // you can add DB comments later
        likes_count: Number(p.likes_count || 0),
        is_user_post: true,
      };
    });
  } catch (e) {
    console.warn("DB posts load failed:", e);
    return [];
  }
}

async function loadPublicsMap(publicIds) {
  const map = new Map();
  if (!supabase || !publicIds.length) return map;

  try {
    const res = await supabase
      .from("publics")
      .select("id,name,avatar_url,is_verified")
      .in("id", publicIds);

    if (res.error) throw res.error;

    for (const row of res.data || []) {
      map.set(String(row.id), row);
    }
  } catch (e) {
    console.warn("Publics load failed:", e);
  }

  return map;
}

function normalizePublicChannelId(publicId) {
  return `p_${String(publicId)}`;
}

function currentDbPublicId() {
  // only allow posting into DB public channel view
  // channelId like "p_12"
  const cid = state.channelId || "";
  if (!cid.startsWith("p_")) return null;
  const n = cid.slice(2);
  const id = Number(n);
  return Number.isFinite(id) ? id : null;
}

// ====== RENDER ======
function render() {
  renderChannelList();

  if (!el.posts) return;

  if (state.view === "discovery") return renderDiscovery();

  if (state.view === "subs") {
    const allowed = new Set([...state.localSubs, ...state.dbSubs]);
    const list = state.posts.filter((p) => allowed.has(p.channel_id));
    return renderPosts(list, "SUBSCRIPTIONS");
  }

  if (state.view === "channel" && state.channelId) {
    const list = state.posts.filter((p) => p.channel_id === state.channelId);
    return renderPosts(list, `CHANNEL: ${channelName(state.channelId)}`);
  }

  return renderPosts(state.posts, "GLOBAL FEED");
}

function renderChannelList() {
  if (!el.publics) return;

  el.publics.innerHTML = "";

  if (!state.channels.length) {
    el.publics.innerHTML = `<div class="empty-state">No channels yet</div>`;
    return;
  }

  for (const c of state.channels) {
    const item = document.createElement("div");
    item.className = "channel-item";

    const subbed = isSubscribed(c.id);

    item.innerHTML = `
      <img class="channel-avatar" src="${escapeAttr(c.avatar || fallbackAvatar(c.name))}" alt="">
      <div class="channel-name">${escapeHtml(c.name)}</div>
      ${c.verified ? `<i class="fas fa-check-circle channel-verified" title="Verified"></i>` : ""}
      <div class="channel-actions" style="margin-left:auto; display:flex; gap:8px;">
        <button class="chip-btn" data-action="sub">${subbed ? "UNSUB" : "SUB"}</button>
      </div>
    `;

    // open channel on click (but not when clicking sub button)
    item.addEventListener("click", (ev) => {
      if (ev.target?.closest?.("button")) return;
      state.view = "channel";
      state.channelId = c.id;
      render();
    });

    // sub/unsub
    const btn = item.querySelector(`button[data-action="sub"]`);
    btn?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await toggleSubscription(c.id);
      renderChannelList();
      if (state.view === "subs") render(); // update list
    });

    el.publics.appendChild(item);
  }
}

function renderDiscovery() {
  // simple: show channel grid as posts area
  el.posts.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "post-card";
  wrap.innerHTML = `
    <div class="post-title">FIND CHANNELS</div>
    <div style="opacity:.8; margin-bottom:12px;">Поиск по каналам (и Discord, и DB).</div>
    <input id="discovery-q" class="discovery-search-input" placeholder="Search channels…" />
    <div id="discovery-grid" class="public-grid" style="margin-top:16px;"></div>
  `;
  el.posts.appendChild(wrap);

  const q = wrap.querySelector("#discovery-q");
  const grid = wrap.querySelector("#discovery-grid");

  const renderGrid = () => {
    const s = (q.value || "").trim().toLowerCase();
    grid.innerHTML = "";
    const list = state.channels.filter((c) => !s || c.name.toLowerCase().includes(s));

    if (!list.length) {
      grid.innerHTML = `<div class="empty-state">Nothing found</div>`;
      return;
    }

    for (const c of list) {
      const card = document.createElement("div");
      card.className = "public-card";
      card.innerHTML = `
        <div class="public-card-header">
          <img class="public-card-avatar" src="${escapeAttr(c.avatar || fallbackAvatar(c.name))}" />
          <div class="public-card-info">
            <div class="public-card-name">
              ${escapeHtml(c.name)}
              ${c.verified ? `<i class="fas fa-check-circle channel-verified"></i>` : ""}
            </div>
            <div class="public-card-subs">${c.source.toUpperCase()} • ${c.count} posts</div>
          </div>
        </div>
        <div class="public-card-last-post">
          <span class="last-post-label">LAST SIGNAL</span>
          <span class="last-post-title">${escapeHtml(c.lastTitle || "—")}</span>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="btn-secondary" data-open>OPEN</button>
          <button class="btn-secondary" data-sub>${isSubscribed(c.id) ? "UNSUB" : "SUB"}</button>
        </div>
      `;

      card.querySelector("[data-open]")?.addEventListener("click", () => {
        state.view = "channel";
        state.channelId = c.id;
        render();
      });

      card.querySelector("[data-sub]")?.addEventListener("click", async () => {
        await toggleSubscription(c.id);
        renderGrid();
      });

      grid.appendChild(card);
    }
  };

  q.addEventListener("input", renderGrid);
  renderGrid();
}

function renderPosts(list, label) {
  el.posts.innerHTML = "";

  if (!list.length) {
    el.posts.innerHTML = `<div class="empty-state">No posts in ${escapeHtml(label)}</div>`;
    return;
  }

  // header card
  const head = document.createElement("div");
  head.className = "post-card";
  head.innerHTML = `
    <div class="post-title">${escapeHtml(label)}</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; opacity:.85;">
      <span>Discord: ${state.postsDiscord.length}</span>
      <span>•</span>
      <span>User: ${state.postsDb.length}</span>
      <span>•</span>
      <span>Total: ${state.posts.length}</span>
    </div>
  `;
  el.posts.appendChild(head);

  for (const p of list) {
    el.posts.appendChild(renderPostCard(p));
  }
}

function renderPostCard(p) {
  const card = document.createElement("div");
  card.className = "post-card";

  const avatar = p.channel_avatar || fallbackAvatar(p.channel_name);
  const time = p.created_at ? fmtTime(new Date(p.created_at)) : "unknown";
  const verified = p.channel_verified ? `<i class="fas fa-check-circle channel-verified" title="Verified"></i>` : "";
  const sourceBadge = p.source === "discord"
    ? `<span class="post-author-tag">DISCORD</span>`
    : `<span class="post-author-tag">USER</span>`;

  const images = (p.images || []).slice(0, CONFIG.MAX_IMAGES_PER_POST);
  const imagesHtml = images.length
    ? `<div class="post-images">${images.map((u) => `
        <a href="${escapeAttr(u)}" target="_blank" rel="noopener">
          <img src="${escapeAttr(u)}" loading="lazy" />
        </a>
      `).join("")}</div>`
    : "";

  const contentHtml = p.content
    ? `<div class="post-content">${linkify(escapeHtml(p.content))}</div>`
    : "";

  const commentsHtml = renderComments(p);

  const likePart = p.is_user_post
    ? `<div class="post-actions">
         <button class="chip-btn" data-like>LIKE</button>
         <span style="opacity:.8;">${Number(p.likes_count||0)} likes</span>
       </div>`
    : `<div class="post-actions"><span style="opacity:.7;">Discord post</span></div>`;

  card.innerHTML = `
    <div class="post-header">
      <img class="post-avatar" src="${escapeAttr(avatar)}" alt="">
      <div class="post-meta">
        <div class="post-channel">
          ${escapeHtml(p.channel_name)} ${verified} ${sourceBadge}
        </div>
        <div class="post-time" style="opacity:.75; font-size:12px; margin-top:4px;">
          <span>${escapeHtml(p.author || "")}</span>
          <span style="opacity:.5;">•</span>
          <span>${escapeHtml(time)}</span>
        </div>
      </div>
      ${
        p.url ? `<a class="btn-secondary" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">OPEN</a>` : ""
      }
    </div>

    <div class="post-title">${escapeHtml(p.title || "Untitled")}</div>
    ${contentHtml}
    ${imagesHtml}
    ${likePart}
    ${commentsHtml}
  `;

  // open channel click
  card.querySelector(".post-channel")?.addEventListener("click", () => {
    state.view = "channel";
    state.channelId = p.channel_id;
    render();
  });

  // like button (db posts only)
  card.querySelector("[data-like]")?.addEventListener("click", async () => {
    if (!supabase) return toast("Supabase не подключен.");
    if (!state.session?.user) return toast("Нужен логин.");

    await likeDbPost(p.id); // p.id is "u_<id>"
    await refresh(false);
  });

  return card;
}

function renderComments(p) {
  const comments = Array.isArray(p.comments) ? p.comments : [];
  if (!comments.length) return "";

  const slice = comments.slice(0, CONFIG.MAX_COMMENTS_RENDER);
  const items = slice.map((c) => {
    const ct = c.created_at ? fmtTime(new Date(c.created_at)) : "";
    const text = escapeHtml(String(c.content || ""));
    return `
      <div class="comment-item">
        <div class="comment-meta">
          <b>${escapeHtml(c.author || "anon")}</b>
          <span style="opacity:.5;">•</span>
          <span>${escapeHtml(ct)}</span>
        </div>
        ${text ? `<div class="comment-text">${linkify(text)}</div>` : ""}
      </div>
    `;
  }).join("");

  return `<div class="comments-block">${items}</div>`;
}

// ====== SUBSCRIPTIONS (local discord + db publics) ======
function isSubscribed(channelId) {
  if (channelId.startsWith("p_")) return state.dbSubs.has(channelId);
  return state.localSubs.has(channelId);
}

async function toggleSubscription(channelId) {
  if (channelId.startsWith("p_")) {
    // DB subscription (requires auth)
    if (!supabase) return toast("Supabase не подключен.");
    if (!state.session?.user) return toast("Нужен логин, чтобы подписываться на DB-паблики.");

    const publicId = Number(channelId.slice(2));
    if (!Number.isFinite(publicId)) return;

    if (state.dbSubs.has(channelId)) {
      // delete
      const del = await supabase
        .from("user_subscriptions")
        .delete()
        .eq("user_id", state.session.user.id)
        .eq("public_id", publicId);

      if (del.error) {
        console.warn(del.error);
        return toast("Не смог отписаться (RLS?).");
      }

      state.dbSubs.delete(channelId);
      toast("Отписка.");
    } else {
      const ins = await supabase
        .from("user_subscriptions")
        .insert({ user_id: state.session.user.id, public_id: publicId });

      if (ins.error) {
        console.warn(ins.error);
        return toast("Не смог подписаться (RLS?).");
      }

      state.dbSubs.add(channelId);
      toast("Подписка.");
    }
    return;
  }

  // Local subscription for Discord channels (no auth)
  if (state.localSubs.has(channelId)) {
    state.localSubs.delete(channelId);
  } else {
    state.localSubs.add(channelId);
  }
  saveLocalSubs([...state.localSubs]);
}

function loadLocalSubs() {
  try {
    const raw = localStorage.getItem("tls_subs_v1");
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.map(String);
  } catch {
    return [];
  }
}
function saveLocalSubs(arr) {
  try {
    localStorage.setItem("tls_subs_v1", JSON.stringify(arr));
  } catch {}
}

// ====== LIKE (DB) ======
async function likeDbPost(prefixedId) {
  // prefixedId: "u_123"
  if (!supabase) return;
  const id = Number(String(prefixedId).replace(/^u_/, ""));
  if (!Number.isFinite(id)) return;

  // simplest: increment likes_count (race conditions exist, but ok for MVP)
  // better: separate table post_likes with unique(user_id, post_id)
  try {
    const upd = await supabase.rpc("increment_post_like", { post_id_input: id });
    if (upd.error) {
      // fallback: direct update
      const cur = await supabase.from("posts").select("likes_count").eq("id", id).single();
      if (cur.error) throw cur.error;
      const next = Number(cur.data?.likes_count || 0) + 1;
      const up2 = await supabase.from("posts").update({ likes_count: next }).eq("id", id);
      if (up2.error) throw up2.error;
    }
    toast("LIKE +1");
  } catch (e) {
    console.warn(e);
    toast("Не смог лайкнуть. Нужен RLS/RPC.");
  }
}

// ====== CHANNELS BUILD ======
function buildChannels(posts) {
  const map = new Map();

  for (const p of posts) {
    const id = p.channel_id;
    const cur = map.get(id) || {
      id,
      name: p.channel_name,
      avatar: p.channel_avatar,
      verified: p.channel_verified,
      lastPostAt: p.created_at,
      lastTitle: p.title,
      count: 0,
      source: p.source || "mixed",
    };

    cur.count += 1;
    if (!cur.lastPostAt || (p.created_at && p.created_at > cur.lastPostAt)) {
      cur.lastPostAt = p.created_at;
      cur.lastTitle = p.title;
      cur.name = p.channel_name || cur.name;
      cur.avatar = p.channel_avatar || cur.avatar;
      cur.verified = p.channel_verified || cur.verified;
      cur.source = p.source || cur.source;
    }

    map.set(id, cur);
  }

  return [...map.values()].sort((a, b) =>
    (b.lastPostAt || "").localeCompare(a.lastPostAt || "")
  );
}

function channelName(channelId) {
  const c = state.channels.find((x) => x.id === channelId);
  return c?.name || channelId;
}

// ====== STATUS / HELPERS ======
function setStatus(text, pulse) {
  if (!el.status) return;
  el.status.textContent = text;
  el.status.style.opacity = pulse ? "1" : "0.9";
}
function setStatusOk() {
  const t = state.lastLoadedAt ? fmtTime(state.lastLoadedAt) : fmtTime(new Date());
  setStatus(`SYNC: OK • ${t}`, false);
}

function fmtTime(d) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    }).format(d);
  } catch {
    return String(d);
  }
}

function fallbackAvatar(name) {
  // simple deterministic SVG data-url
  const s = String(name || "X").trim().toUpperCase();
  const ch = s[0] || "X";
  const hue = (hash(s) % 360 + 360) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="hsl(${hue},90%,55%)"/>
          <stop offset="1" stop-color="hsl(${(hue+60)%360},90%,55%)"/>
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="18" fill="url(#g)"/>
      <text x="48" y="60" font-size="44" text-anchor="middle" fill="rgba(0,0,0,.55)" font-family="Inter,Arial" font-weight="700">${escapeXml(ch)}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function toast(msg) {
  // minimalist: status line flash
  setStatus(String(msg), true);
  setTimeout(() => setStatusOk(), 1500);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("\n", " ");
}
function escapeXml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function linkify(text) {
  // text already escaped
  return text.replace(
    /(https?:\/\/[^\s<]+)/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`
  );
}

function rnd() {
  return Math.random().toString(36).slice(2);
}
function rand(n) {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[(Math.random() * a.length) | 0];
  return s;
}
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
function prettyBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = Number(n || 0);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
