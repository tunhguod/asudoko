// Asudoko API (Cloudflare Workers + D1)
import HALLS_RAW from "./halls.json"; // [name, address, lat, lng, url][]  tools/build_halls_json.py で生成

const LIMITS = { nickname: 30, comment: 100, machine: 40 };
const PIN_MIN = 4, PIN_MAX = 32;
const MAX_FAIL = 5, LOCK_MINUTES = 30;   // 削除キーを5回間違えると30分ロック
const MAX_BODY = 4096;                   // リクエスト本文の上限（バイト）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREF_SLUGS = ["hokkaido","aomori","iwate","miyagi","akita","yamagata","fukushima","ibaraki","tochigi","gunma","saitama","chiba","tokyo","kanagawa","niigata","toyama","ishikawa","fukui","yamanashi","nagano","gifu","shizuoka","aichi","mie","shiga","kyoto","osaka","hyogo","nara","wakayama","tottori","shimane","okayama","hiroshima","yamaguchi","tokushima","kagawa","ehime","kochi","fukuoka","saga","nagasaki","kumamoto","oita","miyazaki","kagoshima","okinawa"];
const PREF_NAMES = "北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 岐阜 静岡 愛知 三重 滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄".split(" ");

/* ---------- ホール検索（メモリ上。D1を読まない） ---------- */
// 全角/半角・大文字/小文字・ひらがな/カタカナの違いを吸収
const norm = s => String(s || "").normalize("NFKC").toLowerCase()
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, "");
const HALLS = HALLS_RAW.map(([name, address, latitude, longitude, url]) => {
  const slug = (url.match(/\/shops\/([a-z]+)\//) || [])[1];
  const pref = PREF_NAMES[PREF_SLUGS.indexOf(slug)] || "";
  return { name, address, latitude, longitude, url, key: norm(name + address + pref) };
});

/* ---------- 共通 ---------- */
function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const allow = !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type,X-Delete-Key",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
const fail = (status, error) => json({ error }, status);

function isValidDate(s) {
  if (!DATE_RE.test(s || "")) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysFromTodayJST = s => (Date.parse(s) - Date.parse(todayJST())) / 86400e3;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").trim().slice(0, max);
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const clientIp = req => req.headers.get("CF-Connecting-IP") || "unknown";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// "salt$hash" 形式で保存。PIN_PEPPER（シークレット）を混ぜるので、DBだけ漏れても総当たりできない
async function hashSecret(env, secret) {
  const salt = randomKey().slice(0, 16);
  return `${salt}$${await sha256(`${env.PIN_PEPPER || ""}:${salt}:${secret}`)}`;
}
async function checkSecret(env, stored, secret) {
  if (!stored || !secret) return false;
  if (!stored.includes("$")) return false;
  const [salt, hash] = stored.split("$");
  const calc = await sha256(`${env.PIN_PEPPER || ""}:${salt}:${secret}`);
  // 比較時間を一定に
  let diff = calc.length ^ hash.length;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  return diff === 0;
}

async function rateLimit(env, binding, req, kind) {
  const rl = env[binding];
  if (!rl) return true; // バインディング未設定（ローカル開発など）は制限なし
  const { success } = await rl.limit({ key: `${kind}:${clientIp(req)}` });
  return success;
}

async function readJson(req) {
  if (!(req.headers.get("Content-Type") || "").includes("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function verifyTurnstile(env, token, req) {
  if (!env.TURNSTILE_SECRET) return true; // 未設定なら無効
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(token).slice(0, 2048));
  form.append("remoteip", clientIp(req));
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await r.json().catch(() => ({}));
  return data.success === true;
}

/* ---------- handlers ---------- */
function searchHalls(u) {
  const words = (u.searchParams.get("q") || "").slice(0, 50).split(/[\s　]+/).map(norm).filter(Boolean).slice(0, 4);
  if (words.join("").length < 2) return json([]);
  const first = words[0];
  const hits = [];
  for (const h of HALLS) if (words.every(w => h.key.includes(w))) hits.push(h);
  hits.sort((a, b) => (norm(b.name).startsWith(first) - norm(a.name).startsWith(first)) || a.name.length - b.name.length);
  return json(hits.slice(0, 20).map(({ key, ...h }) => h), 200, { "Cache-Control": "public, max-age=300" });
}

function nearHalls(u) {
  const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail(400, "lat/lng が不正です");
  const k = Math.cos(lat * Math.PI / 180);
  const list = [];
  for (const h of HALLS) {
    const d = Math.hypot(h.latitude - lat, (h.longitude - lng) * k) * 111;
    if (d <= 10) list.push([d, h]);
  }
  list.sort((a, b) => a[0] - b[0]);
  return json(list.slice(0, 20).map(([d, { key, ...h }]) => ({ ...h, distance_km: Math.round(d * 10) / 10 })));
}

async function listPlans(env, u) {
  const date = u.searchParams.get("date");
  if (!isValidDate(date)) return fail(400, "date は YYYY-MM-DD 形式で指定してください");
  const r = await env.DB.prepare(
    `SELECT p.id,p.play_date AS date,h.id AS hall_id,h.name AS hall,h.address,h.latitude AS lat,h.longitude AS lng,h.url,
            p.nickname,p.comment,p.machine,p.created_at,
            (p.delete_pin IS NOT NULL) AS has_pin
     FROM plans p JOIN halls h ON h.id=p.hall_id WHERE p.play_date=? ORDER BY h.name,p.id LIMIT 500`
  ).bind(date).all();
  return json(r.results, 200, { "Cache-Control": "no-store" });
}

async function createPlan(env, req) {
  const b = await readJson(req);
  if (!b) return fail(400, "リクエストが不正です");
  if (!(await verifyTurnstile(env, b.turnstile, req))) return fail(403, "ボット判定に失敗しました。ページを再読み込みしてやり直してください");
  if (!isValidDate(b.date)) return fail(400, "日付が不正です");
  const diff = daysFromTodayJST(b.date);
  if (diff < 0 || diff > 30) return fail(400, "登録できるのは今日〜30日後までです");
  const url = String(b.hall_url || "");
  if (!HALLS.some(h => h.url === url)) return fail(400, "選択したホールがホールマスタにありません。ホールを選び直してください");
  const hall = await env.DB.prepare("SELECT id FROM halls WHERE url=?").bind(url).first();
  if (!hall) return fail(404, "ホールが見つかりません（ホールマスタが未投入の可能性があります）");
  const pin = String(b.delete_pin ?? "");
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return fail(400, `削除キー（${PIN_MIN}〜${PIN_MAX}文字）を入力してください`);
  const nickname = clean(b.nickname, LIMITS.nickname);
  const comment = clean(b.comment, LIMITS.comment);
  const machine = clean(b.machine, LIMITS.machine);
  // 同じ日・同じホール・同じ名前・同じ内容の連投を防ぐ
  const dup = await env.DB.prepare(
    "SELECT 1 FROM plans WHERE play_date=? AND hall_id=? AND nickname=? AND IFNULL(machine,'')=? AND IFNULL(comment,'')=? LIMIT 1"
  ).bind(b.date, hall.id, nickname, machine, comment).first();
  if (dup) return fail(409, "同じ内容の予定がすでに登録されています");
  const key = randomKey();
  const r = await env.DB.prepare(
    "INSERT INTO plans(play_date,hall_id,nickname,comment,machine,delete_key,delete_pin,created_at) VALUES(?,?,?,?,?,?,?,datetime('now'))"
  ).bind(b.date, hall.id, nickname, comment, machine, await hashSecret(env, key), await hashSecret(env, pin)).run();
  return json({ ok: true, id: r.meta.last_row_id, delete_key: key }, 201);
}

async function deletePlan(env, req, id) {
  if (!/^\d{1,12}$/.test(id)) return fail(400, "IDが不正です");
  const row = await env.DB.prepare(
    "SELECT delete_key,delete_pin,delete_fail,delete_lock_until, (delete_lock_until > datetime('now')) AS locked FROM plans WHERE id=?"
  ).bind(id).first();
  if (!row) return fail(404, "予定が見つかりません");
  if (!row.delete_key && !row.delete_pin) return fail(403, "この予定は削除キーがないため削除できません");
  // ① 投稿したブラウザの自動キー（ヘッダ）なら即削除
  if (!(await checkSecret(env, row.delete_key, req.headers.get("X-Delete-Key")))) {
    // ② ユーザーが決めた削除キー（本文）
    if (row.locked) return fail(429, "削除キーの入力ミスが続いたため、しばらく削除できません。30分ほど待ってからお試しください");
    const b = (await readJson(req)) || {};
    if (!(await checkSecret(env, row.delete_pin, String(b.pin ?? "")))) {
      const fails = (row.delete_fail || 0) + 1;
      if (fails >= MAX_FAIL) {
        await env.DB.prepare(`UPDATE plans SET delete_fail=0, delete_lock_until=datetime('now','+${LOCK_MINUTES} minutes') WHERE id=?`).bind(id).run();
        return fail(403, `削除キーが違います。${LOCK_MINUTES}分間ロックされました`);
      }
      await env.DB.prepare("UPDATE plans SET delete_fail=? WHERE id=?").bind(fails, id).run();
      return fail(403, `削除キーが違います（あと${MAX_FAIL - fails}回でロック）`);
    }
  }
  await env.DB.prepare("DELETE FROM plans WHERE id=?").bind(id).run();
  return json({ ok: true });
}

async function cleanup(env) {
  const days = Math.max(1, Number(env.RETENTION_DAYS) || 3);
  await env.DB.prepare("DELETE FROM plans WHERE play_date < date('now','+9 hours',?)").bind(`-${days} days`).run();
}

export default {
  async fetch(req, env) {
    // CORSヘッダはリクエストごとに付ける（同じisolateで同時に処理されるリクエストと混ざらないように）
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
    const res = await route(req, env);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

async function route(req, env) {
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, "");
    try {
      const isWrite = req.method === "POST" || req.method === "DELETE";
      // 書き込みは許可したオリジンのブラウザからのみ（ALLOWED_ORIGINS 設定時）
      const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (isWrite && allowed.length && !allowed.includes(req.headers.get("Origin") || "")) return fail(403, "許可されていないオリジンです");
      if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) return fail(413, "リクエストが大きすぎます");
      if (!(await rateLimit(env, isWrite ? "RL_WRITE" : "RL_READ", req, isWrite ? "w" : "r")))
        return fail(429, "アクセスが集中しています。少し時間をおいてからお試しください");

      if (p === "/api/halls" && req.method === "GET") return searchHalls(u);
      if (p === "/api/halls/near" && req.method === "GET") return nearHalls(u);
      if (p === "/api/plans" && req.method === "GET") return await listPlans(env, u);
      if (p === "/api/plans" && req.method === "POST") return await createPlan(env, req);
      const m = p.match(/^\/api\/plans\/([^/]+)$/);
      if (m && req.method === "DELETE") return await deletePlan(env, req, m[1]);
      return fail(404, "not found");
    } catch (e) {
      console.error(e);
      return fail(500, "サーバーエラーが発生しました");
    }
}
