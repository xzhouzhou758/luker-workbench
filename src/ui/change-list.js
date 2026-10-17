// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Change list card: one row per changed unit, a checkbox, a 修改/新增/删除
// tag and a fold-out before/after line diff. Footer: 应用所选 / 全部放弃.

import { h, put, clear } from '../util.js';
import { icon } from '../icons.js';
import { button } from './components.js';
import { lineDiff, inlineMarks, changeSummary } from '../model/units.js';

const TAG = { change: ['修改', ''], add: ['新增', 'is-add'], remove: ['删除', 'is-del'] };

function diffView(change) {
    const rows = lineDiff(change.before, change.after);
    const box = h('div', { class: 'wb-diff' });
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const next = rows[i + 1];
        if (r.type === 'del' && next?.type === 'add') {
            const { prefix, suffix } = inlineMarks(r.text, next.text);
            const mark = (text, cls) => h('div', { class: cls },
                text.slice(0, prefix),
                h('mark', { text: text.slice(prefix, text.length - suffix) }),
                text.slice(text.length - suffix));
            put(box, mark(r.text, 'is-del'), mark(next.text, 'is-add'));
            i++;
            continue;
        }
        put(box, h('div', { class: `is-${r.type}`, text: r.text || ' ' }));
    }
    return box;
}

/**
 * @param {{ changes, state: 'pending'|'applied'|'discarded'|'partial', target: string,
 *           onApply(keys), onDiscard(), onUndo?(), selected?: Set }} opts
 */
export function changeList({ changes, state = 'pending', target = '', onApply, onDiscard, onUndo = null, note = '' }) {
    const picked = new Set(changes.map(c => c.key));
    const open = new Set(changes.length === 1 ? [changes[0].key] : []);
    const el = h('div', { class: `wb-chg is-${state}` });

    function paint() {
        clear(el);
        el.className = `wb-chg is-${state}`;
        const pending = state === 'pending';
        put(el, h('div', { class: 'wb-chg-head' },
            icon('list', { size: 14 }),
            h('b', { text: `${changes.length} 处改动` }),
            h('span', { class: 'wb-note', text: [changeSummary(changes), target].filter(Boolean).join(' · ') }),
            h('span', { class: 'wb-spacer' }),
            state === 'applied' ? h('span', { class: 'wb-pilltag is-ok', text: '已应用' })
                : state === 'partial' ? h('span', { class: 'wb-pilltag is-ok', text: '已应用部分' })
                    : state === 'discarded' ? h('span', { class: 'wb-pilltag', text: '已放弃' }) : null));
        let group = '';
        for (const c of changes) {
            if (c.group && c.group !== group && new Set(changes.map(x => x.group)).size > 1) {
                group = c.group;
                put(el, h('div', { class: 'wb-chg-group', text: group }));
            }
            const [tag, cls] = TAG[c.kind];
            const isOpen = open.has(c.key);
            const box = h('button', {
                type: 'button', role: 'checkbox', class: 'wb-check wb-chg-box', disabled: !pending,
                'aria-checked': String(picked.has(c.key)), 'aria-label': `选择「${c.label}」`,
                onClick: () => { if (picked.has(c.key)) picked.delete(c.key); else picked.add(c.key); paint(); },
            }, h('span', { class: 'wb-check-box', 'aria-hidden': 'true' }, icon('check', { size: 11 })));
            put(el, h('div', { class: 'wb-chg-line' },
                box,
                h('div', { class: 'wb-chg-text' },
                    h('button', { type: 'button', class: 'wb-chg-label', 'aria-expanded': String(isOpen), onClick: () => { if (isOpen) open.delete(c.key); else open.add(c.key); paint(); } },
                        h('span', { text: c.label }),
                        icon(isOpen ? 'chevronDown' : 'chevronRight', { size: 12 })),
                    isOpen ? diffView(c) : null),
                h('span', { class: `wb-chg-tag ${cls}`, text: tag })));
        }
        if (pending) {
            put(el, h('div', { class: 'wb-chg-foot' },
                h('span', { class: 'wb-note', text: note || '应用后写进 Luker，在「改动记录」里可以撤销' }),
                button('全部放弃', () => onDiscard(), { className: 'is-ghost' }),
                button(`应用所选（${picked.size}）`, () => onApply([...picked]), { className: 'is-primary', disabled: !picked.size })));
        } else if (onUndo && (state === 'applied' || state === 'partial')) {
            put(el, h('div', { class: 'wb-chg-foot' }, h('span', { class: 'wb-spacer' }), button('撤销', () => onUndo(), { iconName: 'undo', className: 'is-ghost is-sm' })));
        }
    }

    paint();
    return {
        el,
        setState(next) { state = next; paint(); },
    };
}
