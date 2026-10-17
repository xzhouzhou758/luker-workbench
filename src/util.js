// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tiny DOM + misc helpers (same conventions as memory-lens). All text goes
// through textContent; nothing here ever assigns untrusted strings to innerHTML (node content is LLM output).

export function h(tag, props = null, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 'text') el.textContent = String(value);
            else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key === 'style' && typeof value === 'object') {
                for (const [prop, v] of Object.entries(value)) {
                    if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
                    else el.style[prop] = v;
                }
            }
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value === true) el.setAttribute(key, '');
            else el.setAttribute(key, String(value));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else if (child instanceof Node) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
    }
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

/**
 * Null-safe append. Native Element.append() stringifies null/undefined
 * into literal "null" text nodes; this skips them (and flattens arrays).
 */
export function put(el, ...children) {
    append(el, children);
    return el;
}

export function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

export function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

export function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "刚刚" / "12 分钟前" / "昨天 23:40" / "3 天前" */
export function relativeTime(at, now = Date.now()) {
    const t = Number(at) || 0;
    if (!t) return '';
    const diff = Math.max(0, now - t);
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    const d = new Date(t);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    if (t >= today.getTime()) return `${Math.floor(diff / 3600e3)} 小时前`;
    if (t >= today.getTime() - 86400e3) return `昨天 ${formatTime(d)}`;
    const days = Math.ceil((today.getTime() - t) / 86400e3);
    return days < 7 ? `${days} 天前` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 1234 → "1.2k", 15300 → "15k". */
export function formatTokens(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (v < 1000000) return `${Math.round(v / 1000)}k`;
    return `${(v / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatDuration(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1000) return `${Math.round(v)}ms`;
    return `${(v / 1000).toFixed(1)}s`;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(String(text));
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = String(text);
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        area.remove();
        return ok;
    }
}

export function prefersReducedMotion() {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
