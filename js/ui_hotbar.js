/**
 * Avelora — Hotbar, inventory panel, skills panel, drag & drop, floating texts
 *
 * DOM lives in index.html (#skill-bar slots, #inventory-panel, #skills-panel,
 * #item-tooltip, #drag-ghost); this module fills and drives it from the current
 * character's state (game_state.js). Nothing here pauses the game.
 *
 * HOTBAR RULES (the bar is for ACTIONS):
 *   - 10 slots, keys 1..9,0 (physical e.code Digit1..Digit0 — any keyboard
 *     layout) or click/tap on the slot.
 *   - skills: always allowed (only the character's own).
 *   - items: only if the def has a non-null `use` (tools/consumables). Materials
 *     are rejected with a red flash + "Нельзя: у предмета нет действия".
 *   - an item slot is a BINDING by item id, not a copy: shows the total count in
 *     the bag, greys out when the character no longer has it.
 *   - use.type 'equip' toggles holding the item in the right hand.
 *
 * DRAG & DROP uses POINTER events (mouse AND touch — HTML5 DnD doesn't work on
 * touch screens): skills panel -> slot, bag -> slot, bag -> bag (swap/merge),
 * slot -> slot (swap), slot -> anywhere off the bar (clear), bag cell -> the
 * game WORLD (released outside every panel/HUD element: the whole stack is
 * dropped at the character's feet as a ground pile — world_objects.js
 * dropFromInventory; dropping the equipped item unequips it). Draggable elements
 * have `touch-action: none` so the browser doesn't turn the gesture into a
 * scroll; main.js ignores touches/clicks that start on these elements (UI_SELECTOR).
 */
(function () {
    'use strict';

    const DRAG_THRESHOLD = 6;      // px before a press becomes a drag
    const FLOAT_LIFE = 1.5;        // seconds (game time) a floating "+5 Камень" lives
    const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

    function hueOf(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
        return h % 360;
    }

    /** Icon element for an item/skill def: its icon.png, or a styled first-letter tile. */
    function makeIcon(def) {
        if (def && def.iconData) {
            const img = document.createElement('img');
            img.className = 'ui-icon';
            img.src = def.iconData;
            img.alt = '';
            img.draggable = false;
            return img;
        }
        const el = document.createElement('span');
        el.className = 'ui-icon icon-fallback';
        const name = (def && (def.name || def.id)) || '?';
        el.textContent = name.charAt(0).toUpperCase();
        const h = hueOf((def && def.id) || name);
        el.style.background = `radial-gradient(circle at 35% 30%, hsl(${h},32%,34%) 0%, hsl(${h},30%,16%) 100%)`;
        return el;
    }

    class AveloraHotbarUI {
        constructor(game) {
            this.game = game;
            this.state = null;
            this.floats = [];
            this.drag = null;          // active press/drag
            this.skillsOpen = false;
            this.cdCache = new Array(10).fill(-1);
            this.tooltipTimer = null;
            this._v = new THREE.Vector3();

            this.bar = document.getElementById('skill-bar');
            this.slots = Array.from(document.querySelectorAll('#skill-bar .skill-slot:not(.hud-btn)')).slice(0, 10);
            this.invPanel = document.getElementById('inventory-panel');
            this.invGrid = this.invPanel ? this.invPanel.querySelector('.inventory-grid') : null;
            this.invEmpty = this.invPanel ? this.invPanel.querySelector('.inventory-empty') : null;
            this.invBtn = document.getElementById('inventory-btn');
            this.skillsBtn = document.getElementById('skills-btn');
            this.skillsPanel = document.getElementById('skills-panel');
            this.skillsList = document.getElementById('skills-list');
            this.tooltip = document.getElementById('item-tooltip');
            this.ghost = document.getElementById('drag-ghost');
            this.labelsEl = document.getElementById('world-labels');
            this.quantityModal = document.getElementById('quantity-modal');

            this.buildSlots();
            this.buildInventoryCells();
            this.setupQuantityModal();
            this.setupEvents();
        }

        // -----------------------------------------------------------
        // DOM scaffolding
        // -----------------------------------------------------------
        buildSlots() {
            this.slots.forEach((slot, i) => {
                slot.classList.add('hotbar-slot', 'empty');
                slot.dataset.slot = String(i);
                slot.innerHTML = '';
                const icon = document.createElement('span'); icon.className = 'slot-icon';
                const cd = document.createElement('span'); cd.className = 'slot-cd';
                const count = document.createElement('span'); count.className = 'slot-count';
                const key = document.createElement('span'); key.className = 'slot-key'; key.textContent = KEY_LABELS[i];
                slot.append(icon, cd, count, key);
                slot._icon = icon; slot._cd = cd; slot._count = count;
            });
        }

        buildInventoryCells() {
            if (!this.invGrid) return;
            this.invGrid.innerHTML = '';
            this.cells = [];
            for (let i = 0; i < window.AveloraItems.INVENTORY_SIZE; i++) {
                const c = document.createElement('div');
                c.className = 'inventory-cell';
                c.dataset.cell = String(i);
                this.invGrid.appendChild(c);
                this.cells.push(c);
            }
        }

        // -----------------------------------------------------------
        // Character binding
        // -----------------------------------------------------------
        /** Called by main.js whenever a (new) character's state is loaded. */
        bindCharacter(state) {
            this.state = state;
            if (state) state.onChange(() => this.renderAll());
            this.cancelDrag();
            this.clearFloats();
            const has = this.characterSkills().length > 0;
            if (this.skillsBtn) this.skillsBtn.style.display = has ? '' : 'none';
            if (!has) this.setSkillsOpen(false);
            this.renderAll();
        }

        characterSkills() {
            const cfg = this.game.currentCharacterConfig;
            return (cfg && this.game.skills) ? this.game.skills.forCharacter(cfg.id) : [];
        }

        renderAll() {
            this.renderInventory();
            this.renderHotbar();
            this.renderSkills();
        }

        renderInventory() {
            if (!this.cells) return;
            const inv = this.state ? this.state.inventory : null;
            const equipped = this.state ? this.state.equipped.right : null;
            let any = false;
            this.cells.forEach((cell, i) => {
                const c = inv ? inv.cells[i] : null;
                cell.innerHTML = '';
                cell.classList.toggle('filled', !!c);
                cell.classList.remove('equipped');
                if (!c) return;
                any = true;
                const def = window.AveloraItems.get(c.item);
                cell.appendChild(makeIcon(def));
                if (c.count > 1) {
                    const b = document.createElement('span');
                    b.className = 'cell-count';
                    b.textContent = String(c.count);
                    cell.appendChild(b);
                }
                if (equipped && c.item === equipped) cell.classList.add('equipped');
            });
            if (this.invEmpty) this.invEmpty.style.display = any ? 'none' : '';
        }

        renderHotbar() {
            const hb = this.state ? this.state.hotbar : [];
            this.slots.forEach((slot, i) => {
                const e = hb[i] || null;
                slot._icon.innerHTML = '';
                slot._count.textContent = '';
                slot.classList.remove('missing', 'is-skill', 'is-item', 'equipped');
                slot.classList.toggle('empty', !e);
                this.cdCache[i] = -1;
                slot._cd.style.background = '';
                if (!e) return;
                if (e.type === 'skill') {
                    slot.classList.add('is-skill');
                    slot._icon.appendChild(makeIcon(this.game.skills.get(e.id)));
                } else {
                    slot.classList.add('is-item');
                    const def = window.AveloraItems.get(e.id);
                    slot._icon.appendChild(makeIcon(def));
                    const n = this.state.inventory.count(e.id);
                    if (n <= 0) slot.classList.add('missing');
                    if (n > 1 || (def && def.stackMax > 1)) slot._count.textContent = n > 0 ? String(n) : '';
                    if (this.state.equipped.right === e.id) slot.classList.add('equipped');
                }
            });
        }

        renderSkills() {
            if (!this.skillsList) return;
            this.skillsList.innerHTML = '';
            this.characterSkills().forEach(def => {
                const row = document.createElement('div');
                row.className = 'skill-entry';
                row.dataset.skill = def.id;
                const iconWrap = document.createElement('div');
                iconWrap.className = 'skill-entry-icon';
                iconWrap.appendChild(makeIcon(def));
                const text = document.createElement('div');
                text.className = 'skill-entry-text';
                const name = document.createElement('div');
                name.className = 'skill-entry-name';
                name.textContent = def.name;
                const desc = document.createElement('div');
                desc.className = 'skill-entry-desc';
                desc.textContent = def.description || '';
                const meta = document.createElement('div');
                meta.className = 'skill-entry-meta';
                meta.textContent = `Перезарядка ${def.cooldown || 0} с · Дальность ${def.range || 0} м`;
                text.append(name, desc, meta);
                row.append(iconWrap, text);
                this.skillsList.appendChild(row);
            });
        }

        // -----------------------------------------------------------
        // Panels
        // -----------------------------------------------------------
        isSkillsOpen() { return this.skillsOpen; }

        toggleSkills() { this.setSkillsOpen(!this.skillsOpen); }

        setSkillsOpen(open) {
            if (open && !this.characterSkills().length) open = false;
            this.skillsOpen = open;
            if (this.skillsPanel) {
                this.skillsPanel.classList.toggle('open', open);
                this.skillsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
            }
            if (this.skillsBtn) this.skillsBtn.classList.toggle('active', open);
            this.layoutPanels();
            if (!open) this.hideTooltip();
        }

        /** Desktop: skills panel sits left of the inventory when both are open. */
        layoutPanels() {
            if (this.skillsPanel) this.skillsPanel.classList.toggle('beside-inventory', !!this.game.isInventoryOpen);
        }

        pulseInventory() {
            if (!this.invBtn) return;
            this.invBtn.classList.remove('pulse');
            void this.invBtn.offsetWidth; // restart the CSS animation
            this.invBtn.classList.add('pulse');
        }

        // -----------------------------------------------------------
        // Activation
        // -----------------------------------------------------------
        inputAllowed() {
            const g = this.game;
            if (!g.isReady || g.isPaused || g.isTransitioning || !this.state) return false;
            if (g.combat && g.combat.isDead) return false; // "Вы погибли": no actions until respawn
            const cs = document.getElementById('character-select-overlay');
            if (cs && !cs.classList.contains('hidden')) return false;
            return true;
        }

        activateSlot(i) {
            if (!this.inputAllowed()) return;
            const e = this.state.hotbar[i];
            const slot = this.slots[i];
            if (!e) return;
            if (e.type === 'skill') {
                const res = this.game.skills.activate(e.id);
                if (res === 'ok') this.flashSlot(slot, 'pressed');
                else this.flashSlot(slot, 'shake');
                return;
            }
            const def = window.AveloraItems.get(e.id);
            if (!def || this.state.inventory.count(e.id) <= 0) { this.flashSlot(slot, 'shake'); return; }
            if (def.use && def.use.type === 'equip') {
                this.toggleEquip(e.id);
                this.flashSlot(slot, 'pressed');
            } else {
                this.flashSlot(slot, 'shake'); // other use types: not implemented yet
            }
        }

        flashSlot(slot, cls) {
            if (!slot) return;
            slot.classList.remove('pressed', 'shake', 'reject');
            void slot.offsetWidth;
            slot.classList.add(cls);
        }

        // -----------------------------------------------------------
        // Equipment (right hand)
        // -----------------------------------------------------------
        toggleEquip(itemId) {
            const st = this.state;
            const def = window.AveloraItems.get(itemId);
            if (!st || !def) return;
            if (st.equipped.right === itemId) {
                st.setEquipped('right', null);
                this.applyEquipment();
                this.floatText(`${def.name}: убран`, 'info');
            } else {
                st.setEquipped('right', itemId);
                this.applyEquipment();
                this.floatText(`${def.name} в руке`, 'info');
            }
        }

        /** Makes the character's hand match state.equipped (on load, character switch, toggle). */
        applyEquipment() {
            const c = this.game.character;
            if (!c || !this.state) return;
            const itemId = this.state.equipped.right;
            const token = (this._equipToken = (this._equipToken || 0) + 1);
            if (!itemId) { c.setHandItem(null); return; }
            const def = window.AveloraItems.get(itemId);
            window.AveloraItems.parseModel(def && def.modelKey, (scene) => {
                // A newer equip request or another character won the race: discard this one
                if (token !== this._equipToken || c !== this.game.character) {
                    if (scene && window.MedievalCharacter) window.MedievalCharacter.disposeObject(scene);
                    return;
                }
                const variants = window.AveloraItems.splitVariants(scene);
                let obj = variants[0] || window.AveloraItems.makeFallback('held', itemId);
                window.AveloraItems.setShadows(obj, true, false);
                // Optional per-item pose on top of the character's grip (item.json `hold`):
                // the grip frame suits a carried tool (shaft forward-down, like the axe);
                // a staff is rotated upright with `hold.rotation`.
                const hold = def && def.hold;
                if (hold && (hold.rotation || hold.position)) {
                    const g = new THREE.Group();
                    g.add(obj);
                    const r = hold.rotation || [0, 0, 0], pp = hold.position || [0, 0, 0];
                    g.rotation.set(r[0] || 0, r[1] || 0, r[2] || 0);
                    g.position.set(pp[0] || 0, pp[1] || 0, pp[2] || 0);
                    obj = g;
                }
                c.setHandItem(obj);
            });
        }

        // -----------------------------------------------------------
        // Tooltip (#item-tooltip)
        // -----------------------------------------------------------
        showTooltipFor(el, kind, id, count) {
            if (!this.tooltip) return;
            let def = null, meta = '';
            if (kind === 'skill') {
                def = this.game.skills.get(id);
                if (def) meta = `Перезарядка ${def.cooldown || 0} с · Дальность ${def.range || 0} м`;
            } else {
                def = window.AveloraItems.get(id);
                if (def) {
                    const n = this.state ? this.state.inventory.count(id) : 0;
                    meta = count !== undefined ? `Количество: ${count}` : `В сумке: ${n}`;
                    if (!def.use) meta += ' · материал';
                }
            }
            if (!def) return;
            this.tooltip.innerHTML = '';
            this.tooltip.classList.remove('warn');
            const n = document.createElement('div'); n.className = 'tt-name'; n.textContent = def.name;
            const d = document.createElement('div'); d.className = 'tt-desc'; d.textContent = def.description || '';
            const m = document.createElement('div'); m.className = 'tt-meta'; m.textContent = meta;
            this.tooltip.append(n, d, m);
            this.placeTooltip(el);
        }

        showMessageAt(el, text) {
            if (!this.tooltip) return;
            this.tooltip.innerHTML = '';
            this.tooltip.classList.add('warn');
            const n = document.createElement('div'); n.className = 'tt-name'; n.textContent = text;
            this.tooltip.appendChild(n);
            this.placeTooltip(el);
            clearTimeout(this.tooltipTimer); // UI-only timer (not gameplay) — fine to use real time
            this.tooltipTimer = setTimeout(() => this.hideTooltip(), 1800);
        }

        placeTooltip(el) {
            const t = this.tooltip;
            t.classList.remove('hidden');
            const r = el.getBoundingClientRect();
            const tw = t.offsetWidth, th = t.offsetHeight;
            let x = r.left + r.width / 2 - tw / 2;
            x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
            let y = r.top - th - 8;
            if (y < 6) y = r.bottom + 8;
            if (y + th > window.innerHeight - 6) y = Math.max(6, window.innerHeight - th - 6);
            t.style.left = `${x}px`;
            t.style.top = `${y}px`;
        }

        hideTooltip() {
            if (this.tooltip) {
                this.tooltip.classList.add('hidden');
                this.tooltip.classList.remove('interactive');
            }
        }

        /**
         * Interactive item card shown on tap (mobile) or click (desktop) on an inventory cell.
         * Contains description and actionable buttons: Equip/Unequip, Split stack, Drop.
         */
        showItemCard(src) {
            if (!this.tooltip) return;
            const def = window.AveloraItems.get(src.item);
            if (!def) return;
            const st = this.state;
            const isEquipped = st && st.equipped && st.equipped.right === src.item;

            this.tooltip.innerHTML = '';
            this.tooltip.classList.remove('warn');
            this.tooltip.classList.add('interactive');

            const n = document.createElement('div'); n.className = 'tt-name'; n.textContent = def.name;
            const d = document.createElement('div'); d.className = 'tt-desc'; d.textContent = def.description || '';
            const m = document.createElement('div'); m.className = 'tt-meta';
            m.textContent = `Количество: ${src.count} · ${def.use ? (def.use.type === 'equip' ? 'снаряжение' : 'действие') : 'материал'}`;

            this.tooltip.append(n, d, m);

            // Action buttons row (tap on mobile or click on PC)
            const actions = document.createElement('div');
            actions.className = 'tt-actions';

            if (def.use && def.use.type === 'equip') {
                const btnEquip = document.createElement('button');
                btnEquip.className = 'tt-btn';
                btnEquip.textContent = isEquipped ? 'Снять' : 'Надеть';
                btnEquip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    st.setEquipped('right', isEquipped ? null : src.item);
                    this.applyEquipment();
                });
                actions.appendChild(btnEquip);
            }

            if (src.count > 1) {
                const btnSplit = document.createElement('button');
                btnSplit.className = 'tt-btn';
                btnSplit.textContent = '✂ Разделить';
                btnSplit.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideTooltip();
                    const emptyIdx = st.inventory.firstEmpty();
                    if (emptyIdx < 0) {
                        this.showMessageAt(src.el, 'Нет свободных ячеек в сумке');
                        return;
                    }
                    this.openQuantityModal({
                        mode: 'split',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count - 1,
                        initial: Math.floor(src.count / 2),
                        onConfirm: (count) => {
                            st.inventory.split(src.index, -1, count);
                        }
                    });
                });
                actions.appendChild(btnSplit);
            }

            const btnDrop = document.createElement('button');
            btnDrop.className = 'tt-btn drop';
            btnDrop.textContent = '⏏ Выбросить';
            btnDrop.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideTooltip();
                if (src.count === 1) {
                    this.game.worldObjects.dropFromInventory(src.index);
                } else {
                    this.openQuantityModal({
                        mode: 'drop',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count,
                        initial: src.count,
                        onConfirm: (count) => {
                            this.game.worldObjects.dropFromInventory(src.index, count);
                        }
                    });
                }
            });
            actions.appendChild(btnDrop);

            this.tooltip.appendChild(actions);
            this.placeTooltip(src.el);
        }

        setupQuantityModal() {
            if (!this.quantityModal) return;
            this.qmTitle = document.getElementById('quantity-modal-title');
            this.qmIcon = document.getElementById('quantity-item-icon');
            this.qmName = document.getElementById('quantity-item-name');
            this.qmDesc = document.getElementById('quantity-item-desc');
            this.qmInput = document.getElementById('quantity-input');
            this.qmSlider = document.getElementById('quantity-slider');
            this.qmDec = document.getElementById('quantity-dec');
            this.qmInc = document.getElementById('quantity-inc');
            this.qmConfirm = document.getElementById('quantity-confirm');
            this.qmCancel = document.getElementById('quantity-cancel');
            this.qmClose = document.getElementById('quantity-modal-close');
            this.qmPresets = Array.from(this.quantityModal.querySelectorAll('.quantity-preset-btn'));

            const updateVal = (v) => {
                const min = parseInt(this.qmInput.min, 10) || 1;
                const max = parseInt(this.qmInput.max, 10) || 1;
                let val = Math.max(min, Math.min(max, parseInt(v, 10) || min));
                this.qmInput.value = String(val);
                this.qmSlider.value = String(val);
            };

            if (this.qmSlider) this.qmSlider.addEventListener('input', () => updateVal(this.qmSlider.value));
            if (this.qmInput) this.qmInput.addEventListener('input', () => updateVal(this.qmInput.value));
            if (this.qmDec) this.qmDec.addEventListener('click', () => updateVal((parseInt(this.qmInput.value, 10) || 1) - 1));
            if (this.qmInc) this.qmInc.addEventListener('click', () => updateVal((parseInt(this.qmInput.value, 10) || 1) + 1));

            this.qmPresets.forEach(btn => {
                btn.addEventListener('click', () => {
                    const preset = btn.dataset.preset;
                    const max = parseInt(this.qmInput.max, 10) || 1;
                    if (preset === '1') updateVal(1);
                    else if (preset === 'half') updateVal(Math.max(1, Math.floor(max / 2)));
                    else if (preset === 'all') updateVal(max);
                });
            });

            const close = () => {
                this.quantityModal.classList.add('hidden');
                if (this._qmCallbackCancel) this._qmCallbackCancel();
                this._qmCallbackConfirm = null;
                this._qmCallbackCancel = null;
            };

            const confirm = () => {
                const count = parseInt(this.qmInput.value, 10) || 1;
                this.quantityModal.classList.add('hidden');
                if (this._qmCallbackConfirm) this._qmCallbackConfirm(count);
                this._qmCallbackConfirm = null;
                this._qmCallbackCancel = null;
            };

            if (this.qmCancel) this.qmCancel.addEventListener('click', close);
            if (this.qmClose) this.qmClose.addEventListener('click', close);
            if (this.qmConfirm) this.qmConfirm.addEventListener('click', confirm);
            this.quantityModal.addEventListener('click', (e) => {
                if (e.target === this.quantityModal) close();
            });

            window.addEventListener('keydown', (e) => {
                if (this.quantityModal && !this.quantityModal.classList.contains('hidden')) {
                    if (e.code === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        confirm();
                    } else if (e.code === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                    }
                }
            });
        }

        openQuantityModal({ mode, item, totalCount, max, initial, onConfirm, onCancel }) {
            if (!this.quantityModal) return;
            this.hideTooltip();
            const def = window.AveloraItems.get(item);
            this._qmCallbackConfirm = onConfirm;
            this._qmCallbackCancel = onCancel;

            if (this.qmTitle) this.qmTitle.textContent = mode === 'drop' ? 'Выбросить предмет' : 'Разделить стек';
            if (this.qmConfirm) {
                this.qmConfirm.textContent = mode === 'drop' ? 'Выбросить' : 'Разделить';
                this.qmConfirm.className = `quantity-btn confirm ${mode === 'drop' ? 'drop' : ''}`;
            }
            if (this.qmName) this.qmName.textContent = def ? def.name : item;
            if (this.qmDesc) this.qmDesc.textContent = `В ячейке: ${totalCount} шт.`;

            if (this.qmIcon) {
                this.qmIcon.innerHTML = '';
                this.qmIcon.appendChild(makeIcon(def));
            }

            const min = 1;
            const maxVal = Math.max(1, max);
            const initVal = Math.max(min, Math.min(maxVal, initial !== undefined ? initial : maxVal));

            if (this.qmInput) {
                this.qmInput.min = String(min);
                this.qmInput.max = String(maxVal);
                this.qmInput.value = String(initVal);
            }

            if (this.qmSlider) {
                this.qmSlider.min = String(min);
                this.qmSlider.max = String(maxVal);
                this.qmSlider.value = String(initVal);
            }

            this.quantityModal.classList.remove('hidden');
            if (this.qmInput) {
                this.qmInput.focus();
                this.qmInput.select();
            }
        }

        // -----------------------------------------------------------
        // Floating texts ("+5 Камень", "Сумка полна") above the character
        // -----------------------------------------------------------
        floatText(text, kind, delay) {
            if (!this.labelsEl) return;
            const el = document.createElement('div');
            el.className = `float-text ${kind || ''}`;
            el.textContent = text;
            el.style.display = 'none';
            this.labelsEl.appendChild(el);
            const stack = this.floats.filter(f => f.age < 0.5).length;
            this.floats.push({ el, age: -(delay || 0), stack });
        }

        /**
         * Floating text anchored to a WORLD point (damage numbers over a creature,
         * "−7" over the player): rises ~0.9 m and fades, like floatText().
         */
        floatAt(text, kind, x, y, z) {
            if (!this.labelsEl) return;
            const el = document.createElement('div');
            el.className = `float-text ${kind || ''}`;
            el.textContent = text;
            el.style.display = 'none';
            this.labelsEl.appendChild(el);
            // Small random sideways jitter so rapid numbers don't stack exactly
            this.floats.push({ el, age: 0, stack: 0, anchor: { x: x + (Math.random() - 0.5) * 0.35, y, z } });
            if (this.floats.length > 40) { const f = this.floats.shift(); f.el.remove(); }
        }

        clearFloats() {
            this.floats.forEach(f => f.el.remove());
            this.floats.length = 0;
        }

        updateFloats(delta) {
            if (!this.floats.length) return;
            const c = this.game.character;
            const w = window.innerWidth, h = window.innerHeight;
            for (let i = this.floats.length - 1; i >= 0; i--) {
                const f = this.floats[i];
                f.age += delta;
                if (f.age >= FLOAT_LIFE || !c) { f.el.remove(); this.floats.splice(i, 1); continue; }
                if (f.age < 0) continue;
                const t = f.age / FLOAT_LIFE;
                if (f.anchor) this._v.set(f.anchor.x, f.anchor.y + t * 0.9, f.anchor.z).project(this.game.camera);
                else this._v.set(c.position.x, c.position.y + 2.15 + t * 0.9 + f.stack * 0.32, c.position.z).project(this.game.camera);
                if (this._v.z >= 1) { f.el.style.display = 'none'; continue; }
                f.el.style.display = 'block';
                f.el.style.opacity = String(t < 0.15 ? t / 0.15 : t > 0.65 ? (1 - t) / 0.35 : 1);
                f.el.style.transform = `translate(-50%, -100%) translate(${((this._v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - this._v.y) / 2 * h).toFixed(1)}px)`;
            }
        }

        // -----------------------------------------------------------
        // Per-frame (game time): cooldown sweeps + floating texts
        // -----------------------------------------------------------
        update(delta) {
            this.updateFloats(delta);
            if (!this.state) return;
            const hb = this.state.hotbar;
            for (let i = 0; i < this.slots.length; i++) {
                const e = hb[i];
                if (!e || e.type !== 'skill') continue;
                const frac = this.game.skills.cooldownFraction(e.id);
                const q = Math.round(frac * 120); // quantized: only touch the DOM when the sweep visibly moves
                if (q === this.cdCache[i]) continue;
                this.cdCache[i] = q;
                const slot = this.slots[i];
                slot.classList.toggle('cooling', q > 0);
                // Classic clockwise sweep (WoW/Diablo): the uncovered part starts at
                // 12 o'clock and grows CLOCKWISE; the dark remainder is the arc from
                // the sweep edge to 12 o'clock.
                const edge = ((1 - frac) * 360).toFixed(1);
                slot._cd.style.background = q > 0
                    ? `conic-gradient(rgba(6,8,10,0) ${edge}deg, rgba(6,8,10,0.78) ${edge}deg)`
                    : '';
            }
        }

        // -----------------------------------------------------------
        // Input: keys, pointer drag & drop
        // -----------------------------------------------------------
        setupEvents() {
            window.addEventListener('keydown', (e) => {
                if (e.repeat) return;
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
                const m = /^Digit([0-9])$/.exec(e.code);
                if (m) {
                    const d = parseInt(m[1], 10);
                    this.activateSlot(d === 0 ? 9 : d - 1);
                } else if (e.code === 'KeyK') { // physical key: works in RU layout too (Л)
                    if (this.inputAllowed()) this.toggleSkills();
                }
            });

            if (this.skillsBtn) {
                this.skillsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.inputAllowed()) this.toggleSkills();
                });
            }
            const skillsClose = document.getElementById('skills-close');
            if (skillsClose) {
                skillsClose.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setSkillsOpen(false);
                });
            }

            // Press on any drag source (delegated)
            document.addEventListener('pointerdown', (e) => {
                if (this.tooltip && this.tooltip.classList.contains('interactive')) {
                    if (!this.tooltip.contains(e.target) && !e.target.closest('.inventory-cell')) {
                        this.hideTooltip();
                    }
                }
                this.onPointerDown(e);
            });
            window.addEventListener('pointermove', (e) => this.onPointerMove(e));
            window.addEventListener('pointerup', (e) => this.onPointerUp(e));
            window.addEventListener('pointercancel', () => this.cancelDrag());

            // Hover tooltips (mouse only)
            document.addEventListener('pointerover', (e) => {
                if (e.pointerType !== 'mouse' || this.drag) return;
                if (this.tooltip && this.tooltip.classList.contains('interactive')) return;
                const src = this.sourceFromEl(e.target);
                if (src) this.showSourceTooltip(src);
            });
            document.addEventListener('pointerout', (e) => {
                if (e.pointerType !== 'mouse') return;
                if (this.tooltip && this.tooltip.classList.contains('interactive')) return;
                const src = this.sourceFromEl(e.target);
                if (src && !(e.relatedTarget && src.el.contains(e.relatedTarget)) && !(this.tooltip && this.tooltip.classList.contains('warn'))) this.hideTooltip();
            });

            window.addEventListener('game:pause', () => { this.cancelDrag(); this.hideTooltip(); });
        }

        /** Which draggable thing (if any) an element belongs to. */
        sourceFromEl(target) {
            if (!target || !target.closest) return null;
            const slot = target.closest('.hotbar-slot');
            if (slot && this.state) {
                const i = parseInt(slot.dataset.slot, 10);
                const e = this.state.hotbar[i];
                return { kind: 'slot', index: i, entry: e, el: slot };
            }
            const cell = target.closest('.inventory-cell');
            if (cell && this.state) {
                const i = parseInt(cell.dataset.cell, 10);
                const c = this.state.inventory.cells[i];
                return c ? { kind: 'inv', index: i, item: c.item, count: c.count, el: cell } : null;
            }
            const skill = target.closest('.skill-entry');
            if (skill) return { kind: 'skill', id: skill.dataset.skill, el: skill };
            return null;
        }

        showSourceTooltip(src) {
            if (src.kind === 'inv') this.showTooltipFor(src.el, 'item', src.item, src.count);
            else if (src.kind === 'skill') this.showTooltipFor(src.el, 'skill', src.id);
            else if (src.kind === 'slot' && src.entry) this.showTooltipFor(src.el, src.entry.type === 'skill' ? 'skill' : 'item', src.entry.id);
        }

        sourceIconDef(src) {
            if (src.kind === 'inv') return window.AveloraItems.get(src.item);
            if (src.kind === 'skill') return this.game.skills.get(src.id);
            if (src.kind === 'slot' && src.entry) {
                return src.entry.type === 'skill' ? this.game.skills.get(src.entry.id) : window.AveloraItems.get(src.entry.id);
            }
            return null;
        }

        onPointerDown(e) {
            if (e.button !== undefined && e.button !== 0) return;
            if (!this.inputAllowed()) return;
            const src = this.sourceFromEl(e.target);
            if (!src) return;
            this.drag = {
                src,
                x: e.clientX,
                y: e.clientY,
                pointerId: e.pointerId,
                pointerType: e.pointerType,
                active: false,
                over: null,
                shiftKey: !!e.shiftKey,
                ctrlKey: !!e.ctrlKey
            };
            if (e.pointerType !== 'mouse') e.preventDefault(); // no emulated mouse/click storm on touch
        }

        onPointerMove(e) {
            const d = this.drag;
            if (!d || e.pointerId !== d.pointerId) return;
            if (!d.active) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
                // Only real things can be dragged (an empty slot is just a click target)
                if (d.src.kind === 'slot' && !d.src.entry) { this.drag = null; return; }
                d.active = true;
                this.hideTooltip();
                this.startGhost(d.src);
                document.body.classList.add('ui-dragging');
            }
            this.moveGhost(e.clientX, e.clientY);
            this.updateDropHighlight(e.clientX, e.clientY);
        }

        onPointerUp(e) {
            const d = this.drag;
            if (!d || e.pointerId !== d.pointerId) return;
            this.drag = null;
            if (!d.active) {
                // Plain tap/click
                if (d.src.kind === 'slot') {
                    this.activateSlot(d.src.index);
                } else if (d.src.kind === 'inv') {
                    if (e.shiftKey && d.src.count > 1) {
                        // Desktop Shift+Click on stack -> instant split dialog!
                        const emptyIdx = this.state ? this.state.inventory.firstEmpty() : -1;
                        if (emptyIdx < 0) {
                            this.showMessageAt(d.src.el, 'Нет свободных ячеек в сумке');
                            return;
                        }
                        this.openQuantityModal({
                            mode: 'split',
                            item: d.src.item,
                            totalCount: d.src.count,
                            max: d.src.count - 1,
                            initial: Math.floor(d.src.count / 2),
                            onConfirm: (count) => {
                                if (this.state) this.state.inventory.split(d.src.index, -1, count);
                            }
                        });
                        return;
                    }
                    this.showItemCard(d.src);
                } else if (d.pointerType !== 'mouse') {
                    // Touch: no hover, so a tap shows the tooltip for a moment
                    this.showSourceTooltip(d.src);
                    clearTimeout(this.tooltipTimer);
                    this.tooltipTimer = setTimeout(() => this.hideTooltip(), 2500);
                }
                return;
            }
            d.shiftKey = e.shiftKey || d.shiftKey;
            d.ctrlKey = e.ctrlKey || d.ctrlKey;
            this.finishDrag(d, e.clientX, e.clientY);
        }

        cancelDrag() {
            if (this.drag && this.drag.active) this.endDragVisuals();
            this.drag = null;
        }

        startGhost(src) {
            if (!this.ghost) return;
            this.ghost.innerHTML = '';
            this.ghost.appendChild(makeIcon(this.sourceIconDef(src)));
            this.ghost.classList.remove('hidden');
            if (src.el) src.el.classList.add('drag-source');
        }

        moveGhost(x, y) {
            if (this.ghost) this.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        }

        endDragVisuals() {
            if (this.ghost) this.ghost.classList.add('hidden');
            document.body.classList.remove('ui-dragging');
            document.querySelectorAll('.drop-ok, .drop-bad, .drag-source').forEach(el => el.classList.remove('drop-ok', 'drop-bad', 'drag-source'));
        }

        targetAt(x, y) {
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest) return null;
            const slot = el.closest('.hotbar-slot');
            if (slot) return { kind: 'slot', index: parseInt(slot.dataset.slot, 10), el: slot };
            const cell = el.closest('.inventory-cell');
            if (cell) return { kind: 'inv', index: parseInt(cell.dataset.cell, 10), el: cell };
            if (el.closest('#skill-bar')) return { kind: 'bar', el: null };
            return null;
        }

        /** Can src be dropped on target? true | false (invalid, red) | null (not a target at all). */
        dropVerdict(src, tgt) {
            if (!tgt || !tgt.el) return null;
            if (tgt.kind === 'slot') {
                if (src.kind === 'skill' || src.kind === 'slot') return true;
                if (src.kind === 'inv') return window.AveloraItems.canHotbar(src.item);
            }
            if (tgt.kind === 'inv') return src.kind === 'inv' ? true : null;
            return null;
        }

        updateDropHighlight(x, y) {
            const d = this.drag;
            const tgt = this.targetAt(x, y);
            const key = tgt && tgt.el ? tgt.el : null;
            if (d.over === key) return;
            if (d.over) d.over.classList.remove('drop-ok', 'drop-bad');
            d.over = key;
            const v = this.dropVerdict(d.src, tgt);
            if (key && v !== null) key.classList.add(v ? 'drop-ok' : 'drop-bad');
        }

        finishDrag(d, x, y) {
            this.endDragVisuals();
            const src = d.src;
            const tgt = this.targetAt(x, y);
            const st = this.state;
            if (!st) return;

            if (tgt && tgt.kind === 'slot') {
                if (src.kind === 'skill') {
                    this.bindSlot(tgt.index, { type: 'skill', id: src.id });
                } else if (src.kind === 'inv') {
                    if (window.AveloraItems.canHotbar(src.item)) {
                        this.bindSlot(tgt.index, { type: 'item', id: src.item });
                    } else {
                        this.flashSlot(tgt.el, 'reject');
                        this.showMessageAt(tgt.el, 'Нельзя: у предмета нет действия');
                    }
                } else if (src.kind === 'slot') {
                    st.swapHotbar(src.index, tgt.index);
                }
                return;
            }
            if (tgt && tgt.kind === 'inv' && src.kind === 'inv') {
                if (d.shiftKey && src.count > 1 && src.index !== tgt.index) {
                    // Shift-drag in backpack: split onto this specific target cell!
                    this.openQuantityModal({
                        mode: 'split',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count - 1,
                        initial: Math.floor(src.count / 2),
                        onConfirm: (count) => {
                            st.inventory.split(src.index, tgt.index, count);
                        }
                    });
                    return;
                }
                st.inventory.move(src.index, tgt.index);
                return;
            }
            // Dropped a hotbar binding anywhere off the bar -> clear it
            if (src.kind === 'slot' && !(tgt && tgt.kind === 'bar')) {
                st.setHotbar(src.index, null);
                return;
            }
            // Bag cell released over the game world (not over any panel/HUD) -> drop the stack there
            if (src.kind === 'inv' && !tgt && this.isOverWorld(x, y) && this.game.worldObjects) {
                if (src.count <= 1 || d.shiftKey) {
                    // Single item or Shift-drag: drop entire stack immediately!
                    this.game.worldObjects.dropFromInventory(src.index);
                } else if (d.ctrlKey) {
                    // Ctrl-drag on PC: drop exactly 1 item!
                    this.game.worldObjects.dropFromInventory(src.index, 1);
                } else {
                    // Open drop quantity modal!
                    this.openQuantityModal({
                        mode: 'drop',
                        item: src.item,
                        totalCount: src.count,
                        max: src.count,
                        initial: src.count,
                        onConfirm: (count) => {
                            this.game.worldObjects.dropFromInventory(src.index, count);
                        }
                    });
                }
                return;
            }
        }

        /** True when (x, y) is over the 3D world, not over any HUD element / panel (main.js UI_SELECTOR). */
        isOverWorld(x, y) {
            if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const sel = window.AVELORA_UI_SELECTOR || '#skill-bar, #inventory-panel, #skills-panel, #quantity-modal, #item-tooltip';
            return !(el.closest && el.closest(sel));
        }

        /** Binds a slot; the same skill/item bound elsewhere moves here (keeps the bar tidy). */
        bindSlot(index, entry) {
            const st = this.state;
            st.hotbar.forEach((e, i) => {
                if (i !== index && e && e.type === entry.type && e.id === entry.id) st.hotbar[i] = null;
            });
            st.setHotbar(index, entry); // saves + re-renders
            this.flashSlot(this.slots[index], 'pressed');
        }
    }

    window.AveloraHotbarUI = AveloraHotbarUI;
})();
