/**
 * Avelora — NPC dialog, shop and gold (AveloraDialog)
 *
 * Opened by world_objects.js (activate) when the player reaches an NPC prop (prop.json `"npc": "<id>"`,
 * NPC data in content/npcs/<id>/npc.json):
 *   { id, name, title, start, dialog: { <node>: { text, options: [{ text, next | action }] } },
 *     shop: { buy: [{ item, price? }], sell: true } }
 * Option actions: "close", "shop" (opens the buy/sell list). An item's price is its `value`
 * (item.json); selling pays half (min 1).
 * Also awards gold for killed creatures: creature.json `"gold": [min, max]` (window 'game:creatureKilled').
 * Gold itself is a counter in the character state (state.gold), shown under the bag grid.
 */
(function () {
    'use strict';

    const SELL_RATE = 0.5;

    function makeIconEl(def) {
        const el = document.createElement('div');
        el.className = 'dlg-icon';
        if (def && def.iconData) {
            const img = document.createElement('img');
            img.src = def.iconData; img.alt = '';
            el.appendChild(img);
        }
        return el;
    }

    class AveloraDialog {
        constructor(game, ui) {
            this.game = game;
            this.ui = ui;
            this.panel = document.getElementById('dialog-panel');
            this.npc = null;
            this.nodeId = null;
            this.mode = 'talk';      // 'talk' | 'buy' | 'sell' | 'teach' | 'reward' (quest tools / reward window)
            this.reward = null;      // { text, gold, xp, items: [{item, count, tag}], note } while mode === 'reward'
            if (this.panel) {
                this.portrait = this.panel.querySelector('.dlg-portrait');
                this.nameEl = this.panel.querySelector('.dlg-name');
                this.titleEl = this.panel.querySelector('.dlg-title');
                this.body = this.panel.querySelector('.dlg-body');
                const close = this.panel.querySelector('.dlg-close');
                if (close) close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.close();
                });
            }
            this.goldEl = document.getElementById('gold-amount');
            this.tracker = document.createElement('div');
            this.tracker.id = 'quest-tracker';
            ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(evt => {
                this.tracker.addEventListener(evt, (e) => e.stopPropagation());
            });
            document.body.appendChild(this.tracker);
            window.addEventListener('game:creatureKilled', (e) => this.onKilled(e.detail));
            window.addEventListener('game:questUpdated', () => { this.updateTracker(); if (this.isOpen()) this.render(); });
        }

        get state() { return this.game.gameState; }
        isOpen() { return !!this.npc; }
        isShopOpen() { return !!this.npc && this.mode !== 'talk' && this.mode !== 'reward' && !!(this.npc.shop && this.npc.shop.sell); }

        /** Price this NPC pays for one piece of an item (0 = not for sale). */
        sellPriceOf(itemId) {
            const def = window.AveloraItems.get(itemId);
            if (!def || this.isQuestItemOrTool(itemId, def)) return 0;
            if (def.sellPrice > 0) return Math.floor(def.sellPrice);
            return def.value > 0 ? Math.max(1, Math.floor(def.value * SELL_RATE)) : 0;
        }

        /** Quest items and tools handed out for quests cannot be sold to merchants. */
        isQuestItemOrTool(itemId, def) {
            if (!def) def = window.AveloraItems.get(itemId);
            if (!def) return false;
            if (def.category === 'quest' || def.questItem) return true;
            const quests = (window.GAME_CONTENT && window.GAME_CONTENT.quests) || {};
            for (const qid of Object.keys(quests)) {
                const q = quests[qid];
                if (q && q.tools && q.tools.some(t => t && t.item === itemId)) {
                    return true;
                }
            }
            return false;
        }

        /** Sell straight from a bag cell (item card button / drag onto the shop window). */
        sellFromBag(index, all) {
            const st = this.state;
            const c = st && st.inventory.cells[index];
            if (!c) return;
            const price = this.sellPriceOf(c.item);
            if (!price) { this.ui.floatText('Это не продаётся', 'warn'); return; }
            this.sell(c.item, price, all ? c.count : 1);
        }

        // -----------------------------------------------------------
        open(npc) {
            if (!this.panel || !npc) return;
            // Always reset position to left under player portrait on every open
            this.panel.dataset.dragged = '';
            this.panel.style.left = '';
            this.panel.style.top = '';
            this.panel.style.right = '';
            this.panel.style.bottom = '';
            this.panel.style.transform = '';
            this.npc = npc;
            this.nodeId = npc.start || 'start';
            this.mode = 'talk';
            if (this.nameEl) this.nameEl.textContent = npc.name || '';
            if (this.titleEl) this.titleEl.textContent = npc.title || '';
            if (this.portrait) {
                this.portrait.innerHTML = '';
                if (npc.iconData) {
                    const img = document.createElement('img');
                    img.src = npc.iconData; img.alt = npc.name || '';
                    this.portrait.appendChild(img);
                }
            }
            this.panel.classList.add('open');
            this.panel.classList.remove('shop-mode');
            this.panel.setAttribute('aria-hidden', 'false');
            this.render();
        }

        close() {
            this.npc = null;
            this.mode = 'talk';
            this.reward = null;
            if (this.ui && this.ui.hideTooltip) this.ui.hideTooltip();
            this.nodeId = null;
            if (this.panel) {
                if (document.activeElement && this.panel.contains(document.activeElement)) {
                    try { document.activeElement.blur(); } catch (_) {}
                }
                this.panel.classList.remove('open', 'shop-mode');
                this.panel.setAttribute('aria-hidden', 'true');
            }
            if (this.game.worldObjects && this.game.worldObjects.openContainer) {
                this.game.worldObjects.openContainer = null;
            }
            if (this.game.setInventoryOpen) {
                this.game.setInventoryOpen(false);
            }
        }

        /** Called on every state change (ui.renderAll): keep gold / shop lists current. */
        refresh() {
            const st = this.state;
            if (this.goldEl) this.goldEl.textContent = String(st ? st.gold : 0);
            this.updateTracker();
            if (this.npc && this.mode !== 'talk') this.render();
        }

        // -----------------------------------------------------------
        render() {
            if (!this.npc || !this.body) return;
            this.body.innerHTML = '';
            if (this.panel) {
                this.panel.classList.toggle('shop-mode', this.mode !== 'talk' && this.mode !== 'reward');
            }
            if (this.mode === 'talk') this.renderTalk();
            else if (this.mode === 'reward') this.renderReward();
            else if (this.mode === 'teach' || this.mode === 'teach_magic') this.renderTeach();
            else if (this.mode === 'teach_alchemy') this.renderTeachRecipes(['alchemy'], 'Алхимия');
            else if (this.mode === 'teach_craft') this.renderTeachRecipes(['carpentry', 'materials', 'refining', 'tailoring', 'equipment', 'jewelry'], 'Ремесло');
            else this.renderShop();
        }

        // -----------------------------------------------------------
        // Quests (content/quests/<id>/quest.json), offered by npc.quests = [ids]
        // -----------------------------------------------------------
        questDef(id) { return (window.GAME_CONTENT && window.GAME_CONTENT.quests && window.GAME_CONTENT.quests[id]) || null; }
        questProgress(q) {
            const o = q.objective || {}, st = this.state;
            let have = 0;
            if (st && o.type === 'collect') have = st.inventory.count(o.item);
            else if (st && o.type === 'kill') have = st.questKills[q.id] || 0;
            else if (o.type === 'talk') have = 1;
            else if (o.type === 'teleport_home') {
                const knows = st ? st.knowsSkill(o.skill || 'home_recall') : false;
                const visited = st ? st.getQuestFlag('home_camp_visited') : false;
                const returned = st ? st.getQuestFlag('home_camp_returned') : false;
                const ready = knows && visited && returned;
                const stepCount = (knows ? 1 : 0) + (visited ? 1 : 0) + (returned ? 1 : 0);
                return { have: stepCount, need: 3, ready, knows, visited, returned };
            }
            else if (o.type === 'craft_and_drink') {
                const crafted = st ? st.getQuestFlag(o.craftFlag || 'potion_health_small_crafted') : false;
                const drank = st ? st.getQuestFlag(o.drinkFlag || 'potion_health_small_drank') : false;
                const ready = crafted && drank;
                const stepCount = (crafted ? 1 : 0) + (drank ? 1 : 0);
                return { have: stepCount, need: 2, ready, crafted, drank };
            }
            else if (o.type === 'hit_creature' || o.type === 'learn_and_hit') {
                const hit = st ? st.getQuestFlag(o.flag || o.hitFlag || 'spark_hit_creature') : false;
                return { have: hit ? 1 : 0, need: 1, ready: hit, hit };
            }
            return { have: Math.min(have, o.count || 1), need: o.count || 1, ready: have >= (o.count || 1) };
        }

        /** Short objective line for the tracker: "Папоротник: 3/10", "Радужный барсук: 2/5". */
        questBadge(q, p) {
            if (!p) p = this.questProgress(q);
            const o = q.objective || {};
            if (p.ready) return 'К сдаче';
            if (o.type === 'craft_and_drink') {
                if (!p.crafted) return 'Приготовить зелье';
                if (!p.drank) return 'Выпить зелье';
                return 'К сдаче';
            }
            if (o.type === 'hit_creature' || o.type === 'learn_and_hit') {
                return p.ready ? 'К сдаче' : 'Поразить цель';
            }
            if (o.type === 'teleport_home') {
                if (!p.knows) return 'Выучить заклинание';
                if (!p.visited) return 'Телепорт домой';
                if (!p.returned) return 'Вернуться';
                return 'К сдаче';
            }
            if (o.type === 'talk') return 'Поговорить';
            return `${p.have}/${p.need}`;
        }

        questLabel(q, p) {
            const o = q.objective || {};
            const defs = window.GAME_CONTENT || {};
            if (o.type === 'talk') {
                return o.label || `Поговори с ${this.turnInName(q) || 'Лираэль'}`;
            }
            if (o.type === 'teleport_home') {
                if (!p.knows) return 'Выучи «Возвращение домой» у Лираэль';
                if (!p.visited) return 'Перенесись в домашний лагерь';
                if (!p.returned) return 'Вернись к Лираэль';
                return 'Поговори с Лираэль';
            }
            if (o.type === 'craft_and_drink') {
                if (!p.crafted) return 'Приготовь малое зелье здоровья (N)';
                if (!p.drank) return 'Выпей зелье здоровья в бою или из сумки';
                return 'Поговори с Лираэль';
            }
            if (o.type === 'hit_creature' || o.type === 'learn_and_hit') {
                if (!p.ready) return 'Порази «Искрой» любого монстра: 0/1';
                return `Поговори с ${this.turnInName(q) || 'Лираэль'}`;
            }
            const name = o.type === 'kill'
                ? (o.label || (((defs.creatures || {})[o.creature]) || {}).name || o.creature)
                : (window.AveloraItems.get(o.item) || {}).name || o.item;
            return `${name}: ${p.have}/${p.need}`;
        }

        /** Who hands the quest out / who takes the report (q.turnInNpc: report to another NPC than the giver). */
        questIsGiver(q) { return !q.giver || q.giver === this.npc.id; }
        questIsTurnIn(q) { return (q.turnInNpc || q.giver || this.npc.id) === this.npc.id; }
        turnInName(q) {
            const n = window.GAME_CONTENT && window.GAME_CONTENT.npcs && window.GAME_CONTENT.npcs[q.turnInNpc || q.giver];
            return n ? n.name : '';
        }

        questAvailable(q) {
            const st = this.state;
            if (!st) return false;
            if (!q.requires) return true;
            if (Array.isArray(q.requires)) return q.requires.every(id => st.questStatus(id) === 'done');
            return st.questStatus(q.requires) === 'done';
        }

        /** game:creatureKilled — counts kills for active kill quests; a quest may kill a creature for good. */
        questKilled(detail) {
            const st = this.state, defs = (window.GAME_CONTENT && window.GAME_CONTENT.quests) || {};
            if (!st || !detail) return;
            Object.keys(defs).forEach(id => {
                const q = defs[id], o = q.objective || {};
                if (st.questStatus(id) !== 'active' || o.type !== 'kill') return;
                if (Array.isArray(o.creatures) ? o.creatures.indexOf(detail.type) < 0 : o.creature !== detail.type) return;   // creatures: [..] — любой из перечисленных типов
                if (o.creatureId && o.creatureId !== detail.id) return;
                if ((st.questKills[id] || 0) < (o.count || 1)) st.addQuestKill(id);
                if (o.slayForGood && this.game.location) st.slay(this.game.location.id, detail.id);
                this.ui.floatText(this.questLabel(q, this.questProgress(q)), 'info', 0.6);
            });
        }

        updateTracker() {
            if (!this.tracker) return;
            const st = this.state;
            const lines = [];
            let hasReady = false;
            if (st) Object.keys(st.quests || {}).forEach(id => {
                if (st.quests[id] !== 'active') return;
                const q = this.questDef(id);
                if (!q) return;
                const p = this.questProgress(q);
                if (p.ready) hasReady = true;
                lines.push(`<div class="qt-row${p.ready ? ' ready' : ''}" data-quest="${id}"><b>${q.name}</b><span>${p.ready ? 'Вернись к ' + (this.giverName(q) || 'заказчику') : this.questLabel(q, p)}</span></div>`);
            });
            if (lines.length) {
                const iconChar = hasReady ? '?' : '!';
                this.tracker.innerHTML = `<div class="qt-btn-icon${hasReady ? ' ready' : ''}" title="Задания">${iconChar}</div><div class="qt-content"><div class="qt-title"><span>Задания</span><span class="qt-toggle" title="Свернуть задания">▸</span></div><div class="qt-list">${lines.join('')}</div></div>`;
                this.tracker.style.display = 'flex';

                // Hover on quest row shows reward tooltip
                const rows = this.tracker.querySelectorAll('.qt-row');
                rows.forEach(row => {
                    const qid = row.dataset.quest;
                    if (!qid) return;
                    const q = this.questDef(qid);
                    if (!q) return;

                    row.addEventListener('pointerenter', () => {
                        const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                        if (ui && ui.showQuestRewardTooltip) {
                            const p = this.questProgress(q);
                            const rw = this.getQuestRewards ? this.getQuestRewards(q) : { gold: 0, xp: 0, items: [] };
                            ui.showQuestRewardTooltip(row, {
                                id: qid,
                                title: q.name,
                                desc: q.summary || '',
                                completed: false,
                                badge: p.ready ? 'Вернись к ' + (this.giverName(q) || 'заказчику') : this.questLabel(q, p),
                                reward: rw
                            });
                        }
                    });

                    row.addEventListener('pointerleave', () => {
                        const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                        if (ui && ui.hideTooltip) ui.hideTooltip();
                    });
                });

                // Click when collapsed expands the tracker
                this.tracker.onclick = (e) => {
                    if (this.tracker.classList.contains('collapsed')) {
                        e.stopPropagation();
                        this.tracker.classList.remove('collapsed');
                    }
                };

                // Click on header / toggle button collapses tracker
                const title = this.tracker.querySelector('.qt-title');
                if (title) {
                    title.onclick = (e) => {
                        e.stopPropagation();
                        const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                        if (ui && ui.hideTooltip) ui.hideTooltip();
                        this.tracker.classList.add('collapsed');
                    };
                }

                // Click on quest row opens full quests log (ignoring scrollbar clicks)
                const list = this.tracker.querySelector('.qt-list');
                if (list) {
                    list.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
                    list.onclick = (e) => {
                        if (!e.target.closest('.qt-row')) return;
                        e.stopPropagation();
                        const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                        if (ui && ui.hideTooltip) ui.hideTooltip();
                        if (ui && ui.toggleQuests) {
                            ui.toggleQuests();
                        } else {
                            const qp = document.getElementById('quests-panel');
                            if (qp) {
                                qp.classList.toggle('open');
                                if (ui && ui.updateQuestsProgress) ui.updateQuestsProgress();
                            }
                        }
                    };
                }
            } else {
                const ui = this.ui || (this.game && this.game.ui) || window.AveloraHotbar;
                if (ui && ui.hideTooltip) ui.hideTooltip();
                this.tracker.innerHTML = '';
                this.tracker.style.display = 'none';
            }
        }

        giverName(q) {
            const n = window.GAME_CONTENT && window.GAME_CONTENT.npcs && window.GAME_CONTENT.npcs[q.turnInNpc || q.giver];
            return n ? n.name : '';
        }

        getQuestRewards(q) {
            if (!q || !q.reward) return { gold: 0, xp: 0, items: [] };
            const r = q.reward;
            const gold = r.gold || 0;
            const xp = r.xp || 0;
            const items = [];
            if (Array.isArray(r.items)) {
                r.items.forEach(it => { if (it && it.item) items.push(it); });
            }
            const cfg = this.game.currentCharacterConfig;
            const charId = (cfg && cfg.id) || (this.game.character && this.game.character.id) || 'mage';
            if (r.classItems && r.classItems[charId]) {
                r.classItems[charId].forEach(it => { if (it && it.item) items.push(it); });
            }
            return { gold, xp, items };
        }

        questNode(id) {
            const q = this.questDef(id), st = this.state;
            if (!q || !st) return { text: '…', options: [{ text: 'Назад', next: 'start' }] };
            const status = st.questStatus(id), d = q.dialog || {};
            if (!status) {
                const rw = this.getQuestRewards(q);
                return {
                    text: d.offer,
                    rewards: (rw.gold || rw.xp || rw.items.length) ? rw : null,
                    items: this.questTools(q).length ? { label: d.toolsOffer || 'Для этого задания тебе дадут инструмент:', list: this.questTools(q).map(t => ({ item: t.item, count: t.count || 1 })) } : null,
                    options: [{ text: d.accept, action: 'questAccept', quest: id }, { text: d.decline || 'Позже', next: 'start' }]
                };
            }
            const p = this.questProgress(q);
            if (status === 'active' && !this.questIsTurnIn(q)) return { text: d.away || d.progress, options: [{ text: 'Отказаться от задания', action: 'questAbandon', quest: id }, { text: 'Назад', next: 'start' }] };
            if (status === 'active' && p.ready) return { text: d.ready || d.progress, options: [{ text: d.turnIn || 'Сдать', action: 'questTurnIn', quest: id }, { text: 'Отказаться от задания', action: 'questAbandon', quest: id }, { text: 'Назад', next: 'start' }] };
            if (status === 'active') return { text: d.progress, options: [{ text: 'Отказаться от задания', action: 'questAbandon', quest: id }, { text: 'Назад', next: 'start' }] };
            return { text: d.done, options: [{ text: 'Назад', next: 'start' }] };
        }

        abandonQuest(id) {
            const q = this.questDef(id), st = this.state;
            if (!q || !st || st.questStatus(id) !== 'active') return;

            // Remove tools given for this quest (e.g. axe, pickaxe) from hands, bag, chests, and ground
            const tools = q.tools || [];
            let unequippedAny = false;
            tools.forEach(t => {
                if (!t || !t.item) return;
                const itemId = t.item;
                const count = t.count || 1;

                // 1. If equipped in hand/slot
                if (st.equippedSlotsOf) {
                    st.equippedSlotsOf(itemId).forEach(s => {
                        st.equipped[s] = null;
                        unequippedAny = true;
                    });
                } else {
                    const slot = st.equippedSlotOf(itemId);
                    if (slot) {
                        st.equipped[slot] = null;
                        unequippedAny = true;
                    }
                }

                // 2. Remove from bag
                st.inventory.remove(itemId, count);

                // 3. Remove from chests if placed there
                if (st.chestInvs) {
                    Object.values(st.chestInvs).forEach(chestInv => {
                        if (chestInv && typeof chestInv.remove === 'function') {
                            chestInv.remove(itemId, count);
                        }
                    });
                }

                // 4. Remove from saved ground piles in all locations
                if (st.ground) {
                    Object.keys(st.ground).forEach(locId => {
                        if (Array.isArray(st.ground[locId])) {
                            st.ground[locId] = st.ground[locId].filter(g => g && g.item !== itemId);
                            if (!st.ground[locId].length) delete st.ground[locId];
                        }
                    });
                }

                // 5. Remove visual 3D dropped pile from current scene
                if (this.game.worldObjects && this.game.worldObjects.removeDynamicPilesOfItem) {
                    this.game.worldObjects.removeDynamicPilesOfItem(itemId);
                }
            });

            st.abandonQuest(id);

            if (unequippedAny && this.ui && this.ui.applyEquipment) {
                this.ui.applyEquipment();
            }

            if (this.ui) {
                this.ui.floatText(`Задание «${q.name}» отменено`, 'warn');
                if (this.ui.updateQuestsProgress) this.ui.updateQuestsProgress();
                if (this.ui.renderAll) this.ui.renderAll();
            }
            this.updateTracker();

            if (this.isOpen()) {
                this.nodeId = (this.npc && this.npc.start) || 'start';
                this.render();
            }
        }

        renderTalk() {
            let node = (this.npc.dialog || {})[this.nodeId];
            if (this.nodeId && this.nodeId.indexOf('quest:') === 0) node = this.questNode(this.nodeId.slice(6));
            else if (node && this.nodeId === (this.npc.start || 'start') && this.npc.quests) {
                // Доступные (ещё не взятые) квесты идут в самый верх, взятые квесты переносятся ниже
                const available = [];
                const ready = [];
                const inProgress = [];
                this.npc.quests.forEach(qid => {
                    const q = this.questDef(qid), st = this.state;
                    if (!q || !st || !this.questAvailable(q)) return;
                    const status = st.questStatus(qid);
                    if (status === 'done') return;
                    const giver = this.questIsGiver(q), turnIn = this.questIsTurnIn(q);
                    if (!status && !giver) return;                    // only the giver offers a quest
                    if (status === 'active' && !turnIn) return;       // active quest only shown to the turnIn NPC
                    const p = this.questProgress(q);
                    let questType = 'available';
                    let label = q.name;
                    if (status === 'active') {
                        if (p.ready) {
                            questType = 'ready';
                            label = q.name;
                        } else {
                            questType = 'progress';
                            label = q.name + ` (${p.have}/${p.need})`;
                        }
                    }
                    const entry = {
                        text: label,
                        next: 'quest:' + qid,
                        quest: true,
                        questType: questType,
                        ready: p.ready
                    };
                    if (!status) {
                        available.push(entry);
                    } else if (p.ready) {
                        ready.push(entry);
                    } else {
                        inProgress.push(entry);
                    }
                });
                const extra = ready.concat(available, inProgress);
                node = Object.assign({}, node, { options: extra.concat(node.options || []) });
            }
            const text = document.createElement('div');
            text.className = 'dlg-text';
            text.textContent = node ? node.text : '…';
            this.body.appendChild(text);
            if (node && node.rewards) {
                const rw = node.rewards;
                const lab = document.createElement('div');
                lab.className = 'dlg-note dlg-reward-header';
                lab.textContent = 'Награда за выполнение:';
                this.body.appendChild(lab);
                const box = document.createElement('div');
                box.className = 'dlg-rewards';
                const line = (html) => { const d = document.createElement('div'); d.className = 'dlg-reward-line'; d.innerHTML = html; box.appendChild(d); };
                if (rw.gold) line(`<span class="coin"></span> +${rw.gold} монет`);
                if (rw.xp) line(`⭐ +${rw.xp} опыта`);
                (rw.items || []).forEach(it => box.appendChild(this.itemRowEl(it.item, { count: it.count, equip: false })));
                this.body.appendChild(box);
            }
            if (node && node.items && node.items.list && node.items.list.length) {
                const lab = document.createElement('div');
                lab.className = 'dlg-note';
                lab.textContent = node.items.label;
                this.body.appendChild(lab);
                const box = document.createElement('div');
                box.className = 'dlg-rewards';
                node.items.list.forEach(it => box.appendChild(this.itemRowEl(it.item, { count: it.count, equip: false })));
                this.body.appendChild(box);
            }
            const opts = document.createElement('div');
            opts.className = 'dlg-options';
            ((node && node.options) || [{ text: 'До встречи', action: 'close' }]).forEach(o => {
                const b = document.createElement('button');
                b.type = 'button';
                let prefix = '';
                let questClass = '';
                if (o.quest) {
                    if (o.questType === 'ready') {
                        prefix = '[Сдать] ';
                        questClass = ' quest-ready';
                    } else if (o.questType === 'progress') {
                        prefix = '[В процессе] ';
                        questClass = ' quest-progress';
                    } else {
                        prefix = '[Новое] ';
                        questClass = ' quest-available';
                    }
                } else if (o.action === 'shop') {
                    prefix = '[Торговля] ';
                } else if (o.action === 'teach' || o.action === 'teach_magic' || o.action === 'teach_alchemy' || o.action === 'teach_craft') {
                    prefix = '[Обучение] ';
                } else if (o.action === 'questAbandon') {
                    prefix = '[Отмена] ';
                }
                b.className = 'dlg-opt' + (o.action === 'shop' ? ' shop' : '') + (o.quest ? ' quest' + questClass : '') + (o.action === 'questAbandon' ? ' abandon' : '');
                b.textContent = prefix + o.text;
                b.addEventListener('click', (e) => { e.stopPropagation(); this.choose(o); });
                opts.appendChild(b);
            });
            this.body.appendChild(opts);
        }

        choose(o) {
            if (o.action === 'close') {
                this.close();
            } else if (o.action === 'questAbandon') {
                this.abandonQuest(o.quest);
            } else if (o.action === 'questAccept') {
                const aq = this.questDef(o.quest);
                if (this.state.startQuest(o.quest)) {
                    this.ui.floatText('Новое задание', 'good');
                    // Tools the quest hands out (axe for logs, pickaxe for ore): given now, shown in a window with "Надеть"
                    const tools = aq ? this.questTools(aq) : [];
                    if (tools.length) {
                        const given = this.grantItems(tools);
                        const ad = (aq && aq.dialog) || {};
                        this.reward = { text: ad.tools || 'Держи инструмент для этой работы:', gold: 0, xp: 0, items: given.map(g => ({ item: g.item, count: g.count })), note: '' };
                        this.mode = 'reward';
                        this.render();
                        return;
                    }
                }
                this.nodeId = this.npc.start || 'start';
                this.render();
            } else if (o.action === 'questTurnIn') {
                const q = this.questDef(o.quest), st = this.state;
                if (q && st && st.questStatus(o.quest) === 'active' && this.questProgress(q).ready) {
                    if (q.objective.type === 'collect') st.inventory.remove(q.objective.item, q.objective.count);
                    if (q.reward && q.reward.gold) st.addGold(q.reward.gold);
                    if (q.reward && q.reward.xp && this.game.hero) this.game.hero.addXp(q.reward.xp);
                    const gave = this.giveClassRewards(q).concat(q.reward && q.reward.items ? this.grantItems(q.reward.items) : []);
                    st.completeQuest(o.quest);
                    this.ui.floatText('Задание выполнено' + (q.reward && q.reward.gold ? ` · +${q.reward.gold} зол.` : ''), 'good');
                    // Reward window: gold, xp, items with "Надеть" and a comparison tooltip; tools stay with the hero
                    const qd = q.dialog || {};
                    const kept = (q.tools || []).filter(t => t && t.item && st.ownedCount(t.item) > 0).map(t => ({ item: t.item, count: 1, tag: 'остаётся у тебя' }));
                    this.reward = { text: qd.reward || `Награда за задание «${q.name}»:`, gold: (q.reward && q.reward.gold) || 0, xp: (q.reward && q.reward.xp) || 0, items: gave.map(g => ({ item: g.item, count: g.count })).concat(kept), note: qd.keep || '' };
                    this.mode = 'reward';
                    this.render();
                    return;
                }
                this.nodeId = this.npc.start || 'start';
                this.render();
            } else if (o.action === 'teach' || o.action === 'teach_magic') {
                this.mode = 'teach_magic';
                this.render();
            } else if (o.action === 'teach_alchemy') {
                this.mode = 'teach_alchemy';
                this.render();
            } else if (o.action === 'teach_craft') {
                this.mode = 'teach_craft';
                this.render();
            } else if (o.action === 'shop') {
                this.mode = 'buy';
                this.game.setInventoryOpen(true);
                this.render();
            } else if (o.next) {
                this.nodeId = o.next;
                this.render();
            }
        }

        /** reward.classItems = { <characterId>: [{item, count}] } — e.g. the first weapon (staff for the mage, bow for the archer). */
        giveClassRewards(q) {
            const ci = q.reward && q.reward.classItems;
            const cfg = this.game.currentCharacterConfig;
            const list = ci && cfg && ci[cfg.id];
            return list ? this.grantItems(list) : [];
        }

        /** Item ids of q.tools the hero does not own yet: shown in the offer, handed out on accept. */
        questTools(q) {
            const st = this.state;
            return ((q && q.tools) || []).filter(t => t && t.item && window.AveloraItems.get(t.item) && !(st && st.ownedCount(t.item) > 0));
        }

        /** Puts [{item, count}] into the bag (the rest drops at the hero's feet). Returns what was handed out. */
        grantItems(list) {
            const st = this.state, given = [];
            if (!list || !st || !st.inventory) return given;
            const defs = window.AveloraItems;
            list.forEach(r => {
                given.push({ item: r.item, count: r.count || 1 });
                const added = st.inventory.add(r.item, r.count || 1);
                const def = defs ? defs.get(r.item) : null;
                const name = def ? def.name : r.item;
                if (added > 0) this.ui.floatText(`Получено: ${name}`, 'loot', 0.4);
                if (added < (r.count || 1) && this.game.worldObjects && this.game.character) {
                    const c = this.game.character;
                    this.game.worldObjects.addDrop(r.item, (r.count || 1) - added, c.position.x, c.position.z);
                    this.ui.floatText('Сумка полна — награда брошена на землю', 'warn', 0.8);
                }
            });
            return given;
        }

        /** One item line (icon, name, stats, optional "Надеть" button); hover / tap shows the comparison tooltip. */
        itemRowEl(id, opts) {
            opts = opts || {};
            const def = window.AveloraItems.get(id), st = this.state, ui = this.ui;
            const row = document.createElement('div');
            row.className = 'dlg-row dlg-reward-item';
            row.appendChild(makeIconEl(def));
            const n = document.createElement('div');
            n.className = 'dlg-row-name';
            const nm = document.createElement('div');
            nm.textContent = (def ? def.name : id) + (opts.count > 1 ? ` ×${opts.count}` : '');
            const ds = document.createElement('div');
            ds.className = 'dlg-row-desc';
            ds.textContent = (ui && ui.itemStatsLine && def) ? ui.itemStatsLine(def) : '';
            n.append(nm, ds);
            row.appendChild(n);
            if (opts.tag) {
                const tg = document.createElement('div');
                tg.className = 'dlg-tag';
                tg.textContent = opts.tag;
                row.appendChild(tg);
            }
            if (opts.equip && def && def.use && def.use.type === 'equip') {
                const worn = !!(st && st.equippedSlotOf(id));
                const have = !!(st && st.inventory.count(id) > 0);
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-buy' + ((worn || !have) ? ' disabled' : '');
                b.textContent = worn ? 'Надето' : (have ? 'Надеть' : 'Нет в сумке');
                b.disabled = worn || !have;
                b.addEventListener('click', (e) => { e.stopPropagation(); if (ui.equip(id)) this.render(); });
                row.appendChild(b);
            }
            if (ui && ui.showCompareTooltip) {
                row.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') ui.showCompareTooltip(row, id); });
                row.addEventListener('pointerleave', () => ui.hideTooltip());
                row.addEventListener('click', (e) => {   // tap (phones): show the card for a few seconds
                    if (e.target.closest('button')) return;
                    ui.showCompareTooltip(row, id);
                    clearTimeout(ui.tooltipTimer);
                    ui.tooltipTimer = setTimeout(() => ui.hideTooltip(), 5000);
                });
            }
            return row;
        }

        /** Window shown after accepting a quest with tools, and after turning one in (gold, xp, items). */
        renderReward() {
            const r = this.reward || {}, ui = this.ui;
            if (ui && ui.hideTooltip) ui.hideTooltip();
            const text = document.createElement('div');
            text.className = 'dlg-text';
            text.textContent = r.text || '';
            this.body.appendChild(text);
            const box = document.createElement('div');
            box.className = 'dlg-rewards';
            const line = (html) => { const d = document.createElement('div'); d.className = 'dlg-reward-line'; d.innerHTML = html; box.appendChild(d); };
            if (r.gold) line(`<span class="coin"></span> +${r.gold} золота`);
            if (r.xp) line(`✦ +${r.xp} опыта`);
            (r.items || []).forEach(it => box.appendChild(this.itemRowEl(it.item, { count: it.count, equip: true, tag: it.tag })));
            this.body.appendChild(box);
            if (r.note) {
                const nt = document.createElement('div');
                nt.className = 'dlg-note';
                nt.textContent = r.note;
                this.body.appendChild(nt);
            }
            const opts = document.createElement('div');
            opts.className = 'dlg-options';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'dlg-opt';
            b.textContent = 'Хорошо';
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.reward = null;
                this.nodeId = this.npc.start || 'start';
                if (ui && ui.hideTooltip) ui.hideTooltip();
                this.render();
            });
            opts.appendChild(b);
            this.body.appendChild(opts);
        }

        // -----------------------------------------------------------
        // Shop
        // -----------------------------------------------------------
        // -----------------------------------------------------------
        // Teaching: the skills of the current character that it has not learned yet
        // -----------------------------------------------------------
        renderTeach() {
            const st = this.state;
            const cfg = this.game.currentCharacterConfig;
            const basePrice = (this.npc.teach && this.npc.teach.price !== undefined) ? this.npc.teach.price : 1;
            const tabs = document.createElement('div');
            tabs.className = 'dlg-tabs';
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'dlg-tab back';
            back.textContent = '← Назад';
            back.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.nodeId = this.npc.start || 'start';
                this.render();
            });
            const gold = document.createElement('div');
            gold.className = 'dlg-gold';
            gold.innerHTML = '<span class="coin"></span> ' + (st ? st.gold : 0);
            tabs.append(back, gold);
            this.body.appendChild(tabs);

            const list = document.createElement('div');
            list.className = 'dlg-list';
            const heroLevel = this.game.hero ? this.game.hero.level : 1;
            const lvlOf = (sid) => { const d = this.game.skills && this.game.skills.get(sid); return (d && d.requiresLevel) || 1; };
            const ids = ((window.AveloraState && cfg) ? window.AveloraState.skillCatalog(cfg.id) : []).slice()
                .sort((a, b) => lvlOf(a) - lvlOf(b));
            ids.forEach(id => {
                const def = this.game.skills ? this.game.skills.get(id) : null;
                if (!def) return;
                const known = !!st && st.knowsSkill(id);
                if (known) return; // learned skills disappear from the teach list
                const need = def.requiresLevel || 1;
                const locked = heroLevel < need;
                const price = (def.price !== undefined) ? def.price : basePrice;
                const row = document.createElement('div');
                row.className = 'dlg-row' + (locked ? ' locked' : '');
                row.appendChild(makeIconEl(def));
                const n = document.createElement('div');
                n.className = 'dlg-row-name';
                n.innerHTML = '';
                const t = document.createElement('div'); t.textContent = def.name;
                const d = document.createElement('div'); d.className = 'dlg-row-desc'; d.textContent = def.description || '';
                n.append(t, d);
                row.appendChild(n);
                if (known) {
                    const k = document.createElement('div');
                    k.className = 'dlg-row-price';
                    k.textContent = 'Изучено';
                    row.appendChild(k);
                } else {
                    const p = document.createElement('div');
                    p.className = 'dlg-row-price';
                    p.innerHTML = locked ? `<span class="dlg-lvl">с ${need}-го ур.</span>` : `<span class="coin"></span> ${price}`;
                    const b = document.createElement('button');
                    b.type = 'button';
                    const canBuy = !locked && st && st.gold >= price;
                    b.className = 'dlg-buy' + (canBuy ? '' : ' disabled');
                    b.textContent = locked ? 'Закрыто' : 'Изучить';
                    b.disabled = !canBuy;
                    if (locked) b.title = `Нужен ${need}-й уровень (у вас ${heroLevel}-й)`;
                    b.addEventListener('click', (e) => { e.stopPropagation(); this.learn(id, price); });
                    row.append(p, b);
                }
                list.appendChild(row);
            });
            if (!list.children.length) {
                const e = document.createElement('div');
                e.className = 'dlg-empty';
                e.textContent = 'Ты уже знаешь всё, чему я могу тебя научить.';
                list.appendChild(e);
            }
            this.body.appendChild(list);
        }

        learn(skillId, price) {
            const st = this.state;
            if (!st || st.knowsSkill(skillId)) return;
            const sdef = this.game.skills ? this.game.skills.get(skillId) : null;
            const need = (sdef && sdef.requiresLevel) || 1;
            if (this.game.hero && this.game.hero.level < need) { this.ui.floatText(`Нужен ${need}-й уровень`, 'warn'); return; }
            if (!st.spendGold(price)) { this.ui.floatText('Не хватает золота', 'warn'); return; }
            st.learnSkill(skillId);
            const def = this.game.skills ? this.game.skills.get(skillId) : null;
            this.ui.floatText(`Изучено: ${def ? def.name : skillId}`, 'loot');
            window.dispatchEvent(new CustomEvent('game:questUpdated'));
            this.render();
        }

        renderTeachRecipes(categories, titleText) {
            const st = this.state;
            const tabs = document.createElement('div');
            tabs.className = 'dlg-tabs';
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'dlg-tab back';
            back.textContent = '← Назад';
            back.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.nodeId = this.npc.start || 'start';
                this.render();
            });
            const gold = document.createElement('div');
            gold.className = 'dlg-gold';
            gold.innerHTML = '<span class="coin"></span> ' + (st ? st.gold : 0);
            tabs.append(back, gold);
            this.body.appendChild(tabs);

            const list = document.createElement('div');
            list.className = 'dlg-list';
            const heroLevel = this.game.hero ? this.game.hero.level : 1;
            const allRecipes = (window.GAME_CONTENT && window.GAME_CONTENT.recipes) || {};
            const rids = Object.keys(allRecipes).filter(id => {
                const r = allRecipes[id];
                if (!r) return false;
                const cat = r.category || 'other';
                return categories.includes(cat);
            }).sort((a, b) => {
                const la = allRecipes[a].requiresLevel || 1;
                const lb = allRecipes[b].requiresLevel || 1;
                return la - lb;
            });

            rids.forEach(id => {
                const rec = allRecipes[id];
                const resItemDef = window.AveloraItems.get(rec.result.item);
                const known = !!st && st.knowsRecipe(id);
                if (known) return; // learned recipes disappear from the teach list
                const need = rec.requiresLevel || 1;
                const locked = heroLevel < need;
                const price = rec.price || 10;
                const row = document.createElement('div');
                row.className = 'dlg-row' + (locked ? ' locked' : '');
                row.appendChild(makeIconEl(resItemDef || rec));
                const n = document.createElement('div');
                n.className = 'dlg-row-name';
                const t = document.createElement('div');
                t.textContent = rec.name || (resItemDef ? resItemDef.name : id);
                const d = document.createElement('div');
                d.className = 'dlg-row-desc';
                d.textContent = rec.description || (resItemDef ? resItemDef.description : '');
                n.append(t, d);
                row.appendChild(n);

                const p = document.createElement('div');
                p.className = 'dlg-row-price';
                p.innerHTML = locked ? `<span class="dlg-lvl">с ${need}-го ур.</span>` : `<span class="coin"></span> ${price}`;
                const b = document.createElement('button');
                b.type = 'button';
                const canBuy = !locked && st && st.gold >= price;
                b.className = 'dlg-buy' + (canBuy ? '' : ' disabled');
                b.textContent = locked ? 'Закрыто' : 'Изучить';
                b.disabled = !canBuy;
                if (locked) b.title = `Нужен ${need}-й уровень (у вас ${heroLevel}-й)`;
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!st || st.knowsRecipe(id)) return;
                    if (heroLevel < need) { this.ui.floatText(`Нужен ${need}-й уровень`, 'warn'); return; }
                    if (!st.spendGold(price)) { this.ui.floatText('Не хватает золота', 'warn'); return; }
                    st.learnRecipe(id);
                    this.ui.floatText(`Изучен рецепт: ${rec.name}`, 'loot');
                    this.render();
                });
                row.append(p, b);
                list.appendChild(row);
            });

            if (!list.children.length) {
                const e = document.createElement('div');
                e.className = 'dlg-empty';
                e.textContent = 'Ты уже знаешь все эти рецепты.';
                list.appendChild(e);
            }
            this.body.appendChild(list);
        }

        renderShop() {
            const st = this.state;
            const shop = this.npc.shop || {};
            const tabs = document.createElement('div');
            tabs.className = 'dlg-tabs';
            [['buy', 'Купить'], ['sell', 'Продать']].forEach(([m, label]) => {
                if (m === 'sell' && !shop.sell) return;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-tab' + (this.mode === m ? ' active' : '');
                b.textContent = label;
                b.addEventListener('click', (e) => { e.stopPropagation(); this.mode = m; this.render(); });
                tabs.appendChild(b);
            });
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'dlg-tab back';
            back.textContent = '← Назад';
            back.addEventListener('click', (e) => {
                e.stopPropagation();
                this.mode = 'talk';
                this.nodeId = this.npc.start || 'start';
                if (this.game.setInventoryOpen) this.game.setInventoryOpen(false);
                this.render();
            });
            tabs.appendChild(back);
            const gold = document.createElement('div');
            gold.className = 'dlg-gold';
            gold.innerHTML = '<span class="coin"></span> ' + (st ? st.gold : 0);
            tabs.appendChild(gold);
            this.body.appendChild(tabs);

            const list = document.createElement('div');
            list.className = 'dlg-list';
            if (this.mode === 'buy') {
                (shop.buy || []).forEach(g => {
                    const def = window.AveloraItems.get(g.item);
                    if (!def) return;
                    const price = g.price !== undefined ? g.price : (def.value || 1);
                    this.addRow(list, def, def.name, `${price}`, 'Купить', !!st && st.gold >= price, () => this.buy(def.id, price));
                });
            } else {
                const seen = new Set();
                const inv = st ? st.inventory : null;
                (inv ? inv.cells : []).forEach(c => {
                    if (!c || seen.has(c.item)) return;
                    seen.add(c.item);
                    const def = window.AveloraItems.get(c.item);
                    if (!def || !(def.value > 0)) return;
                    const price = this.sellPriceOf(c.item);
                    const have = inv.count(c.item);
                    this.addRow(list, def, `${def.name} ×${have}`, `${price}`, 'Продать', true, () => this.sell(c.item, price, 1),
                        have > 1 ? { label: 'Все', fn: () => this.sell(c.item, price, have) } : null);
                });
                if (!list.children.length) {
                    const e = document.createElement('div');
                    e.className = 'dlg-empty';
                    e.textContent = 'Нечего продать';
                    list.appendChild(e);
                }
            }
            this.body.appendChild(list);
        }

        addRow(list, def, label, price, btnLabel, enabled, fn, extra) {
            const row = document.createElement('div');
            row.className = 'dlg-row';
            row.appendChild(makeIconEl(def));
            const n = document.createElement('div');
            n.className = 'dlg-row-name';
            n.textContent = label;
            const p = document.createElement('div');
            p.className = 'dlg-row-price';
            p.innerHTML = `<span class="coin"></span> ${price}`;
            row.append(n, p);
            const mk = (txt, f, en) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'dlg-buy' + (en ? '' : ' disabled');
                b.textContent = txt;
                b.disabled = !en;
                b.addEventListener('click', (e) => { e.stopPropagation(); f(); });
                return b;
            };
            row.appendChild(mk(btnLabel, fn, enabled));
            if (extra) row.appendChild(mk(extra.label, extra.fn, true));
            list.appendChild(row);
        }

        buy(itemId, price) {
            const st = this.state;
            if (!st) return;
            if (st.inventory.spaceFor(itemId) < 1) { this.ui.floatText('В сумке нет места', 'warn'); return; }
            if (!st.spendGold(price)) { this.ui.floatText('Не хватает золота', 'warn'); return; }
            st.inventory.add(itemId, 1);
            const def = window.AveloraItems.get(itemId);
            this.ui.floatText(`Куплено: ${def ? def.name : itemId}`, 'loot');
        }

        sell(itemId, price, count) {
            const st = this.state;
            if (!st) return;
            const n = st.inventory.remove(itemId, count);
            if (n <= 0) return;
            st.addGold(n * price);
            this.ui.floatText(`+${n * price} золота`, 'gain');
        }

        // -----------------------------------------------------------
        // Gold from kills
        // -----------------------------------------------------------
        onKilled(detail) {
            const st = this.state;
            if (!st || !detail) return;
            this.questKilled(detail);
            const defs = (window.GAME_CONTENT && window.GAME_CONTENT.creatures) || {};
            const def = defs[detail.type];
            if (!def || !Array.isArray(def.gold)) return;
            const mult = Number.isFinite(detail.levelMult) ? detail.levelMult : 1;
            const lo = Math.max(0, Math.floor((def.gold[0] || 0) * mult)), hi = Math.max(lo, Math.floor((def.gold[1] || lo) * mult));
            const n = lo + Math.floor(Math.random() * (hi - lo + 1));
            if (n <= 0) return;
            st.addGold(n);
            this.ui.floatText(`+${n} золота`, 'gain', 0.3);
        }
    }

    window.AveloraDialog = AveloraDialog;
})();
