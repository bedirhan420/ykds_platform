"use strict";
/* Ortak yardımcılar: Upstash Redis (REST), oturum, parola, istek doğrulama.
   Harici paket gerekmez; Node 18+ içindeki fetch ve crypto yeterlidir. */
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = "ykds:";
const COOKIE = "ykds_s";
const SESSION_DAYS = 30;
const MAX_USERS = Math.max(1, parseInt(process.env.MAX_USERS, 10) || 2);
const REGISTER_CODE = process.env.REGISTER_CODE || "";

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

async function redisFetch(path, body) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new HttpError(500, "Veritabanı bağlı değil. Vercel > Storage bölümünden bir Upstash Redis veritabanı bağla ve yeniden deploy et.");
  }
  const r = await fetch(REDIS_URL + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, "Veritabanı hatası: " + (j.error || r.status));
  return j;
}
async function cmd(...args) {
  const j = await redisFetch("", args);
  if (j.error) throw new HttpError(502, "Veritabanı hatası: " + j.error);
  return j.result;
}
async function pipe(list) {
  const j = await redisFetch("/pipeline", list);
  return j.map(x => { if (x.error) throw new HttpError(502, "Veritabanı hatası: " + x.error); return x.result; });
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k)));
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("hex"), hash: (await scrypt(pw, salt)).toString("hex") };
}
async function checkPw(pw, rec) {
  // Kullanıcı yoksa da aynı işi yap (süre farkından kullanıcı adı sızmasın)
  const salt = Buffer.from(rec ? rec.salt : "00".repeat(16), "hex");
  const k = (await scrypt(pw, salt)).toString("hex");
  return !!rec && safeEq(k, rec.hash);
}

/* ---- İstek ---- */
function ip(req) {
  return String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "?").split(",")[0].trim();
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}
function body(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === "object" ? b : {};
}
/* Çapraz site istek sahteciliğine karşı: değiştiren isteklerde JSON içerik türü şart */
function requireJson(req) {
  if (!/application\/json/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "Geçersiz istek.");
}

/* ---- Oturum ---- */
async function newSession(res, name) {
  const token = crypto.randomBytes(32).toString("hex"), h = sha(token);
  await pipe([
    ["SET", P + "sess:" + h, name, "EX", String(SESSION_DAYS * 86400)],
    ["SADD", P + "usess:" + name, h],
  ]);
  setCookie(res, token, SESSION_DAYS * 86400);
  return h;
}
async function currentSession(req) {
  const t = cookies(req)[COOKIE];
  if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const h = sha(t), name = await cmd("GET", P + "sess:" + h);
  return name ? { name, h } : null;
}
async function revokeSessions(name, exceptHash) {
  const all = (await cmd("SMEMBERS", P + "usess:" + name)) || [];
  const del = all.filter(h => h !== exceptHash);
  if (del.length) await pipe(del.map(h => ["DEL", P + "sess:" + h]).concat([["SREM", P + "usess:" + name, ...del]]));
}

/* ---- Hız sınırı (yalnızca başarısız denemeler, IP başına) ---- */
const RL_MAX = 8, RL_WINDOW = 900;
async function rlCheck(req) {
  const n = parseInt(await cmd("GET", P + "rl:" + ip(req)), 10) || 0;
  if (n >= RL_MAX) throw new HttpError(429, "Çok fazla başarısız deneme. 15 dakika sonra tekrar dene.");
}
async function rlFail(req) {
  const k = P + "rl:" + ip(req);
  await pipe([["INCR", k], ["EXPIRE", k, String(RL_WINDOW)]]);
}

async function info(user) {
  const count = await cmd("SCARD", P + "users");
  return { user: user || null, count, max: MAX_USERS, open: count < MAX_USERS, needCode: !!REGISTER_CODE };
}

/* ---- Sarmalayıcı ---- */
function handler(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json(Object.assign({ error: e.message }, e.extra || {}));
      console.error(e);
      res.status(500).json({ error: "Sunucu hatası." });
    }
  };
}

module.exports = {
  P, MAX_USERS, REGISTER_CODE, HttpError, cmd, pipe, hashPw, checkPw, safeEq,
  body, requireJson, newSession, currentSession, revokeSessions, setCookie,
  rlCheck, rlFail, info, handler,
};
