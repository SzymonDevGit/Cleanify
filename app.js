/*
 * Cleanify: clean up a Spotify playlist by swiping through it like a crate of records.
 * Swipe right (or →) keeps a song, swipe left (or ←) removes it from the playlist
 * straight away. Undo puts removed songs back where they were.
 *
 * Runs fully in the browser. Spotify sign-in uses the PKCE flow, so no client
 * secret is needed (or allowed) here.
 */
"use strict";

// Everyone uses their own Spotify app (Spotify lets only 5 people sign in to an app in
// development mode). Its Client ID is entered on the sign-in screen and kept in this
// browser. Never put a client secret in this file.
const CLIENT_ID = (() => {
  try { return JSON.parse(localStorage.getItem("cl_client_id")) || ""; } catch { return ""; }
})();
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",          // the "This browser" player
  "user-read-email",
  "user-read-private",
].join(" ");
const BROWSER = "browser";      // the "Play on" value for this tab's own player
// Must match a Redirect URI in the Spotify dashboard exactly.
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");
const SWIPE_DISTANCE = 100;   // px a card must be dragged to count as a swipe
const HISTORY_SIZE = 100;     // undo steps kept per playlist

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Storage (wrapped: private windows can throw)
// ---------------------------------------------------------------------
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// ---------------------------------------------------------------------
// Spotify auth (Authorization Code with PKCE)
// ---------------------------------------------------------------------
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startLogin() {
  if (!CLIENT_ID) return;
  const verifier = randomString(64);
  const state = randomString(16);
  store.set("cl_verifier", verifier);
  store.set("cl_state", state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(verifier),
    scope: SCOPES,
    state,
  });
  location.href = "https://accounts.spotify.com/authorize?" + params;
}

function saveToken(data) {
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || (store.get("cl_token") || {}).refresh,
    scope: data.scope || (store.get("cl_token") || {}).scope || "",
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  store.set("cl_token", token);
  return token;
}

async function tokenRequest(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify sign-in failed (${res.status})`);
  return saveToken(data);
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  store.remove("cl_me");  // a new sign-in may be another account
  store.remove("cl_playlists");
  history.replaceState(null, "", REDIRECT_URI);
  if (params.get("error")) throw new Error(`Spotify sign-in was cancelled (${params.get("error")}).`);
  if (params.get("state") !== store.get("cl_state")) throw new Error("Sign-in check failed. Please try again.");
  await tokenRequest({
    grant_type: "authorization_code",
    code: params.get("code"),
    redirect_uri: REDIRECT_URI,
    code_verifier: store.get("cl_verifier"),
  });
  store.remove("cl_verifier");
  store.remove("cl_state");
}

// Requests that find the token expired at once share one refresh, because Spotify
// may replace the refresh token and a second refresh with the old one would fail.
let refreshing = null;
async function accessToken() {
  let token = store.get("cl_token");
  if (!token) throw new Error("Not signed in.");
  if (Date.now() > token.expires) {
    if (!token.refresh) throw new Error("Not signed in.");
    refreshing = refreshing || tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh })
      .finally(() => { refreshing = null; });
    token = await refreshing;
  }
  return token.access;
}

function logout() {
  store.remove("cl_token");
  store.remove("cl_me");
  store.remove("cl_playlists");
  location.reload();
}

// Switches to another Spotify app. A sign-in belongs to one app, so it signs you out too.
function setClientId(id) {
  store.set("cl_client_id", id);
  store.remove("cl_token");
  location.reload();
}

// Until a Client ID is saved the setup steps are open and Sign in is disabled;
// afterwards they fold away behind "Use a different Spotify app".
function renderOwnApp() {
  $("own-redirect").textContent = REDIRECT_URI;
  $("login-btn").disabled = !CLIENT_ID;
  if (!CLIENT_ID) {
    $("own-app").open = true;
    return;
  }
  $("own-summary").textContent = "Use a different Spotify app";
  $("own-id").value = CLIENT_ID;
  $("own-using").textContent = `Using your Spotify app (…${CLIENT_ID.slice(-4)}).`;
}

function onOwnAppSave() {
  const id = $("own-id").value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    $("own-status").textContent = "That doesn't look like a Client ID. It's 32 letters and numbers, shown on your app's page in the Spotify dashboard.";
    return;
  }
  setClientId(id.toLowerCase());
}

// ---------------------------------------------------------------------
// Spotify Web API
// ---------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Recent playback calls and what Spotify answered, for the "Copy details" link.
const debugLog = [];
function debug(line) {
  debugLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (debugLog.length > 120) debugLog.shift();
}

function describePlayer(st) {
  if (!st) return "nothing playing";
  return `${st.is_playing ? "playing" : "paused"} "${(st.item || {}).name || "?"}" on ${(st.device || {}).name || "?"}` +
    `${st.context ? " from " + st.context.uri : ""}${st.shuffle_state ? " (shuffle on)" : ""}`;
}

// When Spotify says "too many requests" it also says how long to wait. Asking again
// before then only makes the wait longer, so every call is held back until it's over
// (remembered across reloads and tabs).
// Kept per Client ID: each Spotify app has its own limit, so a new app starts fresh.
const WAIT_KEY = "cl_wait_until_" + CLIENT_ID;
const STRIKES_KEY = "cl_429s_" + CLIENT_ID;
function coolDownLeft() {
  return Math.max(0, store.get(WAIT_KEY, 0) - Date.now());
}

function waitText(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const at = new Date(Date.now() + ms);
  return `until ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function tooManyError() {
  return new ApiError(429, `Spotify has paused your Spotify app for asking too often, so Cleanify will wait ${waitText(coolDownLeft())} before trying again. The limit is shared by everything using the same Client ID: Cleanify on other devices or tabs, and Jukemonster if it uses the same app.`);
}

async function api(path, { method = "GET", body } = {}, retried = false) {
  const url = path.startsWith("http") ? path : "https://api.spotify.com/v1" + path;
  const short = url.replace("https://api.spotify.com/v1", "");
  const logIt = true;
  if (coolDownLeft()) throw tooManyError();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + await accessToken(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    const token = store.get("cl_token") || {};
    token.expires = 0;
    store.set("cl_token", token);
    return api(path, { method, body }, true);
  }
  if (res.status === 429) {
    // Retry-After is in seconds; if the browser can't read it, back off 30 s, doubling.
    const raw = res.headers.get("Retry-After");
    const header = Number(raw);
    const strikes = store.get(STRIKES_KEY, 0) + 1;
    store.set(STRIKES_KEY, strikes);
    const secs = header > 0 ? header : Math.min(30 * 2 ** (strikes - 1), 600);
    store.set(WAIT_KEY, Date.now() + secs * 1000);
    debug(`${method} ${short} -> 429, Retry-After ${raw === null ? "not readable" : raw}, waiting ${secs} s (strike ${strikes})`);
    throw tooManyError();
  }
  if (res.ok) store.remove(STRIKES_KEY);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = (data.error && data.error.message) || `Spotify request failed (${res.status})`;
    if (logIt) debug(`${method} ${short}${body ? " " + JSON.stringify(body) : ""} -> ${res.status} ${message}`);
    throw new ApiError(res.status, message);
  }
  const text = res.status === 204 ? "" : await res.text();
  const data = text ? JSON.parse(text) : null;
  if (logIt) {
    const said = method !== "GET" ? ""
      : short.startsWith("/me/player?") || short === "/me/player" ? describePlayer(data)
      : short.startsWith("/me/player/devices") ? ((data && data.devices) || []).map((d) => `${d.name}${d.is_active ? "*" : ""}${d.is_restricted ? " (restricted)" : ""}`).join(", ")
      : "";
    debug(`${method} ${short}${body ? " " + JSON.stringify(body) : ""} -> ${res.status}${said ? " " + said : ""}`);
  }
  return data;
}

// Spotify renamed a playlist's /tracks to /items in 2026, and changed the body keys
// with it. Try the forms in turn and remember the one that worked.
async function playlistItemsCall(playlistId, method, forms) {
  const key = "cl_form_" + method;
  const first = store.get(key, 0);
  const order = [first, ...forms.keys()].filter((v, i, a) => a.indexOf(v) === i && v < forms.length);
  let lastErr;
  for (const i of order) {
    const [path, body] = forms[i];
    try {
      const res = await api(`/playlists/${encodeURIComponent(playlistId)}/${path}`, { method, body });
      store.set(key, i);
      return res;
    } catch (err) {
      if (![400, 404, 405].includes(err.status)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function removeFromPlaylist(playlistId, uris) {
  const list = uris.map((uri) => ({ uri }));
  return playlistItemsCall(playlistId, "DELETE", [
    ["items", { items: list }],
    ["items", { tracks: list }],
    ["tracks", { tracks: list }],
  ]);
}

function addToPlaylist(playlistId, uris, position) {
  const body = position === undefined ? { uris } : { uris, position };
  return playlistItemsCall(playlistId, "POST", [["items", body], ["tracks", body]]);
}

async function createPlaylist(me, name, description) {
  const body = { name, description, public: false };
  try {
    return await api("/me/playlists", { method: "POST", body });
  } catch (err) {
    if (![404, 405].includes(err.status)) throw err;
    return api(`/users/${encodeURIComponent(me.id)}/playlists`, { method: "POST", body });
  }
}

async function firstItemsPage(id) {
  const qs = "?limit=50&market=from_token";
  try {
    return await api(`/playlists/${encodeURIComponent(id)}/items${qs}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    return api(`/playlists/${encodeURIComponent(id)}/tracks${qs}`);
  }
}

function pickImage(images, small) {
  const list = (images || []).filter((i) => i && i.url);
  if (!list.length) return "";
  return (small ? list[list.length - 1] : list[0]).url;
}

// Playlists you can change: ones you made or collaborate on.
async function fetchPlaylists(me) {
  const list = [];
  let page = await api("/me/playlists?limit=50");
  for (let n = 0; page && n < 20; n++) {
    list.push(...(page.items || []).filter(Boolean));
    page = page.next ? await api(page.next) : null;
  }
  return list
    .filter((p) => (p.owner && p.owner.id === me.id) || p.collaborative)
    .map((p) => ({
      id: p.id,
      uri: p.uri,
      name: p.name || "Untitled playlist",
      total: ((p.items || p.tracks) || {}).total,
      image: pickImage(p.images, true),
    }));
}

// Every entry in playlist order (kept so songs can be put back in the right place),
// plus one card per different song.
async function fetchPlaylistSongs(id) {
  const entries = [];
  const tracks = [];
  const seen = new Set();
  let page;
  try {
    page = await firstItemsPage(id);
  } catch (err) {
    if (err.status === 403) throw new Error("Spotify won't let this app read that playlist.");
    if (err.status === 404) throw new Error("Spotify couldn't find that playlist.");
    throw err;
  }
  while (page) {
    for (const entry of page.items || []) {
      const t = entry.track || entry.item;
      // When Spotify swaps in another release of a song for your country ("relinking"),
      // t.uri is the swapped-in one and linked_from holds the one in the playlist.
      const uri = t && !t.is_local && t.uri ? (t.linked_from && t.linked_from.uri) || t.uri : null;
      entries.push({ uri, gone: false });
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      const album = t.album || t.show || {};
      tracks.push({
        uri,
        title: t.name || "Unknown title",
        artists: (t.artists || []).map((a) => a.name).join(", ") || (t.show ? t.show.publisher || "" : "") || "Unknown artist",
        year: ((album.release_date || t.release_date || "").match(/^\d{4}/) || [""])[0],
        cover: pickImage(album.images || t.images),
        thumb: pickImage(album.images || t.images, true),
        added: entry.added_at || "",
        duration: t.duration_ms || 0,
        album: album.name || "",
        isrc: (t.external_ids || {}).isrc || "",
        entry: entries.length - 1,
        playUri: t.uri,
        playable: t.is_playable !== false,
      });
    }
    page = page.next ? await api(page.next) : null;
  }
  return { entries, tracks };
}

// ---------------------------------------------------------------------
// Per-playlist memory: kept songs, the bargain bin and undo steps
// ---------------------------------------------------------------------
function loadMemory(id) {
  const m = store.get("cl_pl_" + id, {}) || {};
  return {
    kept: m.kept || [],
    removed: m.removed || [],    // {uri, title, artists, year, cover, thumb, added, duration, pos}
    history: m.history || [],    // {uri, dec: "keep" | "remove"}
    backup: m.backup || null,
    dupesSeen: m.dupesSeen || [],  // duplicate groups already shown, so they don't pop up every visit
  };
}

function saveMemory() {
  const { id } = state.playlist;
  state.mem.history = state.mem.history.slice(-HISTORY_SIZE);
  store.set("cl_pl_" + id, state.mem);
}

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------
const state = {
  me: null,
  playlists: [],
  playlist: null,  // {id, uri, name}
  entries: [],     // every playlist entry in order: {uri, gone}
  tracks: [],      // one per song: see fetchPlaylistSongs
  mem: null,
  current: null,   // the track on top of the deck
  busy: false,     // a backup is being made
};

// Spotify calls that change the playlist run one at a time, in swipe order.
let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
}

function isKept(t) { return state.mem.kept.includes(t.uri); }
function isGone(t) { return state.entries[t.entry] && state.entries[t.entry].gone; }
function undecided() { return state.tracks.filter((t) => !isKept(t) && !isGone(t)); }

// Where the song sits in the playlist now: the entries before it that are still there.
function currentPosition(t) {
  let n = 0;
  for (let i = 0; i < t.entry; i++) if (!state.entries[i].gone) n++;
  return n;
}

// Removing a song takes out every copy of it (putting back adds one).
function setGone(uri, gone) {
  state.entries.forEach((e) => { if (e.uri === uri) e.gone = gone; });
}

function trackByUri(uri) { return state.tracks.find((t) => t.uri === uri); }

// A removed song from an earlier visit isn't in the list we loaded: slot it back in
// at the position it had when it was removed.
function restoreTrack(saved) {
  let t = trackByUri(saved.uri);
  if (t) return t;
  const target = Math.max(0, saved.pos || 0);
  let e = 0, present = 0;
  while (e < state.entries.length && (state.entries[e].gone || present < target)) {
    if (!state.entries[e].gone) present++;
    e++;
  }
  state.entries.splice(e, 0, { uri: saved.uri, gone: true });
  state.tracks.forEach((x) => { if (x.entry >= e) x.entry++; });
  t = { ...saved, entry: e };
  delete t.pos;
  const at = state.tracks.findIndex((x) => x.entry > e);
  state.tracks.splice(at === -1 ? state.tracks.length : at, 0, t);
  return t;
}

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("screen-" + name).classList.remove("hidden");
  window.scrollTo(0, 0);
}

function setStatus(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "") + (el.classList.contains("small") ? " small" : "");
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function thumbEl(url) {
  const t = el("span", "thumb");
  if (url) t.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`;
  return t;
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!iso || !(ms >= 0)) return "";
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "Added today";
  if (days < 31) return `Added ${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `Added ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365.25);
  return `Added ${years} yr${years === 1 ? "" : "s"} ago`;
}

function duration(ms) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- Playlists ---
// The list is kept for 10 minutes so going back and forth doesn't ask Spotify again;
// Refresh list always does.
const LIST_CACHE_MS = 10 * 60 * 1000;
async function showPlaylists(force = false) {
  showScreen("playlists");
  stopAutoplay();
  clearInterval(watchTimer);
  const cached = store.get("cl_playlists");
  if (!force && cached && cached.user === state.me.id && Date.now() - cached.at < LIST_CACHE_MS) {
    state.playlists = cached.list;
    renderPlaylists();
    setStatus("playlists-status", "");
    return;
  }
  setStatus("playlists-status", "Loading your playlists…");
  try {
    state.playlists = await fetchPlaylists(state.me);
    store.set("cl_playlists", { user: state.me.id, at: Date.now(), list: state.playlists });
    renderPlaylists();
    setStatus("playlists-status", state.playlists.length ? "" : "You have no playlists of your own yet.");
  } catch (err) {
    setStatus("playlists-status", err.message, "err");
    // Try again by itself once a short wait is over.
    const wait = coolDownLeft();
    if (err.status === 429 && wait && wait < 5 * 60 * 1000) {
      setTimeout(() => { if (!$("screen-playlists").classList.contains("hidden")) showPlaylists(true); }, wait + 500);
    }
  }
}

function renderPlaylists() {
  const ul = $("playlist-list");
  ul.textContent = "";
  for (const p of state.playlists) {
    const li = el("li");
    const b = el("button");
    b.append(thumbEl(p.image));
    const text = el("span");
    text.append(el("span", "name", p.name), el("span", "meta", p.total === undefined ? "" : `${p.total} songs`));
    b.append(text);
    const mem = loadMemory(p.id);
    const sorted = mem.kept.length + mem.removed.length;
    if (sorted) b.append(el("span", "badge", `${sorted} sorted`));
    b.addEventListener("click", () => openPlaylist(p));
    li.append(b);
    ul.append(li);
  }
}

async function openPlaylist(p) {
  setStatus("playlists-status", `Opening ${p.name}…`);
  try {
    const { entries, tracks } = await fetchPlaylistSongs(p.id);
    state.playlist = p;
    state.entries = entries;
    state.tracks = tracks;
    state.mem = loadMemory(p.id);
    // Songs kept earlier but since taken out of the playlist elsewhere don't count any more.
    state.mem.kept = state.mem.kept.filter((u) => trackByUri(u));
    setStatus("playlists-status", "");
    setStatus("play-status", "");
    $("pl-name").textContent = p.name;
    showScreen("swipe");
    render();
    loadDevices();
    if ($("backup").checked && !state.mem.backup && tracks.length) await makeBackup();
    // New duplicates (ones not shown on an earlier visit) are listed before swiping.
    const groups = findDuplicates();
    if (groups.some((g) => !state.mem.dupesSeen.includes(g.key))) showDupes(groups);
  } catch (err) {
    setStatus("playlists-status", err.message, "err");
  }
}

async function makeBackup() {
  state.busy = true;
  render();
  setStatus("play-status", "Saving a backup copy first…");
  try {
    const p = state.playlist;
    const date = new Date().toISOString().slice(0, 10);
    const copy = await createPlaylist(state.me, `${p.name} (backup)`, `Copy of ${p.name} saved by Cleanify on ${date}, before cleaning.`);
    const uris = state.entries.map((e) => e.uri).filter(Boolean);
    for (let i = 0; i < uris.length; i += 100) await addToPlaylist(copy.id, uris.slice(i, i + 100));
    state.mem.backup = copy.id;
    saveMemory();
    setStatus("play-status", `Backup saved as "${p.name} (backup)" in your library.`, "ok");
  } catch (err) {
    setStatus("play-status", `Couldn't save a backup (${err.message}). You can still swipe, or go back and try again.`, "err");
  } finally {
    state.busy = false;
    render();
  }
}

// --- Swipe deck ---
function cardEl(t, cls) {
  const c = el("div", "card " + cls);
  if (!t) return c;
  const art = el("div", "sleeve-art");
  art.append(el("div", "vinyl"));
  if (t.cover) {
    const img = el("img", "cover");
    img.src = t.cover;
    img.alt = "";
    img.draggable = false;
    art.append(img);
  } else {
    art.append(el("div", "fallback", t.title));
  }
  if (t.year) art.append(el("div", "sticker", t.year));
  c.append(art, el("h2", "", t.title), el("p", "artist", t.artists));
  const meta = el("div", "meta");
  for (const m of [ago(t.added), duration(t.duration)]) if (m) meta.append(el("span", "", m));
  if (t.playable === false) meta.append(el("span", "warn-tag", "Can't play in your country"));
  c.append(meta);
  if (cls === "top") {
    c.append(el("div", "stamp keep", "KEEP"), el("div", "stamp bin", "REMOVE"));
    dragHandlers(c);
  }
  return c;
}

function render() {
  const left = undecided();
  const total = state.tracks.length;
  const done = total - left.length;
  const prev = state.current;
  state.current = left[0] || null;

  $("pos").textContent = Math.min(done + 1, total);
  $("total").textContent = total;
  $("prog-bar").style.width = total ? `${(done / total) * 100}%` : "0";
  $("bin-count").textContent = state.mem.removed.length;
  $("keep-count").textContent = state.mem.kept.length;
  $("undo-btn").disabled = !state.mem.history.length || state.busy;
  for (const id of ["bin-btn", "keep-btn", "play-btn"]) $(id).disabled = !state.current || state.busy;

  const deck = $("deck");
  deck.querySelectorAll(".card:not(.flying)").forEach((c) => c.remove());
  if (!state.current) {
    if (!state.busy) setTimeout(() => { if (!state.current) showDone(); }, 300);
    return;
  }
  const cards = [cardEl(left[2], "b2"), cardEl(left[1], "b1"), cardEl(state.current, "top")]
    .filter((c, i) => i === 2 || left[2 - i]);
  deck.prepend(...cards);
  preloadCovers(left.slice(3, 6));
  if (prev !== state.current && !state.busy) {
    if (autoplay()) schedulePlay();
    // Without Autoplay, don't leave the last card's song playing under a new card.
    else if (nowPlaying && !sameSong({ uri: nowPlaying.uri, name: nowPlaying.title }, state.current)) { playSeq++; pausePlayback(); }
  }
}

// Fetch the next few covers early so cards don't appear blank.
const preloaded = new Set();
function preloadCovers(tracks) {
  for (const t of tracks) {
    if (!t.cover || preloaded.has(t.cover)) continue;
    preloaded.add(t.cover);
    new Image().src = t.cover;
  }
}

function decide(dec, fromDrag) {
  const t = state.current;
  if (!t || state.busy) return;
  const card = $("deck").querySelector(".card.top");
  if (card) {
    // The card flies off on its own while the next one is already there to swipe.
    const dir = dec === "keep" ? 1 : -1;
    if (!fromDrag) card.querySelector(dec === "keep" ? ".stamp.keep" : ".stamp.bin").style.opacity = 1;
    card.classList.remove("top", "drag", "snap");
    card.classList.add("flying");
    card.getBoundingClientRect();
    card.classList.add("fly");
    card.style.transform = `translate(${dir * 600}px, 40px) rotate(${dir * 30}deg)`;
    setTimeout(() => card.remove(), 320);
  }
  setStatus("play-status", "");
  state.mem.history.push({ uri: t.uri, dec });
  if (dec === "keep") {
    state.mem.kept.push(t.uri);
  } else {
    removeTrack(t).catch(() => {});  // removeTrack shows the error
  }
  saveMemory();
  render();
}

// Takes a song (every copy of it) out of the playlist and into the bargain bin.
// The caller has already added the undo step.
function removeTrack(t) {
  const pos = currentPosition(t);
  setGone(t.uri, true);
  const { entry, ...saved } = t;
  state.mem.removed.push({ ...saved, pos });
  return enqueue(() => removeFromPlaylist(state.playlist.id, [t.uri])).catch((err) => {
    // It's still in the playlist: undo the swipe so the screen matches Spotify.
    setGone(t.uri, false);
    state.mem.removed = state.mem.removed.filter((r) => r.uri !== t.uri);
    state.mem.history = state.mem.history.filter((h) => !(h.uri === t.uri && h.dec === "remove"));
    saveMemory();
    render();
    showScreen("swipe");
    setStatus("play-status", `Couldn't remove "${t.title}": ${removeError(err)}`, "err");
    throw err;
  });
}

function removeError(err) {
  if (err.status === 403) return "Spotify says you can't change this playlist.";
  return err.message;
}

// Puts a removed song back where it was. Used by Undo and the bargain bin.
function putBack(uri) {
  const saved = state.mem.removed.find((r) => r.uri === uri);
  if (!saved) return Promise.resolve(null);
  const t = restoreTrack(saved);
  return enqueue(async () => {
    const pos = currentPosition(t);
    await addToPlaylist(state.playlist.id, [uri], pos);
    state.entries[t.entry].gone = false;
    state.mem.removed = state.mem.removed.filter((r) => r.uri !== uri);
    saveMemory();
    return t;
  });
}

async function undo() {
  const last = state.mem.history.pop();
  if (!last) return;
  saveMemory();
  $("undo-btn").disabled = true;
  if (last.dec === "keep") {
    state.mem.kept = state.mem.kept.filter((u) => u !== last.uri);
    saveMemory();
    render();
    return;
  }
  if (last.dec === "extras") {
    setStatus("play-status", "Putting the extra copies back…");
    try {
      await restoreExtras(last);
      setStatus("play-status", "The extra copies are back in the playlist.", "ok");
    } catch (err) {
      state.mem.history.push(last);
      saveMemory();
      setStatus("play-status", `Couldn't put them back: ${err.message}`, "err");
    }
    render();
    return;
  }
  setStatus("play-status", "Putting it back…");
  try {
    const t = await putBack(last.uri);
    setStatus("play-status", t ? `"${t.title}" is back in the playlist.` : "", "ok");
  } catch (err) {
    state.mem.history.push(last);
    saveMemory();
    setStatus("play-status", `Couldn't put it back: ${err.message}`, "err");
  }
  render();
}

// Drag the top card left or right; let go past SWIPE_DISTANCE to decide.
function dragHandlers(card) {
  let startX = 0, startY = 0, dx = 0, dragging = false;
  const keep = card.querySelector(".stamp.keep");
  const bin = card.querySelector(".stamp.bin");
  card.addEventListener("pointerdown", (e) => {
    if (state.busy) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add("drag");
    card.classList.remove("snap");
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const dy = (e.clientY - startY) * 0.3;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    keep.style.opacity = Math.max(0, Math.min(1, dx / SWIPE_DISTANCE));
    bin.style.opacity = Math.max(0, Math.min(1, -dx / SWIPE_DISTANCE));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("drag");
    if (Math.abs(dx) >= SWIPE_DISTANCE) return decide(dx > 0 ? "keep" : "remove", true);
    card.classList.add("snap");
    card.style.transform = "";
    keep.style.opacity = bin.style.opacity = 0;
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

// --- Playing songs on the person's Spotify ---
// Songs play on the device picked under "Play on" (remembered in this browser), so
// Spotify can't wander off to another speaker, like an Echo, between songs.
function autoplay() { return $("autoplay").checked; }
function stopAutoplay() { $("play-btn").classList.remove("on"); }

let devices = [];
function savedDevice() { return store.get("cl_device", null); }  // {id, name}

async function loadDevices() {
  const select = $("device-select");
  try {
    devices = ((await api("/me/player/devices")) || {}).devices || [];
  } catch (err) {
    setStatus("play-status", `Couldn't list your Spotify devices: ${err.message}`, "err");
    devices = [];
  }
  const saved = savedDevice();
  if (saved && saved.id === BROWSER) startBrowserPlayer();
  // Device ids can change when an app restarts; the name is a good second guess.
  const match = saved && saved.id === BROWSER ? saved : saved && (devices.find((d) => d.id === saved.id) || devices.find((d) => d.name === saved.name));
  if (match && match.id !== saved.id && saved.id !== BROWSER) store.set("cl_device", { id: match.id, name: match.name });
  select.textContent = "";
  const first = el("option", "", devices.length ? "Pick a speaker…" : "No Spotify devices found");
  first.value = "";
  select.append(first);
  devices = devices.filter((d) => d.id !== browser.id && d.name !== "Cleanify");
  const b = el("option", "", "This browser (plays in this tab)");
  b.value = BROWSER;
  select.append(b);
  for (const d of devices) {
    const o = el("option", "", `${d.name} (${(d.type || "device").toLowerCase()})${d.is_active ? " · playing" : ""}`);
    o.value = d.id;
    select.append(o);
  }
  if (saved && !match && saved.id !== BROWSER) {
    const o = el("option", "", `${saved.name} (not open right now)`);
    o.value = saved.id;
    select.append(o);
  }
  select.value = saved ? (match ? match.id : saved.id) : "";
  return match || null;
}

function onPickDevice() {
  const value = $("device-select").value;
  if (value === BROWSER) {
    $("device-select").blur();
    store.set("cl_device", { id: BROWSER, name: "This browser" });
    // Tokens from before this option existed can't stream: sign in once more.
    if (!/\bstreaming\b/.test((store.get("cl_token") || {}).scope || "")) {
      setStatus("play-status", "Signing in again so this browser can play music…");
      startLogin();
      return;
    }
    startBrowserPlayer();
    setStatus("play-status", "");
    if (autoplay()) playCurrent();
    return;
  }
  const d = devices.find((x) => x.id === value);
  $("device-select").blur();  // so the arrow keys swipe again
  if (d) store.set("cl_device", { id: d.id, name: d.name });
  else store.remove("cl_device");
  setStatus("play-status", "");
  if (d && autoplay()) playCurrent();
}

// Autoplay waits for you to stop on a card, so fast swiping doesn't send a pile of
// play requests that arrive out of order.
let playTimer = null;
function schedulePlay() {
  clearTimeout(playTimer);
  playTimer = setTimeout(playCurrent, 350);
}

// What Cleanify last started: {uri, title, deviceId}. Used to keep Spotify on the card's
// song: pause when the card moves on (without Autoplay), or when Spotify skips ahead.
let nowPlaying = null;
let playSeq = 0;

function sameSong(item, t) {
  if (!item || !t) return false;
  return item.uri === t.uri || (item.linked_from && item.linked_from.uri === t.uri) || plain(item.name) === plain(t.title);
}

// After a play request, check Spotify really plays the card's song. Some phones ignore
// the requested start song when shuffle is on, and some apps ignore single-song plays.
// Phones can take a few seconds to report the new song, so give it up to 6 s.
// Answers "ok", "wrong" (another song is playing) or "failed" (nothing loaded).
async function confirmPlaying(t, seq) {
  let empty = 0;
  for (let i = 0; i < 5; i++) {
    await sleep(i < 2 ? 700 : 1500);
    if (seq !== playSeq) return "ok";
    let st;
    try { st = await api("/me/player?additional_types=track"); } catch { return "ok"; }  // can't tell: trust it
    if (st && st.item && sameSong(st.item, t)) return "ok";
    if (st && !st.item && !st.is_playing) empty++;
  }
  return empty >= 4 ? "failed" : "wrong";
}

// Waking a phone that isn't the active Spotify device: a play request sent straight to
// it often just resumes its last song for a moment. Move playback there first (paused),
// wait until Spotify says it's active, then ask for the song.
async function makeActive(id) {
  if (devices.some((d) => d.id === id && d.is_active)) return;
  let st = null;
  try { st = await api("/me/player"); } catch { /* ignore */ }
  if (st && st.device && st.device.id === id) return;
  try { await api("/me/player", { method: "PUT", body: { device_ids: [id], play: false } }); } catch { return; }
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    try { st = await api("/me/player"); } catch { return; }
    if (st && st.device && st.device.id === id) return;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playCurrent() {
  clearTimeout(playTimer);
  const t = state.current;
  if (!t) return;
  const seq = ++playSeq;
  let device = savedDevice();
  if (!device) {
    const d = await loadDevices();
    device = d && savedDevice();
    if (!device) {
      setStatus("play-status", devices.length ? "Pick where to play under Play on, then press ▶." : "Open Spotify on your phone or computer, press ↻ next to Play on, and pick it.", "err");
      stopAutoplay();
      return;
    }
  }
  if (t.playable === false) {
    await pausePlayback();
    setStatus("play-status", "Spotify can't play this song on your account (it isn't available in your country). You can still keep or remove it.", "err");
    return;
  }
  const start = Math.min(30000, Math.floor((t.duration || 0) / 3));
  // Two ways to start a song. "song" plays just that song (it stops at the end, and
  // shuffle can't change it); "playlist" starts it inside the playlist, for Spotify apps
  // that ignore single-song requests. The way that worked is remembered per device.
  const ways = {
    song: { uris: [t.playUri || t.uri], position_ms: start },
    playlist: { context_uri: state.playlist.uri, offset: { uri: t.uri }, position_ms: start },
  };
  const methods = store.get("cl_play_methods", {});
  const first = methods[device.name] || "song";
  const order = [first, first === "song" ? "playlist" : "song"];
  setStatus("play-status", "Starting…");
  try {
    let lastErr = null;
    for (const way of order) {
      if (seq !== playSeq) return;
      let deviceId;
      try {
        if (way === "playlist") await setShuffle(device, false);
        deviceId = await playOn(device, ways[way]);
      } catch (err) {
        if (err.status !== 400) throw err;
        lastErr = err;
        continue;
      }
      if (seq !== playSeq) return;
      const result = await confirmPlaying(t, seq);
      if (result === "failed") {
        // The device tried and gave up: the song itself won't play. Starting it inside
        // the playlist would only skip to the next song, so stop here.
        throw new ApiError(0, `Spotify couldn't play "${t.title}" on ${device.name}. It may not be available in your country.`);
      }
      if (result === "ok") {
        if (seq !== playSeq) return;
        methods[device.name] = way;
        store.set("cl_play_methods", methods);
        nowPlaying = { uri: t.uri, title: t.title, deviceId };
        watchPlayback();
        $("play-btn").classList.add("on");
        if (state.current === t) setStatus("play-status", "");
        return;
      }
      lastErr = new ApiError(0, `Spotify played a different song instead of "${t.title}".`);
    }
    throw lastErr;
  } catch (err) {
    if (seq !== playSeq) return;
    stopAutoplay();
    setStatus("play-status", playError(err), "err");
  }
}

async function setShuffle(device, on) {
  const id = device.id === BROWSER ? browser.id : device.id;
  if (!id) return;
  try { await api(`/me/player/shuffle?state=${on}&device_id=${encodeURIComponent(id)}`, { method: "PUT" }); } catch { /* not important */ }
}

async function pausePlayback() {
  const p = nowPlaying;
  nowPlaying = null;
  stopAutoplay();
  if (!p) return;
  try { await api(`/me/player/pause?device_id=${encodeURIComponent(p.deviceId)}`, { method: "PUT" }); } catch { /* already stopped */ }
}

// While a song from Cleanify plays, check every few seconds that Spotify is still on it.
// If it moved on to another song in this playlist by itself, pause, so the phone never
// plays a different song from the card. If you picked something else in Spotify, let it be.
let watchTimer = null;
function watchPlayback() {
  clearInterval(watchTimer);
  watchTimer = setInterval(async () => {
    if (!nowPlaying || $("screen-swipe").classList.contains("hidden")) {
      clearInterval(watchTimer);
      return;
    }
    if (document.hidden || coolDownLeft()) return;  // no checks from a tab you aren't looking at
    let st;
    try { st = await api("/me/player?additional_types=track"); } catch { return; }
    if (!nowPlaying) return;
    if (!st || !st.item) { nowPlaying = null; stopAutoplay(); return; }
    if (sameSong(st.item, nowPlaying)) {
      if (!st.is_playing) stopAutoplay(); else $("play-btn").classList.add("on");
      return;
    }
    const ours = st.context && st.context.uri === state.playlist.uri;
    if (ours && st.is_playing && state.current && !sameSong(st.item, state.current)) {
      await pausePlayback();
      setStatus("play-status", "Paused: Spotify moved on to the next song. Press ▶ to hear this one.");
    } else {
      nowPlaying = null;
      stopAutoplay();
    }
  }, 10000);
}

// Plays on the chosen device. If Spotify has lost it (the app was closed and reopened,
// so its id changed), look it up again by name once.
async function playOn(device, body) {
  const put = (id) => api(`/me/player/play?device_id=${encodeURIComponent(id)}`, { method: "PUT", body });
  if (device.id === BROWSER) {
    const id = await browserReady();
    // Lets the browser start sound from this click (mobile Safari and Chrome need it).
    try { await browser.player.activateElement(); } catch { /* ignore */ }
    await put(id);
    return id;
  }
  try {
    await makeActive(device.id);
    await put(device.id);
    return device.id;
  } catch (err) {
    if (err.status !== 404) throw err;
    const found = await loadDevices();
    if (!found) throw new ApiError(404, "device gone");
    await put(found.id);
    return found.id;
  }
}

function playError(err) {
  if (err.browser || err.status === 0) return err.message;
  if (err.status === 404) return `Can't reach ${(savedDevice() || {}).name || "that device"}. Open Spotify on it, press ↻ next to Play on, then ▶.`;
  if (err.status === 403) return "Playing songs from here needs Spotify Premium. You can still swipe.";
  return `Couldn't play it: ${err.message}`;
}

// --- "This browser": Spotify's Web Playback SDK, loaded only when picked ---
const browser = { id: null, player: null, problem: "", waiters: [] };

function browserProblem(text) {
  browser.problem = text;
  browser.id = null;
  browser.waiters.splice(0).forEach((w) => w.reject(Object.assign(new Error(text), { browser: true })));
  setStatus("play-status", text, "err");
}

function startBrowserPlayer() {
  if (browser.started) return;
  browser.started = true;
  if (/Firefox\//.test(navigator.userAgent)) {
    browserProblem("Spotify won't play songs inside Firefox or Zen. Use Chrome or Edge, or pick your Spotify app under Play on.");
    return;
  }
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: "Cleanify",
      getOAuthToken: (cb) => accessToken().then(cb).catch(() => browserProblem("This browser couldn't sign in to play music. Sign out and in again, or pick another device.")),
      volume: 0.8,
    });
    player.addListener("ready", ({ device_id }) => {
      browser.id = device_id;
      browser.player = player;
      browser.problem = "";
      browser.waiters.splice(0).forEach((w) => w.resolve(device_id));
    });
    player.addListener("not_ready", () => { browser.id = null; });
    player.addListener("account_error", () => browserProblem("Playing in this browser needs Spotify Premium."));
    player.addListener("initialization_error", () => browserProblem("This browser can't play Spotify music (protected content is turned off). Turn it on in the browser's settings, or pick another device."));
    player.addListener("authentication_error", () => browserProblem("This browser couldn't sign in to play music. Sign out and in again, or pick another device."));
    player.addListener("autoplay_failed", () => setStatus("play-status", "The browser blocked the sound. Press ▶ to start it.", "err"));
    player.connect().then((ok) => { if (!ok) browserProblem("Spotify's player couldn't start in this browser. Pick another device."); });
  };
  const script = document.createElement("script");
  script.src = "https://sdk.scdn.co/spotify-player.js";
  script.onerror = () => browserProblem("Couldn't load Spotify's player. Check your connection or pick another device.");
  document.head.append(script);
}

// Resolves with the browser player's device id once it's connected.
function browserReady() {
  startBrowserPlayer();
  if (browser.id) return Promise.resolve(browser.id);
  if (browser.problem) return Promise.reject(Object.assign(new Error(browser.problem), { browser: true }));
  return new Promise((resolve, reject) => {
    const w = { resolve, reject };
    browser.waiters.push(w);
    setTimeout(() => {
      const i = browser.waiters.indexOf(w);
      if (i === -1) return;
      browser.waiters.splice(i, 1);
      reject(Object.assign(new Error("This browser's player is still starting. Press ▶ again in a moment."), { browser: true }));
    }, 12000);
  });
}

// --- Duplicates ---
// Version words that don't make it a different song: "Mr. Brightside - Remastered 2019",
// "Toxic (Radio Edit)", "Hey Ya! [Live]", "Song (feat. Someone)".
const VERSION_WORDS = /\b(remaster(ed)?|live|version|edit|mix|remix|mono|stereo|deluxe|radio|explicit|clean|feat|ft|featuring|with|acoustic|demo|anniversary|bonus|single|album|original|extended|from|soundtrack|session|recorded|re-?recorded|taylor'?s|\d{4})\b/;

function plain(text) {
  return (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function songKey(t) {
  let title = plain(t.title)
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (m, inner) => (VERSION_WORDS.test(inner) ? "" : m))
    .replace(/\s+[-–—]\s+(.*)$/, (m, rest) => (VERSION_WORDS.test(rest) ? "" : m))
    .replace(/\s(feat|ft)\.?\s.*$/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const artist = plain(t.artists.split(",")[0]).replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
  return title ? `${title}|${artist}` : "";
}

function copiesOf(t) {
  return state.entries.filter((e) => e.uri === t.uri && !e.gone).length;
}

// Groups of songs still in the playlist that look like the same song: the same track
// added twice, the same recording on another release (same ISRC code), or the same
// title and main artist once version words are taken off.
function findDuplicates() {
  const live = state.tracks.filter((t) => !isGone(t));
  const parent = live.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byKey = new Map();
  live.forEach((t, i) => {
    for (const k of [songKey(t), t.isrc && "isrc:" + t.isrc]) {
      if (!k) continue;
      if (byKey.has(k)) parent[find(i)] = find(byKey.get(k));
      else byKey.set(k, i);
    }
  });
  const groups = new Map();
  live.forEach((t, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1 || copiesOf(g[0]) > 1)
    .map((tracks) => ({ tracks, key: tracks.map((t) => t.uri).sort().join(" ") + ` x${tracks.reduce((n, t) => n + copiesOf(t), 0)}` }));
}

let dupeGroups = [];
function showDupes(groups = findDuplicates()) {
  dupeGroups = groups;
  const box = $("dupe-list");
  box.textContent = "";
  $("dupes-intro").textContent = groups.length
    ? `${groups.length} song${groups.length === 1 ? " is" : "s are"} in ${state.playlist.name} more than once. Ticked ones get removed (they go to the bargain bin, and Undo works).`
    : `No duplicates in ${state.playlist.name}.`;
  for (const g of groups) {
    const wrap = el("div", "dgroup");
    wrap.append(el("h3", "", g.tracks[0].title));
    g.tracks.forEach((t, i) => {
      const row = el("label", "drow");
      const box = el("input");
      box.type = "checkbox";
      box.checked = i > 0;  // keep the first one in the playlist
      box.dataset.uri = t.uri;
      box.dataset.kind = "song";
      const text = el("div", "t");
      const info = [t.artists, t.album, t.year, duration(t.duration)].filter(Boolean).join(" · ");
      text.append(el("b", "", t.title), el("span", "", info));
      row.append(box, thumbEl(t.thumb), text, el("span", "dtag", ""));
      wrap.append(row);
      const copies = copiesOf(t);
      if (copies > 1) {
        const extra = el("label", "drow extra");
        const xbox = el("input");
        xbox.type = "checkbox";
        xbox.checked = true;
        xbox.dataset.uri = t.uri;
        xbox.dataset.kind = "extras";
        extra.append(xbox, el("span", "", `This exact song is in the playlist ${copies} times. Remove the ${copies - 1} extra cop${copies === 2 ? "y" : "ies"}`));
        wrap.append(extra);
      }
    });
    box.append(wrap);
  }
  box.querySelectorAll("input").forEach((i) => i.addEventListener("change", updateDupeButton));
  updateDupeButton();
  setStatus("dupes-status", "");
  showScreen("dupes");
}

function dupePicks() {
  return [...$("dupe-list").querySelectorAll("input:checked")].map((i) => ({ uri: i.dataset.uri, kind: i.dataset.kind }));
}

function updateDupeButton() {
  // A song that's removed takes its extra copies with it, so they aren't counted twice.
  const picks = dupePicks();
  const songs = new Set(picks.filter((p) => p.kind === "song").map((p) => p.uri));
  let n = songs.size;
  for (const p of picks) if (p.kind === "extras" && !songs.has(p.uri)) n += copiesOf(trackByUri(p.uri)) - 1;
  $("dupe-remove").disabled = !n;
  $("dupe-remove").textContent = n ? `Remove ${n} song${n === 1 ? "" : "s"}` : "Nothing ticked";
  $("dupe-list").querySelectorAll(".drow:not(.extra)").forEach((row) => {
    row.querySelector(".dtag").textContent = row.querySelector("input").checked ? "remove" : "keep";
    row.classList.toggle("going", row.querySelector("input").checked);
  });
}

function markDupesSeen() {
  state.mem.dupesSeen = [...new Set([...state.mem.dupesSeen, ...dupeGroups.map((g) => g.key)])].slice(-500);
  saveMemory();
}

async function removeDupes() {
  const picks = dupePicks();
  const songs = new Set(picks.filter((p) => p.kind === "song").map((p) => p.uri));
  $("dupe-remove").disabled = true;
  setStatus("dupes-status", "Removing…");
  const jobs = [];
  for (const uri of songs) {
    const t = trackByUri(uri);
    state.mem.history.push({ uri, dec: "remove" });
    jobs.push(removeTrack(t));
  }
  for (const p of picks) if (p.kind === "extras" && !songs.has(p.uri)) jobs.push(removeExtras(trackByUri(p.uri)));
  markDupesSeen();
  saveMemory();
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    setStatus("dupes-status", `${failed.length} couldn't be removed: ${removeError(failed[0].reason)}`, "err");
    showDupes();
    return;
  }
  showScreen("swipe");
  render();
  setStatus("play-status", "Duplicates removed. Undo puts them back one at a time.", "ok");
}

// Keeps one copy of a song that was added more than once. Spotify removes every copy of a
// song at once, so: remove it, then add one copy back where the first one was.
function removeExtras(t) {
  const extra = [];
  state.entries.forEach((e, i) => { if (e.uri === t.uri && !e.gone && i !== t.entry) extra.push(i); });
  if (!extra.length) return Promise.resolve();
  const step = { uri: t.uri, dec: "extras", entries: extra };
  state.mem.history.push(step);
  extra.forEach((i) => { state.entries[i].gone = true; });
  return enqueue(async () => {
    const pos = currentPosition(t);
    await removeFromPlaylist(state.playlist.id, [t.uri]);
    await addToPlaylist(state.playlist.id, [t.uri], pos);
  }).catch((err) => {
    extra.forEach((i) => { state.entries[i].gone = false; });
    state.mem.history = state.mem.history.filter((h) => h !== step);
    saveMemory();
    throw err;
  });
}

function restoreExtras(step) {
  return enqueue(async () => {
    for (const i of [...step.entries].sort((a, b) => a - b)) {
      if (!state.entries[i] || state.entries[i].uri !== step.uri) continue;
      let pos = 0;
      for (let j = 0; j < i; j++) if (!state.entries[j].gone) pos++;
      await addToPlaylist(state.playlist.id, [step.uri], pos);
      state.entries[i].gone = false;
    }
    saveMemory();
  });
}

async function copyDetails() {
  const device = savedDevice();
  const text = [
    `Cleanify details, ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    `Play on: ${device ? device.name : "(none)"}; ways that worked: ${JSON.stringify(store.get("cl_play_methods", {}))}`,
    `Client ID: …${CLIENT_ID.slice(-4)}; waiting: ${waitText(coolDownLeft())}; 429s in a row: ${store.get(STRIKES_KEY, 0)}`,
    `Card: ${state.current ? `${state.current.title} (${state.current.uri})` : "(none)"}`,
    `Permissions: ${(store.get("cl_token") || {}).scope || "(not recorded)"}`,
    "",
    ...debugLog,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus($("screen-swipe").classList.contains("hidden") ? "playlists-status" : "play-status", "Details copied. Paste them in the chat.", "ok");
  } catch {
    window.prompt("Copy this:", text);
  }
}

// --- Bargain bin ---
function showBin() {
  const n = state.mem.removed.length;
  $("bin-intro").textContent = n
    ? `${n} song${n === 1 ? "" : "s"} removed from ${state.playlist.name}. Changed your mind? Put it back and it returns to where it was.`
    : `Nothing removed from ${state.playlist.name} yet.`;
  const ul = $("bin-list");
  ul.textContent = "";
  for (const r of [...state.mem.removed].reverse()) {
    const li = el("li");
    const text = el("div", "t");
    text.append(el("b", "", r.title), el("span", "", r.artists + (r.year ? ` · ${r.year}` : "")));
    const b = el("button", "btn", "Put back");
    b.addEventListener("click", async () => {
      b.disabled = true;
      setStatus("bin-status", "Putting it back…");
      try {
        await putBack(r.uri);
        if (!state.mem.kept.includes(r.uri)) state.mem.kept.push(r.uri);
        state.mem.history = state.mem.history.filter((h) => h.uri !== r.uri);
        saveMemory();
        setStatus("bin-status", `"${r.title}" is back in the playlist.`, "ok");
        showBin();
      } catch (err) {
        b.disabled = false;
        setStatus("bin-status", `Couldn't put it back: ${err.message}`, "err");
      }
    });
    li.append(thumbEl(r.thumb), text, b);
    ul.append(li);
  }
  $("bin-continue").textContent = undecided().length ? "Keep swiping" : "Done";
  showScreen("bin");
}

function leaveBin() {
  setStatus("bin-status", "");
  if (undecided().length) {
    showScreen("swipe");
    render();
  } else {
    showDone();
  }
}

function showDone() {
  const kept = state.mem.kept.length;
  const removed = state.mem.removed.length;
  const now = state.entries.filter((e) => !e.gone).length;
  $("done-text").textContent = `You kept ${kept} and removed ${removed} song${removed === 1 ? "" : "s"}. ${state.playlist.name} now has ${now} song${now === 1 ? "" : "s"}.`;
  showScreen("done");
}

function restartPlaylist() {
  state.mem.kept = [];
  state.mem.history = state.mem.history.filter((h) => h.dec === "remove");
  saveMemory();
  showScreen("swipe");
  render();
}

// ---------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------
function wire() {
  store.remove("cl_wait_until");  // from before the wait was kept per Client ID
  store.remove("cl_429s");
  $("login-btn").addEventListener("click", startLogin);
  $("own-save").addEventListener("click", onOwnAppSave);
  $("own-id").addEventListener("keydown", (e) => { if (e.key === "Enter") onOwnAppSave(); });
  $("logout-link").addEventListener("click", (e) => { e.preventDefault(); logout(); });
  $("refresh-btn").addEventListener("click", () => showPlaylists(true));
  $("back-link").addEventListener("click", (e) => { e.preventDefault(); showPlaylists(); });
  $("bin-btn").addEventListener("click", () => decide("remove"));
  $("keep-btn").addEventListener("click", () => decide("keep"));
  $("play-btn").addEventListener("click", playCurrent);
  $("copy-details").addEventListener("click", copyDetails);
  $("copy-details-list").addEventListener("click", copyDetails);
  $("device-select").addEventListener("change", onPickDevice);
  $("device-refresh").addEventListener("click", loadDevices);
  $("undo-btn").addEventListener("click", undo);
  $("tally-bin").addEventListener("click", (e) => { e.preventDefault(); showBin(); });
  $("bin-back").addEventListener("click", (e) => { e.preventDefault(); leaveBin(); });
  $("bin-continue").addEventListener("click", leaveBin);
  $("done-bin").addEventListener("click", showBin);
  $("again-btn").addEventListener("click", showPlaylists);
  $("restart-btn").addEventListener("click", restartPlaylist);
  $("dupes-link").addEventListener("click", () => showDupes());
  $("dupe-remove").addEventListener("click", removeDupes);
  $("dupe-skip").addEventListener("click", () => { markDupesSeen(); showScreen("swipe"); render(); });

  $("autoplay").checked = store.get("cl_autoplay", false);
  $("autoplay").addEventListener("change", () => {
    store.set("cl_autoplay", autoplay());
    if (autoplay()) playCurrent();
  });
  $("backup").checked = store.get("cl_backup", true);
  $("backup").addEventListener("change", () => store.set("cl_backup", $("backup").checked));

  document.addEventListener("keydown", (e) => {
    if ($("screen-swipe").classList.contains("hidden") || e.target.closest("input:not([type=checkbox]), select")) return;
    if (e.key === " " && e.target.closest("button")) return;  // the button handles it
    if (e.key === "ArrowRight") decide("keep");
    else if (e.key === "ArrowLeft") decide("remove");
    else if (e.key === " ") { e.preventDefault(); playCurrent(); }
    else if (e.key === "Backspace" || (e.key === "z" && (e.ctrlKey || e.metaKey))) undo();
  });
}

async function main() {
  wire();
  renderOwnApp();
  try {
    await handleRedirect();
  } catch (err) {
    showScreen("login");
    setStatus("login-status", err.message, "err");
    return;
  }
  if (!CLIENT_ID || !store.get("cl_token")) return showScreen("login");
  try {
    state.me = store.get("cl_me") || await api("/me");
    store.set("cl_me", state.me);
    $("user-name").textContent = state.me.display_name || state.me.id;
    await showPlaylists();
  } catch (err) {
    showScreen("login");
    setStatus("login-status", err.status === 403
      ? "Spotify didn't let you in. If this isn't your Spotify app, ask its owner to add your email under User Management."
      : err.message, "err");
  }
}

main();
