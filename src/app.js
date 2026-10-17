// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench shell: the floating window, the left rail and page switching,
// shared state (snapshot, settings), toasts and live refresh.
//
// `source` is the Luker source (source-luker.js) or the preview mock with the
// same shape: { loadSnapshot, readSettings, writeSettings, subscribe,
// setMemoryHorizon, openLens, ask?, ai?, history? }.

import { h, put, clear, debounce } from './util.js';
import { icon } from './icons.js';
import { createWindow } from './ui/window.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { runRules } from './model/suggest.js';
import { createHomePage } from './pages/home.js';
import { createSettingsPage } from './pages/settings.js';
import { createAskPage } from './pages/ask.js';
import { createIteratePage } from './pages/iterate.js';
import { createHistoryPage } from './pages/history.js';
import { formatTokens } from './util.js';
import { createHistory } from './model/history.js';

const PAGES = [
    { id: 'home', label: '总览', iconName: 'home' },
    { id: 'ask', label: '问问', iconName: 'ask' },
    { id: 'ai', label: 'AI 迭代', iconName: 'spark' },
    { id: 'hist', label: '改动记录', iconName: 'history' },
];

function detectTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * @param {{ source: object, container?: HTMLElement, onClose?: () => void }} options
 */
export function mountWorkbench({ source, container = document.body, onClose = null }) {
    const prefs = loadPrefs();
    let theme = prefs.theme === 'light' || prefs.theme === 'dark' ? prefs.theme : detectTheme();
    let page = PAGES.some(p => p.id === prefs.page) || prefs.page === 'settings' ? prefs.page : 'home';
    let snapshot = null;
    let settings = source.readSettings();
    let suggestions = [];
    let loadError = '';
    let destroyed = false;
    let toastTimer = 0;

    const win = createWindow({
        title: '工作台',
        theme: () => theme,
        onThemeToggle: () => { theme = theme === 'dark' ? 'light' : 'dark'; savePrefs({ theme }); },
        onClose: () => close(),
    });
    const rail = h('nav', { class: 'wb-rail', role: 'tablist', 'aria-label': '工作台' });
    const main = h('main', { class: 'wb-main' });
    put(win.body, rail, main);
    const toast = h('div', { class: 'wb-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    put(win.layer, toast);

    const history = createHistory();
    const app = {
        source,
        history,
        refreshBadges() { computeSuggestions(); paintRail(); pages.home?.onSnapshot?.(); },
        layer: win.layer,
        snapshot: () => snapshot,
        settings: () => settings,
        suggestions: () => suggestions,
        loadError: () => loadError,
        isCompact: () => win.isCompact(),
        go(id, opts = {}) {
            page = id;
            savePrefs({ page });
            paintRail();
            showPage(opts);
        },
        saveSettings(next) {
            settings = next;
            source.writeSettings(next);
            computeSuggestions();
            paintRail();
        },
        toast: showToast,
        reload: () => load(),
        collapse: () => win.collapse(),
    };

    const pages = {
        home: createHomePage(app),
        ask: createAskPage(app),
        ai: createIteratePage(app),
        hist: createHistoryPage(app),
        settings: createSettingsPage(app),
    };

    function pendingCount() {
        return pages.ai.pendingCount?.() || 0;
    }

    function computeSuggestions() {
        const snap = snapshot ? { ...snapshot, card: { ...snapshot.card, ...(pages.ai.pendingInfo?.() || {}) } } : {};
        suggestions = runRules(snap, { enabled: settings.rules, dismissed: settings.dismissed });
    }

    function paintRail() {
        clear(rail);
        const tab = (p) => h('button', {
            type: 'button', role: 'tab', class: 'wb-tab', 'aria-selected': String(page === p.id),
            onClick: () => app.go(p.id),
        }, icon(p.iconName), h('span', { class: 'wb-tab-label', text: p.label }),
        p.id === 'ai' && pendingCount() ? h('span', { class: 'wb-tab-count', text: String(pendingCount()) }) : null);
        put(rail, PAGES.map(tab), h('div', { class: 'wb-rail-foot' }, tab({ id: 'settings', label: '设置', iconName: 'gear' })));
        paintPill();
    }

    function paintPill() {
        const todo = suggestions.length;
        win.setPill(
            h('span', null, '提示词 ', h('b', { text: snapshot?.budget ? formatTokens(snapshot.budget.total) : '—' })),
            todo ? h('span', { class: 'wb-pill-todo' }, '· ', h('b', { text: String(todo) }), ' 件待处理') : null);
    }

    let current = null;
    function showPage(opts = {}) {
        const next = pages[page] || pages.home;
        if (current && current !== next) current.hide?.();
        current = next;
        main.classList.toggle('is-flush', Boolean(next.flush));
        clear(main);
        put(main, next.el);
        next.show?.(opts);
    }

    function showToast(text, { action = '', onAction = null, error = false, duration = 3500 } = {}) {
        clearTimeout(toastTimer);
        clear(toast);
        toast.classList.toggle('is-error', error);
        put(toast,
            icon(error ? 'alert' : 'check', { size: 15 }),
            h('span', { text }),
            action ? h('button', { type: 'button', class: 'wb-toast-btn', onClick: () => { toast.hidden = true; onAction?.(); } }, icon('undo', { size: 13 }), h('span', { text: action })) : null);
        toast.hidden = false;
        toastTimer = setTimeout(() => { toast.hidden = true; }, action ? Math.max(duration, 10000) : duration);
    }

    async function load() {
        try {
            snapshot = await source.loadSnapshot();
            loadError = '';
        } catch (err) {
            loadError = String(err?.message || err);
        }
        if (destroyed) return;
        win.setContext(snapshot?.chat?.label ? `${snapshot.chat.label}` : snapshot ? '未选择角色卡' : '');
        computeSuggestions();
        paintRail();
        for (const p of Object.values(pages)) p.onSnapshot?.();
    }
    const scheduleLoad = debounce(() => load(), 400);
    const unsubscribe = source.subscribe?.(() => scheduleLoad()) || (() => {});

    function onKeydown(event) {
        if (event.key === 'Escape' && !win.isCollapsed() && win.layer.contains(document.activeElement)) {
            if (current?.onEscape?.()) { event.preventDefault(); return; }
        }
    }
    win.layer.addEventListener('keydown', onKeydown);

    function close() {
        if (destroyed) return;
        destroyed = true;
        unsubscribe();
        scheduleLoad.cancel?.();
        for (const p of Object.values(pages)) p.destroy?.();
        win.destroy();
        onClose?.();
    }

    container.appendChild(win.layer);
    paintRail();
    showPage();
    load();
    win.focus();

    return {
        close,
        toggle: () => win.toggle(),
        expand: () => win.expand(),
        isCollapsed: () => win.isCollapsed(),
        reload: () => load(),
    };
}
