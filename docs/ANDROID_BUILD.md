# Сборка Android-приложения (TWA) через GitHub Actions

Приложение работает как **Trusted Web Activity (TWA)** — легкая нативная обертка вокруг игры, открывающая её в полноэкранном режиме с аппаратным ускорением WebGL 2.0.

Все ресурсы и логика игры подгружаются из GitHub Pages. Это означает, что **любое изменение в игре сразу отображается на телефонах пользователей без переустановки APK!**

---

## 1. Если изменится название игры или адрес репозитория на GitHub:

> ⚠️ **TODO (Avelora):** имя уже переименовано в `Avelora` (`manifest.json`, `name`/`launcherName` в `twa-manifest.json`), но `packageId`, `startUrl`, `iconUrl`, `maskableIconUrl`, `webManifestUrl` и `fullScopeUrl` в `twa-manifest.json` всё ещё указывают на `ssadovsky.github.io/lakeland/`. Поменять их, когда будет создан GitHub-репозиторий Avelora.

Когда вы определитесь с финальным названием игры или именем репозитория на GitHub, просто проверьте два файла:

### В файле `manifest.json`:
- `"name"`: Имя игры (например, `"LakeLand"` или любое новое).
- `"short_name"`: Короткое имя под иконкой на телефоне.

### В файле `twa-manifest.json`:
- `"host"`: ваш домен (по умолчанию `ssadovsky.github.io`).
- `"packageId"`: уникальный идентификатор приложения (например, `com.ssadovsky.lakeland`).
- `"startUrl"`: путь к игре на GitHub Pages (например, `/lakeland/index.html` или `/newname/index.html`).
- `"fullScopeUrl"`: путь к папке (например, `https://ssadovsky.github.io/lakeland/`).

---

## 2. Что нужно настроить в репозитории на GitHub:

### А. Включить GitHub Pages:
Settings → Pages → Source: **Deploy from a branch** → Branch: **main** (или master) / root → Save.
Игра станет доступна в браузере по адресу `https://<ваш-логин>.github.io/<репозиторий>/`.

### Б. Добавить секреты для подписи APK:
Settings → Secrets and variables → Actions → New repository secret.
Используются те же ключи, что и для других ваших проектов:
- `ANDROID_KEYSTORE_BASE64` — содержимое `android-upload.keystore.b64.txt`.
- `BUBBLEWRAP_KEYSTORE_PASSWORD` — пароль хранилища.
- `BUBBLEWRAP_KEY_PASSWORD` — пароль ключа.

---

## 3. Как запустить сборку APK:

1. Перейдите во вкладку **Actions** в репозитории на GitHub.
2. Выберите воркфлоу **"Build Android app (TWA / Bubblewrap)"**.
3. Нажмите **Run workflow**.
4. Через 2-3 минуты в секции **Artifacts** появится архив со скачиваемым готовым файлом:
   - `app-release-signed.apk` (для установки на телефон и тестирования).
   - `app-release-bundle.aab` (для публикации в Google Play).
