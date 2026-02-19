# Meeting Minutes — Roadmap

> 最后更新：2026-02-19

---

## 🔴 待修复（影响质量）

### P1 - 说话人标签优化
- **问题**：`[SPEAKER_0]`、`[SPEAKER_1]` 机器标签出现在纪要正文里，不自然
- **方案 A（推荐）**：prompt 里指示 Bedrock 根据发言内容推断角色（主持人/成员A/B），不直接用 SPEAKER_X
- **方案 D（配合）**：正文不显示 SPEAKER_X；action items 里无法确认身份时用"待确认（SPEAKER_2）"作 fallback
- **方案 C（长期）**：上传时填写参会人名单，系统自动映射说话人编号 → 真实姓名（需改 UI）

### P2 - 邮件 PDF 去掉
- **问题**：PDF 意义不大，也不美观
- **方案**：邮件正文直接渲染 HTML，去掉 PDF 附件；或邮件改为"查看在线报告"链接

### P3 - 邮件/报告内容美化
- **问题**：内容正文美观度一般
- **方向**：参考 AWS 整体风格（橙色主题、简洁表格、清晰层级）
- **待调研**：GitHub 上 HTML email 模板、AWS 风格 report 模板
- **参考项目**：Zackriya-Solutions/meeting-minutes（PDF 导出风格）

---

## 🟡 待完善（功能增强）

### 词库（glossary）管理
- **现状**：只能通过 DynamoDB CLI 手动增删
- **方案**：管理 UI 增加词库管理页面（增删改查）
- **优先级**：中

### weekly 模板 — 多项目识别准确度
- **现状**：prompt 已加"逐项拆分"说明，但未经真实周会录音验证
- **待测**：用真实周会录音测试 projectReviews 分组是否准确

### fetchGlossaryTerms 缓存策略
- **现状**：内存缓存 TTL 10 分钟，支持分页
- **长期**：词库按团队/项目分类后改用 QueryCommand 精确读取

### 说话人分离准确度
- **现状**：FunASR CAM++ 识别 13-14 人，但相邻说话人可能错误分割
- **待测**：人工对比 SPEAKER_X 和实际说话人，评估错误率

---

## 🟢 已完成

- [x] FunASR 替换 Whisper/Transcribe，成为唯一转录引擎（g6.2xlarge, CAM++ 说话人分离）
- [x] 端到端 pipeline：FunASR → Bedrock → PDF → Email（~5分钟全程）
- [x] 三路 pipeline 开关（ENABLE_TRANSCRIBE/WHISPER/FUNASR 环境变量）
- [x] Bedrock prompt：FunASR 说话人标签说明、词库注入
- [x] weekly 模板升级：teamKPI / announcements / projectReviews / risks / challenges
- [x] general 模板升级：keyTopics / decisions
- [x] glossary 词库 → Bedrock prompt 注入（NexusAI 已入库）
- [x] truncateTranscript FunASR-only 分支
- [x] NVMe 缓存原子写（.tmp → rename）
- [x] 单元测试：30+ 测试全通过

---

## 💡 长期想法

- 实时转录（Streaming ASR）
- 多语言自动检测（中/英混合更准）
- 会议录音自动上传（Zoom/Teams webhook）
- 说话人命名持久化（同一人跨会议识别）
- 报告审阅 + 人工修正工作流
