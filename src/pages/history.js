// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 改动记录（占位，下一步实现）。

import { h } from '../util.js';

export function createHistoryPage(app) {
    const el = h('div', { class: 'wb-page' }, h('h2', { class: 'wb-h2', text: '改动记录' }), h('p', { class: 'wb-sub', text: '这一页还在做。' }));
    return { el, show() {}, pendingCount: () => 0, pendingInfo: () => null };
}
