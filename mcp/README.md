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
| `agent_guide` | 完整指南（工作流 / 接口 / 材料规则 / 关键词映射表），开始前必读 |
| `create_session` | 创建会话（队名 + 同学名单），返回 token |
| `upload_file` | 上传本地材料文件，按文件名关键词自动分类；图片默认自动扫描增强（四角裁剪矫正+黑白，像扫描件）后 OCR，**报销场景要彩色原图就传 `scanMode: "off"`（黑白会把红章变灰）**；判不出类别落入「未分类」，不报错 |
| `update_file` | 补金额、归属、去返程、开票方/收款方、不一致说明等；支持一文件多槽（盖章结账流水 = h_flow + h_pay）、「未分类」归位（group/type）、补充材料（slot: supplement） |
| `get_status` | 全量状态 + 缺漏检查 + 下一步建议 + 会话剩余时间 |
| `set_team_info` | 更新队名 / 名单 / 比赛信息 |
| `download_zip` | 打包并保存队伍 ZIP |
| `station_set_name` | （报销负责人）设置赛站名称 |
| `station_upload_zip` | （报销负责人）上传各队 ZIP，自动提取名单与待办 |
| `station_upload_entryfee` | （报销负责人）上传参赛费材料（邀请函 / 发票 / 支付记录） |
| `station_status` | （报销负责人）查看赛站汇总状态与各队待办 |
| `station_pack` | （报销负责人）打包赛站总 ZIP 并保存 |
| `submit_feedback` | 向网站提交使用意见反馈（先征得用户同意再调用） |

## 说明

- 会话闲置一个月过期（每次调用自动续期），`get_status` 可查 `session.expiresAt`；过期需重建。
- 图片材料先自动扫描增强（四角裁剪矫正 + 黑白，扫描全能王效果；`upload_file` 传 `scanMode: "gray"` 灰度 / `"off"` 关闭），增强后再走服务器 Ollama 识别；文本型 PDF/OFD 的金额归属由 AI 自行读取文件后经 `update_file` 提交。**报销材料一律传彩色原图（`scanMode: "off"`），除非用户点名要黑白扫描件。**
- 酒店盖章结账流水含收款/POS 信息时传一份即可：`update_file` 的 `slot: ["h_flow","h_pay"]`（一文件多槽），金额计入支付合计，ZIP 只出现一份。
- 规则外的材料（如 12306 支付记录）用 `slot: "supplement"`：不参与核对，ZIP 归入该段「补充材料」文件夹。
- 打包 ZIP 自动附带两份汇总 PDF：「发票汇总-扫描打印版.pdf」（仅发票/凭证）+「材料汇总-全部材料扫描打印版.pdf」（全部材料；PDF 无损拷页、图片排 A4、OFD 按坐标矢量渲染为可选中文字的 PDF 页）。需要服务器 node_modules 里有 pdf-lib 及其依赖（@pdf-lib/standard-fonts、@pdf-lib/upng、pako、tslib），以及图片扫描增强用的 jpeg-js、pngjs。
- 差旅审批单是负责人文件，不在队伍 ZIP 内（网页端随赛站汇总提交）。
- 网站由学生团队维护、持续迭代：AI 完成任务后应向用户征求使用意见，征得同意后经 `submit_feedback` 提交（服务器记录在 `feedback/` 目录）。

## AI 实战手册（ICPC/CCPC 通用，沈阳站 2026-11 全流程沉淀）

**下一个 AI 开工前必读仓库根目录 `AGENTS.md`**——端到端流程、上传/核对/打包的每一步验证纪律、财务填报口径（立减按实付、高速费不报、参赛费填其他费用栏）、差旅审批单无头生成管线、以及全部踩坑记录（GLM 1210 毒文件、双 /tmp、curl 中文乱码、ZIP 防截断、station 重打链）都在里面。要点：

- 上传前逐张目检建立「内容→槽位」映射（队友的文件名会骗人）；`get_status` 全绿 ≠ 字节配对正确，交付前必须解包抽验。
- **赛站总包是从「上传的队 ZIP」打包的，不是从会话现打**——任何会话变更后必须：重打队包 → DELETE 旧 station 队包 → 重传 → 重打总包。
- 财务差旅费明细：出差人一组上限 6 人（+加组），职称"其他人员"、伙食/交通补贴"否"、参赛费填"其他费用"栏、立减按实付、高速费不报（票面入账）。
