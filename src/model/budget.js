// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns Luker's itemizedParams() (chat-completion mode) into the overview's
// 「提示词占用」 bar. In that mode Luker reports:
//   oaiPromptTokens   preset prompts + character description / personality /
//                     scenario + examples (anchors already subtracted)
//   oaiSystemTokens   main / jailbreak / nudge / start / NSFW / impersonate
//   worldInfoStringTokens  world info — memory-graph injects through a managed
//                     lorebook entry, so its share is inside this number
//   before/afterScenarioAnchorTokens  extension prompts around the scenario
//   ActualChatHistoryTokens  chat history (in-chat injections included)
//   finalPromptTokens  sum of the above; thisPrompt_max_context = context − reply
// Pure: no DOM.

const n = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * @param {object} p itemizedParams() result
 * @param {{ memory?: number }} extra memory-graph injection tokens (from its own projection)
 * @returns {{ total, max, parts: { key, label, tokens }[] } | null}
 */
export function buildBudget(p, { memory = 0 } = {}) {
    if (!p || typeof p !== 'object' || p.this_main_api !== 'openai') return null;
    const total = n(p.finalPromptTokens);
    if (!total) return null;
    const card = n(p.charDescriptionTokens) + n(p.charPersonalityTokens) + n(p.scenarioTextTokens) + n(p.examplesStringTokens);
    const presetText = Math.max(0, n(p.oaiPromptTokens) - card);
    const system = n(p.oaiSystemTokens) || (n(p.oaiMainTokens) + n(p.oaiJailbreakTokens) + n(p.oaiNudgeTokens) + n(p.oaiStartTokens) + n(p.oaiNsfwTokens) + n(p.oaiImpersonateTokens));
    const worldAll = n(p.worldInfoStringTokens);
    const mem = Math.min(n(memory), worldAll);
    const world = worldAll - mem;
    const anchors = n(p.beforeScenarioAnchorTokens) + n(p.afterScenarioAnchorTokens) + n(p.oaiBiasTokens);
    const chat = n(p.ActualChatHistoryTokens);
    const parts = [
        { key: 'preset', label: '预设', tokens: presetText + system },
        { key: 'card', label: '角色卡', tokens: Math.min(card, n(p.oaiPromptTokens)) },
        { key: 'world', label: '世界书', tokens: world },
        { key: 'memory', label: '记忆图', tokens: mem },
        { key: 'other', label: '其他注入', tokens: anchors },
        { key: 'chat', label: '聊天记录', tokens: chat },
    ].filter(part => part.tokens > 0);
    return { total, max: n(p.thisPrompt_max_context), parts };
}

/** How the biggest non-chat part compares to its own history. */
export function budgetNote(budget, memoryHistory = []) {
    if (!budget) return '';
    const mem = budget.parts.find(part => part.key === 'memory')?.tokens || 0;
    const past = memoryHistory.filter(v => v > 0).sort((a, b) => a - b);
    if (mem && past.length >= 5) {
        const typical = past[Math.floor(past.length / 2)];
        if (typical >= 200 && mem / typical >= 1.5) return `记忆图常驻注入比平时高 ${(mem / typical).toFixed(1)} 倍`;
    }
    if (budget.max && budget.total / budget.max >= 0.9) return `已用掉上下文的 ${Math.round((budget.total / budget.max) * 100)}%`;
    return '';
}
