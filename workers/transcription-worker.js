require("dotenv").config();
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  ListVocabulariesCommand,
} = require("@aws-sdk/client-transcribe");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { UpdateCommand, PutCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../db/dynamodb");
const { receiveMessages, deleteMessage, sendMessage } = require("../services/sqs");

const QUEUE_URL = process.env.SQS_TRANSCRIPTION_QUEUE;
const REPORT_QUEUE_URL = process.env.SQS_REPORT_QUEUE;
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || "meeting-minutes";
const REGION = process.env.AWS_REGION;
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || "meeting-minutes-meetings";
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:9000";
const FUNASR_URL = process.env.FUNASR_URL || "";  // 空字符串表示未配置
const ENABLE_TRANSCRIBE = process.env.ENABLE_TRANSCRIBE === "true";  // 默认关闭
const ENABLE_WHISPER = process.env.ENABLE_WHISPER === "true";        // 默认关闭
const ENABLE_FUNASR = FUNASR_URL ? true : false;                     // URL 存在则开启
const POLL_INTERVAL = 5000; // 5 seconds between SQS polls

const transcribeClient = new TranscribeClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// --------------- AWS Transcribe (Track 1) ---------------

async function checkVocabularyExists(vocabName) {
  try {
    const resp = await transcribeClient.send(new ListVocabulariesCommand({
      NameContains: vocabName,
    }));
    return (resp.Vocabularies || []).some((v) => v.VocabularyName === vocabName);
  } catch {
    return false;
  }
}

async function runAWSTranscribe(meetingId, s3Key) {
  const jobName = `${meetingId}-transcribe`;
  const outputKey = `${PREFIX}/transcripts/${meetingId}/transcribe.json`;
  const mediaUri = `s3://${BUCKET}/${s3Key}`;

  const params = {
    TranscriptionJobName: jobName,
    LanguageCode: "zh-CN",
    Media: { MediaFileUri: mediaUri },
    OutputBucketName: BUCKET,
    OutputKey: outputKey,
  };

  // Use custom vocabulary if available
  const hasVocab = await checkVocabularyExists("meeting-minutes-glossary");
  if (hasVocab) {
    params.Settings = { VocabularyName: "meeting-minutes-glossary" };
    console.log(`[Transcribe] Using custom vocabulary: meeting-minutes-glossary`);
  }

  console.log(`[Transcribe] Starting job: ${jobName}`);
  await transcribeClient.send(new StartTranscriptionJobCommand(params));

  // Poll until complete (every 10s, max 30 minutes)
  const maxAttempts = 180; // 30 min / 10s
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10000);
    const resp = await transcribeClient.send(new GetTranscriptionJobCommand({
      TranscriptionJobName: jobName,
    }));
    const status = resp.TranscriptionJob.TranscriptionJobStatus;
    console.log(`[Transcribe] Job ${jobName} status: ${status} (attempt ${i + 1})`);

    if (status === "COMPLETED") {
      return outputKey;
    }
    if (status === "FAILED") {
      const reason = resp.TranscriptionJob.FailureReason;
      throw new Error(`Transcribe job failed: ${reason}`);
    }
  }
  throw new Error(`Transcribe job timed out after 30 minutes`);
}

// --------------- Whisper HTTP API (Track 2) ---------------

async function isWhisperAvailable() {
  try {
    const resp = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function downloadS3Buffer(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function runWhisper(meetingId, s3Key, filename) {
  const outputKey = `${PREFIX}/transcripts/${meetingId}/whisper.json`;

  // Check Whisper service availability
  const available = await isWhisperAvailable();
  if (!available) {
    console.warn(`[Whisper] Service not available at ${WHISPER_URL}, skipping Whisper track`);
    return null;
  }

  // Pass s3_key directly — Whisper instance downloads from S3 itself
  // This avoids routing 617MB through the main EC2 and uses instance store cache
  console.log(`[Whisper] Sending s3_key to ${WHISPER_URL}/asr (instance will fetch from S3)`);
  const formData = new FormData();
  formData.append("s3_key", s3Key);
  formData.append("s3_bucket", BUCKET);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 30 min
  let resp;
  try {
    resp = await fetch(`${WHISPER_URL}/asr`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    throw new Error(`Whisper API returned ${resp.status}: ${await resp.text()}`);
  }

  const result = await resp.json();
  console.log(`[Whisper] Transcription done, language: ${result.language}`);

  // Upload result to S3
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: outputKey,
    Body: JSON.stringify(result, null, 2),
    ContentType: "application/json",
  }));

  return outputKey;
}

// --------------- FunASR (Track 3) ---------------
async function runFunASR(meetingId, s3Key) {
  if (!FUNASR_URL) {
    console.log("[FunASR] FUNASR_URL not configured, skipping");
    return null;
  }
  // 健康检查
  try {
    const resp = await fetch(`${FUNASR_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`health check failed: ${resp.status}`);
  } catch (err) {
    console.warn(`[FunASR] Service not available at ${FUNASR_URL}, skipping: ${err.message}`);
    return null;
  }

  const outputKey = `${PREFIX}/transcripts/${meetingId}/funasr.json`;

  try {
    console.log(`[FunASR] Sending s3_key to ${FUNASR_URL}/asr`);
    const formData = new FormData();
    formData.append("s3_key", s3Key);
    formData.append("s3_bucket", process.env.S3_BUCKET || "yc-projects-012289836917");
    formData.append("language", "zh");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 30 分钟

    let resp;
    try {
      resp = await fetch(`${FUNASR_URL}/asr`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`FunASR /asr returned ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const result = await resp.json();
    if (result.error) throw new Error(`FunASR error: ${result.error}`);

    // 上传结果到 S3
    const s3Body = JSON.stringify(result);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || "yc-projects-012289836917",
      Key: outputKey,
      Body: s3Body,
      ContentType: "application/json",
    }));

    console.log(`[FunASR] Done: ${result.segments?.length || 0} segments, ${result.speaker_count || 0} speakers → ${outputKey}`);
    return outputKey;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[FunASR] Timeout after 30 minutes");
    } else {
      console.error("[FunASR] Failed:", err.message);
    }
    return null;
  }
}

// --------------- DynamoDB Update ---------------

async function updateMeetingStatus(meetingId, createdAt, status, extraAttrs = {}) {
  const names = { "#s": "status", "#u": "updatedAt" };
  const values = { ":s": status, ":u": new Date().toISOString() };
  let expr = "SET #s = :s, #u = :u";

  for (const [k, v] of Object.entries(extraAttrs)) {
    const nameKey = `#${k}`;
    const valKey = `:${k}`;
    names[nameKey] = k;
    values[valKey] = v;
    expr += `, ${nameKey} = ${valKey}`;
  }

  await docClient.send(new UpdateCommand({
    TableName: DYNAMODB_TABLE,
    Key: { meetingId, createdAt },
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// --------------- Message Parsing ---------------

function parseMeetingTypeFromFilename(filename) {
  if (filename.startsWith("weekly__")) return "weekly";
  if (filename.startsWith("tech__")) return "tech";
  return "general";
}

function parseMessage(body) {
  // S3 Event Notification format
  if (body.Records && body.Records[0] && body.Records[0].s3) {
    const s3Event = body.Records[0].s3;
    const s3Key = decodeURIComponent(s3Event.object.key.replace(/\+/g, " "));
    const filename = s3Key.split("/").pop();
    const meetingId = `meeting-${Date.now()}`;
    const meetingType = parseMeetingTypeFromFilename(filename);
    return { meetingId, s3Key, filename, meetingType, isS3Event: true };
  }

  // Internal format
  return {
    meetingId: body.meetingId,
    s3Key: body.s3Key,
    filename: body.filename,
    meetingType: body.meetingType || "general",
    isS3Event: false,
  };
}

// --------------- Message Processing ---------------

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, s3Key, filename, meetingType, isS3Event } = parseMessage(body);

  // Skip invalid or empty messages
  if (!s3Key) {
    console.log(`Skipping message with no s3Key, body: ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }

  // Skip .keep files
  if (s3Key.endsWith(".keep")) {
    console.log(`Skipping .keep file: ${s3Key}`);
    return;
  }

  // Dedup: check if this s3Key is already being processed (S3 events only)
  // Uses GSI (status-createdAt-index) Query + filter instead of full table Scan
  if (isS3Event) {
    const statusesToCheck = ["pending", "processing", "reported", "completed"];
    let found = false;
    let foundMeetingId = null;

    for (const st of statusesToCheck) {
      const result = await docClient.send(new QueryCommand({
        TableName: DYNAMODB_TABLE,
        IndexName: "status-createdAt-index",
        KeyConditionExpression: "#s = :s",
        FilterExpression: "s3Key = :key",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": st, ":key": s3Key },
        Limit: 1,
      }));
      if (result.Items && result.Items.length > 0) {
        found = true;
        foundMeetingId = result.Items[0].meetingId;
        break;
      }
    }

    if (found) {
      console.log(`[Dedup] Skipping duplicate s3Key: ${s3Key}, existing meetingId: ${foundMeetingId}`);
      return;
    }
  }

  // Auto-create DynamoDB record for S3 Event messages
  const createdAt = new Date().toISOString();
  if (isS3Event) {
    console.log(`[S3 Event] Creating meeting record: ${meetingId} (type: ${meetingType})`);
    await docClient.send(new PutCommand({
      TableName: DYNAMODB_TABLE,
      Item: {
        meetingId,
        status: "processing",
        filename,
        s3Key,
        meetingType,
        createdAt,
      },
    }));
  }

  console.log(`Processing transcription for meeting ${meetingId}, audio: ${s3Key}`);
  console.log(`[Pipeline] Tracks enabled — Transcribe: ${ENABLE_TRANSCRIBE}, Whisper: ${ENABLE_WHISPER}, FunASR: ${ENABLE_FUNASR}`);

  // Run enabled tracks in parallel
  const [transcribeKey, whisperKey, funasrKey] = await Promise.all([
    ENABLE_TRANSCRIBE
      ? runAWSTranscribe(meetingId, s3Key).catch((err) => { console.error(`[Transcribe] Failed:`, err.message); return null; })
      : Promise.resolve(null),
    ENABLE_WHISPER
      ? runWhisper(meetingId, s3Key, filename).catch((err) => { console.error(`[Whisper] Failed:`, err.message); return null; })
      : Promise.resolve(null),
    ENABLE_FUNASR
      ? runFunASR(meetingId, s3Key).catch((err) => { console.error(`[FunASR] Failed:`, err.message); return null; })
      : Promise.resolve(null),
  ]);

  if (!transcribeKey && !whisperKey && !funasrKey) {
    throw new Error("All transcription tracks failed");
  }

  console.log(`[Result] Transcribe: ${transcribeKey || "FAILED"}, Whisper: ${whisperKey || "SKIPPED"}, FunASR: ${funasrKey || "SKIPPED"}`);

  // Update DynamoDB meeting status
  await updateMeetingStatus(meetingId, createdAt, "transcribed", {
    transcribeKey: transcribeKey || "",
    whisperKey: whisperKey || "",
    funasrKey: funasrKey || "",
  });

  // Resolve meetingType: use parsed value, or look up from DynamoDB
  let resolvedMeetingType = meetingType;
  if (!resolvedMeetingType || resolvedMeetingType === "general") {
    try {
      const { Item } = await docClient.send(new GetCommand({
        TableName: DYNAMODB_TABLE,
        Key: { meetingId, createdAt },
      }));
      if (Item && Item.meetingType) {
        resolvedMeetingType = Item.meetingType;
      }
    } catch (err) {
      console.warn(`Failed to read meetingType from DynamoDB for ${meetingId}:`, err.message);
    }
  }

  // Send message to report queue
  await sendMessage(REPORT_QUEUE_URL, {
    meetingId,
    transcribeKey: transcribeKey || null,
    whisperKey: whisperKey || null,
    funasrKey: funasrKey || null,
    meetingType: resolvedMeetingType || "general",
    createdAt,
  });

  console.log(`Transcription complete for meeting ${meetingId}`);
}

// --------------- Polling Loop ---------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll() {
  console.log("Transcription worker started, polling...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      if (messages.length > 0) {
        for (const msg of messages) {
          try {
            await processMessage(msg);
            await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
          } catch (err) {
            console.error(`Failed to process message:`, err);
          }
        }
      }
    } catch (err) {
      console.error("Transcription worker error:", err);
    }
    await sleep(POLL_INTERVAL);
  }
}

poll();
