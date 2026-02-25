const CONFIG = {
  POSTS_URL: "posts.json",
  AUTO_REFRESH_MS: 60_000,
  CACHE_BUST: true,
  MAX_POSTS: 200,
};

const state = {
  posts: [],
  channels: [],
  view: "global",      // global | subs | discovery | channel
  channelId: null,
  subscriptions: new Set(loadSubs()),
  lastLoadedAt: null,
};

const el = {
  posts: document.getElementById("posts-container"),
  publics: document.getElementById("publics-list"),
  status: document.getElementById("sync-status"),
  btnGlobal: document.getElementById("btn-global"),
  btnSubs: document.getElementById("btn-subs"),
  btnDiscovery: document.getElementById("btn-discovery"),
};

boot().catch(console.error);

async function boot() {
  wireUI();
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

async function refresh(firstLoad) {
  try {
    setStatus("SYNC: LOADING…", true);

    const url = CONFIG.CACHE_BUST
      ? `${CONFIG.POSTS_URL}?t=${Date.now()}`
      : CONFIG.POSTS_URL;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load posts.json: ${res.status}`);

    const posts = await res.json();
    state.posts = normalizePosts(posts).slice(0, CONFIG.MAX_POSTS);
    state.channels = buildChannels(state.posts);
    state.lastLoadedAt = new Date();

    setStatus(`SYNC: OK • ${fmtTime(state.lastLoadedAt)}`, false);

    if (state.view === "channel" && state.channelId && !state.channels.find(c => c.id === state.channelId)) {
      state.view = "global";
      state.channelId = null;
    }

    render();
  } catch (e) {
    console.error(e);
    setStatus("SYNC: ERROR", false);
    if (firstLoad) {
      el.posts.innerHTML = `<div class="empty-state">Не могу загрузить posts.json. Проверь что файл лежит рядом с index.html.</div>`;
    }
  }
}

function normalizePosts(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => ({
      id: String(p.id ?? rnd()),
      title: String(p.title ?? "Untitled"),
      content: String(p.content ?? ""),
      created_at: p.created_at ? new Date(p.created_at).toISOString() : null,
      channel_id: String(p.channel_id ?? "unknown"),
      channel_name: String(p.channel_name ?? "UNKNOWN CHANNEL"),
      channel_avatar: p.channel_avatar ?? null,
      channel_verified: Boolean(p.channel_verified ?? false),
      author: String(p.author ?? "BOT"),
      images: Array.isArray(p.images) ? p.images : [],
      url: p.url ?? null,
    }))
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

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
    };

    cur.count += 1;
    if (!cur.lastPostAt || (p.created_at && p.created_at > cur.lastPostAt)) {
      cur.lastPostAt = p.created_at;
      cur.lastTitle = p.title;
      cur.name = p.channel_name || cur.name;
      cur.avatar = p.channel_avatar || cur.avatar;
      cur.verified = p.channel_verified || cur.verified;
    }

    map.set(id, cur);
  }

  return [...map.values()].sort((a, b) => (b.lastPostAt || "").localeCompare(a.lastPostAt || ""));
}

function render() {
  renderChannelList();

  if (state.view === "discovery") return renderDiscovery();
  if (state.view === "subs") return renderPosts(state.posts.filter(p => state.subscriptions.has(p.channel_id)), "SUBSCRIPTIONS");
  if (state.view === "channel") return renderPosts(state.posts.filter(p => p.channel_id === state.channelId), `CHANNEL: ${channelName(state.channelId)}`);
  return renderPosts(state.posts, "GLOBAL FEED");
}

function renderChannelList() {
  el.publics.innerHTML = "";
  if (!state.channels.length) {
    el.publics.innerHTML = `<div class="empty-state">No channels yet</div>`;
    return;
  }

  for (const c of state.channels) {
    const item = document.createElement("div");
    item.className = "channel-item";
    item.innerHTML = `
      <img class="channel-avatar" src="${escapeAttr(c.avatar || fallbackAvatar(c.name))}" alt="">
      <div class="channel-name">${escapeHtml(c.name)}</div>
      ${c.verified ? `<i class="fas fa-check-circle channel-verified" title="Verified"></i>` : ""}
    `;
    item.addEventListener("click", () => {
      state.view = "channel";
      state.channelId = c.id;
      render();
    });
    el.publics.appendChild(item);
  }
}

function renderDiscovery() {
  el.posts.innerHTML = "";
  const head = document.createElement("div");
  head.className = "post-card";
  head.innerHTML = `<div class="post-title">FIND CHANNELS</div><div class="post-content">Подписки — кнопкой в постах.</div>`;
  el.posts.appendChild(head);

  for (const c of state.channels) {
    const card = document.createElement("div");
    card.className = "post-card";
    const isSub = state.subscriptions.has(c.id);

    card.innerHTML = `
      <div class="post-header">
        <img class="post-avatar" src="${escapeAttr(c.avatar || fallbackAvatar(c.name))}" alt="">
        <div class="post-meta">
          <div class="post-channel">${escapeHtml(c.name)} ${c.verified ? `<i class="fas fa-check-circle" style="color: var(--success)"></i>` : ""}</div>
          <div class="post-date">${c.count} posts</div>
        </div>
        <button class="subscribe-btn ${isSub ? "subscribed" : ""}">
          <i class="fas ${isSub ? "fa-bell-slash" : "fa-bell"}"></i>
          ${isSub ? "UNSUB" : "SUB"}
        </button>
      </div>
      <div class="post-title">${escapeHtml(c.lastTitle || "—")}</div>
    `;

    card.querySelector(".subscribe-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSub(c.id);
      render();
    });

    card.addEventListener("click", () => {
      state.view = "channel";
      state.channelId = c.id;
      render();
    });

    el.posts.appendChild(card);
  }
}

function renderPosts(posts, title) {
  el.posts.innerHTML = "";

  const head = document.createElement("div");
  head.className = "post-card";
  head.innerHTML = `
    <div class="post-title">${escapeHtml(title)}</div>
    <div class="post-content">${posts.length ? `Постов: <b>${posts.length}</b>` : "Пока пусто. Бот ещё не принёс контент."}</div>
  `;
  el.posts.appendChild(head);

  for (const p of posts) el.posts.appendChild(renderPostCard(p));
}

function renderPostCard(p) {
  const card = document.createElement("div");
  card.className = "post-card";

  const isSub = state.subscriptions.has(p.channel_id);

  card.innerHTML = `
    <div class="post-header">
      <img class="post-avatar" src="${escapeAttr(p.channel_avatar || fallbackAvatar(p.channel_name))}" alt="">
      <div class="post-meta">
        <div class="post-channel">
          ${escapeHtml(p.channel_name)}
          ${p.channel_verified ? `<i class="fas fa-check-circle" style="color: var(--success)"></i>` : ""}
          <span class="post-author-tag">@${escapeHtml(p.author)}</span>
        </div>
        <div class="post-date">${p.created_at ? escapeHtml(new Date(p.created_at).toLocaleString()) : "—"}</div>
      </div>
      <button class="subscribe-btn ${isSub ? "subscribed" : ""}">
        <i class="fas ${isSub ? "fa-bell-slash" : "fa-bell"}"></i>
        ${isSub ? "UNSUB" : "SUB"}
      </button>
    </div>

    <div class="post-title">${escapeHtml(p.title)}</div>
    <div class="post-content">${escapeHtml(p.content)}</div>

    ${(p.images || []).slice(0, 6).map(u => `
      <div class="post-image-container">
        <img class="post-image" src="${escapeAttr(u)}" alt="">
      </div>
    `).join("")}

    <div class="post-actions">
      <button class="action-btn open-channel"><i class="fas fa-tower-broadcast"></i> CHANNEL</button>
      ${p.url ? `<a class="action-btn" href="${escapeAttr(p.url)}" target="_blank" rel="noreferrer"><i class="fas fa-link"></i> SOURCE</a>` : ""}
    </div>
  `;

  card.querySelector(".subscribe-btn")?.addEventListener("click", () => {
    toggleSub(p.channel_id);
    render();
  });

  card.querySelector(".open-channel")?.addEventListener("click", () => {
    state.view = "channel";
    state.channelId = p.channel_id;
    render();
  });

  return card;
}

function toggleSub(channelId) {
  if (state.subscriptions.has(channelId)) state.subscriptions.delete(channelId);
  else state.subscriptions.add(channelId);
  saveSubs([...state.subscriptions]);
}

function loadSubs() {
  try {
    const raw = localStorage.getItem("tls_subs");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

function saveSubs(arr) {
  localStorage.setItem("tls_subs", JSON.stringify(arr));
}

function channelName(id) {
  return state.channels.find(c => c.id === id)?.name || "UNKNOWN";
}

function setStatus(text, busy) {
  el.status.textContent = text;
  el.status.style.opacity = busy ? "0.7" : "1";
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) { return escapeHtml(s).replaceAll("\n", " "); }

function fallbackAvatar(name) {
  const initials = (name || "?").trim().slice(0, 2).toUpperCase();
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7896ff"/>
        <stop offset="1" stop-color="#a078ff"/>
      </linearGradient>
    </defs>
    <rect width="80" height="80" rx="18" fill="url(#g)"/>
    <text x="50%" y="54%" text-anchor="middle" font-family="Inter, Arial" font-size="28" fill="white">${escapeHtml(initials)}</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function rnd() {
  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}