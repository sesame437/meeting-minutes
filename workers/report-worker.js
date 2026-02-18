require("dotenv").config();
const { receiveMessages, deleteMessage, sendMessage } = require("../services/sqs");
const { getFile, uploadFile } = require("../services/s3");
const { docClient } = require("../db/dynamodb");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const QUEUE_URL = process.env.SQS_REPORT_QUEUE;
const EXPORT_QUEUE_URL = process.env.SQS_EXPORT_QUEUE;
const TABLE = process.env.DYNAMODB_TABLE;

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, transcriptKey } = body;
  console.log(`Generating report for meeting ${meetingId}`);

  // TODO: Read transcript from S3
  // const transcriptStream = await getFile(transcriptKey);
  // const transcriptText = await streamToString(transcriptStream);

  // TODO: Call Bedrock Claude to generate structured meeting minutes
  // const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  // const response = await bedrockClient.send(new InvokeModelCommand({
  //   modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
  //   contentType: "application/json",
  //   body: JSON.stringify({
  //     anthropic_version: "bedrock-2023-05-31",
  //     messages: [{ role: "user", content: `Generate structured meeting minutes with Highlights, Lowlights, Actions, and Summary from: ${transcriptText}` }],
  //     max_tokens: 4096,
  //   }),
  // }));

  // TODO: Parse Bedrock response and extract structured report

  // TODO: Upload report to S3 reports/ prefix
  // await uploadFile(`reports/${meetingId}.json`, JSON.stringify(report), "application/json");

  // TODO: Update DynamoDB with report content and status
  // await docClient.send(new UpdateCommand({
  //   TableName: TABLE,
  //   Key: { meetingId },
  //   UpdateExpression: "SET #s = :s, report = :r, updatedAt = :u",
  //   ExpressionAttributeNames: { "#s": "status" },
  //   ExpressionAttributeValues: {
  //     ":s": "report_generated",
  //     ":r": report,
  //     ":u": new Date().toISOString(),
  //   },
  // }));

  // Send message to export queue
  await sendMessage(EXPORT_QUEUE_URL, {
    meetingId,
    reportKey: `${process.env.S3_PREFIX}/reports/${meetingId}.json`,
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
  }
}

poll();
