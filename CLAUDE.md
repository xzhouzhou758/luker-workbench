# CLAUDE.md — 工作台（luker-workbench）

Luker 第三方扩展：一个可拖动的浮动窗口，汇总四个 AI 工作台（记忆图、编排、预设、角色卡）。姊妹项目 memory-lens、orchestra-lens（`../`），风格和约定沿用它们。当前版本 0.1.0（开发中）。

## 用户的硬性要求

1. 全中文界面（快捷键名除外），简单友好，不暴露技术参数。
2. 风格：石墨灰、青绿 `#3fd0b4`、琥珀 = 需要注意；四个工作台色：记忆图琥珀、编排紫、预设蓝、角色卡珊瑚。手写 SVG 图标，不用 emoji、不照搬第三方。
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

- [x] 0.1 窗口、总览（占用条 / 待处理 / 四张卡片）、设置、小建议
- [ ] 问问
- [ ] AI 迭代：记忆图、编排
- [ ] AI 迭代：预设、角色卡
- [ ] 改动记录 + 撤销
