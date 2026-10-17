// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 总览: prompt budget bar, 待处理 (小建议 + pending AI changes), and the four
// workbench cards.

import { h, put, clear, formatTokens, relativeTime, formatDuration } from '../util.js';
import { icon } from '../icons.js';
import { button, link, dot, pillTag, sectionTitle, loading } from '../ui/components.js';
import { budgetNote } from '../model/budget.js';

export function createHomePage(app) {
    const el = h('div', { class: 'wb-page' });
    const openWhy = new Set();

    function paint() {
        clear(el);
        const snap = app.snapshot();
        const chat = snap?.chat;
        put(el, h('div', null,
            h('h2', { class: 'wb-h2', text: '总览' }),
            h('p', { class: 'wb-sub', text: chat?.label ? `${chat.label}。哪里占地方、哪里有事要处理，都在这里。` : '还没打开聊天。打开一个聊天后，这里会显示提示词占用和小建议。' })));
        if (!snap) {
            put(el, app.loadError() ? h('p', { class: 'wb-note', text: `读取失败：${app.loadError()}` }) : loading());
            return;
        }
        put(el, budgetCard(snap), todoSection(), cardsSection(snap));
    }

    function budgetCard(snap) {
        const b = snap.budget;
        const head = sectionTitle('最近一次提示词里各部分占多少', link('重新计算', () => app.reload(), { iconName: 'refresh' }));
        if (!b) {
            return h('section', { class: 'wb-budget' }, head,
                h('p', { class: 'wb-note', text: '还没有数据。生成一条回复后，这里会显示预设、角色卡、世界书、记忆图、聊天记录各占多少 token（只支持对话补全接口）。' }));
        }
        const note = budgetNote(b, b.memoryHistory || []);
        return h('section', { class: 'wb-budget' }, head,
            h('div', { class: 'wb-budget-top' },
                h('span', { class: 'wb-budget-total', text: formatTokens(b.total) }),
                b.max ? h('span', { class: 'wb-budget-of', text: `/ 上下文 ${formatTokens(b.max)} token` }) : null,
                note ? h('span', { class: 'wb-budget-warn', text: note }) : null),
            h('div', { class: 'wb-bar', role: 'img', 'aria-label': b.parts.map(p => `${p.label} ${formatTokens(p.tokens)}`).join('，') },
                b.parts.map(p => h('span', { style: { flexGrow: String(p.tokens), background: `var(--wb-t-${p.key})` }, title: `${p.label} ${p.tokens} token` }))),
            h('div', { class: 'wb-legend' }, b.parts.map(p => h('span', null,
                h('i', { style: { background: `var(--wb-t-${p.key})` } }), p.label, h('b', { text: formatTokens(p.tokens) })))));
    }

    function todoSection() {
        const list = app.suggestions();
        const head = sectionTitle(list.length ? `待处理 · ${list.length}` : '待处理', link('小建议是怎么来的', () => app.go('settings', { scrollTo: 'rules' }), { iconName: 'info' }));
        if (!list.length) return h('section', null, head, h('p', { class: 'wb-note', text: '现在没有要处理的事。' }));
        return h('section', null, head, h('div', { class: 'wb-tips' }, list.map(tip)));
    }

    function tip(s) {
        const why = h('details', { class: 'wb-why', open: openWhy.has(s.id) || null, onToggle: (e) => { if (e.target.open) openWhy.add(s.id); else openWhy.delete(s.id); } },
            h('summary', null, icon('info', { size: 12 }), h('span', { text: '为什么这么说' })),
            h('div', { class: 'wb-why-body' }, h('div', { text: s.why }), h('span', { class: 'wb-why-src', text: `规则检查 · ${s.source}，没有调用 AI` })));
        const acts = s.actions.map(a => button(a.label, () => runAction(s, a), { className: a.primary ? 'is-primary' : '' }));
        if (s.id !== 'card.pending') acts.push(button('忽略', () => dismiss(s), { className: 'is-ghost' }));
        return h('div', { class: 'wb-tip', style: { '--tone': `var(--wb-t-${s.tone})` } },
            dot(s.tone),
            h('div', { class: 'wb-tip-main' },
                h('div', { text: s.text }),
                h('div', { class: 'wb-tip-meta', text: `${{ memory: '记忆图', orch: '编排', preset: '预设', card: '角色卡' }[s.tone]} · ${s.id === 'card.pending' ? '等你确认' : '小建议'}` }),
                why),
            h('div', { class: 'wb-tip-acts' }, acts));
    }

    function dismiss(s) {
        const next = structuredClone(app.settings());
        next.dismissed = { ...next.dismissed, [s.id]: s.sig };
        app.saveSettings(next);
        paint();
        app.toast('已忽略，数字变了还会再提醒', {
            action: '撤销',
            onAction: () => {
                const back = structuredClone(app.settings());
                delete back.dismissed[s.id];
                app.saveSettings(back);
                paint();
            },
        });
    }

    async function runAction(s, a) {
        if (a.kind === 'session') { app.go('ai', { sessionId: a.sessionId }); return; }
        if (a.kind === 'ai') { app.go('ai', { ws: a.ws, draft: a.prompt }); return; }
        if (a.kind === 'ask') { app.go('ask', { draft: a.question }); return; }
        if (a.kind === 'setHorizon') {
            try {
                const result = await app.source.setMemoryHorizon(a.value);
                app.history?.record?.({ ws: 'memory', title: `常驻注入最大回溯楼层 ${result.before || '不限'} → ${a.value}`, lines: [result.scope === 'character' ? '改的是当前角色单独的设置' : '改的是全局设置'], from: '小建议', undo: { kind: 'setHorizon', value: result.before } });
                app.toast(`已设成 ${a.value}`, {
                    action: '撤销',
                    onAction: async () => { await app.source.setMemoryHorizon(result.before); app.reload(); },
                });
                app.reload();
            } catch (err) {
                app.toast(`没改成：${err?.message || err}`, { error: true });
            }
        }
    }

    function cardsSection(snap) {
        const m = snap.memory;
        const o = snap.orch;
        const p = snap.preset;
        const c = snap.card;
        const warn = (id) => app.suggestions().some(s => s.tone === id);
        const status = (id, installed) => !installed ? pillTag('没装', '') : warn(id) ? pillTag('有建议', 'warn') : pillTag('正常', 'ok');
        const askBtn = (ws) => button('问 AI', () => app.go('ai', { ws }), { iconName: 'spark' });
        const lensBtn = (which, label) => (snap.lenses?.[which] ? button(`打开${label}`, () => { app.source.openLens(which); app.collapse(); }, { iconName: 'lens', className: 'is-ghost' }) : null);
        const card = (tone, iconName, name, by, pill, stats, acts) => h('article', { class: 'wb-card', style: { '--tone': `var(--wb-t-${tone})` } },
            h('div', { class: 'wb-card-head' },
                h('span', { class: 'wb-card-icon' }, icon(iconName, { size: 17 })),
                h('div', { class: 'wb-card-title' }, h('div', { class: 'wb-card-name', text: name }), h('div', { class: 'wb-card-by', text: by })),
                pill),
            h('div', { class: 'wb-card-stat' }, stats.filter(Boolean).map(([k, v]) => h('span', null, `${k} `, h('b', { text: v })))),
            h('div', { class: 'wb-card-acts' }, acts));
        const last = o?.last;
        const avg = o?.runs?.length ? o.runs.reduce((s, r) => s + (r.durationMs || 0), 0) / o.runs.length : 0;
        return h('section', null, sectionTitle('四个工作台'), h('div', { class: 'wb-cards' },
            card('memory', 'memory', '记忆图', m ? `${m.scope === 'character' ? '当前角色单独的设置' : '全局设置'}` : '没有检测到记忆图', status('memory', Boolean(m)),
                m ? [['节点', String(m.nodes)], ['常驻', formatTokens(m.core)], m.focus ? ['本次召回', formatTokens(m.focus)] : null] : [],
                [m ? askBtn('memory') : null, lensBtn('memory', '记忆透镜')]),
            card('orch', 'orch', '编排', o ? (o.enabled ? '已开启' : '没有开启') : '没有检测到编排', status('orch', Boolean(o)),
                o ? [['上次运行', last ? relativeTime(last.at) : '还没有'], avg ? ['平均', formatDuration(avg)] : null] : [],
                [o ? askBtn('orch') : null, lensBtn('orch', '编排透镜')]),
            card('preset', 'preset', '预设', p?.name || '对话补全预设', status('preset', Boolean(p)),
                p ? [['启用条目', String(p.prompts.filter(x => x.enabled).length)], snap.budget ? ['占用', formatTokens(snap.budget.parts.find(x => x.key === 'preset')?.tokens || 0)] : null] : [],
                [p ? askBtn('preset') : null]),
            card('card', 'card', '角色卡', c?.name ? `${c.name}${c.books?.length ? ` · ${c.books.length} 本世界书` : ''}` : '未选择角色卡', c?.name ? (warn('card') ? pillTag('待确认', 'warn') : pillTag('正常', 'ok')) : pillTag('未选择', ''),
                c?.name && snap.budget ? [['设定', formatTokens(snap.budget.parts.find(x => x.key === 'card')?.tokens || 0)], ['世界书', formatTokens(snap.budget.parts.find(x => x.key === 'world')?.tokens || 0)]] : [],
                [c?.name ? askBtn('card') : null])));
    }

    return {
        el,
        show: paint,
        onSnapshot: paint,
    };
}
