# Сборка Android-приложения (TWA) через GitHub Actions

Приложение работает как **Trusted Web Activity (TWA)** — лёгкая нативная обёртка вокруг игры, открывающая её в полноэкранном режиме с аппаратным ускорением WebGL 2.0.

Игра и все ресурсы подгружаются с GitHub Pages. Изменения в игре доходят до телефонов **без переустановки APK**: при каждом запуске телефон скачивает свежий `Avelora.html`, а скрипты и ресурсы подтягивает заново, если у них изменился номер `?v=` (см. раздел 5).

---

## 1. Адреса и настройки Avelora

| Что | Значение |
|---|---|
| Репозиторий | `https://github.com/ssadovsky/Avelora` |
| Игра в браузере | `https://ssadovsky.github.io/Avelora/Avelora.html` |
| Идентификатор приложения (`packageId`) | `com.ssadovsky.avelora` |
| Манифест PWA | `https://ssadovsky.github.io/Avelora/js/manifest.json` |
| Настройки сборки TWA | `js/twa-manifest.json` |
| Иконки | `icons/` (из `temp_work/lib/RawImages/Icon.png`) |

Если репозиторий переименуется, поменяйте в `js/twa-manifest.json`: `startUrl`, `iconUrl`, `maskableIconUrl`, `webManifestUrl`, `fullScopeUrl`.

---

## 2. Что нужно настроить на GitHub (один раз)

### А. Включить GitHub Pages
Settings → Pages → Source: **Deploy from a branch** → Branch: **main** / root → Save.
Файл `.nojekyll` в корне уже есть (Pages не обрабатывает папки Jekyll-ом). Папка `temp_work` в `.gitignore` и на Pages не попадает.

> `js/assets_data.js` весит ~61 МБ. Лимит GitHub на файл — 100 МБ, так что пуш проходит (будет предупреждение про размер больше 50 МБ). Если файл когда-нибудь вырастет до 100 МБ, его придётся резать на части.

### Б. Секреты для подписи APK
Settings → Secrets and variables → Actions → New repository secret:
- `ANDROID_KEYSTORE_BASE64` — содержимое `android-upload.keystore.b64.txt`;
- `BUBBLEWRAP_KEYSTORE_PASSWORD` — пароль хранилища;
- `BUBBLEWRAP_KEY_PASSWORD` — пароль ключа.

Это те же ключи, что и в других ваших проектах.

### В. Digital Asset Links (чтобы приложение открывалось БЕЗ адресной строки)
Chrome проверяет, что сайт «разрешает» приложение, по файлу
`https://ssadovsky.github.io/.well-known/assetlinks.json`.
Он лежит не в репозитории Avelora, а в репозитории **`ssadovsky.github.io`** (корень ваших пользовательских страниц) — скорее всего, он там уже есть от LakeLand. Добавьте в массив ещё одну запись для нового приложения:

```json
{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.ssadovsky.avelora",
    "sha256_cert_fingerprints": ["ТОТ_ЖЕ_SHA256_ЧТО_У_LAKELAND"]
  }
}
```

Отпечаток (SHA-256) тот же, что у LakeLand, если подписываете тем же ключом `android-upload.keystore` (устанавливаете APK вручную). Для публикации в Google Play нужен ещё отпечаток ключа Play App Signing (Play Console → Release → Setup → App signing).
Без этого файла приложение всё равно запустится, но в режиме Custom Tabs (с адресной строкой сверху).

---

## 3. Порядок первого выпуска

1. Положить файлы проекта в репозиторий и запушить в `main` (сам пуш — в вашей IDE).
2. Дождаться, пока Pages опубликует сайт (Settings → Pages → «Your site is live»), и открыть `https://ssadovsky.github.io/Avelora/Avelora.html` в браузере телефона — игра должна загрузиться (первый раз ~61 МБ).
3. Добавить запись в `assetlinks.json` (пункт 2В).
4. Actions → **Build Android app (TWA / Bubblewrap)** → **Run workflow**. Сборка берёт иконку и манифест с уже опубликованного сайта, поэтому сначала должен быть готов Pages.
5. Через 2–3 минуты в **Artifacts** появится архив `avelora-android-build`:
   - `app-release-signed.apk` — для установки на телефон;
   - `app-release-bundle.aab` — для Google Play.
6. APK на телефон: скачать из Artifacts → установить (разрешить установку из неизвестных источников).

Повторная сборка APK нужна только если менялись `js/twa-manifest.json`, `js/manifest.json` или иконки (сборка запускается автоматически при пуше этих файлов). Обновления самой игры APK не требуют.

---

## 4. Как тестировать на телефоне без APK
Откройте `https://ssadovsky.github.io/Avelora/Avelora.html` в Chrome на телефоне → меню ⋮ → «Установить приложение» (PWA). Это то же самое, что APK, но без сборки.

---

## 5. Как обновления доходят до телефона
- `Avelora.html` берётся из сети при каждом запуске (в офлайне — копия из кэша).
- Скрипты, `assets_data.js` и `content_data.js` кэшируются сервис-воркером (`sw.js` в корне, код в `js/sw.js`) по точному адресу **вместе с `?v=...`**. Поменяли файл — поменяйте `?v=` в `Avelora.html`, телефон скачает его заново, а старую копию удалит. Крупный `assets_data.js` скачивается только при смене его `?v=`.
- Новый скрипт добавлять в список в `js/sw.js` не нужно — достаточно подключить его в `Avelora.html`.
- Если поменялся список файлов оболочки (`ASSETS_TO_CACHE` в `js/sw.js`), поднимите `CACHE_NAME`.
