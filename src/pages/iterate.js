// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI 迭代（占位，下一步实现）。

import { h } from '../util.js';

export function createIteratePage(app) {
    const el = h('div', { class: 'wb-page' }, h('h2', { class: 'wb-h2', text: 'AI 迭代' }), h('p', { class: 'wb-sub', text: '这一页还在做。' }));
    return { el, show() {}, pendingCount: () => 0, pendingInfo: () => null };
}
