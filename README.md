# XCPC 报销材料整理工具

依据《2026 年 CPC 参赛注意事项》（东南大学 · CPC 队员会议材料）开发的参赛报销材料整理工具。
技术栈 **Vue 3 + Vite**；支持纯本地使用，也支持局域网部署后由 AI 全程代操作。

> 默认进入**分步向导模式**：按「队员 / 队长 / 报销负责人」三种角色分步引导，照着走就能完成；
> 熟悉工具的同学可随时切换到自由模式。

## 快速开始

```bash
npm install     # 安装依赖
npm run dev     # 本地开发 http://localhost:5173
npm run build   # 打包到 dist/（纯静态）
npm start       # 部署模式运行 server.js（静态托管 dist + 识别代理 + AI Agent API）
```

纯本地使用：打开网页 → 选角色 → 跟着向导走。所有数据仅保存在本机浏览器（localStorage），不会上传。

## 功能

- **分步向导（默认）**：按角色编排步骤，每步带完成判定与下一步指引；可随时切换角色或退出到自由模式
- **批量导入自动分类**：一次选入整套材料或整个文件夹，按文件名与文件夹自动分类到行程段 / 槽位；文件名含「去程 / 返程」自动勾选
- **识别**：文本型 PDF 提取文字；图片 / 扫描件走浏览器内置中文 OCR 或服务器视觉模型（OpenAI 兼容接口 / Ollama，失败自动回退本地）；OFD 发票按坐标原样渲染解析；金额、归属队员、开票方 / 收款方、起讫地去返程自动识别预填
- **核对链**：缺必附材料 → 归属完整性 → 发票抬头（东南大学 + 税号）→ 经济舱 / 二等座 → 发票与支付金额一致 → 开票单位与支付对象一致（收付款核对），问题项进入进度提醒、打包确认与核对报告待办
- **合并与打包**：全部材料合并为一个 PDF（图片排 A4、PDF / OFD 无损或高保真合成）；仅含发票的汇总文档（便捷扫描打印）；队伍 ZIP 规范命名（含队伍信息、同学清单 CSV、核对报告、金额 / 收付款不一致说明）
- **差旅审批单**：按学校模板自动生成标准 .docx（仿宋排版对齐原模板），页内预览 / 打印 / 下载
- **赛站汇总**（负责人）：各队 ZIP 自动解包合并 + 参赛费材料 + 每队待办清单
- **核对报告**：基本信息、打包明细、流程状态、待办事项、群内消息模板；可打印 / 复制 Markdown / 下载 TXT

数据可通过顶栏「导出数据 / 导入数据」在同学之间传递接力填写。

## AI Agent 接入

让同学的 AI（ZCode / Claude / Cursor 等能执行 HTTP 的助手）代替手动操作，全程无需打开网页：

1. **HTTP API**（通用）：`GET /api/agent` 是自描述指南——AI 读完即可按流程
   建会话 → 上传材料（自动分类，图片自动 OCR）→ 按 status 的 next 建议补全 → 打包下载 ZIP。

   ```bash
   # 示例：把这句发给能执行 HTTP 的 AI
   # 「用 http://192.168.3.5:8080/api/agent 帮我整理 D:/材料/ 里的报销材料」
   ```

2. **MCP Server**（零依赖 stdio）：适合 Claude Desktop / ZCode 等 MCP 客户端，见 [mcp/README.md](mcp/README.md)。

   ```json
   { "mcpServers": { "xcpc-baoxiao": {
       "command": "node",
       "args": ["mcp/mcp-server.mjs", "http://192.168.3.5:8080"] } } }
   ```

会话保存在服务器内存中（4 小时自动过期，不上传外部服务）；文本型 PDF/OFD 的金额归属由同学的 AI 自行读取文件后提交。

## 局域网部署

`server.js` 为零依赖纯 Node（无需 npm install），静态托管 `dist/` + 识别代理（本机 Ollama）+ AI Agent API：

```bash
npm run build
scp -r dist server.js src mcp <user>@<服务器>:~/xcpc-baoxiao/   # src 为 server.js 运行所需
node ~/xcpc-baoxiao/server.js                                   # 或配置 systemd 用户级服务
```

图片识别需要服务器本机运行 Ollama（视觉模型，如 glm-ocr），环境变量 `PORT` / `OLLAMA_URL` / `OLLAMA_NUM_CTX` 可调；
发票汇总 PDF 生成需要 `node_modules/` 里有 pdf-lib 及其运行时依赖（tslib、pako、@pdf-lib/*）。

## 目录结构

```
├── index.html              # Vite 入口
├── vite.config.js          # base: './'，打包后可静态部署
├── server.js               # 部署服务：静态 + 识别代理 + AI Agent API（零依赖）
├── mcp/                    # MCP server（stdio）+ 配置说明
└── src/
    ├── main.js             # 应用入口
    ├── App.vue             # 布局 + 向导/自由模式切换 + toast
    ├── store.js            # 响应式状态 + localStorage 持久化
    ├── style.css           # 全局样式（含打印样式）
    ├── data/
    │   ├── core.js         # 纯逻辑核心（服务器零依赖复用）
    │   ├── packaging.js    # 材料模型 / 检查 / 打包（浏览器完整版）
    │   ├── approval.js     # 差旅审批单 .docx 生成
    │   └── report.js       # 核对报告（文本 / Markdown）
    ├── utils/              # zip / unzip / ofd 渲染 / pdfText 识别 / serverRecog / misc
    └── components/         # 各页面组件（含 WizardShell 向导壳）
```

## License

[GPLv3](LICENSE)

> 材料要求以财务处与教练的最新通知为准；工具仅作整理提醒，不替代官方流程。
