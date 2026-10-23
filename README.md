# YKDS Çalışma Platformu (hesaplı sürüm)

İlerleme artık tarayıcıda değil, hesabın altında sunucuda (Upstash Redis) saklanır.
Vercel'de çalışır; ek paket veya build adımı yoktur.

## Dosyalar
- `public/index.html` : uygulama (arayüz)
- `api/auth.js` : kayıt, giriş, çıkış, parola değiştirme, hesap silme
- `api/data.js` : kullanıcının ilerleme verisini okuma/yazma
- `api/_lib.js` : ortak yardımcılar (Redis, oturum, parola)
- `vercel.json`, `package.json` : Vercel ayarları

## Kurulum
1. Bu klasörün içeriğini projenin kök dizinine koy (GitHub'a push et veya klasörde `vercel --prod` çalıştır).
2. Vercel panelinde projeni aç → **Storage** → **Create Database** → **Upstash Redis** (ücretsiz plan yeter) → projene bağla.
   `KV_REST_API_URL` ve `KV_REST_API_TOKEN` ortam değişkenleri otomatik eklenir.
3. (İsteğe bağlı) **Settings → Environment Variables**:
   - `REGISTER_CODE` : doluysa hesap açarken bu davet kodu istenir. İkinci kişi kaydolmadan başkasının araya girmesini önler.
   - `MAX_USERS` : en fazla hesap sayısı (varsayılan `2`).
4. **Redeploy** et (ortam değişkenleri yalnızca yeni deploy'da geçerli olur).
5. Siteyi aç, **Hesap aç** ile iki hesabı oluştur. Hesap sayısı dolunca kayıt kendiliğinden kapanır.

## Notlar
- Parolalar scrypt ile özetlenir, düz metin saklanmaz. Oturum çerezi HttpOnly + Secure'dur, 30 gün geçerlidir.
- Başarısız girişler IP başına 15 dakikada 8 ile sınırlıdır.
- İki cihazda aynı anda çalışırsan veriler birleştirilir; cevap kaybolmaz.
- Hesabı silmek kayıt kontenjanında yer açar (Ayarlar → Hesabı sil).
