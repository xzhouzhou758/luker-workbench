# CLAUDE.md — 工作台（luker-workbench）

Luker 第三方扩展：一个可拖动的浮动窗口，汇总五个 AI 工作台（记忆图、编排、预设、角色卡、世界书）。姊妹项目 memory-lens、orchestra-lens（`../`），风格和约定沿用它们。当前版本 0.2.1（待真机验收）。

## 用户的硬性要求

1. 全中文界面（快捷键名除外），简单友好，不暴露技术参数。
2. 风格：石墨灰、青绿 `#3fd0b4`、琥珀 = 需要注意；四个工作台色：记忆图琥珀、编排紫、预设蓝、角色卡珊瑚、世界书黄绿（--wb-t-world）。手写 SVG 图标，不用 emoji、不照搬第三方。
3. 窗口化（不满屏）；手机上是底部抽屉。**不打开原生工作台**。
4. 测试由用户在真机做；我只跑 `npm test` 和预览不报错，别反复截图。
5. 不改用户的生成预设（含破限），只选用。群聊当「未选择角色卡」。
6. 回复用中文。

## 命令

```bash
npm test          # node:test
npm run preview   # http://127.0.0.1:4177/preview/index.html
# 参数：theme=dark|light  page=home|ask|ai|hist|settings  chat=none（未选角色卡） empty=1  fresh=1（重置窗口位置）
```

## 结构

```
index.js               魔杖菜单「工作台」、Alt+W、加载即启动编排运行记录器
src/app.js             外壳：窗口、左栏、页面切换、快照、设置、toast、实时刷新
src/ui/window.js       浮动窗口（拖动/缩放/放大/收起成胶囊/手机底部抽屉），位置存 localStorage workbench.prefs.v1
src/model/geometry.js  纯函数：窗口尺寸、夹紧、默认位置
src/model/suggest.js   小建议规则（纯函数，7 条，每条带 why/source/actions；忽略按 sig 记，数字变了再提醒）
src/model/budget.js    itemizedParams → 提示词占用条
src/source-luker.js    读 Luker：loadSnapshot、设置（extensionSettings.luker_workbench）、AI 调用 aiRequest、编排运行记录
src/pages/             home（总览）、settings、ask、iterate、history
preview/mock-source.js 预览用假数据（同名函数）
docs/                  接口调查与取舍.md、给原作者的接口问题.md、mockup/（定稿样稿）
```

## 接口要点（详见 docs/接口调查与取舍.md、docs/接口笔记.md）

- 提示词占用：`/scripts/itemized-prompts.js` 的 `itemizedPrompts` + `itemizedParams()`，只支持对话补全。记忆图注入走托管世界书条目，所以它的 token 从「世界书」里扣出来。
- 编排没有运行历史：装了 orchestra-lens 就读它的 `orchestraLens.history.v1`，否则自己订阅 `run-state/store.js` 存 `workbench.orchRuns.v1`（20 条）。
- 记忆图「常驻回溯楼层」：有角色覆盖时 `persistCharacterAdvancedOverride`，否则改 `getSettings()` 再保存。
- 手动压缩没有接口 → 不做「立刻合并」。请求检查器不分来源 → 问问里按内容推测并注明。
- AI 调用：`iteration-library/runner.js` `requestToolCallsWithRetry`，tools 不能为空；连接配置和生成预设分开选（apiPresetName / llmPresetName）。

## 进度

- [x] 右下角常驻胶囊（加载即挂载、折叠；点开窗口，× 收回胶囊；可拖动，位置存 prefs.pill；设置里可关）
- [x] 窗口、总览（占用条 / 待处理 / 四张卡片）、设置、小建议
- [x] 问问（src/model/ask.js 工具 + 循环；读取器 source-luker.js askReaders；请求来源推测 model/requests.js）
- [x] AI 迭代：四个适配器（source-iterate.js），改动清单按「单元」比较（model/units.js、model/adapters.js）
- [x] 改动记录 + 撤销（model/history.js；撤销函数只在本次页面加载内有效）
- [ ] 真机验收（用户）

## 提示词与生成预设

- 问问：工作台内置提示词（model/ask.js SYSTEM），固定使用。
- 四个工作台：用 Luker 各自内置的迭代提示词（用户改过就用改过的）——记忆图 schemaIterSystemPrompt / DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT；编排 requestSystemPrompt / defaults.js getDefaultRequestSystemPrompt（只取通用部分，mode block 引用 luker_orch_* 工具，不用）+ 工作台的工具说明；预设 iterBaseSystemPrompt / buildModelSystemPrompt；角色卡 editorIterationSystemPrompt / studio.js DEFAULT_SYSTEM_PROMPT。设置页「提示词」可看全文。「在前面加一段工作台说明」= settings.builtinPrompt。
- 生成预设优先级：工作台里单独选的 > 原插件的 requestLlmPresetName（「跟随插件」）> 工作台默认 > Luker 自带 plugin-only（存在时）。没有 plugin-only 时设置页提示导入（同 preset-help.js：fetch /presets/plugin-only.json → savePreset）。agent-director / agent-non-director 是给编排运行时助手用的，迭代不用。

## AI 迭代要点

- 每个适配器：load(scope) → live；tools/isRead/runRead/runEdit；units(live) 切成单元；rebuild(base, ai, keys)；commit(target, base, next, keys) → { undo }。
- 记忆图：工具和提示词全用 memory-graph schema-iteration 的（去掉控制工具，加 mg_schema_read_fields）；保存同原生（角色 = persistCharacterSchemaOverride）。
- 世界书：Luker 没有独立的世界书迭代工作台 → 复用角色卡助手的提示词和 lorebook_* / cea_*_lorebook_* 工具（过滤掉卡片字段工具），保存走 commitLorebookOperations。全局 = chatWorldInfo.globalSelection；当前角色卡 = 主书 + getCharaAuxWorlds + 聊天绑定。只允许改已载入的书。
- 纯文本工具协议兜底：模型输出 <function_calls> XML 但 args_json 里有裸换行导致 Luker 解析失败时，model/textcalls.js 自己解析，不把 XML 显示给用户。
- 主题样式泄漏：Luker 给裸 code/small/select option 等加了颜色和 text-shadow，shell.css 开头统一重置。
- 编排：原生迭代工具没导出 → 自己的 wb_orch_* 四个工具（逻辑来自 orchestra-lens edit.js），保存时只把改了的字段叠到最新存档上。
- 预设：CPA 的工具 / 提示词 / normalizeToolCallToEdit + iterationLibrary.applyEdits；去掉 skill 工具和 preset_clone_to_new；保存 ctx.presets.save(ref, body, {select:true})。
- 角色卡：CEA 的工具 / 提示词 / normalize；live = { character, lorebooks }（主世界书 + 绑定的书）；保存 commitCharacterEditorOperations + commitLorebookOperations。
- 一轮结束后 AI 副本和存档比较 → 改动清单；没勾的会从草稿撤回，并在下一轮开头告诉 AI（decisionNote）。
- 「自动应用」= settings.reviewChanges 取反。
