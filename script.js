

const CONFIG = {
  // Discord -> posts.json (рядом с index.html)
  POSTS_URL: "posts.json",
  CACHE_BUST: true,
  AUTO_REFRESH_MS: 60_000,

  MAX_POSTS: 400,
  MAX_IMAGES_PER_POST: 8,
  MAX_COMMENTS_RENDER: 120,

  // Supabase (опционально)
SUPABASE_ENABLED: true,
SUPABASE_URL: "https://adzxwgaoozuoamqqwkcd.supabase.co",
SUPABASE_ANON_KEY: "sb_publishable_MxwhklaWPh4uOnvl_WI4eg_ceEre8pi",
SUPABASE_POSTS_TABLE: "posts",
SUPABASE_PUBLICS_TABLE: "publics",
  ONLY_USER_POSTS: false,  // true = брать только is_user_post=true
};

// ---------- STATE ----------
const state = {
  posts: [],
  postsDiscord: [],
  postsDb: [],
  channels: [],

  view: "global",     // global | subs | discovery | channel
  channelId: null,

  // Discord subscriptions: localStorage
  localSubs: new Set(loadLocalSubs()),

  // DB subscriptions (если потом добавишь): пока не используем
  dbSubs: new Set(),

  lastLoadedAt: null,
};

// ---------- DOM ----------
const el = {
  posts: document.getElementById("posts-container"),
  channels: document.getElementById("publics-list"),
  status: document.getElementById("sync-status"),

  btnGlobal: document.getElementById("btn-global"),
  btnSubs: document.getElementById("btn-subs"),
  btnDiscovery: document.getElementById("btn-discovery"),
};

// ---------- UTIL: basic ----------
function withBust(url){
  try{
    const u = new URL(url, location.href);
    u.searchParams.set("_", String(Date.now()));
    return u.toString();
  }catch{
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "_=" + Date.now();
  }
}

function setStatus(text){
  if (el.status) el.status.textContent = String(text || "");
}

function showError(msg){
  if (!el.posts) return;
  el.posts.innerHTML = `<div class="empty-state">${escapeHtml(msg || "Ошибка")}</div>`;
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function linkifyEscapedText(escapedText){
  // ожидает уже escapeHtml(text)
  return escapedText.replace(
    /(https?:\/\/[^\s<]+)/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`
  );
}

function fmtTime(iso){
  try{
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    }).format(d);
  }catch{
    return String(iso || "");
  }
}

async function loadDbChannels(){
  if (!sbClient) return [];
  const res = await sbClient
    .from(CONFIG.SUPABASE_PUBLICS_TABLE)
    .select("id,name,avatar_url,is_verified,created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (res.error) {
    console.warn("DB channels load failed:", res.error);
    return [];
  }

  return (res.data || []).map(p => ({
    id: `p_${p.id}`,
    name: p.name || `PUBLIC #${p.id}`,
    avatar: p.avatar_url || null,
    verified: !!p.is_verified,
    count: 0,
    lastAt: null,
    lastTitle: "—",
    source: "db"
  }));
}

// ---------- UTIL: avatar fallback (fixes URIError with emoji) ----------
function fallbackAvatar(name){
  const s = String(name || "?").trim();
  const chars = Array.from(s);
  const initials = (chars.slice(0, 2).join("") || "?").toUpperCase();

  const hue = (hash(s) % 360 + 360) % 360;

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},90%,55%)"/>
      <stop offset="1" stop-color="hsl(${(hue+60)%360},90%,55%)"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="18" fill="url(#g)"/>
  <text x="48" y="60" font-size="34" text-anchor="middle"
        fill="rgba(0,0,0,.55)" font-family="Inter,Arial" font-weight="700">${escapeHtml(initials)}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function hash(str){
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

// ---------- SUBS (local discord channels only) ----------
function loadLocalSubs(){
  try{
    const raw = localStorage.getItem("tls_subs_v1");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  }catch{
    return [];
  }
}
function saveLocalSubs(set){
  try{
    localStorage.setItem("tls_subs_v1", JSON.stringify([...set]));
  }catch{}
}

function isSubscribed(channelId){
  // пока только local subs (discord)
  return state.localSubs.has(channelId);
}

function toggleLocalSub(channelId){
  if (state.localSubs.has(channelId)) state.localSubs.delete(channelId);
  else state.localSubs.add(channelId);
  saveLocalSubs(state.localSubs);
}

// ---------- SUPABASE ----------
let sbClient = null;

function canUseSupabase(){
  if (!CONFIG.SUPABASE_ENABLED) return false;
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return false;
  return !!window.supabase?.createClient;
}

function initSupabase(){
  if (!canUseSupabase()) return null;
  try{
    return window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  }catch(e){
    console.warn("Supabase init failed:", e);
    return null;
  }
}

async function loadDbPosts(){
  // 0) диагностика: включился ли supabase вообще
  if (!sbClient){
    console.warn("[DB] sbClient is null. Supabase disabled or not initialized.");
    return [];
  }

  try{
    // 1) минимально безопасный запрос
    // ВАЖНО: сначала без .eq("is_user_post", true), чтобы не отфильтровать всё случайно
    const res = await sbClient
      .from(CONFIG.SUPABASE_POSTS_TABLE) // "posts"
      .select("id,title,content,image_url,public_id,author_name,show_author,likes_count,created_at,is_user_post")
      .order("created_at", { ascending: false })
      .limit(CONFIG.MAX_POSTS);

    if (res.error) {
      console.warn("[DB] Supabase error:", res.error);
      return [];
    }

    const rows = res.data || [];
    console.log("[DB] loaded rows:", rows.length, rows.slice(0, 3));

    // 2) если rows пустой — проверим отдельно, сколько is_user_post=true
    if (rows.length === 0) {
      const check = await sbClient
        .from(CONFIG.SUPABASE_POSTS_TABLE)
        .select("id,is_user_post", { count: "exact", head: true });
      console.log("[DB] table check count:", check.count, "error:", check.error);
      return [];
    }

    // 3) publics map (опционально)
    const publicIds = [...new Set(rows.map(r => r.public_id).filter(v => v != null))];
    const publicsMap = await loadPublicsMap(publicIds);

    // 4) normalize
    return rows.map((p) => {
      const pub = publicsMap.get(String(p.public_id)) || null;

      return {
        id: `u_${String(p.id)}`,
        source: "db",

        title: String(p.title ?? "Untitled"),
        content: String(p.content ?? ""),
        created_at: p.created_at ? new Date(p.created_at).toISOString() : null,

        channel_id: `p_${String(p.public_id ?? "0")}`,
        channel_name: pub?.name || (p.public_id != null ? `PUBLIC #${p.public_id}` : "USER POSTS"),
        channel_avatar: pub?.avatar_url || null,
        channel_verified: Boolean(pub?.is_verified ?? false),

        author: (p.show_author === false) ? "Anonymous" : String(p.author_name ?? "User"),
        author_tag: (p.show_author === false) ? "anon" : String(p.author_name ?? "user"),

        images: p.image_url ? [p.image_url] : [],
        url: null,

        comments: [],
        likes_count: Number(p.likes_count || 0),
        is_user_post: Boolean(p.is_user_post ?? true),
      };
    });

  } catch (e) {
    console.warn("[DB] loadDbPosts crashed:", e);
    return [];
  }
}

async function loadPublicsMap(publicIds){
  const map = new Map();
  if (!sbClient) return map;
  if (!publicIds || !publicIds.length) return map;

  try{
    const res = await sbClient
      .from(CONFIG.SUPABASE_PUBLICS_TABLE)
      .select("id,name,avatar_url,is_verified")
      .in("id", publicIds);

    if (res.error) throw res.error;

    for (const row of res.data || []) {
      map.set(String(row.id), row);
    }
  }catch(e){
    // если таблицы нет/полей нет — не страшно
    console.warn("Publics load failed:", e);
  }

  return map;
}

// ---------- DISCORD posts.json ----------
async function loadDiscordPosts(){
  const url = CONFIG.CACHE_BUST ? withBust(CONFIG.POSTS_URL) : CONFIG.POSTS_URL;

  try{
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`posts.json HTTP ${res.status}`);
    const json = await res.json();
    return normalizeDiscordPosts(json);
  }catch(e){
    console.warn("Discord posts load failed:", e);
    return [];
  }
}

function normalizeDiscordPosts(input){
  if (!Array.isArray(input)) return [];

  return input.map((p) => ({
    id: `d_${String(p.id ?? "") || String(Math.random()).slice(2)}`,
    source: "discord",

    title: String(p.title ?? "Untitled"),
    content: String(p.content ?? ""),
    created_at: p.created_at ? new Date(p.created_at).toISOString() : null,

    channel_id: `d_${String(p.channel_id ?? "unknown")}`,
    channel_name: String(p.channel_name ?? "UNKNOWN"),
    channel_avatar: p.channel_avatar ?? null,
    channel_verified: Boolean(p.channel_verified ?? false),

    author: String(p.author ?? "BOT"),
    author_tag: String(p.author_tag ?? ""),

    images: Array.isArray(p.images) ? p.images : [],
    url: p.url ?? null,

    comments: Array.isArray(p.comments) ? p.comments : [],
    likes_count: 0,
    is_user_post: false,
  }));
}

// ---------- CHANNELS ----------
function buildChannelsFromPosts(posts){
  const map = new Map();

  for (const p of posts) {
    const id = p.channel_id;
    const cur = map.get(id) || {
      id,
      name: p.channel_name,
      avatar: p.channel_avatar,
      verified: p.channel_verified,
      count: 0,
      lastAt: p.created_at,
      lastTitle: p.title,
      source: p.source,
    };

    cur.count += 1;

    if (!cur.lastAt || (p.created_at && p.created_at > cur.lastAt)) {
      cur.lastAt = p.created_at;
      cur.lastTitle = p.title;
      cur.name = p.channel_name || cur.name;
      cur.avatar = p.channel_avatar || cur.avatar;
      cur.verified = p.channel_verified || cur.verified;
      cur.source = p.source || cur.source;
    }

    map.set(id, cur);
  }

  return [...map.values()].sort((a,b) => (b.lastAt || "").localeCompare(a.lastAt || ""));
}

// ---------- RENDER ----------
function render(){
  renderChannelList();

  if (!el.posts) return;

  if (state.view === "discovery") return renderDiscovery();
  if (state.view === "subs") return renderSubs();

  if (state.view === "channel" && state.channelId) {
    const list = state.posts.filter(p => p.channel_id === state.channelId);
    return renderPosts(list, `CHANNEL: ${channelTitle(state.channelId)}`);
  }

  return renderPosts(state.posts, "GLOBAL FEED");
}

function renderChannelList(){
  if (!el.channels) return;
  el.channels.innerHTML = "";

  if (!state.channels.length) {
    el.channels.innerHTML = `<div class="empty-state">No channels yet</div>`;
    return;
  }

  for (const c of state.channels) {
    const item = document.createElement("div");
    item.className = "channel-item";

    const avatar = c.avatar || fallbackAvatar(c.name);
    const subbed = isSubscribed(c.id);

    item.innerHTML = `
      <img class="channel-avatar" src="${escapeHtml(avatar)}" alt="">
      <div class="channel-name">${escapeHtml(c.name)}</div>
      ${c.verified ? `<i class="fas fa-check-circle channel-verified" title="Verified"></i>` : ""}
      <div style="margin-left:auto; display:flex; gap:8px;">
        ${c.id.startsWith("d_") ? `<button class="chip-btn" data-sub>${subbed ? "UNSUB" : "SUB"}</button>` : ``}
      </div>
    `;

    item.addEventListener("click", (ev) => {
      if (ev.target?.closest?.("button")) return;
      state.view = "channel";
      state.channelId = c.id;
      render();
    });

    const btn = item.querySelector("[data-sub]");
    btn?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleLocalSub(c.id);
      renderChannelList();
      if (state.view === "subs") render();
    });

    el.channels.appendChild(item);
  }
}

function renderDiscovery(){
  el.posts.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "post-card";
  wrap.innerHTML = `
    <div class="post-title">FIND CHANNELS</div>
    <div style="opacity:.85; margin-bottom:12px;">Поиск по каналам (Discord + DB).</div>
    <div class="search-container">
      <i class="fas fa-search"></i>
      <input id="q" class="discovery-search-input" placeholder="Search channels…" />
    </div>
    <div id="grid" class="public-grid" style="margin-top:16px;"></div>
  `;
  el.posts.appendChild(wrap);

  const q = wrap.querySelector("#q");
  const grid = wrap.querySelector("#grid");

  const draw = () => {
    const s = (q.value || "").trim().toLowerCase();
    grid.innerHTML = "";

    const list = state.channels.filter(c => !s || c.name.toLowerCase().includes(s));

    if (!list.length) {
      grid.innerHTML = `<div class="empty-state">Nothing found</div>`;
      return;
    }

    for (const c of list) {
      const card = document.createElement("div");
      card.className = "public-card";

      const avatar = c.avatar || fallbackAvatar(c.name);

      card.innerHTML = `
        <div class="public-card-header">
          <img class="public-card-avatar" src="${escapeHtml(avatar)}" alt="">
          <div class="public-card-info">
            <div class="public-card-name">
              ${escapeHtml(c.name)}
              ${c.verified ? `<i class="fas fa-check-circle channel-verified"></i>` : ""}
            </div>
            <div class="public-card-subs">${c.count} posts</div>
          </div>
        </div>
        <div class="public-card-last-post">
          <span class="last-post-label">LAST SIGNAL</span>
          <span class="last-post-title">${escapeHtml(c.lastTitle || "—")}</span>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="btn-secondary" data-open>OPEN</button>
          ${c.id.startsWith("d_") ? `<button class="btn-secondary" data-sub>${isSubscribed(c.id) ? "UNSUB" : "SUB"}</button>` : ""}
        </div>
      `;

      card.querySelector("[data-open]")?.addEventListener("click", () => {
        state.view = "channel";
        state.channelId = c.id;
        render();
      });

      card.querySelector("[data-sub]")?.addEventListener("click", () => {
        toggleLocalSub(c.id);
        draw();
      });

      grid.appendChild(card);
    }
  };

  q.addEventListener("input", draw);
  draw();
}

function renderSubs(){
  const allowed = new Set([...state.localSubs]); // пока только Discord subs
  const list = state.posts.filter(p => allowed.has(p.channel_id));
  renderPosts(list, "SUBSCRIPTIONS");
}

function renderPosts(list, label){
  el.posts.innerHTML = "";

  if (!list.length) {
    el.posts.innerHTML = `<div class="empty-state">No posts in ${escapeHtml(label)}</div>`;
    return;
  }

  const head = document.createElement("div");
  head.className = "post-card";
  head.innerHTML = `
  <div class="post-title">${escapeHtml(label)}</div>
`;
  el.posts.appendChild(head);

  for (const p of list) el.posts.appendChild(renderPostCard(p));
}

function renderPostCard(p){
  const card = document.createElement("div");
  card.className = "post-card";

  const avatar = p.channel_avatar || fallbackAvatar(p.channel_name);
  const time = fmtTime(p.created_at);
  const verified = p.channel_verified ? `<i class="fas fa-check-circle channel-verified" title="Verified"></i>` : "";
  const badge = ""; // без источников

  const images = (p.images || []).slice(0, CONFIG.MAX_IMAGES_PER_POST);
  const imagesHtml = images.length ? `
    <div class="post-images">
      ${images.map(u => `
        <a href="${escapeHtml(u)}" target="_blank" rel="noopener">
          <img class="post-image" src="${escapeHtml(u)}" loading="lazy" alt="">
        </a>
      `).join("")}
    </div>
  ` : "";

  const contentEsc = escapeHtml(p.content || "");
  const contentHtml = contentEsc
    ? `<div class="post-content">${linkifyEscapedText(contentEsc)}</div>`
    : "";

  const commentsHtml = renderCommentsBlock(p);

  card.innerHTML = `
    <div class="post-header">
      <img class="post-avatar" src="${escapeHtml(avatar)}" alt="">
      <div class="post-meta">
        <div class="post-channel">
          ${escapeHtml(p.channel_name)} ${verified} ${badge}
        </div>
        <div class="post-time" style="opacity:.75; font-size:12px; margin-top:4px;">
          <span>${escapeHtml(p.author || "")}</span>
          <span style="opacity:.5;">•</span>
          <span>${escapeHtml(time)}</span>
        </div>
      </div>
      ${""}
    </div>

    <div class="post-title">${escapeHtml(p.title || "Untitled")}</div>
    ${contentHtml}
    ${imagesHtml}
    ${commentsHtml}
  `;

  // click channel name -> open channel
  card.querySelector(".post-channel")?.addEventListener("click", () => {
    state.view = "channel";
    state.channelId = p.channel_id;
    render();
  });

  return card;
}

function renderCommentsBlock(p){
  const comments = Array.isArray(p.comments) ? p.comments : [];
  if (!comments.length) return "";

  const slice = comments.slice(0, CONFIG.MAX_COMMENTS_RENDER);

  const items = slice.map((c) => {
    const when = c.created_at ? fmtTime(c.created_at) : "";
    const textEsc = escapeHtml(String(c.content || ""));
    return `
      <div class="comment-item">
        <div class="comment-meta">
          <b>${escapeHtml(c.author || "anon")}</b>
          <span style="opacity:.5;">•</span>
          <span>${escapeHtml(when)}</span>
        </div>
        ${textEsc ? `<div class="comment-text">${linkifyEscapedText(textEsc)}</div>` : ""}
      </div>
    `;
  }).join("");

  return `<div class="comments-block">${items}</div>`;
}

function channelTitle(channelId){
  const c = state.channels.find(x => x.id === channelId);
  return c?.name || channelId;
}

// ---------- BOOT ----------
boot().catch(console.error);

async function boot(){
  wireUI();

  // init supabase client if possible
  sbClient = initSupabase();

  await refresh(true);

  setInterval(() => refresh(false), CONFIG.AUTO_REFRESH_MS);
}

function wireUI(){
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

async function refresh(firstLoad){
  try{
    setStatus("SYNC: LOADING…");

    // load in parallel
    const [discordPosts, dbPosts] = await Promise.all([
      loadDiscordPosts(),
      loadDbPosts(),
    ]);

    state.postsDiscord = discordPosts;
    state.postsDb = dbPosts;

    const merged = [...discordPosts, ...dbPosts]
      .filter(Boolean)
      .sort((a,b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      })
      .slice(0, CONFIG.MAX_POSTS);

    state.posts = merged;
    state.channels = buildChannelsFromPosts(merged);

const dbChannels = await loadDbChannels();

// merge channels: то, что из постов — обновляет count/lastAt,
// а паблики без постов просто добавляются
const map = new Map(state.channels.map(c => [c.id, c]));
for (const c of dbChannels) {
  if (!map.has(c.id)) map.set(c.id, c);
}
state.channels = [...map.values()].sort((a,b)=> (b.lastAt||"").localeCompare(a.lastAt||""));

    state.lastLoadedAt = new Date().toISOString();
    setStatus(`SYNC: OK • ${fmtTime(state.lastLoadedAt)} • ${merged.length}`);

    // если открытый канал исчез — сброс
    if (state.view === "channel" && state.channelId && !state.channels.find(c => c.id === state.channelId)) {
      state.view = "global";
      state.channelId = null;
    }

    render();
  }catch(e){
    console.error(e);
    setStatus("SYNC: ERROR");
    showError("Не могу загрузить ленту. Проверь posts.json рядом с index.html и Supabase (если включён).");
    if (firstLoad) renderChannelList();
  }
}
