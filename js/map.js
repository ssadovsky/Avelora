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

    const PADDING      = 22;            // отступ от края canvas до карты (px)
    const MAX_INNER_W  = 450;           // макс. внутренняя ширина карты (px)
    const MAX_INNER_H  = 300;           // макс. внутренняя высота карты (px)
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
            this._coordsEl = document.getElementById('map-coords');
            this._closeBtn = document.getElementById('map-close-btn');
            this._mapBtn   = document.getElementById('map-btn');

            if (!this._overlay || !this._canvas) {
                console.warn('[Avelora] Map: HTML elements not found, map disabled');
                return;
            }

            this._ctx = this._canvas.getContext('2d');
            this._canvas.width  = 494;
            this._canvas.height = 344;

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

            // Обновить заголовок и координаты
            const loc = this.game.location;
            if (this._locName) {
                this._locName.textContent = loc ? (loc.name || loc.id) : '—';
            }
            if (this._coordsEl && this.game.character) {
                const p = this.game.character.position;
                this._coordsEl.textContent = `X: ${p.x.toFixed(1)} | Z: ${p.z.toFixed(1)}`;
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
            this._layout = null;
            if (this.isOpen) this.close();
        }

        /**
         * Планировка подземелья по навигационной сетке: проходимые клетки → картинка, границы — по самим клеткам.
         * Строится один раз на сетку. null, если вся сетка проходима (нечего показывать — старый вид карты).
         */
        _getDungeonLayout(pf) {
            if (this._layout && this._layout.pf === pf) return this._layout.data;
            const nx = pf.gridSizeX, nz = pf.gridSizeZ;
            let minI = nx, maxI = -1, minJ = nz, maxJ = -1, blocked = 0;
            for (let j = 0; j < nz; j++) {
                for (let i = 0; i < nx; i++) {
                    if (pf.grid[pf.getIndex(i, j)] === 0) {
                        if (i < minI) minI = i; if (i > maxI) maxI = i;
                        if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
                    } else blocked++;
                }
            }
            let data = null;
            if (blocked > 0 && maxI >= 0) {
                const pad = 2;                                   // клетки запаса вокруг
                const i0 = Math.max(0, minI - pad), i1 = Math.min(nx - 1, maxI + pad);
                const j0 = Math.max(0, minJ - pad), j1 = Math.min(nz - 1, maxJ + pad);
                const SUB = 3;                                   // пикселей на клетку (сглаживается при отрисовке)
                const W = (i1 - i0 + 1) * SUB, H = (j1 - j0 + 1) * SUB;
                const cv = document.createElement('canvas');
                cv.width = W; cv.height = H;
                const cx = cv.getContext('2d');
                const img = cx.createImageData(W, H);
                const walk = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && pf.grid[pf.getIndex(i, j)] === 0;
                for (let j = j0; j <= j1; j++) {
                    for (let i = i0; i <= i1; i++) {
                        if (!walk(i, j)) continue;
                        const edge = !walk(i - 1, j) || !walk(i + 1, j) || !walk(i, j - 1) || !walk(i, j + 1);
                        const c = edge ? [214, 176, 98] : [96, 80, 58];
                        for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
                            const k = ((j - j0) * SUB + sy) * W + (i - i0) * SUB + sx;
                            img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2]; img.data[k * 4 + 3] = edge ? 255 : 235;
                        }
                    }
                }
                cx.putImageData(img, 0, 0);
                const wa = pf.gridToWorld(i0, j0), wb = pf.gridToWorld(i1, j1);
                data = {
                    canvas: cv,
                    bounds: {
                        minX: wa.x - pf.cellWidth / 2, maxX: wb.x + pf.cellWidth / 2,
                        minZ: wa.z - pf.cellHeight / 2, maxZ: wb.z + pf.cellHeight / 2
                    }
                };
            }
            this._layout = { pf, data };
            return data;
        }

        // -----------------------------------------------------------
        // Рендер
        // -----------------------------------------------------------
        render() {
            const ctx = this._ctx;
            const g = this.game;
            const loc = g.location;
            if (!ctx || !loc) return;

            const t = loc.terrain || {};
            const sizeX = t.sizeX || (Array.isArray(t.size) ? t.size[0] : t.size) || 120;
            const sizeZ = t.sizeZ || (Array.isArray(t.size) ? t.size[1] : t.size) || 120;
            const halfX = sizeX / 2;
            const halfZ = sizeZ / 2;

            // Вычисляем масштаб так, чтобы 1 метр по X равнялся ровно 1 метру по Z (сохранение пропорций 3:2 или 1:1)
            const scale = Math.min(MAX_INNER_W / sizeX, MAX_INNER_H / sizeZ);
            const mapW  = Math.round(sizeX * scale);
            const mapH  = Math.round(sizeZ * scale);
            const canvasW = mapW + PADDING * 2;
            const canvasH = mapH + PADDING * 2;

            if (this._canvas.width !== canvasW || this._canvas.height !== canvasH) {
                this._canvas.width  = canvasW;
                this._canvas.height = canvasH;
            }

            const offX = PADDING;
            const offZ = PADDING;

            ctx.clearRect(0, 0, canvasW, canvasH);

            if (this._coordsEl && this.game.character) {
                const p = this.game.character.position;
                this._coordsEl.textContent = `X: ${p.x.toFixed(1)} | Z: ${p.z.toFixed(1)}`;
            }

            // --- Преобразование мировых координат → canvas px ---
            let toX = (wx) => offX + (wx + halfX) * scale;
            let toZ = (wz) => offZ + (wz + halfZ) * scale;
            let toR = (wr) => wr * scale; // radius in px

            // Подземелье: карта строится по реальной сетке проходимости локации (без привязки к конкретному данжу)
            let dungeonLayout = null;
            if (loc.isDungeon && g.pathfinder) {
                try { dungeonLayout = this._getDungeonLayout(g.pathfinder); } catch (e) { dungeonLayout = null; }
            }
            if (dungeonLayout) {
                const b = dungeonLayout.bounds, bw = b.maxX - b.minX, bh = b.maxZ - b.minZ;
                const sc = Math.min(mapW / bw, mapH / bh);
                const dOffX = offX + (mapW - bw * sc) / 2;
                const dOffZ = offZ + (mapH - bh * sc) / 2;
                toX = (wx) => dOffX + (wx - b.minX) * sc;
                toZ = (wz) => dOffZ + (wz - b.minZ) * sc;
                toR = (wr) => wr * sc;
                dungeonLayout.draw = () => {
                    ctx.save();
                    ctx.imageSmoothingEnabled = true;
                    try { ctx.filter = 'blur(1.1px)'; } catch (e) { /* без сглаживания */ }
                    ctx.drawImage(dungeonLayout.canvas, dOffX, dOffZ, bw * sc, bh * sc);
                    ctx.restore();
                };
            }

            // === Фон ===
            ctx.fillStyle = TERRAIN_FILL;
            ctx.fillRect(offX, offZ, mapW, mapH);

            // Квадратная сетка (для подземелья вместо неё — планировка)
            if (dungeonLayout) {
                dungeonLayout.draw();
            } else {
                ctx.save();
                ctx.strokeStyle = GRID_COLOR;
                ctx.lineWidth = 1;
                const stepM = Math.max(sizeX, sizeZ) > 150 ? 50 : 25;
                for (let wx = -Math.floor(halfX / stepM) * stepM; wx <= halfX; wx += stepM) {
                    const x = toX(wx);
                    if (x >= offX && x <= offX + mapW) {
                        ctx.beginPath(); ctx.moveTo(x, offZ); ctx.lineTo(x, offZ + mapH); ctx.stroke();
                    }
                }
                for (let wz = -Math.floor(halfZ / stepM) * stepM; wz <= halfZ; wz += stepM) {
                    const z = toZ(wz);
                    if (z >= offZ && z <= offZ + mapH) {
                        ctx.beginPath(); ctx.moveTo(offX, z); ctx.lineTo(offX + mapW, z); ctx.stroke();
                    }
                }
                ctx.restore();
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
                    const w = toR(sizeX * 0.15);
                    if (side === 'west')  { ctx.fillRect(offX, offZ, w, mapH); }
                    if (side === 'east')  { ctx.fillRect(offX + mapW - w, offZ, w, mapH); }
                    if (side === 'north') { ctx.fillRect(offX, offZ, mapW, w); }
                    if (side === 'south') { ctx.fillRect(offX, offZ + mapH - w, mapW, w); }
                } else if (wb.type === 'river' && Array.isArray(wb.points)) {
                    // Речка: ломаная по контрольным точкам, толщиной в ширину русла
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.strokeStyle = WATER_FILL;
                    ctx.lineWidth = Math.max(3, toR(wb.width || 5));
                    ctx.beginPath();
                    wb.points.forEach((pt, i) => { if (i) ctx.lineTo(toX(pt[0]), toZ(pt[1])); else ctx.moveTo(toX(pt[0]), toZ(pt[1])); });
                    ctx.stroke();
                } else if (wb.type === 'island') {
                    // Весь фон — вода, круг суши по центру
                    ctx.fillStyle = WATER_FILL;
                    ctx.fillRect(offX, offZ, mapW, mapH);
                    const r = toR((wb.islandRadius || 22));
                    ctx.fillStyle = TERRAIN_FILL;
                    ctx.beginPath();
                    ctx.arc(offX + mapW / 2, offZ + mapH / 2, r, 0, Math.PI * 2);
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
            ctx.lineWidth = 1.5;
            ctx.strokeRect(offX - 4, offZ - 4, mapW + 8, mapH + 8);
            ctx.restore();

            // === Стрелки сторон света (N/S/W/E) и координаты игрока ===
            ctx.save();
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.textAlign = 'center';
            ctx.fillText('С', offX + mapW / 2, 14);
            ctx.fillText('Ю', offX + mapW / 2, canvasH - 5);
            ctx.fillText('З', 10, offZ + mapH / 2 + 4);
            ctx.fillText('В', canvasW - 10, offZ + mapH / 2 + 4);

            if (ch) {
                ctx.font = 'bold 10px monospace';
                ctx.fillStyle = 'rgba(239, 207, 122, 0.9)';
                ctx.textAlign = 'left';
                ctx.fillText(`X: ${ch.position.x.toFixed(1)}  Z: ${ch.position.z.toFixed(1)}`, offX, canvasH - 6);
            }
            ctx.restore();
        }
    }

    window.AveloraMap = AveloraMap;
})();
