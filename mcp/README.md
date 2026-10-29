# XCPC 报销工具 · MCP Server

让同学的 AI（ZCode / Claude Desktop 等支持 MCP 的客户端）直接驱动报销工具：
读指南 → 建会话 → 上传材料 → 按指引核对 → 打包 ZIP，全程不需要手动操作网页。

零依赖：只需要 Node.js（≥18）。

## 配置

服务器地址：命令行第一个参数或环境变量 `XCPC_BAOXIAO_URL`，默认 `http://127.0.0.1:8080`。

### ZCode（`~/.zcode/mcp.json` 或项目 `.mcp.json`）

```json
{
  "mcpServers": {
    "xcpc-baoxiao": {
      "command": "node",
      "args": [
        "C:/Users/你/Desktop/XCPC 报销网站/mcp/mcp-server.mjs",
        "http://192.168.3.5:8080"
      ]
    }
  }
}
```

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "xcpc-baoxiao": {
      "command": "node",
      "args": ["<仓库路径>/mcp/mcp-server.mjs", "http://192.168.3.5:8080"]
    }
  }
}
```

## 给同学的使用方式

把这句发给 AI 即可（AI 会先调 `agent_guide` 学习流程）：

> 我们队要整理报销材料。用 xcpc-baoxiao 工具：先调 agent_guide 看流程，然后 create_session 建会话（队名 ×××，同学名单：…），把 D:/材料/ 文件夹里的文件全部 upload_file 上传，按 get_status 的 next 建议补全金额和归属（识别不到的你直接读文件提取），最后 download_zip 打包发给我。

## 工具列表

| 工具 | 用途 |
| --- | --- |
| `agent_guide` | 完整指南（工作流 / 接口 / 材料规则），开始前必读 |
| `create_session` | 创建会话（队名 + 同学名单），返回 token |
| `upload_file` | 上传本地材料文件，自动分类到行程段/槽位，图片自动 OCR |
| `update_file` | 补金额、归属、去返程、开票方/收款方、不一致说明等 |
| `get_status` | 全量状态 + 缺漏检查 + 下一步建议 |
| `set_team_info` | 更新队名 / 名单 / 比赛信息 |
| `download_zip` | 打包并保存队伍 ZIP |

## 说明

- 会话在服务器内存中保留 4 小时，过期需重建。
- 图片材料自动走服务器 Ollama 识别；文本型 PDF/OFD 的金额归属由 AI 自行读取文件后经 `update_file` 提交。
- 服务器版 ZIP 不含「发票汇总-扫描打印版.pdf」与差旅审批单（这两项用网页打包），其余结构与网页版一致。
