"use strict";
const L = require("./_lib");
const { P, HttpError, cmd, pipe } = L;

const NAME_RE = /^[a-z0-9_.-]{3,24}$/;

module.exports = L.handler(async (req, res) => {
  const sess = await L.currentSession(req);

  /* Durum: giriş yapılmış mı, kayıt açık mı */
  if (req.method === "GET") return res.status(200).json(await L.info(sess && sess.name));

  if (req.method !== "POST") throw new HttpError(405, "Yöntem desteklenmiyor.");
  L.requireJson(req);
  const b = L.body(req), action = String(b.action || "");

  /* ---------- Kayıt ---------- */
  if (action === "register") {
    await L.rlCheck(req);
    const name = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
    if (!NAME_RE.test(name)) throw new HttpError(400, "Kullanıcı adı 3–24 karakter olmalı; yalnızca a-z, 0-9, nokta, tire ve alt çizgi kullanılabilir.");
    if (pw.length < 8 || pw.length > 200) throw new HttpError(400, "Parola en az 8 karakter olmalı.");
    if (L.REGISTER_CODE && !L.safeEq(String(b.code || ""), L.REGISTER_CODE)) {
      await L.rlFail(req); throw new HttpError(403, "Davet kodu hatalı.");
    }
    if ((await cmd("SCARD", P + "users")) >= L.MAX_USERS) throw new HttpError(403, `Kayıt kapalı: en fazla ${L.MAX_USERS} hesap açılabilir.`);
    if (await cmd("SISMEMBER", P + "users", name)) throw new HttpError(409, "Bu kullanıcı adı alınmış.");

    const rec = Object.assign(await L.hashPw(pw), { created: Date.now() });
    const added = await cmd("SADD", P + "users", name);
    if (!added) throw new HttpError(409, "Bu kullanıcı adı alınmış.");
    // Yarış durumuna karşı: eşzamanlı iki kayıt sınırı aşarsa geri al
    if ((await cmd("SCARD", P + "users")) > L.MAX_USERS) {
      await cmd("SREM", P + "users", name);
      throw new HttpError(403, `Kayıt kapalı: en fazla ${L.MAX_USERS} hesap açılabilir.`);
    }
    await cmd("SET", P + "user:" + name, JSON.stringify(rec));
    await L.newSession(res, name);
    return res.status(200).json(await L.info(name));
  }

  /* ---------- Giriş ---------- */
  if (action === "login") {
    await L.rlCheck(req);
    const name = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
    const raw = NAME_RE.test(name) && pw.length <= 200 ? await cmd("GET", P + "user:" + name) : null;
    const ok = await L.checkPw(pw, raw ? JSON.parse(raw) : null);
    if (!ok) { await L.rlFail(req); throw new HttpError(401, "Kullanıcı adı veya parola hatalı."); }
    await L.newSession(res, name);
    return res.status(200).json(await L.info(name));
  }

  /* ---------- Çıkış ---------- */
  if (action === "logout") {
    if (sess) await pipe([["DEL", P + "sess:" + sess.h], ["SREM", P + "usess:" + sess.name, sess.h]]);
    L.setCookie(res, "", 0);
    return res.status(200).json(await L.info(null));
  }

  /* Bundan sonrası giriş gerektirir */
  if (!sess) throw new HttpError(401, "Oturum bulunamadı. Tekrar giriş yap.");

  /* ---------- Parola değiştir ---------- */
  if (action === "password") {
    await L.rlCheck(req);
    const cur = String(b.current || ""), next = String(b.next || "");
    if (next.length < 8 || next.length > 200) throw new HttpError(400, "Yeni parola en az 8 karakter olmalı.");
    const rec = JSON.parse(await cmd("GET", P + "user:" + sess.name));
    if (!(await L.checkPw(cur, rec))) { await L.rlFail(req); throw new HttpError(403, "Mevcut parola hatalı."); }
    await cmd("SET", P + "user:" + sess.name, JSON.stringify(Object.assign(rec, await L.hashPw(next))));
    await L.revokeSessions(sess.name, sess.h); // diğer cihazlardaki oturumlar kapanır
    return res.status(200).json({ ok: true });
  }

  /* ---------- Hesabı sil ---------- */
  if (action === "delete") {
    await L.rlCheck(req);
    const rec = JSON.parse(await cmd("GET", P + "user:" + sess.name));
    if (!(await L.checkPw(String(b.password || ""), rec))) { await L.rlFail(req); throw new HttpError(403, "Parola hatalı."); }
    await L.revokeSessions(sess.name, null);
    await pipe([
      ["DEL", P + "user:" + sess.name], ["DEL", P + "data:" + sess.name], ["DEL", P + "rev:" + sess.name],
      ["DEL", P + "usess:" + sess.name], ["SREM", P + "users", sess.name],
    ]);
    L.setCookie(res, "", 0);
    return res.status(200).json(await L.info(null));
  }

  throw new HttpError(400, "Bilinmeyen işlem.");
});
