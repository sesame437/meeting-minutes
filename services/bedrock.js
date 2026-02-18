const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

function getMeetingPrompt(transcriptText, meetingType) {
  if (meetingType === "weekly") {
    return `你是专业会议纪要助手，请分析以下周例会转录文本，生成结构化会议纪要。

转录文本：${transcriptText}

以 JSON 格式输出：
{
  "meetingType": "weekly",
  "summary": "本次会议总结（2-3句话）",
  "highlights": [{ "point": "业务进展要点", "detail": "详情" }],
  "lowlights": [{ "point": "风险/阻塞项", "detail": "影响和解决建议" }],
  "actions": [{ "task": "任务描述", "owner": "负责人", "deadline": "截止日期", "priority": "high/medium/low", "status": "new" }],
  "decisions": [{ "decision": "决策内容", "rationale": "决策原因" }],
  "participants": ["参会人列表"],
  "nextMeeting": "下次会议时间（如有提及）"
}
只输出 JSON。`;
  }

  if (meetingType === "tech") {
    return `你是专业技术会议纪要助手，请分析以下技术讨论会转录文本，生成结构化技术会议纪要。

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
  return `你是一个专业的会议纪要助手。请分析以下会议转录文本，生成结构化的会议纪要。

转录文本：
${transcriptText}

请以 JSON 格式输出，包含以下字段：
{
  "summary": "会议总结（2-3句话）",
  "highlights": [
    { "point": "要点描述", "detail": "详情" }
  ],
  "lowlights": [
    { "point": "风险/问题描述", "detail": "详情" }
  ],
  "actions": [
    { "task": "任务描述", "owner": "负责人（如提及）", "deadline": "截止日期（如提及）", "priority": "high/medium/low" }
  ],
  "participants": ["参会人列表（如可识别）"],
  "duration": "会议时长估计",
  "meetingType": "会议类型（周会/项目会/评审会等）"
}

只输出 JSON，不要其他文字。`;
}

async function invokeModel(transcriptText, meetingType = "general", modelId = DEFAULT_MODEL_ID) {
  // Truncate to ~120K chars (~30K tokens) to stay within 200K context limit
  const MAX_CHARS = 120000;
  const truncated = transcriptText.length > MAX_CHARS
    ? transcriptText.slice(0, MAX_CHARS) + "\n\n[注：转录文本过长，已截取前段内容进行分析]"
    : transcriptText;
  const prompt = getMeetingPrompt(truncated, meetingType);

  const resp = await bedrockClient.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(resp.body));
  return result.content[0].text;
}

module.exports = { invokeModel, getMeetingPrompt };
