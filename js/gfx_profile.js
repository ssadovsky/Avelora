/**
 * gfx_profile.js — единый профиль качества графики (VISUAL_TODO V0).
 *
 * window.GFX.tier: 'low' (телефон / узкое окно <= 900px) | 'high' (ПК).
 * Принудительно: ?gfx=low | ?gfx=high в адресной строке.
 * GFX.refresh() пересчитывает профиль и возвращает true, если он изменился
 * (применяет настройки Game.applyGraphicsProfile() в main.js, без пересоздания сцены).
 */
(function () {
    const PROFILES = {
        low:  { dpr: 1.5,  shadows: true, shadowMapSize: 1024, fpsCap: 60, treeShadowR: 20, fogMul: 1.15, grassRadius: 38,  particles: 40,  vignette: false },
        high: { dpr: 1.25, shadows: true, shadowMapSize: 2048, fpsCap: 60, treeShadowR: 30, fogMul: 1.0,  grassRadius: 55,  particles: 140, vignette: true }
    };
    const LOW_WIDTH = 900;

    function detectTier() {
        let forced = null;
        try { forced = new URLSearchParams(window.location.search).get('gfx'); } catch (e) { /* file:// без query */ }
        if (forced === 'low' || forced === 'high') return forced;
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        const touchUi = !!(document.body && document.body.classList.contains('touch-ui'));
        return (coarse || touchUi || window.innerWidth <= LOW_WIDTH) ? 'low' : 'high';
    }

    /*
     * Тестовые параметры адресной строки (для замеров нагрузки). Выключены; чтобы включить — раскомментировать блок.
     *   ?dpr=1      множитель пикселей (1 / 1.25 / 1.5 ...)
     *   ?shadows=0  выключить тени
     *   ?aa=0       выключить сглаживание (применяется при создании рендерера, нужна перезагрузка)
     *   ?fps=30     лимит кадров (0 = без лимита)
     *   ?novig=1    без виньетки
     * Постоянно действует только ?gfx=low|high (см. detectTier).
     */
    function applyTestParams() {
        /*
        let q;
        try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
        if (q.has('dpr'))     GFX.dpr = parseFloat(q.get('dpr')) || GFX.dpr;
        if (q.get('shadows') === '0') GFX.shadows = false;
        if (q.get('aa') === '0')      GFX.aa = false;
        if (q.has('fps'))     GFX.fpsCap = parseInt(q.get('fps'), 10) || 0;
        if (q.get('novig') === '1')   GFX.vignette = false;
        */
    }

    const GFX = { tier: null };
    GFX.refresh = function () {
        const tier = detectTier();
        if (tier === GFX.tier) return false;
        Object.assign(GFX, PROFILES[tier]);
        GFX.aa = true;
        GFX.tier = tier;
        applyTestParams();
        return true;
    };
    GFX.refresh();
    window.GFX = GFX;
})();
