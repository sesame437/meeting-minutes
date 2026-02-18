const { Router } = require("express");
const crypto = require("crypto");
const { docClient } = require("../db/dynamodb");
const {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const router = Router();
const TABLE = process.env.DYNAMODB_TABLE;

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

module.exports = router;
