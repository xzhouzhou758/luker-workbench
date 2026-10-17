// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench (工作台) — Luker entry point.
//   - wand-menu item and Alt+W → the floating window (loaded lazily)
//   - an orchestrator run recorder from load time, so 小建议 has history
//     even before the window is first opened (skipped if orchestra-lens is
//     installed: its own history is read instead)

const MENU_ID = 'luker_workbench_wand_item';
let handle = null;
let opening = null;

async function open() {
    if (handle) {
        handle.expand();
        return;
    }
    if (opening) return opening;
    opening = (async () => {
        const [{ mountWorkbench }, source] = await Promise.all([
            import('./src/app.js'),
            import('./src/source-luker.js'),
        ]);
        handle = mountWorkbench({ source, onClose: () => { handle = null; } });
    })();
    try {
        await opening;
    } catch (err) {
        console.error('[workbench] failed to open', err);
        globalThis.toastr?.error?.(String(err?.message || err), '工作台');
    } finally {
        opening = null;
    }
}

function toggle() {
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

globalThis.LukerWorkbench = Object.freeze({ open, close, toggle });
