// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker halves of the four AI 迭代 adapters. Each adapter:
//   scopes(ctx)            which scopes exist right now (global / character)
//   load(scope)            → { live, target, title }   fresh working copy
//   prompt(live, scope)    the workbench's own system prompt (Luker's, untouched)
//   tools(live)            OpenAI tool defs (Luker's own where exported)
//   isRead(name)
//   runRead(call, live)    → result
//   runEdit(call, live)    → next live
//   units(live)            → Map of units for the change list (model/adapters.js)
//   rebuild(base, ai, keys) → live with accepted keys applied
//   commit(target, base, next, keys) → { undo() } writes to Luker
// Native modules are imported by URL (same instances Luker already runs).

import { getContext, currentCharacter, boundBooks, SourceError } from './source-luker.js';
import { memoryUnits, memoryRebuild, orchUnits, orchRebuild, presetUnits, presetRebuild, cardUnits, cardRebuild, cardEditsFor } from './model/adapters.js';
import { listAgents, agentFields, getField, setField, replaceInField, validateField, FIELD_LABELS, EditError } from './model/orch-edit.js';
import { pickUnits } from './model/units.js';

const S = '/scripts';
const MG = `${S}/extensions/memory-graph`;
const ORCH = `${S}/extensions/orchestrator`;
const CPA = `${S}/extensions/completion-preset-assistant`;
const CEA = `${S}/extensions/character-editor-assistant`;

const mods = new Map();
function load(url) {
    if (!mods.has(url)) mods.set(url, import(url).catch((err) => { mods.delete(url); throw new SourceError('unsupported', `${url.split('/').slice(-2).join('/')} 加载失败：${err?.message || err}`); }));
    return mods.get(url);
}
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fnName = (t) => t?.function?.name;
const iterLib = () => getContext().iterationLibrary || null;

async function applyEditsTo(edits, live) {
    const lib = iterLib();
    const apply = lib?.applyEdits || (await load(`${S}/iteration-library/index.js`)).applyEdits;
    const res = apply(edits, clone(live));
    if (res?.conflicts?.length) {
        const c = res.conflicts[0];
        throw new SourceError('conflict', `没改成（${c.reason}）：${c.edit?.path || ''}。请先读取最新内容再改。`);
    }
    return res.newLive;
}

// ---------------------------------------------------------------------------
// 记忆图：记忆结构（node-type schema）
// ---------------------------------------------------------------------------

const MG_READ = {
    type: 'function',
    function: {
        name: 'mg_schema_read_fields',
        description: 'Read exact values from the current live MG node-type schema by lodash-style paths. Read-only. Root is the schema array; e.g. "[N].id", "[N].tableColumns", "[N].columnHints", "[N].extractionInstructions", "length".',
        parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'], additionalProperties: false },
    },
};

const memory = {
    name: '记忆图',
    async scopes(ctx) {
        const c = currentCharacter(ctx);
        return { global: true, character: Boolean(c) };
    },
    async load(scope) {
        const ctx = getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const main = await load(`${MG}/main.js`);
        const settings = main.getSettings();
        const info = mg?.getSchemaScopeInfo?.(ctx, settings);
        let schema;
        if (scope === 'character') {
            if (!info?.hasAvatar) throw new SourceError('no-character', '未选择角色卡');
            schema = info.hasOverride ? info.schema : settings.nodeTypeSchema;
        } else {
            schema = settings.nodeTypeSchema;
        }
        const live = clone(main.normalizeNodeTypeSchema(schema));
        return { live, target: { scope, avatar: info?.avatar || '', hadOverride: Boolean(info?.hasOverride) }, title: scope === 'character' ? `「${info.characterName}」单独的记忆结构${info.hasOverride ? '' : '（还没有，保存后新建）'}` : '所有角色共用的记忆结构' };
    },
    async prompt() {
        const main = await load(`${MG}/main.js`);
        const sp = await load(`${MG}/schema-iteration/system-prompt.js`);
        return String(main.getSettings()?.schemaIterSystemPrompt || '').trim() || sp.DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT || sp.buildSystemPrompt?.() || '';
    },
    async tools() {
        const t = await load(`${MG}/schema-iteration/tools.js`);
        const control = new Set(Object.values(t.CONTROL_TOOL_NAMES || {}));
        return [...t.buildToolCatalog().filter(d => !control.has(fnName(d))), MG_READ];
    },
    isRead: (name) => name === 'mg_schema_read_fields',
    async runRead(call, live) {
        const d = await load(`${MG}/schema-iteration/read-fields-dispatcher.js`);
        return d.dispatchMgSchemaReadFields({ liveSchema: live, args: call.args });
    },
    async runEdit(call, live) {
        const [t, main] = await Promise.all([load(`${MG}/schema-iteration/tools.js`), load(`${MG}/main.js`)]);
        const edits = await t.normalizeToolCallToEdit({ function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }, { live, normalizeNodeTypeSchema: main.normalizeNodeTypeSchema });
        return edits?.length ? edits[edits.length - 1].newValue : live;
    },
    units: (live) => memoryUnits(live),
    rebuild: (base, ai, keys) => memoryRebuild(pickUnits(memoryUnits(base), memoryUnits(ai), keys)),
    async commit(target, base, next) {
        const ctx = getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const main = await load(`${MG}/main.js`);
        const settings = main.getSettings();
        const normalized = main.normalizeNodeTypeSchema(next);
        if (target.scope === 'character') {
            const before = mg.getSchemaScopeInfo(ctx, settings);
            const ok = await mg.persistCharacterSchemaOverride(ctx, target.avatar, normalized);
            if (!ok) throw new SourceError('write-failed', '写入角色卡失败');
            return {
                async undo() {
                    if (before.hasOverride) await mg.persistCharacterSchemaOverride(ctx, target.avatar, before.schema);
                    else await mg.removeCharacterSchemaOverride?.(ctx, target.avatar);
                },
            };
        }
        const previous = clone(settings.nodeTypeSchema);
        settings.nodeTypeSchema = normalized;
        await (ctx.saveSettings ? ctx.saveSettings() : ctx.saveSettingsDebounced?.());
        return { async undo() { settings.nodeTypeSchema = previous; await (ctx.saveSettings ? ctx.saveSettings() : ctx.saveSettingsDebounced?.()); } };
    },
};

// ---------------------------------------------------------------------------
// 编排：每位助手的设定（orchestrator 的迭代工具没导出，用自己的四个工具）
// ---------------------------------------------------------------------------

const AGENT_NAMES = {
    distiller: '场景提炼', lorebook_reader: '世界书守门', anti_data_guard: '文风把关', planner: '剧情规划', recall_relevance: '记忆筛选',
    critic: '审稿', synthesizer: '汇总', finalizer: '汇总', single_agent: '单助手', agenda_planner: '调度员', loop_agent: '研究员', main: '主笔',
    intent_scout: '意图侦察', chat_scout: '聊天侦察', memory_scout: '记忆侦察', lorebook_scout: '世界书侦察', plot_brainstormer: '情节构思',
    voice_critic: '口吻评审', continuity_critic: '连贯评审', notes_curator: '笔记整理', memory_curator: '记忆整理',
};
export const agentName = (id) => AGENT_NAMES[id] || id;

const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const AGENT = { type: 'string', description: 'Agent id exactly as listed in the overview.' };
const FIELD = { type: 'string', enum: ['description', 'system', 'task', 'api', 'preset'], description: 'system = role prompt, task = task template, description = director sub-agent description, api = connection profile name, preset = generation preset name.' };
const ORCH_TOOLS = [
    fn('wb_orch_overview', 'List agents and which fields each one has, with short previews.', {}, []),
    fn('wb_orch_read_agent', 'Read the full current text of every editable field of one agent.', { agent_id: AGENT }, ['agent_id']),
    fn('wb_orch_replace_text', 'Replace one exact passage inside a text field. old_text must be copied verbatim and occur exactly once.', { agent_id: AGENT, field: FIELD, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['agent_id', 'field', 'old_text', 'new_text']),
    fn('wb_orch_set_field', 'Replace the whole value of a field. Prefer wb_orch_replace_text for long prompts.', { agent_id: AGENT, field: FIELD, value: { type: 'string' } }, ['agent_id', 'field', 'value']),
];
// The orchestrator's own iteration tools are not exported, so only its
// mode-agnostic base prompt (settings.requestSystemPrompt or the default) is
// reused; the mode blocks name luker_orch_* tools we do not offer.
const ORCH_TOOL_NOTE = [
    '## Tools available in this session (they replace the luker_orch_* tools)',
    '- You can edit, per agent: system (role prompt), task (task template, keep macros like {{recent_chat}}), description (director sub-agent description), api (connection profile name), preset (chat completion preset name). Adding / removing agents, stages or tool switches is not possible here — tell the user to use the native orchestrator panel for that.',
    '- Read first with wb_orch_overview / wb_orch_read_agent, then patch with wb_orch_replace_text (old_text verbatim, occurring once); use wb_orch_set_field only for a full rewrite. Keep macros, output formats and the structure later agents depend on.',
].join('\n');

async function orchBasePrompt() {
    const s = getContext().extensionSettings?.orchestrator || {};
    const custom = String(s.requestSystemPrompt || '').trim();
    if (custom) return { text: custom, custom: true };
    const d = await load(`${ORCH}/defaults.js`).catch(() => null);
    return { text: String(d?.getDefaultRequestSystemPrompt?.() || ''), custom: false };
}

function resolveOrch(ctx, scope) {
    const settings = ctx.extensionSettings?.orchestrator;
    if (!settings) throw new SourceError('no-extension', '没有检测到编排');
    const mode = ['spec', 'agenda', 'loop', 'director', 'single'].includes(String(settings.executionMode)) ? String(settings.executionMode) : 'spec';
    if (mode === 'single') {
        if (scope === 'character') throw new SourceError('scope', '单助手模式没有角色单独的方案，只能改全局');
        return { settings, mode, presetId: '', profile: { spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] }, presets: { single_agent: { systemPrompt: settings.singleAgentSystemPrompt, userPromptTemplate: settings.singleAgentUserPromptTemplate } } }, name: '单助手' };
    }
    if (scope === 'character') {
        const c = currentCharacter(ctx);
        if (!c) throw new SourceError('no-character', '未选择角色卡');
        const ext = ctx.characters[c.index]?.data?.extensions?.orchestrator;
        const id = String(ext?.activePresetIds?.[mode] || '');
        const raw = id ? ext?.presetLibraries?.[mode]?.[id] : null;
        if (!raw) throw new SourceError('no-preset', `「${c.name}」还没有单独的编排方案。先在编排面板里给这个角色保存一份，再回来改。`);
        return { settings, mode, presetId: id, profile: clone(raw), name: raw.name || id, avatar: c.avatar, index: c.index };
    }
    const lib = settings.presetLibraries?.[mode] || {};
    let id = String(settings.activePresetIds?.[mode] || '');
    if (!lib[id]) id = Object.keys(lib)[0] || '';
    if (!id) throw new SourceError('no-preset', '还没有保存过编排方案。请先在编排面板里保存一次。');
    return { settings, mode, presetId: id, profile: clone(lib[id]), name: lib[id].name || id };
}

const orch = {
    name: '编排',
    async scopes(ctx) {
        return { global: Boolean(ctx.extensionSettings?.orchestrator), character: Boolean(currentCharacter(ctx)) };
    },
    async load(scope) {
        const r = resolveOrch(getContext(), scope);
        return { live: { mode: r.mode, profile: r.profile }, target: { scope, mode: r.mode, presetId: r.presetId, avatar: r.avatar || '', index: r.index }, title: `${scope === 'character' ? '角色单独的' : '全局'}方案「${String(r.name).replace(/^Default/i, '默认')}」` };
    },
    async prompt(live) {
        const base = await orchBasePrompt();
        const lines = [base.text, '', ORCH_TOOL_NOTE, '', `Execution mode: ${live.mode}`, 'Agents:'];
        for (const id of listAgents(live.mode, live.profile)) lines.push(`- ${id}（${agentName(id)}）：${agentFields(live.mode, live.profile, id).map(f => FIELD_LABELS[f]).join('、')}`);
        return lines.join('\n');
    },
    tools: async () => ORCH_TOOLS,
    isRead: (name) => name === 'wb_orch_overview' || name === 'wb_orch_read_agent',
    async runRead(call, live) {
        const { mode, profile } = live;
        if (call.name === 'wb_orch_overview') {
            return listAgents(mode, profile).map(id => ({ id, name: agentName(id), fields: Object.fromEntries(agentFields(mode, profile, id).map(f => [f, getField(mode, profile, id, f).slice(0, 160)])) }));
        }
        const id = String(call.args?.agent_id || '');
        if (!listAgents(mode, profile).includes(id)) throw new EditError('agent', `没有这位助手：${id}`);
        return Object.fromEntries(agentFields(mode, profile, id).map(f => [f, getField(mode, profile, id, f)]));
    },
    async runEdit(call, live) {
        const { mode, profile } = live;
        const a = call.args || {};
        const id = String(a.agent_id || '');
        if (!agentFields(mode, profile, id).includes(a.field)) throw new EditError('field', `${id} 没有 ${a.field} 这一项`);
        const next = call.name === 'wb_orch_set_field' ? setField(mode, profile, id, a.field, a.value) : replaceInField(mode, profile, id, a.field, a.old_text, a.new_text);
        const problem = validateField(mode, id, a.field, getField(mode, next, id, a.field));
        if (problem) throw new EditError('invalid', problem);
        return { mode, profile: next };
    },
    units: (live) => orchUnits(live, agentName),
    rebuild: (base, ai, keys) => orchRebuild(base, ai, keys),
    async commit(target, base, next) {
        const ctx = getContext();
        const fresh = resolveOrch(ctx, target.scope);
        if (fresh.mode !== target.mode || fresh.presetId !== target.presetId) throw new SourceError('target-gone', '编排方案在别处被切换了，请重新打开这段对话');
        const previous = clone(fresh.profile);
        // Only the fields that changed, on top of what is stored now.
        let merged = clone(fresh.profile);
        for (const id of listAgents(next.mode, next.profile)) {
            for (const f of agentFields(next.mode, next.profile, id)) {
                const v = getField(next.mode, next.profile, id, f);
                if (v !== getField(base.mode, base.profile, id, f)) merged = setField(next.mode, merged, id, f, v);
            }
        }
        await writeOrch(ctx, target, fresh, merged);
        return { undo: () => writeOrch(getContext(), target, resolveOrch(getContext(), target.scope), previous) };
    },
};

async function writeOrch(ctx, target, fresh, profile) {
    const s = fresh.settings;
    if (target.mode === 'single') {
        const sa = profile?.presets?.single_agent || {};
        s.singleAgentSystemPrompt = String(sa.systemPrompt || '');
        s.singleAgentUserPromptTemplate = String(sa.userPromptTemplate || '');
    } else if (target.scope === 'global') {
        const lib = s.presetLibraries[target.mode];
        lib[target.presetId] = { ...profile, name: lib[target.presetId]?.name };
    } else {
        const ext = clone(ctx.characters[fresh.index]?.data?.extensions?.orchestrator);
        const lib = ext.presetLibraries[target.mode];
        lib[target.presetId] = { ...profile, name: lib[target.presetId]?.name };
        const api = ctx.getExtensionApi?.('orchestrator');
        if (typeof api?.persistOrchestratorCharacterExtension === 'function') await api.persistOrchestratorCharacterExtension(ctx, fresh.index, ext);
        else await ctx.writeExtensionField(fresh.index, 'orchestrator', ext);
        return;
    }
    await (ctx.saveSettings ? ctx.saveSettings() : ctx.saveSettingsDebounced?.());
    // Native editor caches drafts; make it reload from settings.
    try { (await load(`${ORCH}/editor-state.js`)).initializeUiState?.(ctx); } catch { /* not loaded */ }
}

// ---------------------------------------------------------------------------
// 预设：当前对话补全预设（completion-preset-assistant 的工具）
// ---------------------------------------------------------------------------

const preset = {
    name: '预设',
    async scopes() { return { global: true, character: false }; },
    async load() {
        const ctx = getContext();
        const ref = ctx.presets?.getSelected?.('openai');
        if (!ref?.name) throw new SourceError('no-preset', '没有选中的对话补全预设');
        const stored = ctx.presets.getStored(ref);
        if (!stored?.body) throw new SourceError('no-preset', `预设「${ref.name}」读不到`);
        const strip = ctx.openai?.stripPresetConnectionFields;
        const live = clone(typeof strip === 'function' ? strip(stored.body) : stored.body);
        return { live, target: { ref: clone(ref) }, title: `预设「${ref.name}」${ref.origin?.kind === 'character' ? '（绑在角色卡上）' : ''}` };
    },
    async prompt() {
        const sp = await load(`${CPA}/cpa-iteration/system-prompts.js`);
        const s = getContext().extensionSettings?.completion_preset_assistant;
        const base = String(s?.iterBaseSystemPrompt || '').trim();
        return base || sp.buildModelSystemPrompt({ mode: 'general' });
    },
    async tools() {
        const t = await load(`${CPA}/cpa-iteration/tools.js`);
        // No reference preset, no skill tools, no clone-to-new (side effect).
        return t.buildToolCatalog({ hasReference: false }).filter(d => !t.isCpaSkillTool?.(fnName(d)) && fnName(d) !== 'preset_clone_to_new');
    },
    isRead: (name) => /^preset_(read|diff|simulate)/.test(name),
    async runRead(call, live) {
        const t = await load(`${CPA}/cpa-iteration/tools.js`);
        const res = await t.runCpaReadTool({ id: call.id, name: call.name, args: call.args || {} }, { live, reference: null, referenceName: '', presetName: getContext().presets?.getSelected?.('openai')?.name || '', context: getContext() });
        if (res?.ok === false) throw new SourceError('read', res.error || '读取失败');
        return res?.toolResultText || res?.result;
    },
    async runEdit(call, live) {
        const t = await load(`${CPA}/cpa-iteration/tools.js`);
        const edits = await t.normalizeToolCallToEdit({ function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }, { live, session: {}, getReferencePresetBody: () => null });
        if (!edits) throw new SourceError('bad-args', '参数不对');
        return edits.length ? applyEditsTo(edits, live) : live;
    },
    units: (live) => presetUnits(live),
    rebuild: (base, ai, keys) => presetRebuild(base, ai, keys),
    async commit(target, base, next) {
        const ctx = getContext();
        const stored = ctx.presets.getStored(target.ref);
        const previous = clone(stored?.body);
        // Re-attach the connection fields the working copy had stripped.
        const body = { ...(previous || {}), ...next };
        const res = await ctx.presets.save(target.ref, body, { select: true });
        if (res?.ok === false) throw new SourceError('write-failed', '保存预设失败');
        return { async undo() { if (previous) await getContext().presets.save(target.ref, previous, { select: true }); } };
    },
};

// ---------------------------------------------------------------------------
// 角色卡 + 世界书（character-editor-assistant 的工具和保存）
// ---------------------------------------------------------------------------

const card = {
    name: '角色卡',
    async scopes(ctx) { return { global: false, character: Boolean(currentCharacter(ctx)) }; },
    async load() {
        const ctx = getContext();
        const c = currentCharacter(ctx);
        if (!c) throw new SourceError('no-character', '未选择角色卡');
        const main = await load(`${CEA}/main.js`);
        const snap = await main.buildUnifiedCharacterEditorLiveSnapshot(ctx, c.avatar);
        const live = { character: clone(snap.character), lorebooks: clone(snap.lorebooks || {}) };
        for (const name of await boundBooks(ctx)) {
            if (live.lorebooks[name]) continue;
            try { const data = await ctx.loadWorldInfo(name); if (data) live.lorebooks[name] = clone(data); } catch { /* skip */ }
        }
        return { live, target: { avatar: c.avatar }, title: `「${c.name}」的角色卡${Object.keys(live.lorebooks).length ? ` · ${Object.keys(live.lorebooks).length} 本世界书` : ''}` };
    },
    async prompt() {
        const st = await load(`${CEA}/editor-iteration/studio.js`).catch(() => null);
        const s = getContext().extensionSettings?.character_editor_assistant;
        return String(s?.editorIterationSystemPrompt || '').trim() || st?.DEFAULT_SYSTEM_PROMPT || '';
    },
    async tools() {
        const t = await load(`${CEA}/editor-iteration/tools.js`);
        return t.buildCeaEditorToolSet(getContext(), {}, { hasSearchTools: false }).filter(d => fnName(d) !== 'web_search');
    },
    isRead: (name) => /^(cea_read_|lorebook_|world_book_|simulate_|inspect_)/.test(name),
    async runRead(call, live) {
        const [t, main] = await Promise.all([load(`${CEA}/editor-iteration/tools.js`), load(`${CEA}/main.js`)]);
        const ctx = getContext();
        const helperApis = main.buildCharacterEditorHelperApis?.(ctx, { avatar: currentCharacter(ctx)?.avatar }) || [];
        const settings = ctx.extensionSettings?.character_editor_assistant || {};
        const res = await t.runCeaEditorReadTool({ id: call.id, name: call.name, args: call.args || {} }, { context: ctx, settings, helperApis, state: { live } });
        if (res?.ok === false) throw new SourceError('read', res.error || '读取失败');
        return res?.result ?? res;
    },
    async runEdit(call, live) {
        const t = await load(`${CEA}/editor-iteration/tools.js`);
        const edits = await t.normalizeToolCallToEdit({ id: call.id, name: call.name, args: call.args || {} }, { context: getContext(), live });
        if (!edits) throw new SourceError('bad-args', '参数不对');
        let next = clone(live);
        for (const e of edits) {
            const kind = e?.target?.kind;
            if (kind === 'lorebook') {
                const book = e.target.bookName;
                const rel = { ...e, path: String(e.path).replace(/^lorebook\./, '') };
                next.lorebooks[book] = await applyEditsTo([rel], next.lorebooks[book] || { entries: {} });
            } else {
                const rel = { ...e, path: String(e.path).replace(/^card\./, '') };
                next.character = await applyEditsTo([rel], next.character || {});
            }
        }
        return next;
    },
    units: (live) => cardUnits(live),
    rebuild: (base, ai, keys) => cardRebuild(base, ai, keys),
    async commit(target, base, next, keys) {
        const ctx = getContext();
        const main = await load(`${CEA}/main.js`);
        const { cardEdits, bookEdits } = cardEditsFor(base, next, keys);
        const undo = [];
        if (cardEdits.length) {
            const live = (ctx.characters || []).find(c => c?.avatar === target.avatar);
            const res = await main.commitCharacterEditorOperations(ctx, target.avatar, cardEdits, { liveCharacter: live });
            if (res?.conflicts?.length) throw new SourceError('conflict', `角色卡有 ${res.conflicts.length} 处在别处被改过，没有保存。请重新打开对话。`);
            const inverse = cardEdits.map(e => ({ op: 'set', path: e.path, oldValue: e.newValue, newValue: e.oldValue }));
            undo.push(async () => { const c = getContext(); await main.commitCharacterEditorOperations(c, target.avatar, inverse, { liveCharacter: (c.characters || []).find(x => x?.avatar === target.avatar) }); });
        }
        for (const [book, edits] of Object.entries(bookEdits)) {
            if (!edits.length) continue;
            const before = clone(await ctx.loadWorldInfo(book));
            const res = await main.commitLorebookOperations(book, before, edits, { context: ctx, settings: ctx.extensionSettings?.character_editor_assistant || {} });
            if (res?.conflicts?.length) throw new SourceError('conflict', `世界书「${book}」有 ${res.conflicts.length} 处冲突，没有保存。`);
            undo.push(async () => { await getContext().saveWorldInfo(book, before, true); });
        }
        return { async undo() { for (const u of undo.reverse()) await u(); } };
    },
};

export const ADAPTERS = { memory, orch, preset, card };

const PROMPT_SOURCES = {
    memory: ['记忆图', 'schemaIterSystemPrompt', '记忆图设置里的「Schema 迭代系统提示词」'],
    orch: ['编排', 'requestSystemPrompt', '编排设置里的「AI 迭代系统提示词」（通用部分；工作台另附自己的工具说明）'],
    preset: ['预设助手', 'iterBaseSystemPrompt', '预设助手设置里的「迭代基础提示词」'],
    card: ['角色卡助手', 'editorIterationSystemPrompt', '角色卡助手设置里的「编辑迭代提示词」'],
};

/** Which Luker prompt a workbench uses, and whether the user customised it. */
export async function promptInfo(ws) {
    const [, key, where] = PROMPT_SOURCES[ws];
    const live = ws === 'orch' ? { mode: 'spec', profile: {} } : null;
    const text = await ADAPTERS[ws].prompt(live);
    const plugin = { memory: 'memory_graph', orch: 'orchestrator', preset: 'completion_preset_assistant', card: 'character_editor_assistant' }[ws];
    const stored = String(getContext().extensionSettings?.[plugin]?.[key] || '').trim();
    let custom = false;
    if (ws === 'orch') custom = (await orchBasePrompt()).custom;
    else if (ws === 'memory') { const sp = await load(`${MG}/schema-iteration/system-prompt.js`).catch(() => null); custom = Boolean(stored) && stored !== String(sp?.DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT || '').trim(); }
    else if (ws === 'preset') { const sp = await load(`${CPA}/cpa-iteration/system-prompts.js`).catch(() => null); custom = Boolean(stored) && stored !== String(sp?.buildBaseSystemPrompt?.() || '').trim(); }
    else if (ws === 'card') { const st = await load(`${CEA}/editor-iteration/studio.js`).catch(() => null); custom = Boolean(stored) && stored !== String(st?.DEFAULT_SYSTEM_PROMPT || '').trim(); }
    return { from: `Luker 内置 · ${where}`, custom, text };
}

export async function adapterScopes() {
    const ctx = getContext();
    const out = {};
    for (const [k, a] of Object.entries(ADAPTERS)) {
        try { out[k] = await a.scopes(ctx); } catch { out[k] = { global: false, character: false }; }
    }
    return out;
}

/** The facade AI 迭代 uses (preview supplies the same shape). */
export const iterate = {
    scopes: adapterScopes,
    async load(ws, scope) { return ADAPTERS[ws].load(scope); },
    async systemPrompt(ws, scope, live, { wrapper = '' } = {}) {
        const own = await ADAPTERS[ws].prompt(live, scope);
        return [wrapper, own].filter(Boolean).join('\n\n');
    },
    tools: (ws, live) => ADAPTERS[ws].tools(live),
    isRead: (ws, name) => ADAPTERS[ws].isRead(name),
    runRead: (ws, call, live) => ADAPTERS[ws].runRead(call, live),
    runEdit: (ws, call, live) => ADAPTERS[ws].runEdit(call, live),
    units: (ws, live) => ADAPTERS[ws].units(live),
    rebuild: (ws, base, ai, keys) => ADAPTERS[ws].rebuild(base, ai, keys),
    commit: (ws, target, base, next, keys) => ADAPTERS[ws].commit(target, base, next, keys),
    async lastReply() {
        const chat = getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && m.mes) return `（第 ${i} 楼，${m.name || '角色'}）\n${String(m.mes).slice(0, 4000)}`;
        }
        return '';
    },
};
