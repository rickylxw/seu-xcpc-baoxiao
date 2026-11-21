# AGENTS.md — AI 报销助手实战手册

本仓库驱动东南大学 XCPC（ICPC/CCPC）参赛报销材料整理。AI（ZCode/Claude 等）通过 agent API 或 MCP 驱动全流程。**本手册是 ICPC 沈阳站（2026-11）全流程实战沉淀，下一个 AI 直接照此执行，不要重新发明流程。**

- 公网部署：https://xcpcbx.rickylin.top （GET /api/agent 自描述指南）
- MCP：`mcp/mcp-server.mjs`（配置见 mcp/README.md）
- 局域网部署：192.168.3.5:8080（ssh rickylin@192.168.3.5，`~/xcpc-baoxiao/`，systemd user unit `xcpc-baoxiao`）

## 一、端到端流程（每队）

1. **建会话**：`POST /api/agent/sessions`（teamName + members 带**一卡通号** + meta 比赛名）。名单顺序一旦确定不要再改——支付记录归属按 members 下标引用。
2. **上传材料**：`POST /sessions/:token/files`，头 X-Filename 用**规范名**（含"机票发票/支付记录/行程单/流水"等关键词才好自动分类；哈希名文件先目检内容再起规范名）。图片一律带 **X-Scan: off**（见下"彩色口径"）。
3. **逐张目检**：图片先本地体检（jpeg-js 解码防 CMYK/毒文件，PDF 先 pdftoppm 渲染再读——GLM 读个别正常文件会报 1210 文件解析失败并**永久砖死会话**，详见下文"1210"）。目检建立**内容→槽位**映射，不要信文件名（队友的文件名会骗人）。
4. **PATCH 补数据**：`PATCH /sessions/:token/files/:fileId` 交 amount/members/scope。要点：跨段移动必须 `{type:'local',slot,scope}`（只传 slot 会 400）；收付款不一致一次 PATCH 同时交 {issuer,payee,consistent:true,note}；PATCH members 必须保持原数组顺序。
5. **status 全绿**：`GET /sessions/:token/status`，next 清零 = 机票/住宿 invSum=paySum 且缺料补齐。市内交通不参与金额核对（只核对机票+住宿）。
6. **打队包**：`POST /sessions/:token/zip`，**必须 EOCD 校验**（`buf.readUInt32LE(i)==0x06054b50` 且 central 目录偏移自洽），截断则重试。
7. **交付前解包验证**：列出条目 → 抽验文件魔数（%PDF-/PNG/JPEG）→ 关键材料目检（至少发票/支付/流水各抽一）→ CSV 卡号核对。**status 全绿 ≠ 字节配对正确**（amount 是文本，不校验图内容）；发生过"4 张图片字节循环错位"事故，解包目检是唯一防线。
8. **彩色口径**：服务器上传图片**默认黑白化**（X-Scan: bw，红章会变灰）。**除非用户点名要黑白扫描件，一律 X-Scan: off 传彩色原图**。裁剪/转正可以做（scan-core 有 adaptiveBinarize 等导出），二值化不做。手机横拍图先转正——rot90 坐标转换极易写反，**写完立刻导出小图目检方向**再继续。

## 二、赛站打包链（负责人）

`POST /station/zip` 是**从"上传的队 ZIP"打包，不是从服务器会话现打**。所以：

> 任何会话内容变更（补材料/PATCH/换彩色）后：`POST /sessions/:token/zip` 重打队包 → `DELETE /station/zips/:id`（status.zips 里查旧 id）→ 重新上传新队包 → 再 `POST /station/zip` 重打总包。**跳过这一步就会交付旧内容的"假总包"**（沈阳站真实翻车过一次）。

赛站级：PATCH station {name} → 上传队包×N → 参赛费（X-Slot: invite / fee_invoice / fee_pay）→ status → station/zip。

## 三、财务填报口径（2026-11 沈阳站与财务实际核对后定稿）

**混合口径，别一刀切**：
- **支付立减按实付报销**：东航"机票支付立减"0.50/张、华住"银行卡立减金"等，报销额=实付。车船费/住宿费填实付合计。
- **高速费等票面外附加不报销**：高德聚合打车的票面低于实付（差额=高速费），按**发票票面**填，差额队员自担并在审批单备注说明。
- **参赛注册费**填财务系统"**其他费用**"栏（4500/3 队）。
- **出租车老式纸质票二维码扫不出是正常现象**（非增值税发票），手填票面四要素（代码/号码/日期/金额）或让队员高德 App 补开电子票——**二选一，防重复报销**。

**差旅费明细填法**（财务系统出差人一组上限 6 人，右上角 + 加组；9 人 = 6+3 两组）：
- 组内多队行程合并一行：省份=辽宁省、出差地点="辽宁 沈阳 东北大学"、起止取全队最早/最晚、天数=起止自然日。
- 行程行日期/天数**复制上一组时最容易忘改**（沈阳站真实填错过），提交前逐项核对。
- 职称全选**其他人员**；伙食补贴"否"（如可领按财务标准）、交通补贴**否**（市内交通已实报）。
- 沈阳站最终数：组1 车船 9973.00/市内 423.11/住宿 1910.00/其他费用 4500（计 16806.11）；组2 车船 4356.00/住宿 1755.26（计 6111.26）；总计 **22917.37**。
- 服务器/ZIP 金额保持**发票口径**（核对全绿，报销少于票面无违规）；对照单（status.sysFill.text）也是发票口径，与实付差额口头向财务说明。

## 四、差旅审批单

无头生成管线（已验证）：项目根 entry（模板 `tmp-approval-entry.mjs`，gitignored，改 9 人数据/日期/事由/卡号即可）→ `node_modules/.bin/esbuild tmp-approval-entry.mjs --bundle --platform=node --format=esm --define:process.env.NODE_ENV='"production"' --outfile=<bundle>` → `node bundle` 写 docx → `soffice --headless --convert-to pdf` → pdftoppm 渲染目检。**entry 里 import 用 `./src/...`；不要垫 document**（垫了 vue runtime-dom 会炸，让它走无 DOM 分支；localStorage 要垫）。

**特殊事项备注模板（用户定稿）**：`东北大学-沈阳机场出租车无电子发票\n打车高速费未报销，支付宝银行优惠立减已扣除`（按实际城市/行程套写）。其余固定：☑校内人员、事由"参加XX赛"、所到单位=承办校、经费卡号（乐山/沈阳均为 4209002407）、学生、乘坐等级①是☑、飞机经济舱、住宿按标准限额据实报销☑、伙食/市内交通不领取补贴☑。打印后负责人+单位负责人两处手签，随赛站材料提交（不在队 ZIP 内）。

## 五、环境与工具坑（都是踩过的）

- **GLM 1210 毒文件**：读材料前先本地体检（pdftoppm 渲染 PDF / jpeg-js 验图片）。毒文件一旦进了会话历史，每条消息都重放 → 会话永久 1210，救不活。偶发瞬时 1210 重试即过；确定性 3/3 失败的文件进黑名单，只读渲染副本。
- **两个 /tmp 并存**：Write 工具的 `/tmp` = `C:\tmp`；Git Bash 的 `/tmp` = `%TEMP%`。脚本统一写 `C:/tmp/...` 并用完整 Windows 路径调用。
- **curl 传中文**：Git Bash curl 的中文头/体会按 GBK 发送 → 乱码。一律用 `node -e` / .mjs 里的 fetch + `encodeURIComponent`。
- **Bash 回显中文乱码**：UTF-8 输出显示成 GBK 是显示层问题，文件本身正常；需要读内容就落盘后用 Read。
- **ZIP 下载防截断**：EOCD 校验 + 重试（间隔 3s，最多 6 次）；"200 但 EOCD 恒 BAD 且大小稳定"= 服务器端打包出错，查 `journalctl --user -u xcpc-baoxiao` 的 [summary] skipped 日志。
- **服务器持久化**：agent-sessions.json 每 5s flush，重启自动恢复；字节单份 base64 存储 + 载入按 id 挂链（fa6a9d2 修复过"重启后字节全坏"）。19 个会话恢复成功 ≠ 字节健康，**必须实际打包验证**。
- **图片名实不符常见**：.png 实为 JPEG 等按魔数处理，别信扩展名。
- **「打车 X 程」别当已知数**：按人头×去返推算（N 人最多 2N 程）对着支付流水数；聚合打车承运商五花八门，文件名金额≠票面金额（实付含高速费等线下附加）。
- 远程部署更新：`scp server.js rickylin@192.168.3.5:~/xcpc-baoxiao/` → `systemctl --user restart xcpc-baoxiao`；server.js 依赖远程 src/ 与 node_modules（pdf-lib 系、jpeg-js、pngjs），改 src 里的 core.js 等也要同步 scp。
