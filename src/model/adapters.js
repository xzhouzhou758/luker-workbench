// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure halves of the four AI 迭代 adapters: cutting a working copy into
// units for the change list, and rebuilding it from accepted units. The
// Luker halves (load / tools / commit) live in source-iterate.js.
//
//   memory  live = node-type schema array      unit = one type
//   orch    live = { mode, profile }           unit = one agent field
//   preset  live = preset body                 unit = one prompt entry / setting
//   card    live = { character, lorebooks }    unit = one card field / lorebook entry

import { listAgents, agentFields, getField, setField, FIELD_LABELS } from './orch-edit.js';

const json = (v) => JSON.stringify(v ?? null, null, 1);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ----- memory: one unit per type ---------------------------------------------

function memoryText(spec) {
    const lines = [];
    lines.push(`名称：${spec.label || spec.id}`);
    if (spec.extractHint) lines.push(`这类记忆是什么：${spec.extractHint}`);
    const hints = spec.columnHints || {};
    const req = new Set(spec.requiredColumns || []);
    for (const key of spec.tableColumns || []) lines.push(`· ${key}${req.has(key) ? '（必填）' : ''}：${hints[key] || ''}`);
    const flags = [spec.alwaysInject ? '一直让 AI 看到' : '', spec.latestOnly ? '同名只保留最新' : '', spec.compression?.mode === 'hierarchical' ? '自动合并成摘要' : ''].filter(Boolean);
    if (flags.length) lines.push(`记录方式：${flags.join('、')}`);
    if (spec.extractionInstructions) lines.push(`提取规则：${spec.extractionInstructions}`);
    return lines.join('\n');
}

export const memoryUnits = (schema) => new Map((schema || []).map(spec => [String(spec.id), { key: String(spec.id), label: spec.label || spec.id, group: '记忆类型', text: memoryText(spec), raw: spec }]));
export const memoryRebuild = (units) => [...units.values()].map(u => clone(u.raw));

// ----- orchestrator: one unit per agent field --------------------------------

export function orchUnits({ mode, profile }, nameOf = (id) => id) {
    const out = new Map();
    for (const id of listAgents(mode, profile)) {
        for (const field of agentFields(mode, profile, id)) {
            const key = `${id}/${field}`;
            out.set(key, { key, label: `${nameOf(id)} · ${FIELD_LABELS[field]}`, group: nameOf(id), text: getField(mode, profile, id, field), raw: { id, field } });
        }
    }
    return out;
}

export function orchRebuild(base, aiLive, accepted) {
    let profile = clone(base.profile);
    for (const key of accepted) {
        const [id, field] = key.split('/');
        profile = setField(base.mode, profile, id, field, getField(aiLive.mode, aiLive.profile, id, field));
    }
    return { mode: base.mode, profile };
}

// ----- preset: prompt entries + top-level settings ---------------------------

const PRESET_SETTING_KEYS = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'openai_max_context', 'openai_max_tokens', 'stream_openai', 'names_behavior', 'continue_prefill', 'squash_system_messages', 'assistant_prefill', 'assistant_impersonation', 'wi_format', 'scenario_format', 'personality_format'];

function promptOrder(body) {
    const orders = Array.isArray(body?.prompt_order) ? body.prompt_order : [];
    return orders.find(o => Number(o.character_id) === 100001) || orders[0] || { order: [] };
}

export function presetUnits(body) {
    const out = new Map();
    const order = promptOrder(body);
    const enabled = new Map((order.order || []).map((o, i) => [o.identifier, { on: Boolean(o.enabled), at: i }]));
    for (const p of body?.prompts || []) {
        if (!p?.identifier) continue;
        const state = enabled.get(p.identifier);
        const head = `${state ? (state.on ? '开启' : '关闭') : '不在列表里'} · ${p.role || 'system'}${p.injection_position ? ` · 插入深度 ${p.injection_depth}` : ''}`;
        const text = p.marker ? `${head}\n（系统占位：${p.name || p.identifier}）` : `${head}\n${p.content || ''}`;
        out.set(`prompt:${p.identifier}`, { key: `prompt:${p.identifier}`, label: p.name || p.identifier, group: '条目', text, raw: { prompt: p, order: state } });
    }
    out.set('order', { key: 'order', label: '条目顺序', group: '结构', text: (order.order || []).map(o => o.identifier).join(' → '), raw: clone(order.order || []) });
    const settings = {};
    for (const k of PRESET_SETTING_KEYS) if (body && k in body) settings[k] = body[k];
    out.set('settings', { key: 'settings', label: '生成参数', group: '结构', text: json(settings), raw: settings });
    return out;
}

export function presetRebuild(base, ai, accepted) {
    const next = clone(base);
    const keys = new Set(accepted);
    const aiOrder = promptOrder(ai).order || [];
    const order = promptOrder(next);
    const byId = new Map((next.prompts || []).map((p, i) => [p.identifier, i]));
    for (const key of keys) {
        if (key === 'settings') {
            for (const k of PRESET_SETTING_KEYS) { if (k in ai) next[k] = clone(ai[k]); else delete next[k]; }
        } else if (key === 'order') {
            order.order = clone(aiOrder);
        } else if (key.startsWith('prompt:')) {
            const id = key.slice(7);
            const aiPrompt = (ai.prompts || []).find(p => p.identifier === id);
            const aiState = aiOrder.find(o => o.identifier === id);
            if (!aiPrompt) {
                next.prompts = (next.prompts || []).filter(p => p.identifier !== id);
                order.order = (order.order || []).filter(o => o.identifier !== id);
                continue;
            }
            if (byId.has(id)) next.prompts[byId.get(id)] = clone(aiPrompt);
            else next.prompts = [...(next.prompts || []), clone(aiPrompt)];
            const slot = (order.order || []).find(o => o.identifier === id);
            if (aiState && slot) slot.enabled = aiState.enabled;
            else if (aiState && !slot) order.order = [...(order.order || []), clone(aiState)];
        }
    }
    return next;
}

// ----- character card + lorebooks --------------------------------------------

export const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'alternate_greetings'];
export const CARD_LABELS = { name: '名字', description: '描述', personality: '性格', scenario: '场景', first_mes: '开场白', mes_example: '示例对话', system_prompt: '系统提示', post_history_instructions: '历史后指令', creator_notes: '作者备注', alternate_greetings: '备选开场白' };

function cardField(character, field) {
    const v = character?.[field] ?? character?.data?.[field];
    return Array.isArray(v) ? v.join('\n—\n') : String(v ?? '');
}

function entryText(e) {
    const keys = [...(e.key || [])].join('、');
    const flags = [e.disable ? '已关闭' : '', e.constant ? '常驻' : ''].filter(Boolean).join('、');
    return `关键词：${keys || '（无）'}${e.keysecondary?.length ? `\n次要关键词：${e.keysecondary.join('、')}` : ''}${flags ? `\n${flags}` : ''}\n${e.content || ''}`;
}

export function cardUnits(live) {
    const out = new Map();
    for (const f of CARD_FIELDS) {
        const text = cardField(live?.character, f);
        if (text || f === 'description') out.set(`card:${f}`, { key: `card:${f}`, label: CARD_LABELS[f], group: '角色卡', text, raw: { field: f } });
    }
    for (const [book, data] of Object.entries(live?.lorebooks || {})) {
        for (const [uid, e] of Object.entries(data?.entries || {})) {
            out.set(`wi:${book}:${uid}`, { key: `wi:${book}:${uid}`, label: e.comment || (e.key || [])[0] || `条目 ${uid}`, group: `世界书「${book}」`, text: entryText(e), raw: { book, uid } });
        }
    }
    return out;
}

/** Accepted keys → { cardEdits, bookEdits: { [book]: edits } } as iteration-library edits. */
export function cardEditsFor(base, ai, accepted) {
    const cardEdits = [];
    const bookEdits = {};
    for (const key of accepted) {
        if (key.startsWith('card:')) {
            const f = key.slice(5);
            const before = base.character?.[f] ?? base.character?.data?.[f];
            const after = ai.character?.[f] ?? ai.character?.data?.[f];
            cardEdits.push({ op: 'set', path: f, oldValue: clone(before), newValue: clone(after) });
        } else if (key.startsWith('wi:')) {
            const [, book, uid] = key.match(/^wi:(.*):([^:]+)$/) || [];
            const prev = base.lorebooks?.[book]?.entries?.[uid];
            const next = ai.lorebooks?.[book]?.entries?.[uid];
            const list = (bookEdits[book] ||= []);
            if (!prev && next) list.push({ op: 'lorebook_entry_add', path: 'entries', uid: next.uid ?? uid, entry: clone(next) });
            else if (prev && !next) list.push({ op: 'lorebook_entry_remove', path: 'entries', uid: prev.uid ?? uid, entry: clone(prev) });
            else if (prev && next) {
                const patch = {};
                const before = {};
                for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
                    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) { patch[k] = clone(next[k]); before[k] = clone(prev[k]); }
                }
                if (Object.keys(patch).length) list.push({ op: 'lorebook_entry_update', path: 'entries', uid: prev.uid ?? uid, patch, before });
            }
        }
    }
    return { cardEdits, bookEdits };
}

/** Builds the card live that results from accepting some changes (for continuing the chat). */
export function cardRebuild(base, ai, accepted) {
    const next = clone(base);
    for (const key of accepted) {
        if (key.startsWith('card:')) {
            const f = key.slice(5);
            const v = clone(ai.character?.[f] ?? ai.character?.data?.[f]);
            next.character ||= {};
            next.character[f] = v;
            if (next.character.data) next.character.data[f] = v;
        } else if (key.startsWith('wi:')) {
            const [, book, uid] = key.match(/^wi:(.*):([^:]+)$/) || [];
            const entry = ai.lorebooks?.[book]?.entries?.[uid];
            next.lorebooks ||= {};
            next.lorebooks[book] ||= { entries: {} };
            next.lorebooks[book].entries ||= {};
            if (entry) next.lorebooks[book].entries[uid] = clone(entry);
            else delete next.lorebooks[book].entries[uid];
        }
    }
    return next;
}
