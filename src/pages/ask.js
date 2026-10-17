// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 问问: read-only Q&A over Luker's data. Left: what it can see (live counts).
// Right: the conversation. Each answer shows what was read and roughly how
// much went to the model; "去改…" hands the finding to AI 迭代.

import { h, put, clear, formatTokens, relativeTime } from '../util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { runAsk, readsSummary } from '../model/ask.js';
import { createSessionStore, titleFrom } from '../model/sessions.js';

const CHIPS = ['这条回复为什么会这样写', '刚才为什么报错', '哪个插件最费 token', '这次发给模型的提示词里有什么', '帮我写一份问题反馈，附上调试信息'];
const WS_NAME = { memory: '记忆图', orch: '编排', preset: '预设', card: '角色卡' };

export function createAskPage(app) {
    const store = createSessionStore();
    const side = h('aside', { class: 'wb-src' });
    const chatHead = h('div', { class: 'wb-chat-head' });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', { class: 'wb-input', rows: 1, placeholder: '问什么都行，比如：为什么她突然忘了昨天的事？', 'aria-label': '问问' });
    const sendBtn = button('发送', () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chips = h('div', { class: 'wb-chips' }, CHIPS.map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus(); } }, c)));
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chips, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, chatHead, body, composer);
    const el = h('div', { class: 'wb-page is-split' }, side, chat);

    let session = null;
    let busy = false;
    let abort = null;
    let steps = [];
    let sideOpen = false;
    let counts = null;

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

    // ----- Left: sources ---------------------------------------------------
    async function loadCounts() {
        const s = app.source;
        const settled = await Promise.allSettled([s.listRequests?.({ limit: 200 }), s.frontendLogCount?.()]);
        counts = {
            requests: settled[0].status === 'fulfilled' ? settled[0].value?.length ?? null : null,
            requestsError: settled[0].status === 'rejected',
            logs: settled[1].status === 'fulfilled' ? settled[1].value : null,
            debug: s.debugLoggingOn?.() ?? null,
        };
        paintSide();
    }

    function paintSide() {
        clear(side);
        side.classList.toggle('is-open', sideOpen);
        const snap = app.snapshot();
        const allowed = app.settings().ask.sources;
        const item = (name, n, key, state = 'ok') => h('div', { class: 'wb-src-item' },
            h('span', { class: `wb-src-st is-${allowed[key] === false ? 'off' : state}`, 'aria-hidden': 'true' }),
            h('span', { class: 'wb-src-name', text: name }),
            h('span', { class: 'wb-src-n', text: allowed[key] === false ? '不读' : n }));
        const c = counts;
        put(side,
            h('div', { class: 'wb-src-head' },
                h('div', { class: 'wb-src-title', text: '问问能看到的' }),
                h('p', { class: 'wb-note', text: '都在本地读取，回答时只把用得上的部分发给 AI。' }),
                sideOpen ? iconButton('x', '关闭', () => { sideOpen = false; paintSide(); }, { className: 'wb-src-close' }) : null),
            h('div', { class: 'wb-src-list' },
                h('div', { class: 'wb-src-group', text: '运行记录' }),
                item('请求检查器', c ? (c.requestsError ? '读不到' : `${c.requests ?? 0} 次请求`) : '…', 'inspector', c?.requestsError ? 'warn' : 'ok'),
                item('前端日志', c?.logs == null ? '…' : `${c.logs.toLocaleString()} 条`, 'frontLogs', c?.debug === false ? 'warn' : 'ok'),
                item('服务器日志', '按需读取', 'serverLogs'),
                c?.debug === false && allowed.frontLogs !== false ? h('div', { class: 'wb-src-warn' },
                    h('div', { text: '「前端调试日志」没打开，API 请求的日志不会记下来。' }),
                    button('帮我打开', () => {
                        try { app.source.enableDebugLogging(); app.toast('已打开前端调试日志'); loadCounts(); } catch (err) { app.toast(String(err?.message || err), { error: true }); }
                    }, { className: 'is-sm' })) : null,
                h('div', { class: 'wb-src-group', text: '当前内容' }),
                item('聊天', snap?.chat?.label ? `${snap.chat.floors} 楼` : '没打开', 'content'),
                item('角色卡', snap?.card?.name || '未选择', 'content'),
                item('世界书', snap?.card?.books?.length ? `${snap.card.books.length} 本` : '—', 'content'),
                item('预设', snap?.preset?.name || '—', 'content'),
                item('连接配置', snap?.connection || '—', 'content'),
                h('div', { class: 'wb-src-group', text: '插件' }),
                item('记忆图', snap?.memory ? `${snap.memory.nodes} 个节点` : '没有', 'plugins'),
                item('编排', snap?.orch ? `${snap.orch.runs.length} 次运行` : '没有', 'plugins'),
                item('小建议', `${app.suggestions().length} 条`, 'plugins')),
            h('div', { class: 'wb-src-foot' }, button('在设置里调整', () => app.go('settings'), { className: 'is-ghost is-sm' })));
    }

    // ----- Right: conversation ---------------------------------------------
    function paintHead() {
        clear(chatHead);
        const recent = store.list('ask').slice(0, 8);
        put(chatHead,
            iconButton('list', '能看到的内容', () => { sideOpen = true; paintSide(); }, { className: 'wb-src-toggle' }),
            h('span', { class: 'wb-chat-title', text: '问问' }),
            h('span', { class: 'wb-note wb-chat-tag', text: '只读，不会改任何东西' }),
            h('span', { class: 'wb-spacer' }),
            recent.length ? historyMenu(recent) : null,
            button('新对话', () => { session = null; steps = []; paintHead(); paintBody(); input.focus(); }, { iconName: 'plus', className: 'is-ghost wb-chat-new', title: '新对话' }));
    }

    function historyMenu(recent) {
        const sel = h('select', { class: 'wb-select wb-chat-hist', 'aria-label': '之前的对话' },
            h('option', { value: '', text: '之前的对话' }),
            recent.map(s => h('option', { value: s.id, text: `${s.title} · ${relativeTime(s.updatedAt)}` })));
        sel.value = session?.id || '';
        sel.addEventListener('change', () => { session = store.get(sel.value); steps = []; paintBody(); });
        return sel;
    }

    function paintBody() {
        clear(body);
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            put(body, h('div', { class: 'wb-empty' },
                icon('ask', { size: 28 }),
                h('b', { text: '想知道什么，直接问' }),
                h('div', { text: '比如「这条回复为什么等了这么久」「为什么她忘了昨天的约定」「哪个插件最费 token」。问问会自己去翻请求、日志、角色卡和记忆图。' })));
        }
        for (const t of turns) put(body, t.role === 'user' ? h('div', { class: 'wb-msg-me', text: t.text }) : answerBlock(t));
        if (busy) {
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }),
                    h('span', { text: steps.length ? `正在看 ${readsSummary(steps)}…` : '正在想…' })),
                button('停止', () => abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' })));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        paintOpts();
    }

    function answerBlock(t) {
        const reads = readsSummary(t.reads || []);
        return h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: `看了 ${reads}` })) : null,
            t.error ? h('div', { class: 'wb-msg-error', text: t.error }) : renderMarkdown(t.answer),
            t.suggest && WS_NAME[t.suggest] ? h('div', { class: 'wb-ans-acts' },
                button(`去改${WS_NAME[t.suggest]}`, () => app.go('ai', { ws: t.suggest, draft: t.fixPrompt || '', from: t.answer }), { iconName: 'spark' })) : null,
            t.sent ? h('details', { class: 'wb-sent' },
                h('summary', null, icon('up', { size: 12 }), h('span', { text: `发给 AI 的内容（约 ${formatTokens(Math.round(t.sent / 1.6))} token）` })),
                h('ul', null,
                    h('li', { text: '问题和一份概况（聊天、预设、提示词占用、最近 8 次请求的状态）' }),
                    (t.reads || []).map(r => h('li', { text: `${readsSummary([r])}${r.args && Object.keys(r.args).length ? `：${JSON.stringify(r.args)}` : ''}（${r.chars.toLocaleString()} 字）` })),
                    app.settings().ask.redact ? h('li', { text: 'API key 和接口地址已去掉' }) : null)) : null);
    }

    function paintOpts() {
        clear(opts);
        const s = app.settings();
        put(opts, checkRow({
            checked: s.ask.previewBeforeSend,
            label: '发给 AI 前先给我看',
            onChange: (v) => { const n = structuredClone(app.settings()); n.ask.previewBeforeSend = v; app.saveSettings(n); },
        }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    async function send() {
        const question = input.value.trim();
        if (!question || busy) return;
        const s = app.settings();
        let overview;
        try { overview = await app.source.askOverview(); } catch (err) { overview = { 错误: String(err?.message || err) }; }
        if (s.ask.previewBeforeSend && !globalThis.confirm(`将发给 AI：\n\n问题：${question}\n\n概况：\n${JSON.stringify(overview, null, 1).slice(0, 1500)}\n\n之后 AI 会按需读取数据。继续吗？`)) return;
        if (!session) session = store.create({ kind: 'ask', title: titleFrom(question) });
        session = store.update(session.id, { turns: [...session.turns, { role: 'user', text: question, at: Date.now() }] });
        input.value = '';
        grow();
        busy = true;
        steps = [];
        abort = new AbortController();
        paintBody();
        const history = session.turns.slice(0, -1).slice(-6).map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.role === 'user' ? t.text : t.answer || '' }));
        let turn;
        try {
            const result = await runAsk({
                question,
                overview,
                history,
                sources: s.ask.sources,
                signal: abort.signal,
                readers: app.source.askReaders({ redactText: s.ask.redact, suggestions: () => app.suggestions() }),
                request: (messages, tools) => app.source.aiRequest('ask', { messages, tools, signal: abort.signal }),
                onStep: (step) => { steps.push(step); paintBody(); },
            });
            turn = { role: 'ai', ...result, at: Date.now() };
        } catch (err) {
            turn = { role: 'ai', answer: '', error: abort.signal.aborted ? '已停止。' : `没问成：${err?.message || err}`, reads: steps, at: Date.now() };
        }
        busy = false;
        abort = null;
        session = store.update(session.id, { turns: [...session.turns, turn] });
        paintHead();
        paintBody();
    }

    return {
        el,
        flush: true,
        show(o = {}) {
            paintSide();
            paintHead();
            paintBody();
            loadCounts();
            if (o.draft) { input.value = o.draft; grow(); }
            requestAnimationFrame(() => input.focus());
        },
        onSnapshot() { paintSide(); },
        onEscape() {
            if (sideOpen) { sideOpen = false; paintSide(); return true; }
            if (busy) { abort?.abort(); return true; }
            return false;
        },
        destroy() { abort?.abort(); },
    };
}
