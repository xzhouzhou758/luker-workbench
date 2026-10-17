// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The floating window: title bar (drag, double-click to maximise), resize
// grip, maximise / collapse / close, and the collapsed pill. On narrow
// screens it becomes a bottom sheet over a scrim. The box is remembered.

import { h, put, clear } from '../util.js';
import { icon } from '../icons.js';
import { iconButton } from './components.js';
import { fitToViewport } from '../viewport.js';
import { defaultBox, clampBox, maxBox, sheetBox, pillPos, isCompactWidth, parseSavedBox } from '../model/geometry.js';
import { loadPrefs, savePrefs } from '../prefs.js';

/**
 * @param {{ title: string, onClose(): void, onThemeToggle(): void, theme: () => string }} options
 * @returns {{ layer, body, setContext(text), setPill(nodes), collapse(), expand(), isCollapsed(), focus(), destroy() }}
 */
export function createWindow({ title, onClose, onThemeToggle, theme }) {
    const prefs = loadPrefs();
    let box = parseSavedBox(prefs.box);
    let maximised = Boolean(prefs.maximised);
    let collapsed = false;
    let compact = false;
    let vw = globalThis.innerWidth || 1280;
    let vh = globalThis.innerHeight || 800;

    const ctx = h('span', { class: 'wb-title-ctx' });
    const themeBtn = iconButton('sun', '切换深浅色', () => { onThemeToggle(); paintTheme(); });
    const maxBtn = iconButton('max', '放大', () => toggleMax(), { className: 'wb-ctl-max' });
    const bar = h('header', { class: 'wb-titlebar' },
        h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 16 })),
        h('span', { class: 'wb-title', text: title }),
        ctx,
        h('span', { class: 'wb-spacer' }),
        themeBtn,
        maxBtn,
        iconButton('min', '收起', () => collapse()),
        iconButton('x', '关闭', () => onClose(), { className: 'is-close' }));
    const body = h('div', { class: 'wb-body' });
    const grip = h('div', { class: 'wb-resize', 'aria-hidden': 'true' });
    const win = h('section', { class: 'wb-win', role: 'dialog', 'aria-label': title, tabIndex: -1 }, bar, body, grip);
    const scrim = h('div', { class: 'wb-scrim', hidden: true, onClick: () => collapse() });
    const pill = h('button', { type: 'button', class: 'wb-pill', hidden: true, 'aria-label': `打开${title}`, onClick: () => expand() });
    const layer = h('div', { class: 'wbench', dataset: { theme: theme() } }, scrim, win, pill);

    function paintTheme() {
        layer.dataset.theme = theme();
        clear(themeBtn);
        put(themeBtn, icon(theme() === 'dark' ? 'sun' : 'moon'));
    }

    function apply() {
        compact = isCompactWidth(vw);
        layer.classList.toggle('is-compact', compact);
        win.classList.toggle('is-max', maximised && !compact);
        clear(maxBtn);
        put(maxBtn, icon(maximised ? 'restore' : 'max'));
        maxBtn.title = maxBtn.ariaLabel = maximised ? '还原' : '放大';
        win.hidden = collapsed;
        pill.hidden = !collapsed;
        scrim.hidden = !compact || collapsed;
        const b = compact ? sheetBox(vw, vh) : maximised ? maxBox(vw, vh) : (box = clampBox(box || defaultBox(vw, vh), vw, vh));
        Object.assign(win.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
        const p = pillPos(vw, vh, compact);
        Object.assign(pill.style, { right: `${p.right}px`, bottom: `${p.bottom}px` });
    }

    const persist = () => savePrefs({ box, maximised });

    function toggleMax() {
        if (compact) return;
        maximised = !maximised;
        apply();
        persist();
    }

    // ----- Drag (title bar) -----
    bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button') || compact || maximised) return;
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
        bar.setPointerCapture?.(event.pointerId);
        bar.classList.add('is-dragging');
        const move = (e) => {
            box = clampBox({ ...box, left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y }, vw, vh);
            win.style.left = `${box.left}px`;
            win.style.top = `${box.top}px`;
        };
        const end = () => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', end);
            persist();
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', end);
    });
    bar.addEventListener('dblclick', (event) => { if (!event.target.closest('button')) toggleMax(); });

    // ----- Resize (bottom-right grip) -----
    grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || compact || maximised) return;
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY, width: box.width, height: box.height };
        grip.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            box = clampBox({ ...box, width: start.width + e.clientX - start.x, height: start.height + e.clientY - start.y }, vw, vh);
            win.style.width = `${box.width}px`;
            win.style.height = `${box.height}px`;
        };
        const end = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            persist();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    });

    // The layer covers the visible viewport (iOS-safe); the window is
    // positioned inside it in px.
    const fit = fitToViewport(layer, {
        layout: (w, hgt) => {
            vw = w;
            vh = hgt;
            queueMicrotask(apply);
            return null;
        },
    });

    function collapse() {
        collapsed = true;
        apply();
    }
    function expand() {
        collapsed = false;
        apply();
        win.focus();
    }

    paintTheme();
    apply();

    return {
        layer,
        body,
        win,
        setContext(text) {
            ctx.textContent = text || '';
            ctx.hidden = !text;
        },
        /** Pill content when collapsed (nodes). */
        setPill(...nodes) {
            clear(pill);
            put(pill, h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 15 })), ...nodes);
        },
        collapse,
        expand,
        toggle: () => (collapsed ? expand() : collapse()),
        isCollapsed: () => collapsed,
        isCompact: () => compact,
        paintTheme,
        focus: () => win.focus(),
        destroy() {
            fit.destroy();
            layer.remove();
        },
    };
}
