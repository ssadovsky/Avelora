/**
 * Avelora — размеры «невидимых цилиндров» для наведения/клика + режим их показа для отладки.
 *
 * Конфиг ниже: правьте числа и обновляйте страницу (Ctrl+F5).
 *   creature  — зверь: радиус берётся из размеров тела модели (ширина×длина) * sizeMul, в пределах minRadius..maxRadius;
 *               высота = рост модели * heightMul (не меньше minHeight). Крыса и медведь получают разные размеры сами.
 *   tree      — дерево (размеры в единицах модели, масштаб дерева применяется сверху)
 *   fern      — папоротник
 *   pile      — предметы на земле: радиус = clamp(footprint * footprintMul, minRadius, maxRadius)
 *   container — сундук/NPC/пенёк-контейнер: радиус не меньше minRadius
 *
 * Показ контуров: клавиша F4 (или добавить ?hitboxes в адрес страницы). Только отладка:
 * в обычной игре контуры выключены. Кусты, камни и камыш наводятся по своей реальной форме — у них цилиндра нет.
 */
(function () {
    'use strict';

    window.AVELORA_HIT = {
        creature:  { sizeMul: 0.9, minRadius: 0.3, maxRadius: 1.2, heightMul: 0.9, minHeight: 0.4 },
        tree:      { radiusBottom: 0.22, radiusTop: 0.38, height: 2.2 },
        fern:      { radiusBottom: 0.224, radiusTop: 0.176, height: 0.2 },
        ore:       { radiusBottom: 0.75, radiusTop: 0.65, height: 0.7 },
        pile:      { minRadius: 0.25, maxRadius: 0.55, footprintMul: 0.6, height: 0.45 },
        container: { minRadius: 0.4, minHeight: 0.7 }
    };

    const COLORS = { creature: 0xff4040, tree: 0x40ff60, fern: 0x40ffd0, ore: 0xffaa40, pile: 0xffe040, container: 0x60a0ff };
    const mats = {};
    function wireMat(kind) {
        if (!mats[kind]) mats[kind] = new THREE.MeshBasicMaterial({ color: COLORS[kind] || 0xffffff, wireframe: true, transparent: true, opacity: 0.85, fog: false });
        return mats[kind];
    }

    const Dbg = {
        visible: /[?&]hitboxes\b/.test(location.search),

        /** Adds a wire outline to a (single) proxy mesh: it is a child, so it moves with it. */
        attach(proxy, kind) {
            const w = new THREE.Mesh(proxy.geometry, wireMat(kind));
            w.userData.hitWire = true;
            w.visible = Dbg.visible;
            w.raycast = function () {};
            w.renderOrder = 50;
            proxy.add(w);
            return w;
        },

        /** Same for an InstancedMesh proxy: a twin sharing its instance matrices. */
        attachInstanced(proxy, kind, parent) {
            const w = new THREE.InstancedMesh(proxy.geometry, wireMat(kind), proxy.count);
            w.instanceMatrix = proxy.instanceMatrix;
            w.position.copy(proxy.position);
            w.frustumCulled = false;
            w.userData.hitWire = true;
            w.visible = Dbg.visible;
            w.raycast = function () {};
            w.renderOrder = 50;
            parent.add(w);
            return w;
        },

        set(game, on) {
            Dbg.visible = !!on;
            if (game && game.scene) game.scene.traverse(o => { if (o.userData && o.userData.hitWire) o.visible = Dbg.visible; });
            return Dbg.visible;
        },

        toggle(game) { return Dbg.set(game, !Dbg.visible); }
    };
    window.AveloraHitDebug = Dbg;
})();
