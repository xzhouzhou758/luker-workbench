// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 设置: AI connections (connection profile and generation preset chosen
// separately, a default row plus one row per workbench), 问问 sources,
// window, and the 小建议 rules with their conditions.

import { h, put, clear } from '../util.js';
import { button, link, dot, checkRow, select, sectionTitle, loading } from '../ui/components.js';
import { RULES } from '../model/suggest.js';

const ROWS = [
    { key: 'ask', label: '问问', tone: 'other' },
    { key: 'memory', label: '记忆图', tone: 'memory' },
    { key: 'orch', label: '编排', tone: 'orch' },
    { key: 'preset', label: '预设', tone: 'preset' },
    { key: 'card', label: '角色卡', tone: 'card' },
];
const SOURCES = [
    { key: 'inspector', name: '请求检查器', note: '最近 200 次请求的完整内容、用时、状态' },
    { key: 'frontLogs', name: '前端日志', note: '浏览器控制台输出，刷新页面后清空' },
    { key: 'serverLogs', name: '服务器日志', note: '开了多用户时只有管理员能读' },
    { key: 'content', name: '当前内容', note: '聊天、角色卡、世界书、预设、连接配置' },
    { key: 'plugins', name: '插件', note: '记忆图、编排、token 记录、小建议' },
];

export function createSettingsPage(app) {
    const el = h('div', { class: 'wb-page' });
    let choices = null;
    let testing = '';

    async function ensureChoices() {
        if (choices) return;
        try { choices = await app.source.listAiChoices(); } catch { choices = { connections: [], presets: [] }; }
        paint();
    }

    function edit(mutate) {
        const next = structuredClone(app.settings());
        mutate(next);
        app.saveSettings(next);
    }

    function aiTable() {
        const s = app.settings();
        if (!choices) return loading('读取连接配置…');
        const opts = (list, first) => [{ value: '', label: first }, ...list.map(name => ({ value: name, label: name }))];
        const nativeLabel = (key, field) => {
            const n = choices.native?.[key]?.[field];
            return n ? `跟随插件（${n}）` : '跟随默认';
        };
        const row = (key, label, tone, isDefault = false) => {
            const cur = s.ai?.[key] || {};
            const first = (field) => (isDefault
                ? (field === 'preset' ? (choices.hasPluginOnly ? 'plugin-only（Luker 推荐）' : '用 Luker 当前选中的') : '用 Luker 当前的')
                : nativeLabel(key, field));
            return h('tr', null,
                h('td', null, tone ? dot(tone) : null, isDefault ? h('b', { text: label }) : h('span', { text: label })),
                h('td', null, select(opts(choices.connections, first('connection')), cur.connection || '', (v) => edit(n => { n.ai[key].connection = v; }), { ariaLabel: `${label} 连接配置`, follow: true })),
                h('td', null, select(opts(choices.presets, first('preset')), cur.preset || '', (v) => edit(n => { n.ai[key].preset = v; }), { ariaLabel: `${label} 生成预设`, follow: true })));
        };
        return h('div', { class: 'wb-list' }, h('table', { class: 'wb-api' },
            h('thead', null, h('tr', null, h('th'), h('th', { text: '连接配置' }), h('th', { text: '生成预设' }))),
            h('tbody', null, row('default', '默认', '', true), ROWS.map(r => row(r.key, r.label, r.tone)))));
    }

    async function test() {
        testing = 'running';
        paint();
        try {
            const ms = await app.source.aiTest('ask');
            app.toast(`连接正常，用时 ${(ms / 1000).toFixed(1)} 秒`);
        } catch (err) {
            app.toast(`连接失败：${err?.message || err}`, { error: true, duration: 6000 });
        }
        testing = '';
        paint();
    }

    function paint() {
        clear(el);
        const s = app.settings();
        put(el,
            h('div', null, h('h2', { class: 'wb-h2', text: '设置' }), h('p', { class: 'wb-sub', text: 'AI 接口统一选一次，问问和四个工作台共用；也可以单独给某一项换。' })),
            h('section', null,
                sectionTitle('AI 接口', testing ? h('span', { class: 'wb-note', text: '测试中…' }) : link('测试默认', () => test())),
                aiTable(),
                h('p', { class: 'wb-note wb-api-note', text: '连接配置决定用哪个模型、哪个地址；生成预设决定请求外面包的提示词（破限内容在这里，会照常带上）。默认生成预设不选时用 Luker 自带的 plugin-only；「跟随插件」= 用记忆图 / 编排 / 预设助手 / 角色卡助手自己设置里的「迭代 AI」那一项。两项都来自 Luker 自己的列表，工作台只是选用，不会改动它们。' }),
                presetHint(),
                h('div', { class: 'wb-checks' },
                    checkRow({ checked: s.reviewChanges, label: '改动先给我看，不要直接应用', onChange: (v) => edit(n => { n.reviewChanges = v; }) }))),
            promptSection(),
            h('section', null,
                sectionTitle('问问'),
                h('div', { class: 'wb-list' },
                    SOURCES.map(src => setRow(src.name, src.note, checkRow({ checked: s.ask.sources[src.key] !== false, label: '读取', onChange: (v) => edit(n => { n.ask.sources[src.key] = v; }) }))),
                    setRow('聊天原文最多带几楼', '问到某条回复时，连同前后几楼一起发给 AI',
                        select([{ value: '2', label: '前后各 2 楼' }, { value: '0', label: '只带那一楼' }, { value: '5', label: '前后各 5 楼' }], String(s.ask.floors), (v) => edit(n => { n.ask.floors = Number(v); }), { ariaLabel: '聊天原文楼数' }))),
                h('div', { class: 'wb-checks' },
                    checkRow({ checked: s.ask.previewBeforeSend, label: '发给 AI 前先给我看', onChange: (v) => edit(n => { n.ask.previewBeforeSend = v; }) }),
                    checkRow({ checked: s.ask.redact, label: '发出去之前去掉 API key 和地址', onChange: (v) => edit(n => { n.ask.redact = v; }) }))),
            h('section', null,
                sectionTitle('窗口'),
                h('div', { class: 'wb-list' },
                    setRow('右下角的入口', '常驻在角落：显示提示词用量和待处理数，点一下打开，可以拖到别处', checkRow({ checked: s.pill !== false, label: '显示', onChange: (v) => edit(n => { n.pill = v; }) })),
                    setRow('快捷键', '也可以从魔杖菜单打开', select([{ value: 'alt+w', label: 'Alt + W' }, { value: '', label: '不用快捷键' }], s.hotkey, (v) => edit(n => { n.hotkey = v; }), { ariaLabel: '快捷键' })),
                    setRow('窗口和入口的位置', '拖动标题栏移动，右下角拉大小，双击标题栏放大', button('恢复默认', () => { try { const p = JSON.parse(localStorage.getItem('workbench.prefs.v1') || '{}'); delete p.box; delete p.pill; delete p.maximised; localStorage.setItem('workbench.prefs.v1', JSON.stringify(p)); } catch { /* ignore */ } app.toast('刷新页面后生效'); }, { className: 'is-sm' })))),
            rulesSection());
    }

    function rulesSection() {
        const s = app.settings();
        const dismissedCount = Object.keys(s.dismissed || {}).length;
        return h('section', { id: 'wb-rules' },
            sectionTitle('小建议', dismissedCount ? link(`恢复已忽略的 ${dismissedCount} 条`, () => edit(n => { n.dismissed = {}; })) : null),
            h('p', { class: 'wb-sub wb-rules-intro' }, '都是固定的规则，在本地检查记忆图、编排、预设和角色卡的数据和设置，', h('b', { text: '不调用 AI，不花 token' }), '。打开工作台、或者每次生成回复后检查一遍。点「让 AI 看看」时才会真正调用 AI。'),
            h('div', { class: 'wb-list' }, RULES.map(rule => h('div', { class: 'wb-rule' },
                dot(rule.tone),
                h('div', { class: 'wb-rule-main' }, h('div', { text: rule.name }), h('div', { class: 'wb-note', text: rule.when })),
                checkRow({ checked: s.rules[rule.id] ?? rule.defaultOn, ariaLabel: rule.name, onChange: (v) => edit(n => { n.rules[rule.id] = v; }) })))));
    }

    // Luker ships plugin-only.json for plugin / iteration AI calls: a clean
    // envelope that separates the task from RP context. Recommend it here.
    function presetHint() {
        if (!choices) return null;
        const s = app.settings();
        if (choices.hasPluginOnly) return null;
        return h('div', { class: 'wb-hint' },
            h('div', null,
                h('b', { text: '还没有 Luker 自带的「plugin-only」预设' }),
                h('div', { class: 'wb-note', text: '这是 Luker 专门给插件和迭代 AI 准备的预设，把「这是工具任务」和角色扮演内容分开，AI 不容易被文风带跑。导入后工作台默认就用它，你的破限可以照常加在里面。' })),
            h('div', { class: 'wb-hint-acts' },
                button('导入', async () => {
                    try {
                        await app.source.importBundledPreset('plugin-only');
                        choices = null;
                        app.toast('已导入 plugin-only');
                        ensureChoices();
                    } catch (err) { app.toast(String(err?.message || err), { error: true }); }
                }, { className: 'is-primary is-sm' })));
    }

    let prompts = null;
    async function loadPrompts() {
        const roles = ['ask', 'memory', 'orch', 'preset', 'card'];
        const out = {};
        for (const r of roles) {
            try { out[r] = await app.source.promptInfo(r); } catch (err) { out[r] = { from: '读不到', custom: false, text: String(err?.message || err) }; }
        }
        prompts = out;
        paint();
    }

    function promptSection() {
        const s = app.settings();
        const rows = ROWS.map(r => {
            const p = prompts?.[r.key];
            return h('details', { class: 'wb-prompt' },
                h('summary', null,
                    dot(r.tone),
                    h('span', { class: 'wb-prompt-name', text: r.label }),
                    h('span', { class: 'wb-note wb-prompt-from', text: p ? `${p.from}${p.custom ? '（你改过）' : ''}` : '读取中…' })),
                p ? h('pre', { class: 'wb-prompt-text', text: p.text || '（空）' }) : null);
        });
        return h('section', null,
            sectionTitle('提示词'),
            h('p', { class: 'wb-sub wb-rules-intro', text: '问问用工作台内置的提示词；四个工作台直接用 Luker 各自内置的迭代提示词（在原插件设置里改过的话，用你改过的）。点开可以看全文。' }),
            h('div', { class: 'wb-list' }, rows),
            h('div', { class: 'wb-checks' },
                checkRow({ checked: s.builtinPrompt, label: '在前面加一段工作台说明', note: '告诉 AI 改动会先进清单、回复用中文短句、这是改设定不是写故事。不影响 Luker 原来的提示词', onChange: (v) => edit(n => { n.builtinPrompt = v; }) })));
    }

    function setRow(name, note, control) {
        return h('div', { class: 'wb-setrow' }, h('div', null, h('div', { class: 'wb-setrow-name', text: name }), note ? h('div', { class: 'wb-note', text: note }) : null), control);
    }

    return {
        el,
        show(opts = {}) {
            paint();
            ensureChoices();
            if (!prompts) loadPrompts();
            if (opts.scrollTo === 'rules') requestAnimationFrame(() => el.querySelector('#wb-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        },
    };
}
