/**
 * gfx_profile.js — единый профиль качества графики.
 *
 * Два профиля:
 *   'high' — полная графика ПК (по умолчанию на ПК при каждом старте, если не выбрана экономная);
 *   'low'  — экономная графика: всегда на телефоне/планшете, на ПК — если включена в настройках
 *            («Экономная графика», запоминается в localStorage 'avelora_gfx_quality' = 'eco').
 * Телефон определяется по основному указателю (pointer: coarse), ширина окна не влияет.
 *
 * window.GFX.tier: 'low' | 'high'; window.GFX.mobile: true, когда действует экономный профиль (поле оставлено
 * под прежним именем — его читают water.js / main.js); window.GFX.isPhone: устройство — телефон/планшет.
 * GFX.setQuality('high' | 'eco') — сохранить выбор (только ПК) и пересчитать профиль.
 * GFX.refresh() пересчитывает профиль и возвращает true, если он изменился
 * (Game.applyGraphicsProfile() в main.js применяет его на лету, без пересоздания сцены).
 */
(function () {
    const PROFILES = {
        // экономная (телефон): чёткость 1, лимит 30 кадров, тени без размытия, низкая анизотропия.
        // Отражение воды — 256 и раз в 2 кадра (снижает нагрузку и нагрев GPU на телефоне).
        low:  { dpr: 1.0,  shadows: true, shadowMapSize: 1024, fpsCap: 30, treeShadowR: 20, treeLodR: 40, fogMul: 1.15, grassRadius: 38,  particles: 40,  vignette: false,
                softShadows: false, aniso: 2, waterBuf: 256, waterThrottle: 2 },
        high: { dpr: 1.25, shadows: true, shadowMapSize: 2048, fpsCap: 60, treeShadowR: 30, treeLodR: 55, fogMul: 1.0,  grassRadius: 55,  particles: 140, vignette: true,
                softShadows: true, aniso: 8, waterBuf: 512, waterThrottle: 2 }
    };
    const STORE_KEY = 'avelora_gfx_quality';

    function isPhone() {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    }

    let memQuality = null;   // если localStorage недоступен — выбор живёт до перезагрузки
    function savedQuality() {
        if (memQuality) return memQuality;
        try { return localStorage.getItem(STORE_KEY) === 'eco' ? 'eco' : 'high'; } catch (e) { return 'high'; }
    }

    const GFX = { tier: null };
    GFX.refresh = function () {
        const phone = isPhone();
        const tier = (phone || savedQuality() === 'eco') ? 'low' : 'high';
        GFX.isPhone = phone;
        if (tier === GFX.tier) return false;
        Object.assign(GFX, PROFILES[tier]);
        GFX.aa = true;
        GFX.tier = tier;
        GFX.mobile = tier === 'low';
        return true;
    };
    /** Выбор в настройках (только ПК): 'eco' — экономная графика, иначе полная. */
    GFX.setQuality = function (q) {
        memQuality = q === 'eco' ? 'eco' : 'high';
        try { localStorage.setItem(STORE_KEY, memQuality); } catch (e) { /* без хранилища — до перезагрузки */ }
    };
    GFX.quality = savedQuality;
    GFX.refresh();
    window.GFX = GFX;
})();
