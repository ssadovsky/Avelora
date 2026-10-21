/**
 * Avelora — Character Slots & Selection System (WoW style)
 *
 * Manages up to 5 character slots with independent progress, location,
 * equipment, inventory, and stats. Seamlessly migrates legacy single-character
 * saves without losing any progress.
 */
(function () {
    'use strict';

    const SLOTS_KEY = 'avelora_character_slots';
    const MAX_SLOTS = 8;

    function formatTime(totalSec) {
        const sec = Math.floor(totalSec || 0);
        const hrs = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        if (hrs > 0) return `${hrs} ч ${mins} мин`;
        if (mins > 0) return `${mins} мин`;
        return `${sec} с`;
    }

    function normalizeLegacyKeys(slots) {
        if (!Array.isArray(slots)) return;
        let modified = false;
        slots.forEach(slot => {
            if (slot.saveId === 'mage' || slot.saveId === 'archer' || slot.saveId === 'warrior') {
                const oldSaveKey = 'avelora_save_' + slot.saveId;
                const oldStateKey = 'avelora_state_' + slot.saveId;
                const newSaveId = slot.slotId || ('slot_' + Date.now());
                const newSaveKey = 'avelora_save_' + newSaveId;
                const newStateKey = 'avelora_state_' + newSaveId;

                const saveRaw = localStorage.getItem(oldSaveKey);
                if (saveRaw) {
                    try {
                        const parsedSave = JSON.parse(saveRaw);
                        parsedSave.characterId = newSaveId;
                        localStorage.setItem(newSaveKey, JSON.stringify(parsedSave));
                        localStorage.removeItem(oldSaveKey);
                    } catch (_) {}
                }

                const stateRaw = localStorage.getItem(oldStateKey);
                if (stateRaw) {
                    try {
                        const parsedState = JSON.parse(stateRaw);
                        parsedState.characterId = newSaveId;
                        localStorage.setItem(newStateKey, JSON.stringify(parsedState));
                        localStorage.removeItem(oldStateKey);
                    } catch (_) {}
                }

                slot.saveId = newSaveId;
                modified = true;
            }
        });
        if (modified) {
            saveSlots(slots);
        }
    }

    function getSlots() {
        let raw = null;
        try {
            raw = localStorage.getItem(SLOTS_KEY);
        } catch (e) {
            console.warn('[AveloraSlots] localStorage error', e);
        }

        if (!raw) {
            return [];
        }

        try {
            const slots = JSON.parse(raw);
            if (Array.isArray(slots)) {
                if (slots.length > 0) normalizeLegacyKeys(slots);
                return slots;
            }
        } catch (e) {
            console.warn('[AveloraSlots] corrupt slots JSON', e);
        }
        return [];
    }

    function saveSlots(slots) {
        try {
            localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
        } catch (e) {
            console.warn('[AveloraSlots] could not write slots', e);
        }
    }

    function getSlotDetails(slot) {
        if (!slot) return null;
        const catalog = window.CHARACTER_CATALOG || [];
        const charCfg = catalog.find(c => c.id === slot.classId) || catalog[0] || {};

        let save = null;
        if (window.AveloraSave && window.AveloraSave.loadSave) {
            save = window.AveloraSave.loadSave(slot.saveId);
        }

        let state = null;
        try {
            const raw = localStorage.getItem('avelora_state_' + slot.saveId);
            if (raw) state = JSON.parse(raw);
        } catch (e) { /* ignore */ }

        const xp = (state && typeof state.xp === 'number') ? state.xp : 0;
        let level = 1;
        if (window.AveloraProgress && window.AveloraProgress.levelForXp) {
            level = window.AveloraProgress.levelForXp(xp);
        }

        const locId = (save && save.locationId) || window.START_LOCATION || 'forestEdge';
        const locObj = window.LOCATIONS && window.LOCATIONS[locId];
        const locationName = (locObj && locObj.name) || 'Долина';

        const playTime = state && state.playTime ? state.playTime : 0;
        const gold = state && typeof state.gold === 'number' ? state.gold : 0;

        return {
            slotId: slot.slotId,
            saveId: slot.saveId,
            classId: slot.classId,
            name: slot.name || charCfg.name || 'Герой',
            className: charCfg.className || 'Искатель приключений',
            icon: charCfg.icon || '🔮',
            portrait: charCfg.portrait || 'heroPortrait_mage',
            charConfig: charCfg,
            level: level,
            xp: xp,
            gold: gold,
            locationId: locId,
            locationName: locationName,
            playTimeStr: formatTime(playTime),
            hasSave: !!save || !!state,
            savedAt: (save && save.savedAt) || slot.createdAt || Date.now()
        };
    }

    function createCharacter(classId, customName) {
        const slots = getSlots();
        if (slots.length >= MAX_SLOTS) {
            alert('Все слоты персонажей заняты (максимум ' + MAX_SLOTS + '). Удалите одного из персонажей.');
            return null;
        }

        const catalog = window.CHARACTER_CATALOG || [];
        const charCfg = catalog.find(c => c.id === classId) || catalog[0];

        const slotUid = 'slot_' + Date.now();
        const newSlot = {
            slotId: slotUid,
            saveId: slotUid,
            classId: classId,
            name: (customName && customName.trim()) || charCfg.name || 'Герой',
            createdAt: Date.now()
        };

        // Clear any old garbage under this saveId just in case
        if (window.AveloraSave && window.AveloraSave.deleteSave) {
            window.AveloraSave.deleteSave(newSlot.saveId);
        }

        slots.push(newSlot);
        saveSlots(slots);
        return newSlot;
    }

    function deleteCharacter(slotId) {
        let slots = getSlots();
        const slot = slots.find(s => s.slotId === slotId);
        if (!slot) return false;

        if (window.AveloraSave && window.AveloraSave.deleteSave) {
            window.AveloraSave.deleteSave(slot.saveId);
        }

        slots = slots.filter(s => s.slotId !== slotId);
        saveSlots(slots);
        return true;
    }

    function exportSlotData(slotId) {
        const slots = getSlots();
        const slot = slots.find(s => s.slotId === slotId);
        if (!slot) return null;

        const saveRaw = localStorage.getItem('avelora_save_' + slot.saveId);
        const stateRaw = localStorage.getItem('avelora_state_' + slot.saveId);

        return JSON.stringify({
            version: 1,
            slot: slot,
            save: saveRaw ? JSON.parse(saveRaw) : null,
            state: stateRaw ? JSON.parse(stateRaw) : null
        }, null, 2);
    }

    function importSlotData(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            if (!data || !data.slot || !data.slot.classId) return { ok: false, error: 'Неверный формат данных сохранения' };
            const slots = getSlots();
            if (slots.length >= MAX_SLOTS) return { ok: false, error: 'Нет свободных слотов' };

            const newSaveId = 'slot_' + Date.now();
            const newSlot = {
                slotId: newSaveId,
                saveId: newSaveId,
                classId: data.slot.classId,
                name: data.slot.name || 'Импортированный герой',
                createdAt: Date.now()
            };

            if (data.save) {
                data.save.characterId = newSaveId;
                localStorage.setItem('avelora_save_' + newSaveId, JSON.stringify(data.save));
            }
            if (data.state) {
                data.state.characterId = newSaveId;
                localStorage.setItem('avelora_state_' + newSaveId, JSON.stringify(data.state));
            }

            slots.push(newSlot);
            saveSlots(slots);
            return { ok: true, slot: newSlot };
        } catch (e) {
            return { ok: false, error: 'Ошибка парсинга JSON: ' + e.message };
        }
    }

    function getClassForSaveId(saveId) {
        if (!saveId) return 'mage';
        if (saveId === 'mage' || saveId === 'archer' || saveId === 'warrior') return saveId;
        const slots = getSlots();
        const slot = slots.find(s => s.saveId === saveId || s.slotId === saveId);
        return slot ? slot.classId : 'mage';
    }

    function downloadSlotFile(slotId) {
        const dataStr = exportSlotData(slotId);
        if (!dataStr) return false;
        const slots = getSlots();
        const slot = slots.find(s => s.slotId === slotId);
        const safeName = (slot && slot.name ? slot.name : 'hero').replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
        try {
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `avelora_${safeName}.json`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
            return true;
        } catch (e) {
            console.warn('[AveloraSlots] download failed', e);
            return false;
        }
    }

    function importSlotFile(file, callback) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const res = importSlotData(e.target.result);
            if (callback) callback(res);
        };
        reader.onerror = () => {
            if (callback) callback({ ok: false, error: 'Не удалось прочитать файл' });
        };
        reader.readAsText(file);
    }

    window.AveloraSlots = {
        MAX_SLOTS,
        getSlots,
        getSlotDetails,
        getClassForSaveId,
        createCharacter,
        deleteCharacter,
        exportSlotData,
        importSlotData,
        downloadSlotFile,
        importSlotFile
    };
})();
