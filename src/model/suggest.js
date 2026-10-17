// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 小建议: fixed local rules over a snapshot of the four workbenches. No AI,
// no network. Each rule returns at most one suggestion with the numbers it
// was based on (shown under 「为什么这么说」) and the actions it offers.
//
// Snapshot shape (every part optional; a missing part skips its rules):
//   memory: { core, coreHistory: number[], events, unmerged, compression: bool,
//             threshold, maxSeqDistance, floors }
//   budget: { total, max }
//   orch:   { runs: [{ at, durationMs, agents: [{ id, label, durationMs, error }] }] }
//   preset: { name, prompts: [{ id, name, text, enabled }] }
//   card:   { name, pending: number, sessionTitle }

import { formatTokens } from '../util.js';

export const RULES = [
    { id: 'memory.coreHigh', tone: 'memory', name: '常驻注入偏高', when: '常驻注入比这个聊天平时高 1.5 倍以上，或超过上下文的 20%', defaultOn: true },
    { id: 'memory.unmerged', tone: 'memory', name: '事件堆着没合并', when: '没合并的事件超过 50 条', defaultOn: true },
    { id: 'memory.horizon', tone: 'memory', name: '常驻回溯不限', when: '「常驻注入最大回溯楼层」是 0，且聊天超过 200 楼', defaultOn: true },
    { id: 'orch.errors', tone: 'orch', name: '助手经常出错', when: '最近 5 次运行里同一个助手出错 2 次以上', defaultOn: true },
    { id: 'orch.slow', tone: 'orch', name: '助手很慢', when: '某个助手平均用时占整次运行的一半以上（至少 3 次运行）', defaultOn: true },
    { id: 'preset.dup', tone: 'preset', name: '预设条目重复', when: '两条启用的条目内容有八成以上相同', defaultOn: false },
    { id: 'card.pending', tone: 'card', name: '角色卡有改动没确认', when: 'AI 对话里有没应用也没放弃的改动', defaultOn: true },
];

export const HORIZON_SUGGESTED = 100;

function median(list) {
    const v = list.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!v.length) return 0;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const CHECKS = {
    'memory.coreHigh'(snap) {
        const m = snap.memory;
        if (!m || !(m.core > 0)) return null;
        const typical = median(m.coreHistory || []);
        const max = snap.budget?.max || 0;
        const ratio = typical >= 200 && (m.coreHistory || []).length >= 5 ? m.core / typical : 0;
        const share = max ? m.core / max : 0;
        if (ratio < 1.5 && share < 0.2) return null;
        const reasons = [];
        if (ratio >= 1.5) reasons.push(`这次常驻注入 ${formatTokens(m.core)}，这个聊天平时大约 ${formatTokens(typical)}，高了 ${ratio.toFixed(1)} 倍。`);
        if (share >= 0.2) reasons.push(`占了上下文上限 ${formatTokens(max)} 的 ${Math.round(share * 100)}%。`);
        return {
            text: `记忆图常驻注入 ${formatTokens(m.core)}，${ratio >= 1.5 ? `比平时高 ${ratio.toFixed(1)} 倍` : `占上下文的 ${Math.round(share * 100)}%`}`,
            why: reasons.join(''),
            source: '读的是记忆图这次的注入和 token 记录',
            sig: `${Math.round(m.core / 500)}`,
            actions: [{ kind: 'ask', label: '看看是哪些', question: '记忆图常驻注入为什么这么高？是哪些类型、哪些条目占的？' }],
        };
    },
    'memory.unmerged'(snap) {
        const m = snap.memory;
        if (!m || !(m.unmerged > 50)) return null;
        const why = `事件一共 ${m.events} 条，其中 ${m.unmerged} 条还没合并成摘要，它们都会常驻注入。`
            + (m.compression
                ? (m.threshold ? `「自动合并成摘要」开着，门槛是满 ${m.threshold} 条才合并。` : '「自动合并成摘要」开着。')
                : '「自动合并成摘要」没有开。');
        return {
            text: `有 ${m.unmerged} 条事件还没合并成摘要`,
            why,
            source: '读的是记忆图的数据和记忆结构',
            sig: `${Math.round(m.unmerged / 20)}`,
            actions: [{ kind: 'ai', ws: 'memory', label: '让 AI 看看', prompt: `有 ${m.unmerged} 条事件没合并成摘要，常驻注入偏高。帮我看看「事件」的合并设置和说明该怎么调。` }],
        };
    },
    'memory.horizon'(snap) {
        const m = snap.memory;
        if (!m || m.maxSeqDistance !== 0 || !(m.floors > 200)) return null;
        return {
            text: '「常驻注入最大回溯楼层」是不限',
            why: `聊天已经 ${m.floors} 楼，这个设置是 0（不限），很早以前的内容也一直常驻。设成 ${HORIZON_SUGGESTED}，更早的内容改为需要时再召回。`,
            source: '读的是记忆图的设置',
            sig: 'on',
            actions: [{ kind: 'setHorizon', value: HORIZON_SUGGESTED, label: `设成 ${HORIZON_SUGGESTED}` }],
        };
    },
    'orch.errors'(snap) {
        const runs = (snap.orch?.runs || []).slice(-5);
        if (runs.length < 2) return null;
        const counts = new Map();
        for (const run of runs) {
            for (const a of run.agents || []) {
                if (!a.error) continue;
                const c = counts.get(a.id) || { label: a.label || a.id, n: 0, last: '' };
                c.n++;
                c.last = String(a.error);
                counts.set(a.id, c);
            }
        }
        const worst = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
        if (!worst || worst[1].n < 2) return null;
        const [id, c] = worst;
        return {
            text: `「${c.label}」最近 ${runs.length} 次有 ${c.n} 次出错`,
            why: `最近 ${runs.length} 次运行里，「${c.label}」出错 ${c.n} 次。最近一次的错误：${c.last.slice(0, 120)}`,
            source: '读的是编排的运行记录',
            sig: `${id}:${c.n}`,
            actions: [{ kind: 'ai', ws: 'orch', label: '让 AI 看看', prompt: `编排里的「${c.label}」最近 ${runs.length} 次运行有 ${c.n} 次出错，最近一次的错误是：${c.last.slice(0, 300)}。帮我看看原因。` }],
        };
    },
    'orch.slow'(snap) {
        const runs = (snap.orch?.runs || []).filter(r => r.durationMs > 0).slice(-10);
        if (runs.length < 3) return null;
        const share = new Map();
        for (const run of runs) {
            for (const a of run.agents || []) {
                if (!(a.durationMs > 0)) continue;
                const s = share.get(a.id) || { label: a.label || a.id, sum: 0, n: 0, ms: 0 };
                s.sum += a.durationMs / run.durationMs;
                s.ms += a.durationMs;
                s.n++;
                share.set(a.id, s);
            }
        }
        const top = [...share.entries()].map(([id, s]) => ({ id, ...s, avg: s.sum / s.n })).sort((a, b) => b.avg - a.avg)[0];
        if (!top || top.n < 3 || top.avg <= 0.5) return null;
        const sec = (top.ms / top.n / 1000).toFixed(1);
        return {
            text: `「${top.label}」占了编排一半以上的用时`,
            why: `最近 ${runs.length} 次运行里，「${top.label}」平均 ${sec} 秒，占整次运行的 ${Math.round(top.avg * 100)}%。`,
            source: '读的是编排的运行记录',
            sig: `${top.id}:${Math.round(top.avg * 10)}`,
            actions: [{ kind: 'ai', ws: 'orch', label: '让 AI 看看', prompt: `编排里的「${top.label}」平均要 ${sec} 秒，占整次运行的 ${Math.round(top.avg * 100)}%。帮我看看能不能让它快一点。` }],
        };
    },
    'preset.dup'(snap) {
        const prompts = (snap.preset?.prompts || []).filter(p => p.enabled && String(p.text || '').trim().length >= 20);
        for (let i = 0; i < prompts.length; i++) {
            for (let j = i + 1; j < prompts.length; j++) {
                const sim = similarity(prompts[i].text, prompts[j].text);
                if (sim >= 0.8) {
                    return {
                        text: `预设里「${prompts[i].name}」和「${prompts[j].name}」内容差不多`,
                        why: `两条都开着，内容有 ${Math.round(sim * 100)}% 相同，模型会读到两遍。`,
                        source: `读的是预设「${snap.preset.name}」`,
                        sig: `${prompts[i].id}|${prompts[j].id}`,
                        actions: [{ kind: 'ai', ws: 'preset', label: '让 AI 看看', prompt: `预设里「${prompts[i].name}」和「${prompts[j].name}」内容差不多，帮我合并或去掉重复的部分。` }],
                    };
                }
            }
        }
        return null;
    },
    'card.pending'(snap) {
        const c = snap.card;
        if (!c || !(c.pending > 0)) return null;
        return {
            text: `角色卡有 ${c.pending} 处改动等你确认`,
            why: `「${c.sessionTitle || 'AI 对话'}」里有 ${c.pending} 处改动还没应用，也没放弃。`,
            source: '读的是工作台的 AI 对话',
            sig: `${c.pending}`,
            actions: [{ kind: 'session', sessionId: c.sessionId, label: '去确认', primary: true }],
        };
    },
};

/** Character-bigram Dice similarity (0..1); good enough for CJK and Latin. */
export function similarity(a, b) {
    const grams = (text) => {
        const s = String(text || '').replace(/\s+/g, '');
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) || 0) + 1);
        }
        return m;
    };
    const ga = grams(a);
    const gb = grams(b);
    let total = 0;
    let shared = 0;
    for (const n of ga.values()) total += n;
    for (const n of gb.values()) total += n;
    for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
    return total ? (2 * shared) / total : 0;
}

/**
 * @param {object} snap
 * @param {{ enabled?: Record<string, boolean>, dismissed?: Record<string, string> }} prefs
 *   dismissed: ruleId → sig at the time it was ignored; it comes back when the numbers change.
 * @returns {{ id, tone, name, text, why, source, actions }[]}
 */
export function runRules(snap, { enabled = {}, dismissed = {} } = {}) {
    const out = [];
    for (const rule of RULES) {
        const on = enabled[rule.id] ?? rule.defaultOn;
        if (!on) continue;
        let found = null;
        try { found = CHECKS[rule.id](snap || {}); } catch { found = null; }
        if (!found) continue;
        if (dismissed[rule.id] && dismissed[rule.id] === found.sig) continue;
        out.push({ id: rule.id, tone: rule.tone, name: rule.name, ...found });
    }
    // Things waiting on the user first.
    return out.sort((a, b) => (b.id === 'card.pending') - (a.id === 'card.pending'));
}
