// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Everything the workbench reads from (and writes to) Luker. The pages only
// see plain objects from here; any Luker module that moved or is missing
// degrades to null for that part instead of breaking the window.
//
// Public surface used: Luker.getContext() (characters, chat, presets,
// chatCompletionSettings, extensionSettings, eventSource), getExtensionApi
// ('memory-graph'). By URL (same module instances Luker already loaded):
// itemized-prompts.js, memory-graph/main.js, orchestrator run-state store.

import { buildBudget } from './model/budget.js';

const MG = '/scripts/extensions/memory-graph';
const ORCH = '/scripts/extensions/orchestrator';
const SETTINGS_KEY = 'luker_workbench';
const ORCH_RUNS_KEY = 'workbench.orchRuns.v1';
const ORCH_LENS_HISTORY = 'orchestraLens.history.v1';
const MAX_ORCH_RUNS = 20;

export class SourceError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

export function getContext() {
    const ctx = globalThis.Luker?.getContext?.() || globalThis.SillyTavern?.getContext?.();
    if (!ctx) throw new SourceError('no-host', '未检测到 Luker 运行环境');
    return ctx;
}

const lazy = (url) => {
    let p = null;
    return () => (p ||= import(url).catch(() => { p = null; return null; }));
};
const loadItemized = lazy('/scripts/itemized-prompts.js');
const loadMemoryMain = lazy(`${MG}/main.js`);
const loadMemoryRead = lazy(`${MG}/read-api.js`);
const loadOrchStore = lazy(`${ORCH}/run-state/store.js`);

/** Current character (null in group chats or when none is open). */
export function currentCharacter(ctx = getContext()) {
    if (ctx.groupId) return null;
    const c = ctx.characters?.[ctx.characterId];
    return c?.avatar ? { avatar: String(c.avatar), name: String(c.name || c.data?.name || ''), index: Number(ctx.characterId) } : null;
}

function chatInfo(ctx) {
    const chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
    const character = currentCharacter(ctx);
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let label = '';
    if (ctx.groupId) label = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId))?.name || '群聊';
    else label = character?.name || '';
    return { chatId: chatId ? String(chatId) : '', label, character, floors: chat.length, group: Boolean(ctx.groupId) };
}

// ---------------------------------------------------------------------------
// Settings (follow the account: extensionSettings.luker_workbench)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
    ai: {
        default: { connection: '', preset: '' },
        memory: { connection: '', preset: '' },
        orch: { connection: '', preset: '' },
        preset: { connection: '', preset: '' },
        card: { connection: '', preset: '' },
        ask: { connection: '', preset: '' },
    },
    builtinPrompt: true,
    reviewChanges: true,
    rules: {},
    dismissed: {},
    ask: { sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true }, floors: 2, previewBeforeSend: false, redact: true },
    hotkey: 'alt+w',
};

function merge(base, extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return structuredClone(base);
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(extra)) {
        out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return out;
}

export function readSettings(ctx = getContext()) {
    return merge(DEFAULT_SETTINGS, ctx.extensionSettings?.[SETTINGS_KEY]);
}

export function writeSettings(next, ctx = getContext()) {
    ctx.extensionSettings[SETTINGS_KEY] = structuredClone(next);
    (ctx.saveSettingsDebounced || ctx.saveSettings)?.();
}

// ---------------------------------------------------------------------------
// Orchestrator runs: kept by the workbench itself (the orchestrator only has
// the current run). If orchestra-lens is installed, its richer history wins.
// ---------------------------------------------------------------------------

/** One finished run → { at, durationMs, status, agents: [{ id, label, durationMs, error }] }. */
export function summarizeOrchRun(run) {
    if (!run) return null;
    const agents = new Map();
    for (const round of run.rounds || []) {
        const sections = round.sections || [];
        const byNode = sections.filter(s => /^node-/.test(String(s.id)));
        const units = byNode.length ? byNode.map(s => ({ id: String(s.id).replace(/^node-/, ''), label: s.title, status: s.status, body: s.body, start: s.meta?.startedAt, end: s.meta?.endedAt }))
            : [{ id: String(round.id).replace(/-\d+$/, '').replace(/^(node|sub|agent|main)-/, ''), label: round.label, status: round.status, body: '', start: round.startedAt, end: round.endedAt }];
        for (const u of units) {
            const entry = agents.get(u.id) || { id: u.id, label: String(u.label || u.id).replace(/\s*[#·].*$/, ''), durationMs: 0, error: '' };
            const start = Number(u.start ?? round.startedAt);
            const end = Number(u.end ?? round.endedAt);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) entry.durationMs += end - start;
            if (u.status === 'failed') entry.error ||= String(u.body || '失败').slice(-300);
            agents.set(u.id, entry);
        }
    }
    const start = Number(run.startedAt);
    const end = Number(run.endedAt);
    return {
        at: Number(run.startedAtWall) || Date.now(),
        durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
        status: String(run.status || ''),
        error: run.error ? String(run.error) : '',
        agents: [...agents.values()],
    };
}

function readJson(key, fallback) {
    try { return JSON.parse(globalThis.localStorage?.getItem(key) || '') ?? fallback; } catch { return fallback; }
}

function orchRuns() {
    const lens = readJson(ORCH_LENS_HISTORY, null);
    if (Array.isArray(lens) && lens.length) {
        return lens.filter(r => (r.source || 'orchestrator') === 'orchestrator' && !r.quiet).slice(0, MAX_ORCH_RUNS).reverse().map(summarizeOrchRun).filter(Boolean);
    }
    const own = readJson(ORCH_RUNS_KEY, []);
    return Array.isArray(own) ? own : [];
}

/** Records finished orchestrator runs while orchestra-lens is not installed. Returns stop(). */
export async function startOrchRecorder() {
    const mod = await loadOrchStore();
    const store = mod?.default;
    if (!store?.subscribe || !store?.getCurrentRun) return () => {};
    let lastId = '';
    let startedWall = 0;
    return store.subscribe((event) => {
        if (event?.type === 'run_started') startedWall = Date.now();
        if (event?.type !== 'run_finished') return;
        if (globalThis.OrchestraLens) return; // orchestra-lens keeps a fuller history
        const run = store.getCurrentRun();
        if (!run || run.quiet || run.runId === lastId) return;
        lastId = run.runId;
        const summary = summarizeOrchRun({ ...run, startedAtWall: startedWall });
        const list = readJson(ORCH_RUNS_KEY, []);
        const next = [...(Array.isArray(list) ? list : []), summary].slice(-MAX_ORCH_RUNS);
        try { globalThis.localStorage?.setItem(ORCH_RUNS_KEY, JSON.stringify(next)); } catch { /* full */ }
    }) || (() => {});
}

// ---------------------------------------------------------------------------
// Snapshot for the overview + 小建议
// ---------------------------------------------------------------------------

async function memoryPart(ctx, chat) {
    const mg = ctx.getExtensionApi?.('memory-graph');
    if (!mg) return null;
    const [main, read] = await Promise.all([loadMemoryMain(), loadMemoryRead()]);
    const out = { installed: true, nodes: 0, events: 0, unmerged: 0, core: 0, focus: 0, coreHistory: [], compression: false, threshold: 0, maxSeqDistance: null, floors: chat.floors, structure: '', scope: 'global' };
    try {
        const settings = main?.getSettings?.();
        const adv = mg.getAdvancedScopeInfo?.(ctx, settings);
        out.maxSeqDistance = Number(adv?.settings?.persistentInjectionMaxSeqDistance ?? settings?.persistentInjectionMaxSeqDistance ?? 0);
        out.scope = adv?.scope || 'global';
        const schemaInfo = mg.getSchemaScopeInfo?.(ctx, settings);
        const event = (schemaInfo?.schema || []).find(s => String(s?.id) === 'event');
        out.compression = String(event?.compression?.mode || '') === 'hierarchical';
        out.threshold = Number(event?.compression?.threshold) || 0;
        out.types = (schemaInfo?.schema || []).length;
    } catch { /* settings unavailable */ }
    try {
        if (chat.chatId && main?.ensureMemoryStoreLoaded && read?.getMemoryGraphReadApi) {
            const store = await main.ensureMemoryStoreLoaded(ctx);
            const api = store ? read.getMemoryGraphReadApi(store, ctx) : null;
            const nodes = api?.listNodes?.({ activeOnly: false }) || [];
            out.nodes = nodes.length;
            const events = nodes.filter(node => node?.type === 'event' && !node.archived);
            out.events = events.length;
            // Leaves with no rollup above them are what still injects one by one.
            out.unmerged = events.filter(node => !(Number(node.semanticDepth) > 0) && !node.parentId).length;
        }
    } catch { /* store not ready */ }
    try {
        const proj = await mg.getLastRecallProjection?.(ctx);
        if (proj?.blocks) {
            const count = (text) => (ctx.getTokenCountAsync ? ctx.getTokenCountAsync(String(text || '')) : Promise.resolve(0));
            [out.core, out.focus] = await Promise.all([count(proj.blocks.corePacket), count(proj.blocks.focusPacket)]);
            out.recallAt = proj.at;
        }
    } catch { /* no recall yet */ }
    // memory-lens records one entry per generation in the chat metadata.
    const log = ctx.chatMetadata?.memory_lens_tokens?.entries;
    if (Array.isArray(log)) out.coreHistory = log.slice(-30).map(e => Number(e.core) || 0);
    return out;
}

async function budgetPart(ctx, memoryTokens) {
    const mod = await loadItemized();
    const list = mod?.itemizedPrompts;
    if (!Array.isArray(list) || !list.length || typeof mod.itemizedParams !== 'function') return null;
    const idx = list.length - 1;
    try {
        const params = await mod.itemizedParams(list, idx, list[idx]?.mesId);
        return buildBudget(params, { memory: memoryTokens });
    } catch {
        return null;
    }
}

function presetPart(ctx) {
    try {
        const live = ctx.presets?.getLive?.('openai');
        const body = live?.body || {};
        const order = (body.prompt_order || []).find(o => Number(o.character_id) === 100001) || (body.prompt_order || [])[0];
        const enabledIds = new Set((order?.order || []).filter(o => o.enabled).map(o => o.identifier));
        const prompts = (body.prompts || []).filter(p => p && !p.marker).map(p => ({ id: p.identifier, name: p.name || p.identifier, text: String(p.content || ''), enabled: enabledIds.has(p.identifier) }));
        return { name: live?.ref?.name || ctx.chatCompletionSettings?.preset_settings_openai || '', prompts, enabled: prompts.filter(p => p.enabled).length };
    } catch {
        return null;
    }
}

function cardPart(ctx, chat) {
    const c = chat.character;
    if (!c) return { name: '', pending: 0 };
    const full = ctx.characters?.[c.index] || {};
    const books = new Set();
    const main = full.data?.extensions?.world;
    if (main) books.add(String(main));
    for (const extra of ctx.chatMetadata?.world_info ? [ctx.chatMetadata.world_info] : []) books.add(String(extra));
    return { name: c.name, avatar: c.avatar, books: [...books], pending: 0 };
}

function orchPart(ctx) {
    const s = ctx.extensionSettings?.orchestrator;
    if (!s) return null;
    const runs = orchRuns();
    const last = runs[runs.length - 1] || null;
    return { enabled: Boolean(s.enabled), mode: String(s.executionMode || ''), runs, last };
}

export function connectionName(ctx = getContext()) {
    try {
        const sel = document.getElementById('connection_profiles');
        const text = sel?.selectedOptions?.[0]?.textContent?.trim();
        if (text && sel.value) return text;
    } catch { /* no DOM */ }
    return String(ctx.chatCompletionSettings?.chat_completion_source || '');
}

/**
 * @returns {Promise<{ chat, memory, budget, preset, card, orch, connection, at }>}
 */
export async function loadSnapshot() {
    const ctx = getContext();
    const chat = chatInfo(ctx);
    const memory = await memoryPart(ctx, chat).catch(() => null);
    const [budget] = await Promise.all([budgetPart(ctx, memory?.core || 0)]);
    if (budget && memory) budget.memoryHistory = memory.coreHistory;
    return {
        chat,
        memory,
        budget,
        preset: presetPart(ctx),
        card: cardPart(ctx, chat),
        orch: orchPart(ctx),
        connection: connectionName(ctx),
        lenses: { memory: Boolean(globalThis.MemoryLens), orch: Boolean(globalThis.OrchestraLens) },
        at: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Quick actions from 小建议
// ---------------------------------------------------------------------------

/** Sets memory-graph's 常驻注入最大回溯楼层 in whichever scope is active. Returns the old value. */
export async function setMemoryHorizon(value) {
    const ctx = getContext();
    const mg = ctx.getExtensionApi?.('memory-graph');
    const main = await loadMemoryMain();
    const settings = main?.getSettings?.();
    if (!mg || !settings) throw new SourceError('unsupported', '记忆图的设置读不到');
    const adv = mg.getAdvancedScopeInfo?.(ctx, settings);
    const before = Number(adv?.settings?.persistentInjectionMaxSeqDistance ?? settings.persistentInjectionMaxSeqDistance ?? 0);
    if (adv?.scope === 'character' && adv.avatar && mg.persistCharacterAdvancedOverride) {
        const ok = await mg.persistCharacterAdvancedOverride(ctx, adv.avatar, { ...adv.settings, persistentInjectionMaxSeqDistance: value });
        if (!ok) throw new SourceError('write-failed', '写入角色卡失败');
        return { before, scope: 'character', avatar: adv.avatar };
    }
    settings.persistentInjectionMaxSeqDistance = value;
    (ctx.saveSettingsDebounced || ctx.saveSettings)?.();
    // Keep the native settings field in step if it is on screen.
    const input = document.getElementById('luker_rpg_memory_advanced_persistent_injection_max_seq_distance');
    if (input) input.value = String(value);
    return { before, scope: 'global' };
}

/** Subscribes to the Luker events that should refresh the window. */
export function subscribe(onChange) {
    const offs = [];
    try {
        const ctx = getContext();
        const types = ctx.eventTypes || ctx.event_types || {};
        for (const name of ['CHAT_CHANGED', 'GENERATION_ENDED', 'MESSAGE_DELETED', 'SETTINGS_UPDATED', 'ITEMIZED_PROMPTS_SAVED', 'OAI_PRESET_CHANGED_AFTER', 'CHARACTER_EDITED']) {
            const type = types[name];
            if (!type || !ctx.eventSource?.on) continue;
            const handler = () => onChange(name);
            ctx.eventSource.on(type, handler);
            offs.push(() => ctx.eventSource.removeListener?.(type, handler));
        }
    } catch { /* no host */ }
    return () => { for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } } };
}

export function openLens(which) {
    if (which === 'memory') return globalThis.MemoryLens?.open?.();
    if (which === 'orch') return globalThis.OrchestraLens?.open?.();
    return null;
}

// ---------------------------------------------------------------------------
// AI connections (shared by 问问 and AI 迭代)
// ---------------------------------------------------------------------------

const loadRunner = lazy('/scripts/iteration-library/runner.js');
const loadProfiles = lazy('/scripts/extensions/connection-manager/profile-resolver.js');

/** Connection profiles and chat-completion presets the user can pick. */
export async function listAiChoices() {
    const ctx = getContext();
    let connections = [];
    try {
        const resolver = await loadProfiles();
        connections = (resolver?.getChatCompletionConnectionProfiles?.() || []).map(p => String(p?.name || '')).filter(Boolean);
    } catch { connections = []; }
    let presets = [];
    try {
        const names = ctx.getPresetManager?.('openai')?.getAllPresets?.();
        presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
    } catch { presets = []; }
    return { connections: [...new Set(connections)], presets };
}

/** Effective { apiPresetName, llmPresetName } for a role ('ask' | 'memory' | 'orch' | 'preset' | 'card'). */
export function aiTarget(role, settings = readSettings()) {
    const own = settings.ai?.[role] || {};
    const def = settings.ai?.default || {};
    return { apiPresetName: String(own.connection || def.connection || '').trim(), llmPresetName: String(own.preset || def.preset || '').trim() };
}

/**
 * One model call with tools. `messages` are OpenAI-style; tool results go
 * back as { role: 'tool', tool_call_id, content }.
 * @returns {Promise<{ text: string, calls: { id, name, args }[] }>}
 */
export async function aiRequest(role, { messages, tools = [], signal = null }) {
    const ctx = getContext();
    const runner = await loadRunner();
    if (typeof runner?.requestToolCallsWithRetry !== 'function') throw new SourceError('unsupported', '找不到 Luker 的 AI 调用接口');
    if (!tools.length) throw new SourceError('bad-call', 'AI 调用至少要有一个工具');
    const result = await runner.requestToolCallsWithRetry(ctx, { toolCallRetryMax: 2 }, {
        taskMessages: messages,
        runtimeWorldInfo: null,
        ...aiTarget(role),
        tools,
        allowedNames: new Set(tools.map(t => t?.function?.name).filter(Boolean)),
        abortSignal: signal,
        includeAssistantText: true,
        allowNoToolCalls: true,
    });
    const calls = (Array.isArray(result?.toolCalls) ? result.toolCalls : []).map((c, i) => ({
        id: String(c?.id || `wb_${Date.now().toString(36)}_${i}`),
        name: String(c?.name || ''),
        args: c?.args && typeof c.args === 'object' ? c.args : {},
    }));
    return { text: String(result?.assistantText || result?.text || '').trim(), calls };
}

/** Quick connectivity test for a role. */
export async function aiTest(role) {
    const started = Date.now();
    const tools = [{ type: 'function', function: { name: 'wb_ok', description: 'Call this once to confirm the connection works.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
    await aiRequest(role, { messages: [{ role: 'system', content: '这是连接测试。调用 wb_ok 工具一次，不要输出别的。' }, { role: 'user', content: '测试连接' }], tools });
    return Date.now() - started;
}
