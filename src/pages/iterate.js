// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI 迭代: one conversation per (workbench, scope). The AI edits its own copy;
// at the end of each turn the page diffs that copy against the saved one and
// shows a change list. 应用所选 writes the accepted units to Luker (through
// the workbench's own save path) and records an undoable history entry.
//
// Scope rules: 记忆图 / 编排 = 全局 or 当前角色卡; 预设 = 全局 only;
// 角色卡 = 当前角色卡 only. No character (or a group chat) = 未选择角色卡.

import { h, put, clear, relativeTime } from '../util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, segmented, dot } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { changeList } from '../ui/change-list.js';
import { diffUnits } from '../model/units.js';
import { runIterateTurn, wrapperPrompt, decisionNote, trimMessages } from '../model/iterate.js';
import { createSessionStore, groupSessions, titleFrom } from '../model/sessions.js';

const WS = [
    { value: 'memory', label: '记忆图', tone: 'memory' },
    { value: 'orch', label: '编排', tone: 'orch' },
    { value: 'preset', label: '预设', tone: 'preset' },
    { value: 'card', label: '角色卡', tone: 'card' },
];
const WS_NAME = Object.fromEntries(WS.map(w => [w.value, w.label]));
const CHIPS = {
    memory: ['为什么这次没召回该记的事', '帮我新建一个记忆类型', '常驻注入太高怎么办', '把记录项的说明写得更清楚'],
    orch: ['最近一次运行哪里慢', '这个助手的提示词能更短吗', '让审稿更严格一点', '换一个更快的连接给最慢的助手'],
    preset: ['找出互相矛盾的要求', '精简文风条目', '回复太长了，改哪里', '这条回复不像角色，查查预设'],
    card: ['这条回复不像她，帮我找原因', '精简设定，去掉重复的描述', '补几段示例对话', '检查世界书有没有冲突'],
};
const SCOPE_NOTE = {
    memory: { global: '改所有角色共用的记忆结构', character: '只改这个角色单独的记忆结构（没有的话保存时新建一份）' },
    orch: { global: '改所有角色共用的编排方案', character: '只改这个角色单独的编排方案' },
    preset: { global: '预设不分角色，改的是当前选中的预设' },
    card: { character: '改这个角色的角色卡和绑定的世界书' },
};

export function createIteratePage(app) {
    const store = createSessionStore();
    const sess = h('aside', { class: 'wb-sess' });
    const head = h('div', { class: 'wb-chat-head' });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', { class: 'wb-input', rows: 1, placeholder: '想改什么？用平常说话的方式描述就行', 'aria-label': '告诉 AI 想改什么' });
    const sendBtn = button('发送', () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chips = h('div', { class: 'wb-chips' });
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chips, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, head, body, composer);
    const el = h('div', { class: 'wb-page is-split' }, sess, chat);

    let ws = 'card';
    let scope = 'character';
    let scopes = null; // { memory: { global, character }, ... }
    let session = null;
    // In-memory per session: { base, ai, target, title } — rebuilt when missing.
    const work = new Map();
    let busy = false;
    let abort = null;
    let liveStep = '';
    let withReply = true;
    let sessOpen = false;
    let loadError = '';

    const iter = () => app.source.iterate;
    const charName = () => app.snapshot()?.card?.name || '';

    // ----- scope ----------------------------------------------------------
    function allowedScopes(w = ws) {
        const s = scopes?.[w] || { global: w !== 'card', character: Boolean(charName()) && w !== 'preset' };
        return { global: Boolean(s.global) && w !== 'card', character: Boolean(s.character) && w !== 'preset' };
    }
    function fixScope() {
        const a = allowedScopes();
        if (scope === 'character' && !a.character) scope = a.global ? 'global' : 'character';
        if (scope === 'global' && !a.global) scope = 'character';
    }
    const blocked = () => ws === 'card' && !allowedScopes().character;

    // ----- sessions -------------------------------------------------------
    const sessions = () => store.list('iterate');
    function pendingOf(s) {
        const last = [...(s?.turns || [])].reverse().find(t => t.role === 'ai' && t.changes?.length);
        return last && last.state === 'pending' ? last.changes.length : 0;
    }

    function paintSessions() {
        clear(sess);
        sess.classList.toggle('is-open', sessOpen);
        const list = sessions();
        put(sess,
            h('div', { class: 'wb-sess-head' },
                button('新对话', () => newChat(), { iconName: 'plus' }),
                sessOpen ? iconButton('x', '关闭', () => { sessOpen = false; paintSessions(); }) : null),
            h('div', { class: 'wb-sess-list' },
                list.length ? groupSessions(list).map(g => [
                    h('div', { class: 'wb-src-group', text: g.label }),
                    g.items.map(s => {
                        const p = pendingOf(s);
                        return h('button', { type: 'button', class: 'wb-sess-item', 'aria-current': String(s.id === session?.id), onClick: () => openSession(s.id) },
                            dot(s.ws),
                            h('span', { class: 'wb-sess-main' },
                                h('span', { class: 'wb-sess-t', text: s.title }),
                                h('span', { class: 'wb-sess-m' },
                                    `${WS_NAME[s.ws]} · ${s.scope === 'character' ? s.scopeName || '角色' : '全局'} · ${relativeTime(s.updatedAt)}`,
                                    p ? h('span', { class: 'wb-sess-p', text: ` · ${p} 处待确认` }) : null)));
                    })]) : h('p', { class: 'wb-note wb-sess-empty', text: '还没有对话。' })));
    }

    function newChat() {
        session = null;
        sessOpen = false;
        paintAll();
        input.focus();
    }

    function openSession(id) {
        const s = store.get(id);
        if (!s) return;
        session = s;
        ws = s.ws;
        scope = s.scope;
        sessOpen = false;
        paintAll();
    }

    // ----- head -----------------------------------------------------------
    function paintHead() {
        clear(head);
        fixScope();
        const a = allowedScopes();
        const name = charName();
        const locked = Boolean(session?.turns?.length);
        put(head,
            iconButton('list', '对话列表', () => { sessOpen = true; paintSessions(); }, { className: 'wb-src-toggle' }),
            segmented(WS.map(w => ({ ...w, disabled: locked && w.value !== ws })), ws, (v) => { ws = v; session = null; scope = v === 'preset' ? 'global' : 'character'; paintAll(); }, { ariaLabel: '改哪个工作台', className: 'wb-ws-seg' }),
            segmented([
                { value: 'global', label: '全局', iconName: 'globe', hidden: ws === 'card', disabled: !a.global || (locked && scope !== 'global') },
                { value: 'character', label: name ? `当前角色卡「${name}」` : '未选择角色卡', iconName: 'card', hidden: ws === 'preset', disabled: !a.character || (locked && scope !== 'character') },
            ], scope, (v) => { scope = v; session = null; paintAll(); }, { ariaLabel: '改哪一份', className: 'wb-scope-seg' }),
            h('span', { class: 'wb-scope-note', text: blocked() ? '' : !name && ws !== 'preset' && ws !== 'card' ? '没选角色卡，只能改全局的' : SCOPE_NOTE[ws][scope] || '' }));
    }

    // ----- body -----------------------------------------------------------
    function paintBody() {
        clear(body);
        if (blocked()) {
            put(body, h('div', { class: 'wb-empty' }, icon('card', { size: 28 }), h('b', { text: '未选择角色卡' }),
                h('div', { text: '角色卡没有全局的一份。先在 Luker 里打开一个角色的聊天（群聊不行），再回来改。记忆图、编排、预设可以照常改全局的。' })));
            composer.hidden = true;
            return;
        }
        composer.hidden = false;
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            const w = work.get(keyOf());
            put(body, h('div', { class: 'wb-empty' }, icon('spark', { size: 28 }),
                h('b', { text: `和 AI 一起改${WS_NAME[ws]}` }),
                h('div', { text: loadError || (w ? `要改的是：${w.title}。说说哪里不满意，AI 会改好放进改动清单，你勾选后再应用。` : '说说哪里不满意，AI 会改好放进改动清单，你勾选后再应用。') })));
        }
        turns.forEach((t, i) => put(body, t.role === 'user' ? h('div', { class: 'wb-msg-me', text: t.text }) : aiBlock(t, i)));
        if (busy) {
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }), h('span', { text: liveStep || '正在想…' })),
                button('停止', () => abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' })));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }

    function aiBlock(t, index) {
        const reads = t.reads ? `看了 ${t.reads} 次${t.edits ? `，改了 ${t.edits} 次` : ''}${t.failed ? `，${t.failed} 次没改成` : ''}` : '';
        const node = h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: reads })) : null,
            t.error ? h('div', { class: 'wb-msg-error', text: t.error }) : t.text ? renderMarkdown(t.text) : null);
        if (t.changes?.length) {
            const card = changeList({
                changes: t.changes,
                state: t.state || 'pending',
                target: t.target || '',
                note: app.settings().reviewChanges ? '' : '已自动应用。可以在「改动记录」里撤销',
                onApply: (keys) => apply(index, keys),
                onDiscard: () => discard(index),
                onUndo: t.historyId && app.history.canUndo(t.historyId) ? () => undoTurn(index) : null,
            });
            put(node, card.el);
        } else if (!t.error && t.edits === 0 && t.text) {
            // nothing
        }
        return node;
    }

    function paintOpts() {
        clear(chips);
        put(chips, CHIPS[ws].map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus(); } }, c)));
        clear(opts);
        const s = app.settings();
        put(opts,
            checkRow({ checked: withReply, label: '带上最近一条回复', onChange: (v) => { withReply = v; } }),
            checkRow({ checked: !s.reviewChanges, label: '自动应用', onChange: (v) => { const n = structuredClone(app.settings()); n.reviewChanges = !v; app.saveSettings(n); paintBody(); } }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    function paintAll() {
        paintSessions();
        paintHead();
        paintBody();
        paintOpts();
        ensureWork();
    }

    // ----- working copies -------------------------------------------------
    const keyOf = (w = ws, s = scope) => `${w}:${s}:${s === 'character' ? app.snapshot()?.chat?.character?.avatar || '' : ''}`;

    async function ensureWork() {
        if (blocked() || !iter()) return null;
        const k = keyOf();
        if (work.has(k)) return work.get(k);
        try {
            const res = await iter().load(ws, scope);
            const w = { base: res.live, ai: structuredClone(res.live), target: res.target, title: res.title };
            work.set(k, w);
            loadError = '';
            if (!session?.turns?.length && !busy) paintBody();
            return w;
        } catch (err) {
            loadError = String(err?.message || err);
            paintBody();
            return null;
        }
    }

    // ----- send -----------------------------------------------------------
    function grow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    }
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !globalThis.matchMedia?.('(hover: none)').matches) {
            event.preventDefault();
            send();
        }
    });

    async function send() {
        const text = input.value.trim();
        if (!text || busy || blocked()) return;
        const w = await ensureWork();
        if (!w) { app.toast(loadError || '读不到要改的内容', { error: true }); return; }
        if (!session) session = store.create({ kind: 'iterate', ws, scope, scopeName: scope === 'character' ? charName() : '', title: titleFrom(text), messages: [] });
        // Pending changes from the last turn that were never decided count as discarded.
        const turns = session.turns.map(t => (t.state === 'pending' ? { ...t, state: 'discarded' } : t));
        if (turns.some((t, i) => t.state !== session.turns[i].state)) w.ai = structuredClone(w.base);
        let userContent = text;
        const note = session.note || '';
        if (note) userContent = `${note}\n\n${text}`;
        if (withReply) {
            const reply = await iter().lastReply?.();
            if (reply) userContent += `\n\n<最近一条回复>\n${reply}\n</最近一条回复>`;
        }
        session = store.update(session.id, { turns: [...turns, { role: 'user', text, at: Date.now() }], note: '' });
        input.value = '';
        grow();
        busy = true;
        liveStep = '';
        abort = new AbortController();
        paintBody();
        paintOpts();
        let turn;
        try {
            const system = await iter().systemPrompt(ws, scope, w.ai, { wrapper: wrapperPrompt({ wsName: WS_NAME[ws], scopeText: w.title, builtin: app.settings().builtinPrompt }) });
            const history = (session.messages || []).filter(m => m.role !== 'system');
            const messages = trimMessages([{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }]);
            const tools = await iter().tools(ws, w.ai);
            const result = await runIterateTurn({
                messages,
                live: w.ai,
                tools,
                isRead: (n) => iter().isRead(ws, n),
                runRead: (call, live) => iter().runRead(ws, call, live),
                runEdit: (call, live) => iter().runEdit(ws, call, live),
                request: (msgs, t) => app.source.aiRequest(ws, { messages: msgs, tools: t, signal: abort.signal }),
                onRound: (info) => { liveStep = `看了 ${info.reads} 次，改了 ${info.edits} 次…`; paintBody(); },
                signal: abort.signal,
            });
            w.ai = result.live;
            const changes = diffUnits(iter().units(ws, w.base), iter().units(ws, w.ai));
            turn = { role: 'ai', text: result.text || (changes.length ? '' : '（AI 没有改动）'), reads: result.reads.length, edits: result.edits.length, failed: result.failed.length, changes, state: changes.length ? 'pending' : '', target: w.title, at: Date.now() };
            session = store.update(session.id, { messages: result.messages.filter(m => m.role !== 'system').slice(-60) });
        } catch (err) {
            turn = { role: 'ai', text: '', error: abort.signal.aborted ? '已停止。' : `没改成：${err?.message || err}`, at: Date.now() };
        }
        busy = false;
        abort = null;
        session = store.update(session.id, { turns: [...session.turns, turn] });
        const idx = session.turns.length - 1;
        if (turn.changes?.length && !app.settings().reviewChanges) await apply(idx, turn.changes.map(c => c.key));
        paintAll();
        app.refreshBadges();
    }

    // ----- decide ---------------------------------------------------------
    async function apply(index, keys) {
        const w = work.get(keyOf(session.ws, session.scope));
        const t = session.turns[index];
        if (!w || !t?.changes) return;
        try {
            const next = iter().rebuild(ws, w.base, w.ai, keys);
            const handle = await iter().commit(ws, w.target, w.base, next, keys);
            const labels = t.changes.filter(c => keys.includes(c.key)).map(c => c.label);
            const dropped = t.changes.filter(c => !keys.includes(c.key)).map(c => c.label);
            const historyId = app.history.record({
                ws, title: `${session.title}`, scope: w.title,
                lines: t.changes.filter(c => keys.includes(c.key)).map(c => `${{ add: '新增', remove: '删除', change: '修改' }[c.kind]}「${c.label}」`),
                from: 'AI 对话',
                undo: async () => { await handle.undo(); work.delete(keyOf(session.ws, session.scope)); },
            });
            w.base = structuredClone(next);
            w.ai = structuredClone(next);
            const turns = session.turns.map((x, i) => (i === index ? { ...x, state: dropped.length ? 'partial' : 'applied', historyId } : x));
            session = store.update(session.id, { turns, note: decisionNote({ applied: labels, discarded: dropped }) });
            app.toast(`已应用 ${keys.length} 处`, { action: '撤销', onAction: () => undoTurn(index) });
            app.reload();
        } catch (err) {
            app.toast(`没保存成功：${err?.message || err}`, { error: true, duration: 7000 });
        }
        paintAll();
        app.refreshBadges();
    }

    function discard(index) {
        const w = work.get(keyOf(session.ws, session.scope));
        const t = session.turns[index];
        if (w) w.ai = structuredClone(w.base);
        const turns = session.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x));
        session = store.update(session.id, { turns, note: decisionNote({ discarded: (t?.changes || []).map(c => c.label) }) });
        paintAll();
        app.refreshBadges();
    }

    async function undoTurn(index) {
        const t = session.turns[index];
        if (!t?.historyId) return;
        try {
            await app.history.undo(t.historyId);
            work.delete(keyOf(session.ws, session.scope));
            const turns = session.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x));
            session = store.update(session.id, { turns, note: `（用户撤销了上一轮应用的改动：${t.changes.map(c => c.label).join('、')}。现在是改之前的样子。）` });
            app.toast('已撤销');
            app.reload();
        } catch (err) {
            app.toast(`没撤销成功：${err?.message || err}`, { error: true });
        }
        paintAll();
        app.refreshBadges();
    }

    // ----- refresh when Luker changes -------------------------------------
    async function refreshScopes() {
        try { scopes = await iter()?.scopes?.(); } catch { scopes = null; }
    }

    return {
        el,
        flush: true,
        async show(o = {}) {
            if (o.sessionId) { const s = store.get(o.sessionId); if (s) { session = s; ws = s.ws; scope = s.scope; } }
            else if (o.ws && o.ws !== ws) { ws = o.ws; session = null; scope = ws === 'preset' ? 'global' : 'character'; }
            else if (o.ws) { session = null; }
            await refreshScopes();
            paintAll();
            if (o.draft) { input.value = o.draft; grow(); }
            requestAnimationFrame(() => input.focus());
        },
        onSnapshot() {
            // The open character may have changed: drop copies for other characters.
            for (const k of [...work.keys()]) if (!k.endsWith(`:${app.snapshot()?.chat?.character?.avatar || ''}`) && k.includes(':character:')) work.delete(k);
            refreshScopes().then(() => { if (el.isConnected && !busy) { paintHead(); paintBody(); } });
        },
        pendingCount: () => sessions().reduce((n, s) => n + (pendingOf(s) ? 1 : 0), 0),
        pendingInfo() {
            const s = sessions().find(x => x.ws === 'card' && pendingOf(x));
            return s ? { pending: pendingOf(s), sessionTitle: s.title, sessionId: s.id } : null;
        },
        onEscape() {
            if (sessOpen) { sessOpen = false; paintSessions(); return true; }
            if (busy) { abort?.abort(); return true; }
            return false;
        },
        destroy() { abort?.abort(); },
    };
}
