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

async function getCreatedAt(meetingId) {
  try {
    const result = await docClient.send(new (require("@aws-sdk/lib-dynamodb").QueryCommand)({
      TableName: process.env.DYNAMODB_TABLE || "meeting-minutes-meetings",
      KeyConditionExpression: "meetingId = :id",
      ExpressionAttributeValues: { ":id": meetingId },
      Limit: 1,
    }));
    return result.Items?.[0]?.createdAt || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function getMeetingType(meetingId, messageType) {
  // Use meetingType from SQS message if provided
  if (messageType && messageType !== "general") {
    return messageType;
  }
  // Otherwise look up from DynamoDB
  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { meetingId, createdAt: await getCreatedAt(meetingId) },
    }));
    return (Item && Item.meetingType) || "general";
  } catch (err) {
    console.warn(`Failed to read meetingType from DynamoDB for ${meetingId}:`, err.message);
    return "general";
  }
}

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, transcribeKey, whisperKey } = body;
  console.log(`Generating report for meeting ${meetingId}`);

  // Get createdAt for composite key
  const createdAt = await getCreatedAt(meetingId);

  // Determine meeting type
  const meetingType = await getMeetingType(meetingId, body.meetingType);
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
