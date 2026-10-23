"use strict";
const L = require("./_lib");
const { P, HttpError, cmd, pipe } = L;

const MAX_BYTES = 900000; // Upstash ücretsiz katmanında istek sınırı 1 MB

/* Atomik karşılaştır-ve-yaz: istemcinin bildiği sürüm (rev) sunucudakiyle aynıysa yazar. */
const WRITE = `
local rev = tonumber(redis.call('GET', KEYS[2]) or '0')
if rev ~= tonumber(ARGV[1]) then return {0, rev} end
rev = rev + 1
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], tostring(rev))
return {1, rev}`;

function valid(d) {
  return d && typeof d === "object" && !Array.isArray(d) && d.v === 1 &&
    d.q && typeof d.q === "object" && Array.isArray(d.sess) && d.pref && typeof d.pref === "object";
}

module.exports = L.handler(async (req, res) => {
  const sess = await L.currentSession(req);
  if (!sess) throw new HttpError(401, "Oturum bulunamadı. Tekrar giriş yap.");
  const dk = P + "data:" + sess.name, rk = P + "rev:" + sess.name;

  if (req.method === "GET") {
    const [raw, rev] = await pipe([["GET", dk], ["GET", rk]]);
    return res.status(200).json({ rev: parseInt(rev, 10) || 0, data: raw ? JSON.parse(raw) : null });
  }

  if (req.method === "PUT") {
    L.requireJson(req);
    const b = L.body(req);
    if (!valid(b.data)) throw new HttpError(400, "Geçersiz veri biçimi.");
    const text = JSON.stringify(b.data);
    if (text.length > MAX_BYTES) throw new HttpError(413, "Veri çok büyük.");
    const r = await cmd("EVAL", WRITE, "2", dk, rk, String(parseInt(b.rev, 10) || 0), text);
    if (r[0] === 1) return res.status(200).json({ rev: r[1] });
    // Başka bir cihaz daha yeni veri yazmış: güncel hâli geri ver
    const raw = await cmd("GET", dk);
    throw new HttpError(409, "Sürüm çakışması.", { rev: r[1], data: raw ? JSON.parse(raw) : null });
  }

  throw new HttpError(405, "Yöntem desteklenmiyor.");
});
