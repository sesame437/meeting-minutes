const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX;

async function uploadFile(key, body, contentType) {
  const fullKey = `${PREFIX}/${key}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: fullKey,
    Body: body,
    ContentType: contentType,
  }));
  return fullKey;
}

async function getFile(key) {
  const fullKey = key.startsWith(PREFIX) ? key : `${PREFIX}/${key}`;
  const resp = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: fullKey,
  }));
  return resp.Body;
}

module.exports = { s3, uploadFile, getFile };
