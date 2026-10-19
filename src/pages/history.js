// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 改动记录: a timeline of everything applied from the workbench, filterable
// by workbench, each entry undoable while this page load still holds its
// undo function.

import { h, put, clear, relativeTime } from '../util.js';
import { button } from '../ui/components.js';

const NAMES = { memory: '记忆图', orch: '编排', preset: '预设', card: '角色卡', world: '世界书' };

export function createHistoryPage(app) {
    const el = h('div', { class: 'wb-page' });
    let filter = '';

    function paint() {
        clear(el);
        const list = app.history.list().filter(e => !filter || e.ws === filter);
        put(el,
            h('div', null, h('h2', { class: 'wb-h2', text: '改动记录' }), h('p', { class: 'wb-sub', text: '在工作台里应用过的所有改动，每一条都能单独撤销（刷新页面之前）。' })),
            h('div', { class: 'wb-filters' },
                [['', '全部'], ...Object.entries(NAMES)].map(([k, n]) => h('button', { type: 'button', class: 'wb-chip', 'aria-pressed': String(filter === k), onClick: () => { filter = k; paint(); } }, n))));
        if (!list.length) {
            put(el, h('p', { class: 'wb-note', text: filter ? '这个工作台还没有改动。' : '还没有改动。在 AI 迭代里应用改动、或者点小建议里的按钮后，会记在这里。' }));
            return;
        }
        put(el, h('div', { class: 'wb-hist' }, list.map(e => h('div', { class: `wb-hist-item ${e.undone ? 'is-undone' : ''}`, style: { '--tone': `var(--wb-t-${e.ws})` } },
            h('span', { class: 'wb-hist-dot', 'aria-hidden': 'true' }),
            h('div', { class: 'wb-hist-card' },
                h('div', { class: 'wb-hist-top' },
                    h('div', { class: 'wb-hist-title', text: e.title }),
                    e.undone ? h('span', { class: 'wb-note', text: '已撤销' })
                        : app.history.canUndo(e.id) ? button('撤销', () => undo(e), { iconName: 'undo', className: 'is-ghost is-sm' }) : null),
                h('div', { class: 'wb-note', text: [NAMES[e.ws], e.scope, relativeTime(e.at), `来自 ${e.from}`].filter(Boolean).join(' · ') }),
                e.lines?.length ? h('ul', { class: 'wb-hist-lines' }, e.lines.slice(0, 8).map(l => h('li', { text: l })), e.lines.length > 8 ? h('li', { text: `…还有 ${e.lines.length - 8} 处` }) : null) : null)))));
    }

    async function undo(e) {
        try {
            await app.history.undo(e.id);
            app.toast('已撤销');
            app.reload();
        } catch (err) {
            app.toast(`没撤销成功：${err?.message || err}`, { error: true });
        }
        paint();
    }

    app.history.subscribe(() => { if (el.isConnected) paint(); });
    return { el, show: paint };
}
