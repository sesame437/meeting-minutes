const { Router } = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { docClient } = require("../db/dynamodb");
const {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { uploadFile } = require("../services/s3");
const { sendMessage } = require("../services/sqs");

const router = Router();
const TABLE = process.env.DYNAMODB_TABLE;
const upload = multer({
  dest: "/tmp",
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB 上限
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a",
      "audio/ogg", "audio/webm", "video/mp4", "video/webm",
      "video/quicktime", "application/octet-stream",
    ];
    const allowedExts = [".mp3", ".wav", ".mp4", ".m4a", ".ogg", ".webm", ".mov"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件格式: ${file.originalname}`), false);
    }
  },
});

// List meetings
router.get("/", async (_req, res, next) => {
  try {
    const { Items } = await docClient.send(new ScanCommand({ TableName: TABLE }));
    res.json(Items || []);
  } catch (err) {
    next(err);
  }
});

// Create meeting
router.post("/", async (req, res, next) => {
  try {
    const item = {
      meetingId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "created",
      ...req.body,
    };
    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// Get single meeting
router.get("/:id", async (req, res, next) => {
  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { meetingId: req.params.id },
    }));
    if (!Item) return res.status(404).json({ error: "Not found" });
    res.json(Item);
  } catch (err) {
    next(err);
  }
});

// Update meeting
router.put("/:id", async (req, res, next) => {
  try {
    const { status, content, title } = req.body;
    const expressions = [];
    const names = {};
    const values = {};

    if (status !== undefined) {
      expressions.push("#s = :s");
      names["#s"] = "status";
      values[":s"] = status;
    }
    if (content !== undefined) {
      expressions.push("#c = :c");
      names["#c"] = "content";
      values[":c"] = content;
    }
    if (title !== undefined) {
      expressions.push("#t = :t");
      names["#t"] = "title";
      values[":t"] = title;
    }

    expressions.push("updatedAt = :u");
    values[":u"] = new Date().toISOString();

    const { Attributes } = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { meetingId: req.params.id },
      UpdateExpression: `SET ${expressions.join(", ")}`,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    res.json(Attributes);
  } catch (err) {
    next(err);
  }
});

// Delete meeting
router.delete("/:id", async (req, res, next) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE,
      Key: { meetingId: req.params.id },
    }));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Upload file and start transcription
router.post("/upload", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      // Clean up temp file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "文件大小超过 2GB 限制" });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const meetingId = crypto.randomUUID();
    const filename = req.file.originalname;
    const s3Key = `inbox/${meetingId}/${filename}`;

    // Upload to S3
    const fileBuffer = fs.readFileSync(req.file.path);
    await uploadFile(s3Key, fileBuffer, req.file.mimetype);

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    // Parse and validate recipient emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let recipientEmails = [];
    if (req.body.recipientEmails) {
      recipientEmails = req.body.recipientEmails
        .split(",")
        .map(e => e.trim())
        .filter(e => emailRegex.test(e));
    }

    // Create meeting record in DynamoDB
    const meetingType = req.body.meetingType || "general";
    const item = {
      meetingId,
      title: req.body.title || filename.replace(/\.[^.]+$/, ""),
      createdAt: new Date().toISOString(),
      status: "pending",
      s3Key,
      filename,
      meetingType,
      ...(recipientEmails.length ? { recipientEmails } : {}),
    };
    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));

    // Send message to transcription queue
    await sendMessage(process.env.SQS_TRANSCRIPTION_QUEUE, {
      meetingId,
      s3Key,
      filename,
      meetingType,
    });

    res.status(201).json({ meetingId, status: "pending" });
  } catch (err) {
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(err);
  }
});

// Retry failed meeting
router.post("/:id/retry", async (req, res, next) => {
  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { meetingId: req.params.id },
    }));
    if (!Item) return res.status(404).json({ error: "Not found" });
    if (Item.status !== "failed") {
      return res.status(400).json({ error: "Only failed meetings can be retried" });
    }

    // Reset status and send back to transcription queue
    const updateExpr = "SET #s = :s, stage = :stage, updatedAt = :u REMOVE errorMessage";
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { meetingId: req.params.id },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "processing",
        ":stage": "transcribing",
        ":u": new Date().toISOString(),
      },
    }));

    await sendMessage(process.env.SQS_TRANSCRIPTION_QUEUE, {
      meetingId: Item.meetingId,
      s3Key: Item.s3Key,
      filename: Item.filename,
      meetingType: Item.meetingType || "general",
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
