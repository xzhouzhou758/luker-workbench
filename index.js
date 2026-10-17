// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench (工作台) — Luker entry point.
//   - a resident pill in the bottom-right corner (mounted once Luker is ready),
//     wand-menu item and Alt+W → the floating window
//   - an orchestrator run recorder from load time, so 小建议 has history
//     even before the window is first opened (skipped if orchestra-lens is
//     installed: its own history is read instead)

const MENU_ID = 'luker_workbench_wand_item';
let handle = null;
let opening = null;

async function mount({ collapsed }) {
    if (handle) return handle;
    if (opening) return opening;
    opening = (async () => {
        const [{ mountWorkbench }, source] = await Promise.all([
            import('./src/app.js'),
            import('./src/source-luker.js'),
        ]);
        handle = mountWorkbench({ source, startCollapsed: collapsed, onClose: () => { handle = null; } });
        return handle;
    })();
    try {
        return await opening;
    } catch (err) {
        console.error('[workbench] failed to open', err);
        globalThis.toastr?.error?.(String(err?.message || err), '工作台');
        return null;
    } finally {
        opening = null;
    }
}

async function open() {
    const h = handle || await mount({ collapsed: false });
    h?.expand();
}

async function toggle() {
    if (!handle) return open();
    handle.toggle();
    return null;
}

function close() {
    handle?.close();
}

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(MENU_ID)) return true;
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-table-columns extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = '工作台';
    item.append(icon, label);
    item.addEventListener('click', () => open());
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    menu.appendChild(item);
    return true;
}

function hotkeyOn() {
    try {
        const s = globalThis.Luker?.getContext?.()?.extensionSettings?.luker_workbench;
        return (s?.hotkey ?? 'alt+w') === 'alt+w';
    } catch {
        return true;
    }
}

document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyW') return;
    if (!hotkeyOn()) return;
    event.preventDefault();
    toggle();
});

if (!addMenuItem()) {
    const observer = new MutationObserver(() => {
        if (addMenuItem()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 120000);
}

import('./src/source-luker.js')
    .then(({ startOrchRecorder }) => startOrchRecorder())
    .catch(err => console.info('[workbench] orchestrator recorder not started:', err?.message || err));

// Resident pill: mount folded once Luker's UI is up.
function mountPill() {
    if (!handle && !opening) mount({ collapsed: true });
}
try {
    // APP_READY is an auto-fire event: late listeners are called right away.
    const ctx = globalThis.Luker?.getContext?.() || globalThis.SillyTavern?.getContext?.();
    const ready = ctx?.eventTypes?.APP_READY;
    if (ready && ctx.eventSource?.on) ctx.eventSource.on(ready, mountPill);
    else setTimeout(mountPill, 3000);
} catch {
    setTimeout(mountPill, 3000);
}

globalThis.LukerWorkbench = Object.freeze({ open, close, toggle });
