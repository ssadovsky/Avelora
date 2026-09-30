/**
 * Avelora — Mini-map (M key / button)
 *
 * Рисует приблизительную карту текущей локации на canvas:
 *   - Вода (синяя зона из waterBody)
 *   - Деревья / камни (зелёные/серые точки из environment.objects)
 *   - Существа: красные враги, жёлтые нейтральные (creatures.list)
 *   - Персонаж: белый треугольник-стрелка с направлением
 *   - Выход(ы) в другие локации: оранжевые круги с подписью
 *
 * Открытие/закрытие: `game.map.toggle()`, клавиша M, кнопка #map-btn.
 * При открытии ставит паузу; при закрытии — снимает.
 * Карта перерисовывается при открытии и при смене локации (clearAll).
 *
 * Не зависит от Three.js напрямую, использует только game.*
 */
(function () {
    'use strict';

    const MAP_SIZE = 420;           // размер canvas (px)
    const PADDING  = 28;            // отступ от края карты (м → px)
    const WATER_COLOR   = '#1a3d5c';
    const WATER_FILL    = 'rgba(26,74,108,0.72)';
    const TERRAIN_FILL  = 'rgba(28,42,22,0.88)';
    const GRID_COLOR    = 'rgba(255,255,255,0.05)';
    const TREE_COLOR    = '#2e7d32';
    const ROCK_COLOR    = '#78716c';
    const EXIT_COLOR    = '#f59e0b';
    const CREATURE_HOSTILE = '#ef4444';
    const CREATURE_NEUTRAL = '#eab308';
    const PLAYER_COLOR  = '#ffffff';
    const BORDER_COLOR  = 'rgba(195,160,95,0.7)';

    class AveloraMap {
        constructor(game) {
            this.game = game;
            this.isOpen = false;
            this._wasPaused = false;  // состояние паузы до открытия карты

            this._overlay  = document.getElementById('map-overlay');
            this._canvas   = document.getElementById('map-canvas');
            this._locName  = document.getElementById('map-loc-name');
            this._closeBtn = document.getElementById('map-close-btn');
            this._mapBtn   = document.getElementById('map-btn');

            if (!this._overlay || !this._canvas) {
                console.warn('[Avelora] Map: HTML elements not found, map disabled');
                return;
            }

            this._ctx = this._canvas.getContext('2d');
            this._canvas.width  = MAP_SIZE;
            this._canvas.height = MAP_SIZE;

            // Кнопка закрытия (×)
            if (this._closeBtn) {
                this._closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
            }
            // Клик на фон оверлея — закрыть
            this._overlay.addEventListener('click', (e) => {
                if (e.target === this._overlay) this.close();
            });
            // Кнопка на панели хотбара / микроменю
            if (this._mapBtn) {
                this._mapBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.game.ui && this.game.ui.closeMicroMenu) this.game.ui.closeMicroMenu();
                    const isMenuOpen = this.game.pauseOverlay && this.game.pauseOverlay.classList.contains('open');
                    if (isMenuOpen) return;
                    this.toggle();
                });
            }
        }

        toggle() {
            if (this.isOpen) this.close(); else this.open();
        }

        open() {
            if (!this._overlay) return;
            if (this.isOpen) return;
            this.isOpen = true;

            // Запомнить, была ли пауза, и поставить паузу БЕЗ открытия pause-overlay меню!
            this._wasPaused = this.game.isPaused;
            if (!this._wasPaused) this.game.setPaused(true, false);

            // Обновить заголовок
            const loc = this.game.location;
            if (this._locName) {
                this._locName.textContent = loc ? (loc.name || loc.id) : '—';
            }

            this._overlay.classList.add('open');
            if (this._mapBtn) this._mapBtn.classList.add('active');
            this.render();
        }

        close() {
            if (!this._overlay) return;
            if (!this.isOpen) return;
            this.isOpen = false;

            this._overlay.classList.remove('open');
            if (this._mapBtn) this._mapBtn.classList.remove('active');

            // Снять паузу только если мы её поставили (сами)
            if (!this._wasPaused && this.game.isPaused) {
                this.game.setPaused(false);
            }
        }

        /** Вызывается при смене локации — сбрасывает кэш. */
        clearAll() {
            if (this.isOpen) this.close();
        }

        // -----------------------------------------------------------
        // Рендер
        // -----------------------------------------------------------
        render() {
            const ctx = this._ctx;
            const g = this.game;
            const loc = g.location;
            if (!ctx || !loc) return;

            const S = MAP_SIZE;
            ctx.clearRect(0, 0, S, S);

            const t = loc.terrain || {};
            const sizeX = t.sizeX || (Array.isArray(t.size) ? t.size[0] : t.size) || 120;
            const sizeZ = t.sizeZ || (Array.isArray(t.size) ? t.size[1] : t.size) || 120;
            const halfX = sizeX / 2;
            const halfZ = sizeZ / 2;

            // --- Преобразование мировых координат → canvas px ---
            const toX = (wx) => PADDING + (wx + halfX) / sizeX * (S - PADDING * 2);
            const toZ = (wz) => PADDING + (wz + halfZ) / sizeZ * (S - PADDING * 2);
            const toR = (wr) => wr / Math.max(sizeX, sizeZ) * (S - PADDING * 2); // radius in px

            // === Фон ===
            ctx.fillStyle = TERRAIN_FILL;
            ctx.fillRect(0, 0, S, S);

            // Слабая сетка
            ctx.strokeStyle = GRID_COLOR;
            ctx.lineWidth = 1;
            const step = (S - PADDING * 2) / 4;
            for (let i = 0; i <= 4; i++) {
                const v = PADDING + step * i;
                ctx.beginPath(); ctx.moveTo(v, PADDING); ctx.lineTo(v, S - PADDING); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(PADDING, v); ctx.lineTo(S - PADDING, v); ctx.stroke();
            }

            // === Водоём ===
            const wb = loc.terrain && loc.terrain.waterBody;
            if (wb && wb.type !== 'none') {
                ctx.save();
                ctx.fillStyle = WATER_FILL;
                ctx.strokeStyle = WATER_COLOR;
                ctx.lineWidth = 2;
                if (wb.type === 'lake') {
                    const cx = toX(wb.x || 0), cz = toZ(wb.z || 0);
                    const r = toR(wb.radius || 10);
                    ctx.beginPath();
                    ctx.ellipse(cx, cz, r, r * 0.88, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                } else if (wb.type === 'coast') {
                    // Берег вдоль одного края — рисуем полосу
                    const side = wb.side || 'west';
                    const w = toR(half * 0.35);
                    if (side === 'west')  { ctx.fillRect(PADDING, PADDING, w, S - PADDING * 2); }
                    if (side === 'east')  { ctx.fillRect(S - PADDING - w, PADDING, w, S - PADDING * 2); }
                    if (side === 'north') { ctx.fillRect(PADDING, PADDING, S - PADDING * 2, w); }
                    if (side === 'south') { ctx.fillRect(PADDING, S - PADDING - w, S - PADDING * 2, w); }
                } else if (wb.type === 'island') {
                    // Весь фон — вода, круг суши по центру
                    ctx.fillStyle = WATER_FILL;
                    ctx.fillRect(PADDING, PADDING, S - PADDING * 2, S - PADDING * 2);
                    const r = toR((wb.islandRadius || 22));
                    ctx.fillStyle = TERRAIN_FILL;
                    ctx.beginPath();
                    ctx.arc(S / 2, S / 2, r, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            // === Деревья (из environment.objects — InstancedMesh и одиночные) ===
            const env = g.environment;
            if (env && env.objects) {
                ctx.save();
                env.objects.forEach(obj => {
                    if (!obj || obj.visible === false) return;
                    const kind = obj.kind || '';
                    if (kind === 'tree') {
                        const r = Math.max(2, toR((obj.scale || 1) * 1.2));
                        ctx.fillStyle = TREE_COLOR;
                        ctx.globalAlpha = 0.55;
                        ctx.beginPath();
                        ctx.arc(toX(obj.x), toZ(obj.z), r, 0, Math.PI * 2);
                        ctx.fill();
                    } else if (kind === 'boulder' || kind === 'rock') {
                        const r = Math.max(1.5, toR((obj.scale || 1) * 0.9));
                        ctx.fillStyle = ROCK_COLOR;
                        ctx.globalAlpha = 0.6;
                        ctx.beginPath();
                        ctx.arc(toX(obj.x), toZ(obj.z), r, 0, Math.PI * 2);
                        ctx.fill();
                    }
                });
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // === Выходы (exits) ===
            const exits = g.exits || [];
            ctx.save();
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            exits.forEach(ex => {
                const ex2 = ex.data || ex; // main.js wraps in { data, zone, ... }
                const x = toX(ex2.x || 0), z = toZ(ex2.z || 0);
                const r = Math.max(6, toR(ex2.radius || 3));
                ctx.fillStyle = EXIT_COLOR;
                ctx.globalAlpha = 0.75;
                ctx.beginPath(); ctx.arc(x, z, r, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
                ctx.fillStyle = EXIT_COLOR;
                ctx.strokeStyle = '#78350f';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(x, z, r, 0, Math.PI * 2); ctx.stroke();
                // подпись
                ctx.fillStyle = '#fef3c7';
                ctx.globalAlpha = 0.9;
                ctx.fillText(ex2.label || '→', x, z - r - 3);
                ctx.globalAlpha = 1;
            });
            ctx.restore();

            // === Существа ===
            const cr = g.creatures;
            if (cr) {
                ctx.save();
                cr.list.forEach(rec => {
                    if (!cr.isAlive(rec)) return;
                    const isHostile = (rec.def.behavior === 'aggressive') || rec.aggro;
                    ctx.fillStyle = isHostile ? CREATURE_HOSTILE : CREATURE_NEUTRAL;
                    ctx.globalAlpha = 0.85;
                    ctx.beginPath();
                    ctx.arc(toX(rec.x), toZ(rec.z), 4, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // === Игрок (стрелка-треугольник) ===
            const ch = g.character;
            if (ch) {
                const px = toX(ch.position.x), pz = toZ(ch.position.z);
                // Направление: rotation = atan2(dx,dz)+PI → вектор вперёд (-sin r, -cos r)
                // На canvas: ось Z мира → ось Y canvas; ось X мира → ось X canvas
                const rot = ch.currentRotation;
                const fx = -Math.sin(rot), fz = -Math.cos(rot);

                const AR = 9; // длина треугольника
                const AW = 5; // полуширина основания

                ctx.save();
                ctx.fillStyle = PLAYER_COLOR;
                ctx.strokeStyle = '#111';
                ctx.lineWidth = 1.5;
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 4;

                // Вершина вперёд, два угла назад
                const tipX  = px + fx * AR;
                const tipZ  = pz + fz * AR;
                const b1X   = px - fx * AR * 0.4 + (-fz) * AW;
                const b1Z   = pz - fz * AR * 0.4 + fx * AW;
                const b2X   = px - fx * AR * 0.4 - (-fz) * AW;
                const b2Z   = pz - fz * AR * 0.4 - fx * AW;

                ctx.beginPath();
                ctx.moveTo(tipX, tipZ);
                ctx.lineTo(b1X, b1Z);
                ctx.lineTo(b2X, b2Z);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }

            // === Рамка ===
            ctx.save();
            ctx.strokeStyle = BORDER_COLOR;
            ctx.lineWidth = 2;
            ctx.strokeRect(PADDING - 8, PADDING - 8, S - (PADDING - 8) * 2, S - (PADDING - 8) * 2);
            ctx.restore();

            // === Стрелки сторон света (N/S/W/E) ===
            ctx.save();
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.textAlign = 'center';
            ctx.fillText('С', S / 2, 14);
            ctx.fillText('Ю', S / 2, S - 4);
            ctx.fillText('З', 10, S / 2 + 4);
            ctx.fillText('В', S - 10, S / 2 + 4);
            ctx.restore();
        }
    }

    window.AveloraMap = AveloraMap;
})();
