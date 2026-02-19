const { Router } = require("express");
const crypto = require("crypto");
const { docClient } = require("../db/dynamodb");
const {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const router = Router();
const TABLE = process.env.GLOSSARY_TABLE;

// List glossary terms
router.get("/", async (_req, res, next) => {
  try {
    const { Items } = await docClient.send(new ScanCommand({ TableName: TABLE }));
    res.json(Items || []);
  } catch (err) {
    next(err);
  }
});

// Add term
router.post("/", async (req, res, next) => {
  try {
    const item = {
      termId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...req.body,
    };
    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// Update term
router.put("/:id", async (req, res, next) => {
  try {
    const { term, definition, aliases } = req.body;
    const expressions = [];
    const names = {};
    const values = {};

    if (term !== undefined) {
      expressions.push("#t = :t");
      names["#t"] = "term";
      values[":t"] = term;
    }
    if (definition !== undefined) {
      expressions.push("#d = :d");
      names["#d"] = "definition";
      values[":d"] = definition;
    }
    if (aliases !== undefined) {
      expressions.push("#a = :a");
      names["#a"] = "aliases";
      values[":a"] = aliases;
    }

    expressions.push("updatedAt = :u");
    values[":u"] = new Date().toISOString();

    const { Attributes } = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { termId: req.params.id },
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

// Delete term
router.delete("/:id", async (req, res, next) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE,
      Key: { termId: req.params.id },
    }));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
