require("dotenv").config();
const { receiveMessages, deleteMessage, sendMessage } = require("../services/sqs");
const { getFile } = require("../services/s3");

const QUEUE_URL = process.env.SQS_TRANSCRIPTION_QUEUE;
const REPORT_QUEUE_URL = process.env.SQS_REPORT_QUEUE;

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, audioKey } = body;
  console.log(`Processing transcription for meeting ${meetingId}, audio: ${audioKey}`);

  // TODO: Call AWS Transcribe StartTranscriptionJob with the S3 audio file
  // const transcribeClient = new TranscribeClient({ region: process.env.AWS_REGION });
  // await transcribeClient.send(new StartTranscriptionJobCommand({
  //   TranscriptionJobName: `mm-${meetingId}-${Date.now()}`,
  //   LanguageCode: "en-US",
  //   Media: { MediaFileUri: `s3://${process.env.S3_BUCKET}/${audioKey}` },
  //   OutputBucketName: process.env.S3_BUCKET,
  //   OutputKey: `${process.env.S3_PREFIX}/transcripts/${meetingId}.json`,
  // }));

  // TODO: Poll GetTranscriptionJob until status is COMPLETED or FAILED

  // TODO: Upload transcript result to S3 transcripts/ prefix

  // Send message to report queue for next stage
  await sendMessage(REPORT_QUEUE_URL, {
    meetingId,
    transcriptKey: `${process.env.S3_PREFIX}/transcripts/${meetingId}.json`,
  });

  console.log(`Transcription complete for meeting ${meetingId}`);
}

async function poll() {
  console.log("Transcription worker started, polling...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      for (const msg of messages) {
        await processMessage(msg);
        await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
      }
    } catch (err) {
      console.error("Transcription worker error:", err);
    }
  }
}

poll();
