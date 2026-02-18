const { Router } = require("express");
const crypto = require("crypto");
const fs = require("fs");
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
const upload = multer({ dest: "/tmp" });

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
router.post("/upload", upload.single("file"), async (req, res, next) => {
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

module.exports = router;
