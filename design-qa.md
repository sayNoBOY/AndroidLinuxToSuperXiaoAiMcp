# Design QA — 首页任务中心（image-to-code）

## 对比对象

- **源视觉真相**: `/mnt/shared/Documents/随身互联开发文档/设计/随身互联App四Tab原型(6).html`（Tab1 `#tp0` 任务中心 + `#newOv` 新建任务弹层），经 `http://127.0.0.1:8630/` 宿主后由 Chromium 截取
- **实现**: `http://localhost:5173/`（`App/HtmlView/src/views/HomeView.vue`，登录 admin 后进入 `#/`）
- **视口**: 375 × 812（两端一致）
- **状态**: 首页默认态（1 执行中 / 1 排队中 / 6 已完成折叠 / 1 失败，与原型 mock 同分布）+ 新建任务弹层态
- **截图**（`output/playwright/`）:
  - 源首页: `qa-source-fresh.png` / `src-home-final.png`（含徽标+水印，像素探针确认 badge=true, mark=109）
  - 实现首页: `qa-impl-home.png` / `impl-home-final.png`（badge=false, mark=0 — 见开放问题①）
  - 源弹层: `qa-source-newtask.png` / `sheet-src-final.png`（mark=348 水印确认为源）
  - 实现弹层: `qa-impl-newtask.png` / `sheet-impl-final.png`
  - 实现详情弹层: `qa-impl-detail.png`

## 全图对比证据

源与实现同视口同状态并排比对（多图 Read 结果乱序，场景归属以文件内时钟 + 像素探针为准）：

- 构图与层级一致：状态栏 → 紫条「任务中心」→ 4 统计卡 → 任务卡列表 → 更多已完成折叠 → 清空/新建按钮 → 底部四 Tab。
- 关键区域量化测量（`getBoundingClientRect`，源 vs 实现）：

| 区域 | 源 y/h | 实现 y/h | Δ |
|------|--------|----------|---|
| sect-title | 58 / 24 | 58 / 24 | 0 / 0 |
| stats | 94 / 74 | 94 / 74 | 0 / 0 |
| card1（执行中） | 168 / 125 | 168 / 125 | 0 / 0 |
| card2（排队中） | 305 / 107 | 305 / 107 | 0 / 0 |
| card3（失败） | 424 / 107 | 424 / 107 | 0 / 0 |
| 更多已完成 | 549 / 33 | 549 / 33 | 0 / 0 |
| tabbar | 748 / 64 | 748 / 64 | 0 / 0 |

修复后**全部 delta = 0（像素级一致）**。

## 五项保真面检查

- **字体与排版**: 字体栈与源一致（-apple-system/PingFang SC 等）；字重/字号（16/700 标题、14/600 任务名、11px 副行、11/600 标签、12px 按钮）逐项一致；行高归为 `normal`（见 P1-2）。
- **间距与布局节奏**: 上表量化为证；卡片内边距 14px、间隙 12px、按钮行 margin-top 10px、统计卡 gap 10px 均与源相同。
- **颜色与 token**: `--bg:#0a0e1a --card:#111827 --blue:#3b82f6 --green:#22c55e --red:#ef4444` 等 16 个 token 逐值复刻；状态胶囊（st blue/gray/green/red）与进度条配色一致。
- **图像与资产**: 任务图标沿用源的 emoji 方式（📤🎬🧹…），Tab/状态栏图标为原型内联 SVG 原样复制，未引入替代图形。无头 Chromium 缺少彩色 emoji 字体，两端截图均呈 tofu 方框（环境限制，真机正常）——非实现差异。
- **文案**: 「任务中心 / 执行中 / 排队中 / 今日完成 / 失败 / 更多已完成 / 清空已完成 / ＋ 新建任务 / 暂停 / 取消 / 重试 / 删除 / 查看详情」与源逐字一致。

## Findings（按轮次记录）

- **[P1] 任务名/副行居中**（第 1 轮）
  - Evidence: 源左对齐（`text-align:start`），实现 `computed text-align=center`。
  - Fix: `.page { text-align: left }` 覆盖脚手架 `#app { text-align: center }` 全局继承（`HomeView.vue`）。复查截图已左对齐。
- **[P1] 卡片高度系统性 +8px**（第 2 轮，量化测量发现）
  - Evidence: card1/2/3 均 +8px；内层测量 `line-height: 23.2px`（脚手架 `font: …/145%`）vs 源 `normal`，name 20→23、sub 16→23。
  - Fix: `.page { line-height: normal }`。复测全部 delta=0。
- **[P2→数据] 运行中任务时间**: 实现 `02:01 · 耗时 12:31`（真实时钟与实时耗时）vs 源 `09:12 · 02:47`（静态 mock）。属活数据预期差异，不做修改。
- **[P2→数据] 排队序号**: 实现 `#1`（真实 FIFO）vs 源 `#2`（mock 自身不一致：仅 1 个排队却标 #2）。实现语义更正确，保留。
- **[P2→环境] emoji tofu**: 两端截图同样缺字形（无头环境无 emoji 字体），像素证据一致，非实现问题；真机验证待办。
- **[P2→已修复的测试数据] 时区**: 首轮截图 `17:12 · 耗时 00:00` 为测试种子按北京时间直存导致（fixture 问题，非代码），重播为 UTC-naive 后显示正确。

## Open Questions（已分类为可接受/有意为之）

1. **消息 Tab 红色徽标「6」未实现**（源有徽标，实现无）：消息模块后端尚不存在，显示静态假计数会传达虚假信息；消息/设备/我的三个 Tab 均为视觉占位（点击有 toast 提示）。若希望与原型像素完全一致，可加静态徽标——请拍板。
2. **新建任务弹层多一个「任务指令」输入**（源 170px 单输入，实现 265px 双输入）：TaskApi `POST /tasks` 必填 `message`，源 mock 仅有任务名。样式（sheet 圆角、h3、input、按钮）与源一致，仅多一个必填字段。有意扩展。
3. 源截图右下水印「本页面由超级小爱AI生成」为其生成工具注入，非设计元素，实现不含（正确）。

## 主交互实测（Chromium，全部 PASS，console 零报错）

1. 未登录访问 `#/` → 重定向 `#/login`
2. 登录成功 → 跳转 `#/` 任务中心（用户要求的「登录后跳转」）
3. 展开「更多已完成」→ 折叠列表显示
4. 「查看详情」→ 弹层显示详情 + 消息记录（2 条）+ session_id
5. 「＋ 新建任务」→ 弹层 → 真实 `POST /api/v1/tasks` → 列表出现新任务
6. 「取消」→ `PUT /cancel` → 状态变「已取消」（长任务实测）
7. 「删除」→ `DELETE` → 列表移除
8. 统计卡点击 → 滚动定位对应状态任务
9. 非首页 Tab → 占位 toast
10. WS 断线重连/事件刷新（API 层另有 13/13 WS 测试）

## Comparison History

| 轮次 | 发现 | 动作 | 复测证据 |
|------|------|------|----------|
| 1 | P1 文本居中；fixture 时间错误 | text-align 修复；重播种子数据 | 对齐 left（computed）；时间显示正确 |
| 2 | P1 卡片 +8px（行高）；量化全表 delta | line-height:normal | 全表 delta=0（见上表） |
| 3 | 弹层/交互/全图终检 | 无代码改动 | 弹层断言可见（源 h170/实现 h265）；交互 11/11；探针确认文件身份 |

## Implementation Checklist

- [x] 源/实现同视口截图与像素身份校验
- [x] text-align / line-height 全局样式覆盖
- [x] 布局量化 delta=0
- [x] 五保真面逐项过检
- [x] 主交互 11 项实测 + console 零错
- [ ] 消息徽标取舍（待产品决策，见开放问题①）
- [ ] 真机 emoji 渲染确认（无头环境无法验证）

**final result: passed**
