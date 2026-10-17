// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Preview-only stand-in for source-luker.js: same function names, fictional
// data (雾港灯塔), no network. Query params: chat=none, empty=1.

import { DEFAULT_SETTINGS } from '../src/source-luker.js';

const params = new URLSearchParams(location.search);
const noChar = params.get('chat') === 'none';
const empty = params.get('empty') === '1';
let settings = structuredClone(DEFAULT_SETTINGS);
let horizon = 0;

const now = Date.now();
const runs = Array.from({ length: 6 }, (_, i) => ({
    at: now - (6 - i) * 9 * 60e3,
    durationMs: 22000 + i * 1800,
    status: 'done',
    agents: [
        { id: 'plot_advisor', label: '剧情顾问', durationMs: 14000 + i * 1500, error: i % 3 === 1 ? '429 Too Many Requests' : '' },
        { id: 'style_check', label: '文风检查', durationMs: 2600, error: '' },
        { id: 'final', label: '最终回复', durationMs: 5200, error: '' },
    ],
}));

export { DEFAULT_SETTINGS };
export const readSettings = () => structuredClone(settings);
export const writeSettings = (next) => { settings = structuredClone(next); };
export const subscribe = () => () => {};
export const openLens = (which) => console.info('[preview] open lens', which);

export async function loadSnapshot() {
    await new Promise(r => setTimeout(r, 120));
    const chat = noChar ? { chatId: '', label: '', character: null, floors: 0, group: false } : { chatId: 'demo', label: '雾港灯塔 · 林栖', character: { avatar: 'linqi.png', name: '林栖', index: 0 }, floors: 412, group: false };
    if (empty) return { chat, memory: null, budget: null, preset: null, card: { name: '', pending: 0 }, orch: null, connection: '', lenses: {}, at: now };
    return {
        chat,
        memory: { installed: true, nodes: 212, events: 212, unmerged: 164, core: 7600, focus: 1800, coreHistory: [3000, 3100, 3400, 3300, 3200, 3350], compression: true, threshold: 200, maxSeqDistance: horizon, floors: 412, scope: 'global', types: 6 },
        budget: {
            total: 32700, max: 64000, memoryHistory: [3000, 3100, 3400, 3300, 3200, 3350],
            parts: [
                { key: 'preset', label: '预设', tokens: 3100 },
                { key: 'card', label: '角色卡', tokens: 2400 },
                { key: 'world', label: '世界书', tokens: 1600 },
                { key: 'memory', label: '记忆图', tokens: 7600 },
                { key: 'chat', label: '聊天记录', tokens: 18000 },
            ],
        },
        preset: { name: 'plugin-only', prompts: [{ id: 'main', name: '主提示', text: '你是一位细腻的小说作者。', enabled: true }, { id: 'style', name: '文风', text: '语气亲切，多用对话推动情节。', enabled: true }] },
        card: noChar ? { name: '', pending: 0 } : { name: '林栖', avatar: 'linqi.png', books: ['雾港', '灯塔守则'], pending: 0 },
        orch: { enabled: true, mode: 'spec', runs, last: runs[runs.length - 1] },
        connection: 'DeepSeek 官方',
        lenses: { memory: true, orch: true },
        at: now,
    };
}

export async function setMemoryHorizon(value) {
    const before = horizon;
    horizon = value;
    return { before, scope: 'global' };
}

export async function listAiChoices() {
    return { connections: ['DeepSeek 官方', 'Claude（中转）', '本地 Ollama'], presets: ['plugin-only', '默认', '写作-长回复'] };
}

export async function aiTest() {
    await new Promise(r => setTimeout(r, 600));
    return 1200;
}
