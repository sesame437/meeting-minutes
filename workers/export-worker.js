require("dotenv").config();
const { receiveMessages, deleteMessage } = require("../services/sqs");
const { getFile, uploadFile } = require("../services/s3");
const { sendEmail } = require("../services/ses");
const { docClient } = require("../db/dynamodb");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const QUEUE_URL = process.env.SQS_EXPORT_QUEUE;
const TABLE = process.env.DYNAMODB_TABLE;

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, reportKey } = body;
  console.log(`Exporting meeting ${meetingId}`);

  // TODO: Read report from S3
  // const reportStream = await getFile(reportKey);
  // const reportData = JSON.parse(await streamToString(reportStream));

  // TODO: Generate PDF from report data
  // Consider using pdfkit or puppeteer for PDF generation
  // const pdfBuffer = await generatePdf(reportData);

  // TODO: Upload PDF to S3
  // const pdfKey = await uploadFile(`exports/${meetingId}.pdf`, pdfBuffer, "application/pdf");

  // TODO: Send email with PDF attachment via SES
  // await sendEmail({
  //   to: process.env.SES_TO_EMAIL,
  //   subject: `Meeting Minutes - ${meetingId}`,
  //   htmlBody: `<h1>Meeting Minutes</h1><p>Please find the attached meeting minutes.</p>`,
  // });

  // TODO: Update DynamoDB status to "exported"
  // await docClient.send(new UpdateCommand({
  //   TableName: TABLE,
  //   Key: { meetingId },
  //   UpdateExpression: "SET #s = :s, updatedAt = :u",
  //   ExpressionAttributeNames: { "#s": "status" },
  //   ExpressionAttributeValues: {
  //     ":s": "exported",
  //     ":u": new Date().toISOString(),
  //   },
  // }));

  console.log(`Export complete for meeting ${meetingId}`);
}

async function poll() {
  console.log("Export worker started, polling...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      for (const msg of messages) {
        await processMessage(msg);
        await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
      }
    } catch (err) {
      console.error("Export worker error:", err);
    }
  }
}

poll();
