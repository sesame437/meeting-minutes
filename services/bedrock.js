const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

function getMeetingPrompt(transcriptText, meetingType, glossaryTerms = []) {
  const speakerNote = transcriptText.includes("[SPEAKER_")
    ? `转录文本中包含说话人标签（如 [SPEAKER_0]、[SPEAKER_1]），请利用这些标签识别不同发言人，在参会人列表和行动项中标注发言人编号或角色。\n\n`
    : "";

  const glossaryNote = glossaryTerms.length > 0
    ? `专有名词词库（请确保报告中使用正确拼写）：${glossaryTerms.join("、")}\n\n`
    : "";

  if (meetingType === "weekly") {
    return `${speakerNote}${glossaryNote}你是专业会议纪要助手，请分析以下 AWS SA 团队周例会转录文本，生成结构化会议纪要。周例会通常包含三大部分：团队/个人 KPI 汇报、公司公告事项、客户/项目逐个 Review。请注意：若 teamKPI 或 announcements 部分在转录中未明确提及，对应字段输出空数组即可，不要编造内容。每个项目/客户单独作为一个 projectReviews 条目，若会议中多人分别汇报不同项目，请逐项拆分，不要合并为一条。

转录文本：${transcriptText}

以 JSON 格式输出：
{
  "meetingType": "weekly",
  "summary": "本次周会总结（2-3句话，涵盖整体氛围和最重要结论）",
  "teamKPI": {
    "overview": "团队整体 KPI 完成情况概述",
    "individuals": [
      { "name": "SPEAKER_X 或姓名", "kpi": "个人 KPI 要点", "status": "on-track / at-risk / completed" }
    ]
  },
  "announcements": [
    { "title": "公告标题", "detail": "公告内容", "owner": "发布人（如提及）" }
  ],
  "projectReviews": [
    {
      "project": "项目/客户名称",
      "progress": "本周进展概述",
      "followUps": [
        { "task": "待跟进事项", "owner": "SPEAKER_X 或姓名", "deadline": "截止时间（如提及）", "status": "new / in-progress / blocked" }
      ],
      "highlights": [{ "point": "亮点", "detail": "详情" }],
      "lowlights": [{ "point": "问题或未达预期", "detail": "影响" }],
      "risks": [{ "risk": "风险描述", "impact": "high / medium / low", "mitigation": "缓解措施或应对方向" }],
      "challenges": [{ "challenge": "挑战", "detail": "背景和当前状态" }]
    }
  ],
  "decisions": [
    { "decision": "决策内容", "rationale": "决策原因", "owner": "决策人（如提及）" }
  ],
  "actions": [
    { "task": "行动项", "owner": "SPEAKER_X 或姓名", "deadline": "截止日期（如提及）", "priority": "high / medium / low", "project": "关联项目（如有）" }
  ],
  "participants": ["SPEAKER_0（可能是：角色描述）"],
  "nextMeeting": "下次会议时间（如有提及）"
}
只输出 JSON。`;
  }

  if (meetingType === "tech") {
    return `${speakerNote}${glossaryNote}你是专业技术会议纪要助手，请分析以下技术讨论会转录文本，生成结构化技术会议纪要。

转录文本：${transcriptText}

以 JSON 格式输出：
{
  "meetingType": "tech",
  "summary": "技术讨论总结（2-3句话）",
  "topics": [{ "topic": "技术议题", "discussion": "讨论要点", "conclusion": "结论" }],
  "highlights": [{ "point": "技术亮点/分享要点", "detail": "详情" }],
  "lowlights": [{ "point": "技术风险/Trade-off", "detail": "影响分析" }],
  "actions": [{ "task": "技术任务", "owner": "负责人", "deadline": "截止日期", "priority": "high/medium/low", "estimate": "工时估计" }],
  "knowledgeBase": [{ "title": "知识点标题", "content": "可直接用于文档的技术总结" }],
  "participants": ["参会人列表"],
  "techStack": ["涉及的技术/工具/框架"]
}
只输出 JSON。`;
  }

  // general (default)
  return `${speakerNote}${glossaryNote}你是一个专业的会议纪要助手。请分析以下会议转录文本，生成结构化的会议纪要。

转录文本：
${transcriptText}

请以 JSON 格式输出，包含以下字段：
{
  "summary": "会议总结（2-3句话）",
  "keyTopics": [{ "topic": "议题", "discussion": "讨论要点", "conclusion": "结论或待定" }],
  "highlights": [
    { "point": "要点描述", "detail": "详情" }
  ],
  "lowlights": [
    { "point": "风险/问题描述", "detail": "详情" }
  ],
  "decisions": [{ "decision": "决策内容", "rationale": "决策原因" }],
  "actions": [
    { "task": "任务描述", "owner": "SPEAKER_X 或姓名", "deadline": "截止日期（如提及）", "priority": "high/medium/low" }
  ],
  "participants": ["SPEAKER_0（可能是：角色描述）"],
  "duration": "会议时长估计",
  "meetingType": "会议类型（周会/项目会/评审会等）"
}

只输出 JSON，不要其他文字。`;
}

function truncateTranscript(text) {
  const MAX_TOTAL = 120000;
  const MAX_EACH = 60000;

  // FunASR-only 模式：整体截断（已在 report-worker 层截过 60k）
  if (text.includes("[FunASR 转录（含说话人标签）]") && !text.includes("[AWS Transcribe 转录]")) {
    const FUNASR_LABEL = "[FunASR 转录（含说话人标签）]";
    const idx = text.indexOf(FUNASR_LABEL);
    const before = text.slice(0, idx); // 可能的前导文字
    const after = text.slice(idx + FUNASR_LABEL.length);
    return before + FUNASR_LABEL + after.slice(0, MAX_EACH);
  }

  // 如果是双轨合并文本，各自截断
  if (text.includes("[AWS Transcribe 转录]") && text.includes("[Whisper 转录]")) {
    const WHISPER_LABEL = "[Whisper 转录]";
    const parts = text.split(WHISPER_LABEL);
    const transcribePart = parts[0].slice(0, MAX_EACH);
    const whisperPart = WHISPER_LABEL + parts[1].slice(0, MAX_EACH - WHISPER_LABEL.length);
    return transcribePart + "\n\n" + whisperPart;
  }
  // 单轨：整体截断
  return text.slice(0, MAX_TOTAL);
}

async function invokeModel(transcriptText, meetingType = "general", glossaryTerms = [], modelId = DEFAULT_MODEL_ID) {
  const truncated = truncateTranscript(transcriptText);
  const prompt = getMeetingPrompt(truncated, meetingType, glossaryTerms);

  const resp = await bedrockClient.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 16000,
        messages: [{ role: "user", content: prompt }],
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(resp.body));
  return result.content[0].text;
}

module.exports = { invokeModel, getMeetingPrompt };
