require("dotenv").config();
const { receiveMessages, deleteMessage, sendMessage } = require("../services/sqs");
const { getFile, uploadFile } = require("../services/s3");
const { invokeModel } = require("../services/bedrock");
const { docClient } = require("../db/dynamodb");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const QUEUE_URL = process.env.SQS_REPORT_QUEUE;
const EXPORT_QUEUE_URL = process.env.SQS_EXPORT_QUEUE;
const TABLE = process.env.DYNAMODB_TABLE;

const POLL_INTERVAL = 5000;

function buildPrompt(transcriptText) {
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

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readTranscript(transcribeKey, whisperKey) {
  try {
    const stream = await getFile(transcribeKey);
    return await streamToString(stream);
  } catch (err) {
    console.warn(`Failed to read transcribeKey (${transcribeKey}), falling back to whisperKey`);
    const stream = await getFile(whisperKey);
    return await streamToString(stream);
  }
}

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, transcribeKey, whisperKey } = body;
  console.log(`Generating report for meeting ${meetingId}`);

  // 1. Read transcript from S3 (prefer transcribeKey, fallback to whisperKey)
  const transcriptText = await readTranscript(transcribeKey, whisperKey);

  // 2. Call Bedrock Claude to generate structured report
  const prompt = buildPrompt(transcriptText);
  const responseText = await invokeModel(prompt);

  // 3. Parse the JSON response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse report JSON from Bedrock response for meeting ${meetingId}`);
  }
  const report = JSON.parse(jsonMatch[0]);

  // 4. Upload report to S3
  const reportKey = `reports/${meetingId}/report.json`;
  await uploadFile(reportKey, JSON.stringify(report, null, 2), "application/json");
  const fullReportKey = `${process.env.S3_PREFIX}/${reportKey}`;

  // 5. Update DynamoDB status to "reported"
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { meetingId },
    UpdateExpression: "SET #s = :s, reportKey = :rk, updatedAt = :u",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":s": "reported",
      ":rk": fullReportKey,
      ":u": new Date().toISOString(),
    },
  }));

  // 6. Send message to export queue
  await sendMessage(EXPORT_QUEUE_URL, {
    meetingId,
    reportKey: fullReportKey,
  });

  console.log(`Report generated for meeting ${meetingId}`);
}

async function poll() {
  console.log("Report worker started, polling...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      for (const msg of messages) {
        await processMessage(msg);
        await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
      }
    } catch (err) {
      console.error("Report worker error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

poll();
