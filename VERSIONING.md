# 版本管理

本项目使用本地 Git 保存源码与可直接运行的 `NERVA.html`。无需远端仓库即可比较、查看或恢复历史版本。

## 当前版本

- 发行版本：`0.6.0`，界面显示 `v0.6`，发布标签为 `v0.6`。
- 挑战规则版本：`package.json` 中的 `nerva.scoreSchema = 5`。
- 修改前基线：`baseline-pre-v0.3`。
- 前一发行版本：`v0.5.2`。v0.6 增加残气供液，改变挑战可用推进剂与末段推力，因此规则版本递增为 5；计分公式不变。
- `package.json` 是版本号唯一来源。`version.js` 由 `build-version.cjs` 生成，请勿手动修改。

## 后续发布

1. 修改源码，并在 `package.json` 更新语义版本。新增功能更新次版本（如 `0.7.0`）；兼容修复更新修订号（如 `0.6.1`）。改变计分含义或挑战物理条件时同时递增 `nerva.scoreSchema`。
2. 在 `CHANGELOG.md` 添加该版本变化与日期。
3. 执行 `npm run version:sync`、`npm test` 和 `npm run check`。
4. 执行 `npm run standalone`，生成与版本一致的 `version.js` 和 `NERVA.html`，再验证浏览器操作与水印。
5. 用 `git diff` 检查修改，提交源码、说明、测试及生成的 HTML。确认检查通过后，为提交创建对应版本标签，例如 `git tag -a v0.6 -m "NERVA v0.6"`。

排行榜存储键包含完整发行版本，记录本身同时检查发行版本与计分规则版本。新版本不会自动导入旧榜；如需迁移，应单独设计规则并在更新记录中注明。每个版本保留每种模式、每种推进剂各 50 条最好成绩。

## 比较与查看历史

- 查看发布标签：`git tag --list`。
- 查看版本变化：`git diff v0.5.2 v0.6 -- simulation.js audio.js app.js`。
- 查看历史文件：`git show v0.6:package.json`。
- 当前可玩 HTML 随发布提交一起保存，任何版本标签都能追溯对应代码和计分规则。

截图和临时验证产物由 `.gitignore` 排除。当前仅进行本地版本管理；未来配置远端后可另行推送提交与标签。
