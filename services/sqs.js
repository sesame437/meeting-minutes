const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");

const sqs = new SQSClient({ region: process.env.AWS_REGION });

async function sendMessage(queueUrl, body) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
  }));
}

async function receiveMessages(queueUrl, maxMessages = 1) {
  const resp = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: maxMessages,
    WaitTimeSeconds: 20,
  }));
  return resp.Messages || [];
}

async function deleteMessage(queueUrl, receiptHandle) {
  await sqs.send(new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  }));
}

module.exports = { sqs, sendMessage, receiveMessages, deleteMessage };
