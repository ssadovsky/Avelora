/**
 * asset_loader.js — подгрузка 3D-моделей по требованию (работает и с file://, без fetch).
 *
 * Каждая модель лежит в своём файле js/assets/m/<key>.js (генерирует temp_work/build_assets.py):
 *   AveloraAssets.put("<key>", "<base64 GLB>");
 * Список файлов — js/assets/index.js (window.AVELORA_ASSET_INDEX = { key: [путь, хеш] }, алиасы — AVELORA_ASSET_ALIASES).
 * Модель подключается обычным <script>, поэтому игра по-прежнему открывается двойным кликом по Avelora.html.
 *
 * Правило для кода: перед чтением GAME_ASSETS.models[key] / LakesideEnvironment.getModelBuffer(key)
 * дождаться AveloraAssets.ensure(key) (Promise<boolean>). Всё, что запрошено при постройке локации,
 * подгружается под экраном загрузки (main.js ждёт AveloraAssets.idle()); после загрузки модели,
 * не нужные новой локации, выгружаются из памяти (evictUnused). Никаких списков «локация → модели» нет:
 * грузится ровно то, что код локации запросил.
 *
 * Текстуры (js/assets/textures.js) по-прежнему грузятся сразу при старте.
 */
(function () {
    const A = window.GAME_ASSETS = window.GAME_ASSETS || { models: {}, textures: {} };
    const BASE = 'js/assets/';

    const loading = {};          // файловый ключ -> Promise<boolean>
    const used = new Set();      // ключи, запрошенные с начала текущей локации
    let pending = 0;
    let idleWaiters = [];

    function index() { return window.AVELORA_ASSET_INDEX || {}; }
    function canon(key) { const al = window.AVELORA_ASSET_ALIASES || {}; return al[key] || key; }

    function flushIdle() {
        if (pending > 0) return;
        const w = idleWaiters; idleWaiters = [];
        w.forEach(r => r());
    }

    function loadFile(k) {
        if (loading[k]) return loading[k];
        const e = index()[k];
        if (!e) return Promise.resolve(false);
        pending++;
        loading[k] = new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = BASE + e[0] + (e[1] ? '?v=' + e[1] : '');
            s.async = true;
            s.onload = () => { s.remove(); resolve(!!A.models[k]); };
            s.onerror = () => { s.remove(); console.warn(`[AveloraAssets] не удалось загрузить модель "${k}" (${s.src})`); resolve(false); };
            document.head.appendChild(s);
        }).then((ok) => {
            delete loading[k];
            pending--;
            // idle — после того как колбэки ensure() (разбор модели) успели стартовать
            setTimeout(flushIdle, 0);
            return ok;
        });
        return loading[k];
    }

    const AveloraAssets = {
        /** Вызывается из файлов js/assets/m/*.js. */
        put(key, b64) {
            A.models[key] = b64;
            const al = window.AVELORA_ASSET_ALIASES || {};
            for (const a in al) if (al[a] === key) A.models[a] = b64;
        },

        /** Есть ли такая модель в сборке (загружена или может быть загружена). */
        known(key) { return !!key && (!!A.models[key] || !!index()[canon(key)]); },

        /** Promise<boolean>: модель key в GAME_ASSETS.models (false — такой модели нет / ошибка загрузки). */
        ensure(key) {
            if (!key) return Promise.resolve(false);
            const k = canon(key);
            used.add(key); used.add(k);
            if (A.models[key]) return Promise.resolve(true);
            if (A.models[k]) { A.models[key] = A.models[k]; return Promise.resolve(true); }
            return loadFile(k).then((ok) => {
                if (ok && !A.models[key]) A.models[key] = A.models[k];
                return !!A.models[key];
            });
        },

        ensureAll(keys) { return Promise.all((keys || []).map(k => AveloraAssets.ensure(k))); },

        /** Resolves, когда не осталось подгружаемых моделей. */
        idle() {
            if (pending === 0) return new Promise(r => setTimeout(r, 0));
            return new Promise(r => idleWaiters.push(r));
        },

        /** Начало постройки локации: с этого момента считаем, какие модели ей нужны. */
        beginLocation() { used.clear(); },

        /**
         * Выгружает из памяти модели, которые не запрашивались с beginLocation() (строка base64 и
         * раскодированный буфер). Уже построенные меши не затрагиваются; если модель понадобится снова —
         * ensure() подгрузит её заново (из кэша браузера, быстро).
         */
        evictUnused() {
            const idx = index();
            let n = 0;
            Object.keys(A.models).forEach((key) => {
                const k = canon(key);
                if (used.has(key) || used.has(k) || loading[k] || !idx[k]) return;
                delete A.models[key];
                if (window.LakesideEnvironment && window.LakesideEnvironment.dropModelBuffer) window.LakesideEnvironment.dropModelBuffer(key);
                n++;
            });
            if (window.LakesideEnvironment && window.LakesideEnvironment.clearModelBuffers) window.LakesideEnvironment.clearModelBuffers();
            return n;
        },

        /** Для отладки: сколько моделей сейчас в памяти. */
        stats() { return { loaded: Object.keys(A.models).length, pending, used: used.size }; }
    };

    window.AveloraAssets = AveloraAssets;
})();
