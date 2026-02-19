"use strict";

// Mock db/dynamodb BEFORE requiring the router
const mockSend = jest.fn();
jest.mock("../db/dynamodb", () => ({
  docClient: { send: mockSend },
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  ScanCommand: jest.fn((p) => ({ ...p, _type: "ScanCommand" })),
  PutCommand: jest.fn((p) => ({ ...p, _type: "PutCommand" })),
  UpdateCommand: jest.fn((p) => ({ ...p, _type: "UpdateCommand" })),
  DeleteCommand: jest.fn((p) => ({ ...p, _type: "DeleteCommand" })),
}));

const express = require("express");
const request = require("supertest");

function buildApp() {
  const app = express();
  app.use(express.json());
  const glossaryRouter = require("../routes/glossary");
  app.use("/glossary", glossaryRouter);
  return app;
}

describe("PUT /glossary/:id", () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    // Re-mock after resetModules
    jest.mock("../db/dynamodb", () => ({
      docClient: { send: mockSend },
    }));
    jest.mock("@aws-sdk/lib-dynamodb", () => ({
      ScanCommand: jest.fn((p) => ({ ...p, _type: "ScanCommand" })),
      PutCommand: jest.fn((p) => ({ ...p, _type: "PutCommand" })),
      UpdateCommand: jest.fn((p) => ({ ...p, _type: "UpdateCommand" })),
      DeleteCommand: jest.fn((p) => ({ ...p, _type: "DeleteCommand" })),
    }));
    mockSend.mockReset();
  });

  test("正常更新：term + definition + aliases 全部写入", async () => {
    const fakeAttributes = {
      termId: "abc-123",
      term: "Hello",
      definition: "A greeting",
      aliases: "hi,hey",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mockSend.mockResolvedValueOnce({ Attributes: fakeAttributes });

    app = buildApp();
    const res = await request(app)
      .put("/glossary/abc-123")
      .send({ term: "Hello", definition: "A greeting", aliases: "hi,hey" });

    expect(res.status).toBe(200);

    // Verify UpdateCommand was called and aliases is in the expression
    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.UpdateExpression).toContain("#a = :a");
    expect(callArgs.ExpressionAttributeValues[":a"]).toBe("hi,hey");
    expect(callArgs.ExpressionAttributeValues[":t"]).toBe("Hello");
    expect(callArgs.ExpressionAttributeValues[":d"]).toBe("A greeting");
  });

  test("aliases 为空字符串时：写入空字符串", async () => {
    const fakeAttributes = {
      termId: "abc-123",
      term: "Hello",
      definition: "A greeting",
      aliases: "",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mockSend.mockResolvedValueOnce({ Attributes: fakeAttributes });

    app = buildApp();
    const res = await request(app)
      .put("/glossary/abc-123")
      .send({ term: "Hello", definition: "A greeting", aliases: "" });

    expect(res.status).toBe(200);

    const callArgs = mockSend.mock.calls[0][0];
    // aliases="" is still !== undefined, so it gets written
    expect(callArgs.UpdateExpression).toContain("#a = :a");
    expect(callArgs.ExpressionAttributeValues[":a"]).toBe("");
  });

  test("缺少 term 字段时：返回 400", async () => {
    app = buildApp();
    const res = await request(app)
      .put("/glossary/abc-123")
      .send({ definition: "A greeting" });

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
