require("dotenv").config();
const { receiveMessages, deleteMessage, sendMessage } = require("../services/sqs");
const { getFile, uploadFile } = require("../services/s3");
const { invokeModel } = require("../services/bedrock");
const { docClient } = require("../db/dynamodb");
const { UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

const QUEUE_URL = process.env.SQS_REPORT_QUEUE;
const EXPORT_QUEUE_URL = process.env.SQS_EXPORT_QUEUE;
const TABLE = process.env.DYNAMODB_TABLE;

const POLL_INTERVAL = 5000;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function extractTranscribeText(rawJson) {
  try {
    const data = JSON.parse(rawJson);
    // AWS Transcribe JSON 格式：results.transcripts[0].transcript
    const transcript = data?.results?.transcripts?.[0]?.transcript;
    if (transcript) return transcript;
    // 如果解析不到，原样返回（可能已经是纯文本）
    return rawJson;
  } catch (e) {
    // 不是 JSON，已经是纯文本
    return rawJson;
  }
}

async function readTranscript(transcribeKey, whisperKey) {
  // 注意：不能用 `await getFile(key)` 作为 allSettled 的参数——
  // await 在数组构造期就会求值，若抛错会绕过 allSettled 直接冒泡。
  // 正确做法：把 Promise 工厂（不带 await）直接传给 allSettled。
  const results = await Promise.allSettled([
    transcribeKey ? streamToString(getFile(transcribeKey)) : Promise.reject("no transcribeKey"),
    whisperKey ? streamToString(getFile(whisperKey)) : Promise.reject("no whisperKey"),
  ]);

  const rawTranscribeText = results[0].status === "fulfilled" ? results[0].value : null;
  const whisperText = results[1].status === "fulfilled" ? results[1].value : null;

  // AWS Transcribe 返回 JSON，需要提取纯文本
  const transcribeText = rawTranscribeText ? extractTranscribeText(rawTranscribeText) : null;

  if (!transcribeText && !whisperText) {
    throw new Error("Both transcription sources failed");
  }

  if (transcribeText && whisperText) {
    return `[AWS Transcribe 转录]\n${transcribeText}\n\n[Whisper 转录]\n${whisperText}`;
  }
  return transcribeText || whisperText;
}

async function getMeetingType(meetingId, createdAt, messageType) {
  // Use meetingType from SQS message if provided
  if (messageType && messageType !== "general") {
    return messageType;
  }
  // Otherwise look up from DynamoDB
  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { meetingId, createdAt },
    }));
    return Item?.meetingType || "general";
  } catch (err) {
    console.warn(`Failed to read meetingType from DynamoDB for ${meetingId}:`, err.message);
    return "general";
  }
}

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, transcribeKey, whisperKey, createdAt } = body;
  console.log(`Generating report for meeting ${meetingId}`);

  // Determine meeting type
  const meetingType = await getMeetingType(meetingId, createdAt, body.meetingType);
  console.log(`Meeting type: ${meetingType}`);

  // 1. Read transcript from S3 (prefer transcribeKey, fallback to whisperKey)
  const transcriptText = await readTranscript(transcribeKey, whisperKey);

  // 2. Call Bedrock Claude to generate structured report
  const responseText = await invokeModel(transcriptText, meetingType);

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
    Key: { meetingId, createdAt },
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
    createdAt,
  });

  console.log(`Report generated for meeting ${meetingId}`);
}

async function poll() {
  console.log("Report worker started, polling...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      for (const msg of messages) {
        try {
          await processMessage(msg);
          await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
        } catch (err) {
          console.error(`[report-worker] Failed to process message, will retry:`, err.message);
          // 不删除消息 → SQS visibility timeout 后自动重试
        }
      }
    } catch (err) {
      console.error("Report worker error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

poll();
