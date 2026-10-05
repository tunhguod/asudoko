"use strict";
const API_BASE = "https://slot-plan-api.asudoko.workers.dev";
const MAPTILER_KEY = "ozpQrTMkzk3Yc8j2TcEf"; // MapTiler管理画面で使えるドメインを制限しておくこと
const TURNSTILE_SITE_KEY = ""; // Cloudflare Turnstile のサイトキー（空なら無効。Worker側の TURNSTILE_SECRET とセットで設定）

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
// https のURLだけリンクにする（javascript: などを防ぐ）
const safeUrl = u => /^https:\/\//i.test(String(u || "")) ? u : "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const WD = ["日", "月", "火", "水", "木", "金", "土"];
// 日本時間の YYYY-MM-DD（toISOString は UTC なので 0〜9時に前日になるのを防ぐ）
const jstDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400e3).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s));
const PREF_SLUG = { hokkaido: "北海道", aomori: "青森県", iwate: "岩手県", miyagi: "宮城県", akita: "秋田県", yamagata: "山形県", fukushima: "福島県", ibaraki: "茨城県", tochigi: "栃木県", gunma: "群馬県", saitama: "埼玉県", chiba: "千葉県", tokyo: "東京都", kanagawa: "神奈川県", niigata: "新潟県", toyama: "富山県", ishikawa: "石川県", fukui: "福井県", yamanashi: "山梨県", nagano: "長野県", gifu: "岐阜県", shizuoka: "静岡県", aichi: "愛知県", mie: "三重県", shiga: "滋賀県", kyoto: "京都府", osaka: "大阪府", hyogo: "兵庫県", nara: "奈良県", wakayama: "和歌山県", tottori: "鳥取県", shimane: "島根県", okayama: "岡山県", hiroshima: "広島県", yamaguchi: "山口県", tokushima: "徳島県", kagawa: "香川県", ehime: "愛媛県", kochi: "高知県", fukuoka: "福岡県", saga: "佐賀県", nagasaki: "長崎県", kumamoto: "熊本県", oita: "大分県", miyazaki: "宮崎県", kagoshima: "鹿児島県", okinawa: "沖縄県" };
// 住所の先頭 → だめなら店舗URL（/shops/tokyo/...）から都道府県を判定（住所が空のホールが約1500件あるため）
const prefOf = (addr, url) => (String(addr || "").match(/^(.{2,3}?[都道府県])/) || [])[1]
  || PREF_SLUG[(String(url || "").match(/\/shops\/([a-z]+)\//) || [])[1]] || "その他";
const addrOf = h => h.address || prefOf("", h.url);
function labelOf(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  const base = `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
  const rel = { [jstDate(0)]: "今日", [jstDate(1)]: "明日", [jstDate(-1)]: "昨日" }[ymd];
  return rel ? `${rel} ${base}` : base;
}
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), 2800);
}
async function api(path, opt = {}) {
  let r;
  try { r = await fetch(API_BASE + path, opt); }
  catch { throw new Error("通信できませんでした。電波状況を確認してください。"); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `エラーが発生しました（${r.status}）`);
  return body;
}

/* ---------- state ---------- */
const params = new URLSearchParams(location.search);
const state = {
  // 昼までは「今日」、それ以降は「明日」を最初に表示
  date: isYmd(params.get("date")) ? params.get("date") : (Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false })) < 12 ? jstDate(0) : jstDate(1)),
  pref: params.get("pref") || "",
  plans: [],
  myKeys: store.get("asudoko.keys", {}), // { planId: deleteKey }
};
let loadSeq = 0;

/* ---------- map ---------- */
const map = L.map("map", { zoomControl: true }).setView([36.2, 138.25], 5);
L.tileLayer(`https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
  tileSize: 512, zoomOffset: -1, maxZoom: 19,
  attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const markersByHall = new Map();
let meMarker = null;

function pinIcon(n) {
  return L.divIcon({ className: "", html: `<div class="pin${n >= 5 ? " many" : ""}"><span>${n}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32] });
}

/* ---------- render ---------- */
function groupByHall(plans) {
  const m = new Map();
  for (const p of plans) {
    if (!m.has(p.hall_id)) m.set(p.hall_id, { hall_id: p.hall_id, hall: p.hall, address: p.address, lat: p.lat, lng: p.lng, url: p.url, pref: prefOf(p.address, p.url), people: [] });
    m.get(p.hall_id).people.push(p);
  }
  return [...m.values()].sort((a, b) => b.people.length - a.people.length || a.hall.localeCompare(b.hall, "ja"));
}

function renderPrefOptions() {
  const counts = {};
  for (const p of state.plans) { const k = prefOf(p.address, p.url); counts[k] = (counts[k] || 0) + 1; }
  const sel = $("#pref");
  const prefs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (state.pref && !counts[state.pref]) prefs.push(state.pref);
  sel.innerHTML = `<option value="">全国（${state.plans.length}）</option>` +
    prefs.map(p => `<option value="${esc(p)}">${esc(p)}（${counts[p] || 0}）</option>`).join("");
  sel.value = state.pref;
}

// own: このブラウザで投稿 / pin: 削除キーで削除可（v2時代のキーなし予定は削除不可）
const deleteMode = p => state.myKeys[p.id] ? "own" : p.has_pin ? "pin" : "";
function personHtml(p) {
  const mine = state.myKeys[p.id];
  return `<li class="person">
    <span class="who">${esc(p.nickname || "匿名")}</span>${mine ? `<span class="mine">あなた</span>` : ""}
    ${p.machine ? `<span class="machine">${esc(p.machine)}</span>` : ""}
    ${p.comment ? `<div class="comment">${esc(p.comment)}</div>` : ""}
    ${deleteMode(p) ? `<button type="button" class="delete" data-id="${p.id}" data-mode="${deleteMode(p)}">削除</button>` : ""}
  </li>`;
}

function render() {
  const groups = groupByHall(state.plans).filter(g => !state.pref || g.pref === state.pref);
  const people = groups.reduce((n, g) => n + g.people.length, 0);

  $("#date-text").textContent = labelOf(state.date);
  $("#date").value = state.date;
  $("#today").classList.toggle("active", state.date === jstDate(0));
  $("#tomorrow").classList.toggle("active", state.date === jstDate(1));
  $("#list-title").textContent = `${labelOf(state.date)} の予定${state.pref ? `（${state.pref}）` : ""}`;
  $("#count").textContent = `${groups.length}ホール / ${people}人`;
  renderPrefOptions();

  markerLayer.clearLayers(); markersByHall.clear();
  for (const g of groups) {
    const m = L.marker([g.lat, g.lng], { icon: pinIcon(g.people.length), title: g.hall }).addTo(markerLayer);
    m.bindPopup(`<div class="popup"><div class="name">${esc(g.hall)}</div>
      <ul>${g.people.map(p => `<li>${esc(p.nickname || "匿名")}${p.machine ? `：${esc(p.machine)}` : ""}</li>`).join("")}</ul>
      ${safeUrl(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">店舗ページ</a>` : ""}</div>`);
    m.on("click", () => highlightCard(g.hall_id));
    markersByHall.set(g.hall_id, m);
  }

  $("#plans").innerHTML = groups.length ? groups.map(g => `
    <article class="hall-card" data-hall="${g.hall_id}" tabindex="0">
      <div class="head"><div><div class="name">${esc(g.hall)}</div><div class="addr">${esc(addrOf(g))}</div></div>
        <span class="badge">${g.people.length}人</span></div>
      <ul class="people">${g.people.map(personHtml).join("")}</ul>
      <div class="links">${safeUrl(g.url) ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">店舗ページ ↗</a>` : ""}</div>
    </article>`).join("")
    : `<div class="empty">${state.pref ? `${esc(state.pref)}の` : "この日の"}予定はまだありません。<br>右上の「＋ 予定を追加」から登録できます。</div>`;

  if (groups.length) map.fitBounds(L.latLngBounds(groups.map(g => [g.lat, g.lng])), { padding: [40, 40], maxZoom: 14 });
}

function highlightCard(hallId) {
  document.querySelectorAll(".hall-card.focus").forEach(e => e.classList.remove("focus"));
  const el = document.querySelector(`.hall-card[data-hall="${hallId}"]`);
  if (el) { el.classList.add("focus"); el.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
}

function syncUrl() {
  const q = new URLSearchParams();
  q.set("date", state.date);
  if (state.pref) q.set("pref", state.pref);
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

async function load() {
  const seq = ++loadSeq;
  syncUrl();
  $("#date-text").textContent = labelOf(state.date);
  $("#plans").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const plans = await api(`/api/plans?date=${state.date}`);
    if (seq !== loadSeq) return; // 古いリクエストの結果は捨てる
    state.plans = plans;
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    $("#plans").innerHTML = `<div class="empty">読み込みに失敗しました。<br><button type="button" id="retry">再読み込み</button></div>`;
    $("#retry").onclick = load;
    toast(e.message, true);
  }
}
const setDate = d => { if (isYmd(d)) { state.date = d; load(); } };

/* ---------- toolbar ---------- */
$("#prev").onclick = () => setDate(addDays(state.date, -1));
$("#next").onclick = () => setDate(addDays(state.date, 1));
$("#today").onclick = () => setDate(jstDate(0));
$("#tomorrow").onclick = () => setDate(jstDate(1));
$("#date").onchange = e => setDate(e.target.value);
$("#pref").onchange = e => { state.pref = e.target.value; syncUrl(); render(); };
$("#share").onclick = async () => {
  const text = `${labelOf(state.date)}の打ち予定${state.pref ? `（${state.pref}）` : ""} | Asudoko`;
  try {
    if (navigator.share) await navigator.share({ title: "Asudoko", text, url: location.href });
    else { await navigator.clipboard.writeText(location.href); toast("URLをコピーしました"); }
  } catch (e) { if (e.name !== "AbortError") toast("共有できませんでした", true); }
};

$("#plans").addEventListener("click", async e => {
  const del = e.target.closest(".delete");
  if (del) {
    e.stopPropagation();
    const id = del.dataset.id;
    if (del.dataset.mode === "pin") { openDeleteDialog(state.plans.find(p => String(p.id) === id)); return; }
    if (!confirm("この予定を削除しますか？")) return;
    del.disabled = true;
    try { await deletePlan(id); }
    catch (err) { del.disabled = false; toast(err.message, true); }
    return;
  }
  if (e.target.closest("a")) return;
  const card = e.target.closest(".hall-card");
  if (card) focusHall(Number(card.dataset.hall));
});
$("#plans").addEventListener("keydown", e => {
  const card = e.target.closest?.(".hall-card");
  if (card && e.key === "Enter") focusHall(Number(card.dataset.hall));
});
async function deletePlan(id, pin) {
  await api(`/api/plans/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-Delete-Key": state.myKeys[id] || "" },
    body: JSON.stringify({ pin: pin || "" }),
  });
  delete state.myKeys[id]; store.set("asudoko.keys", state.myKeys);
  toast("削除しました"); load();
}

/* ---------- 削除キーで削除 ---------- */
const delDialog = $("#del-dialog");
let delTarget = null;
function openDeleteDialog(p) {
  if (!p) return;
  delTarget = p;
  $("#del-form").reset();
  $("#del-error").hidden = true;
  $("#del-target").textContent = `${p.hall} / ${p.nickname || "匿名"}${p.machine ? ` / ${p.machine}` : ""}`;
  delDialog.showModal();
  $("#del-pin").focus();
}
$("#del-cancel").onclick = () => delDialog.close();
delDialog.addEventListener("click", e => { if (e.target === delDialog) delDialog.close(); });
$("#del-form").onsubmit = async e => {
  e.preventDefault();
  const pin = $("#del-pin").value;
  if (!pin) { $("#del-pin").focus(); return; }
  const btn = $("#del-submit"); btn.disabled = true;
  try { await deletePlan(delTarget.id, pin); delDialog.close(); }
  catch (err) { $("#del-error").textContent = err.message; $("#del-error").hidden = false; $("#del-pin").select(); }
  finally { btn.disabled = false; }
};

function focusHall(id) {
  const m = markersByHall.get(id);
  if (!m) return;
  highlightCard(id);
  map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 15), { duration: .6 });
  setTimeout(() => m.openPopup(), 650);
  if (matchMedia("(max-width:800px)").matches) $("#map").scrollIntoView({ behavior: "smooth" });
}

/* ---------- dialog ---------- */
const dialog = $("#dialog");
const form = $("#plan-form");
const searchEl = $("#hall-search"), resultsEl = $("#hall-results"), selectedEl = $("#selected-hall");
let selectedHall = null, searchTimer, searchAbort, results = [], activeIdx = -1;

function openDialog() {
  form.reset();
  $("#plan-date").value = state.date;
  $("#nickname").value = store.get("asudoko.nickname", "");
  $("#delete-pin").value = store.get("asudoko.pin", "");
  $("#comment-count").textContent = "0";
  clearSelection();
  dialog.showModal();
  initTurnstile();
  searchEl.focus();
}
function clearSelection() {
  selectedHall = null; selectedEl.hidden = true; selectedEl.innerHTML = "";
  searchEl.hidden = false; resultsEl.innerHTML = ""; results = []; activeIdx = -1;
}
function selectHall(h) {
  selectedHall = h;
  searchEl.hidden = true; resultsEl.innerHTML = "";
  selectedEl.hidden = false;
  selectedEl.innerHTML = `<div><strong>${esc(h.name)}</strong><br><small>${esc(addrOf(h))}</small></div><button type="button" id="change-hall">変更</button>`;
  $("#change-hall").onclick = () => { clearSelection(); searchEl.value = ""; searchEl.focus(); };
}
function showResults(list, note) {
  results = list; activeIdx = -1;
  resultsEl.innerHTML = list.length
    ? list.map((h, i) => `<button type="button" class="hall-result" role="option" data-i="${i}"><strong>${esc(h.name)}</strong><small>${esc(addrOf(h))}${h.distance_km != null ? ` ・約${h.distance_km}km` : ""}</small></button>`).join("")
    : `<div class="hall-results-note">${esc(note || "見つかりませんでした")}</div>`;
}
resultsEl.addEventListener("click", e => {
  const b = e.target.closest(".hall-result");
  if (b) selectHall(results[Number(b.dataset.i)]);
});
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  if (q.length < 2) { resultsEl.innerHTML = ""; results = []; return; }
  searchTimer = setTimeout(async () => {
    searchAbort?.abort(); searchAbort = new AbortController();
    try { showResults(await api(`/api/halls?q=${encodeURIComponent(q)}`, { signal: searchAbort.signal }), "該当するホールがありません"); }
    catch (e) { if (e.name !== "AbortError") showResults([], e.message); }
  }, 250);
});
searchEl.addEventListener("keydown", e => {
  const items = resultsEl.querySelectorAll(".hall-result");
  if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((el, i) => el.setAttribute("aria-selected", i === activeIdx));
    items[activeIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectHall(results[Math.max(activeIdx, 0)]);
  }
});
$("#near").onclick = () => {
  if (!navigator.geolocation) return toast("この端末では現在地を取得できません", true);
  showResults([], "現在地を取得中…");
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [14, 14] }) }).addTo(map);
    try {
      clearSelection(); searchEl.value = "";
      showResults(await api(`/api/halls/near?lat=${lat}&lng=${lng}`), "近くにホールが見つかりませんでした");
    } catch (e) { showResults([], e.message); }
  }, () => showResults([], "現在地を取得できませんでした（位置情報の許可を確認してください）"), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
};
$("#comment").addEventListener("input", e => ($("#comment-count").textContent = e.target.value.length));
$("#add").onclick = openDialog;
$("#cancel").onclick = () => dialog.close();
dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });

form.onsubmit = async e => {
  e.preventDefault();
  if (!selectedHall) { toast("ホールを検索して選択してください", true); searchEl.focus(); return; }
  const date = $("#plan-date").value;
  if (!isYmd(date)) { toast("日付を選んでください", true); return; }
  const nickname = $("#nickname").value.trim();
  const pin = $("#delete-pin").value;
  if (pin.length < 4) { toast("削除キー（4文字以上）を入力してください", true); $("#delete-pin").focus(); return; }
  const btn = $("#submit");
  btn.disabled = true; btn.textContent = "追加中…";
  try {
    const r = await api("/api/plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, hall_url: selectedHall.url, turnstile: turnstileToken(), nickname, machine: $("#machine").value.trim(), comment: $("#comment").value.trim(), delete_pin: pin }),
    });
    state.myKeys[r.id] = r.delete_key; store.set("asudoko.keys", state.myKeys);
    store.set("asudoko.nickname", nickname);
    store.set("asudoko.pin", pin);
    dialog.close();
    toast(`${selectedHall.name} を追加しました`);
    state.date = date; await load();
    const posted = state.plans.find(p => p.url === selectedHall.url);
    if (posted) focusHall(posted.hall_id);
  } catch (err) {
    toast(err.message, true);
  } finally {
    resetTurnstile();
    btn.disabled = false; btn.textContent = "追加する";
  }
};

/* ---------- Turnstile（ボット対策。サイトキー設定時のみ） ---------- */
let tsWidget = null, tsLoading = null;
function initTurnstile() {
  if (!TURNSTILE_SITE_KEY) return;
  const box = $("#turnstile"); box.hidden = false;
  tsLoading ??= new Promise((ok, ng) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true; s.onload = ok; s.onerror = ng;
    document.head.appendChild(s);
  });
  tsLoading.then(() => {
    if (tsWidget === null) tsWidget = turnstile.render(box, { sitekey: TURNSTILE_SITE_KEY, language: "ja", size: "flexible" });
    else turnstile.reset(tsWidget);
  }).catch(() => toast("ボット対策の読み込みに失敗しました", true));
}
const turnstileToken = () => (TURNSTILE_SITE_KEY && tsWidget !== null && window.turnstile) ? turnstile.getResponse(tsWidget) || "" : "";
const resetTurnstile = () => { if (TURNSTILE_SITE_KEY && tsWidget !== null && window.turnstile) turnstile.reset(tsWidget); };

load();
