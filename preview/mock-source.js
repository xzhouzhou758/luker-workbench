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

// ----- 问问 ---------------------------------------------------------------
const requests = [
    { id: 'r5', timestamp: now - 62e3, model: 'deepseek-chat', durationMs: 5000, status: 'done', messageCount: 3, usage: { prompt_tokens: 3300, completion_tokens: 400 }, searchText: 'dialogue_batch extract' },
    { id: 'r4', timestamp: now - 70e3, model: 'deepseek-chat', durationMs: 2600, status: 'done', messageCount: 4, usage: { prompt_tokens: 2100, completion_tokens: 120 }, searchText: 'luker_orch style check' },
    { id: 'r3', timestamp: now - 102e3, model: 'deepseek-chat', durationMs: 31200, status: 'done', httpStatus: 200, messageCount: 4, usage: { prompt_tokens: 6800, completion_tokens: 900 }, searchText: 'luker_orch plot advisor', error: '' },
    { id: 'r2', timestamp: now - 108e3, model: 'deepseek-chat', durationMs: 3100, status: 'done', messageCount: 2, usage: { prompt_tokens: 4200, completion_tokens: 300 }, searchText: 'You are a memory recall planner' },
    { id: 'r1', timestamp: now - 112e3, model: 'deepseek-chat', durationMs: 8400, status: 'done', messageCount: 40, usage: { prompt_tokens: 9100, completion_tokens: 700 }, searchText: '' },
];

export async function listRequests({ limit = 60 } = {}) {
    const { attribute } = await import('../src/model/requests.js');
    return requests.slice(0, limit).map(e => ({ ...e, attr: attribute(e) }));
}
export const frontendLogCount = async () => 1284;
let debugOn = false;
export const debugLoggingOn = () => debugOn;
export const enableDebugLogging = () => { debugOn = true; return true; };

export function askReaders() {
    return {
        wb_list_requests: async () => (await listRequests()).map(e => ({ id: e.id, source: e.attr.label, durationMs: e.durationMs })),
        wb_read_frontend_logs: async () => [{ time: '15:42:10', level: 'warn', message: '[orchestrator] plot_advisor: 429 Too Many Requests, retrying in 20s' }],
        wb_read_orchestrator: async () => ({ runs: runs.slice(-3) }),
    };
}
export async function askOverview() { return { 聊天: '雾港灯塔 · 林栖，412 楼' }; }

/** Scripted model: reads twice, then answers. */
export async function aiRequest(role, { messages, tools }) {
    await new Promise(r => setTimeout(r, 500));
    const names = tools.map(t => t.function.name);
    const toolTurns = messages.filter(m => m.role === 'tool').length;
    if (role === 'ask') {
        if (toolTurns === 0 && names.includes('wb_list_requests')) return { text: '', calls: [{ id: 'a1', name: 'wb_list_requests', args: { limit: 10 } }, { id: 'a2', name: 'wb_read_frontend_logs', args: { search: '429' } }] };
        return {
            text: '',
            calls: [{
                id: 'a3', name: 'wb_answer', args: {
                    text: '第 412 楼一共发了 5 个请求，总共 **50.3 秒**。慢在**编排的「剧情顾问」**：第一次请求被返回 **429（请求太频繁）**，等了 20 秒自动重试才成功。\n\n| 请求 | 用时 | 状态 |\n|---|---|---|\n| 主模型回复 | 8.4s | 完成 |\n| 记忆图 · 召回规划 | 3.1s | 完成 |\n| 编排 · 剧情顾问 | 31.2s | 429 → 重试后完成 |\n| 编排 · 文风检查 | 2.6s | 完成 |\n| 记忆图 · 提取 | 5.0s | 完成 |\n\n这 5 个请求用的是同一个连接，1 分钟内发了 5 次，容易撞上频率限制。可以给剧情顾问换一个连接。',
                    suggest: 'orch', fix_prompt: '剧情顾问经常 429，帮我看看能不能换个连接或者错开调用。', request_ids: ['r3'],
                },
            }],
        };
    }
    return { text: '（预览里的假回复）', calls: [] };
}
