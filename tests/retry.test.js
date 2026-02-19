"use strict";

const mockSend = jest.fn();
const mockSendMessage = jest.fn();

jest.mock("../db/dynamodb", () => ({
  docClient: { send: mockSend },
}));

jest.mock("../services/sqs", () => ({
  sendMessage: mockSendMessage,
}));

jest.mock("@aws-sdk/lib-dynamodb", () => ({
  ScanCommand: jest.fn((p) => ({ ...p, _type: "ScanCommand" })),
  GetCommand: jest.fn((p) => ({ ...p, _type: "GetCommand" })),
  PutCommand: jest.fn((p) => ({ ...p, _type: "PutCommand" })),
  UpdateCommand: jest.fn((p) => ({ ...p, _type: "UpdateCommand" })),
  DeleteCommand: jest.fn((p) => ({ ...p, _type: "DeleteCommand" })),
}));

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function getRetryHandler() {
  const router = require("../routes/meetings");
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/:id/retry" && l.route.methods.post
  );
  return layer.route.stack[0].handle;
}

describe("POST /api/meetings/:id/retry", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...oldEnv,
      DYNAMODB_TABLE: "meeting-table",
      SQS_TRANSCRIPTION_QUEUE: "https://sqs.test/transcription",
    };
    mockSend.mockReset();
    mockSendMessage.mockReset();
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("正常重试：failed 会议 -> 发 SQS -> 更新 DynamoDB -> 返回 success", async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          meetingId: "m-1",
          status: "failed",
          s3Key: "inbox/m-1/a.mp3",
          filename: "a.mp3",
          meetingType: "weekly",
        },
      })
      .mockResolvedValueOnce({ Attributes: {} });
    mockSendMessage.mockResolvedValueOnce({ MessageId: "msg-1" });

    const handler = getRetryHandler();
    const req = { params: { id: "m-1" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockSendMessage).toHaveBeenCalledWith("https://sqs.test/transcription", {
      meetingId: "m-1",
      s3Key: "inbox/m-1/a.mp3",
      filename: "a.mp3",
      meetingType: "weekly",
    });

    const updateCall = mockSend.mock.calls[1][0];
    expect(updateCall._type).toBe("UpdateCommand");
    expect(updateCall.UpdateExpression).toBe("SET #s = :s, stage = :stage, updatedAt = :u REMOVE errorMessage");
    expect(updateCall.ExpressionAttributeValues[":s"]).toBe("processing");
    expect(updateCall.ExpressionAttributeValues[":stage"]).toBe("transcribing");
    expect(updateCall.ExpressionAttributeNames).toEqual({ "#s": "status" });
  });

  test("会议不存在 -> 返回 404", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const handler = getRetryHandler();
    const req = { params: { id: "not-found" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test("status 不是 failed -> 返回 400", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        meetingId: "m-2",
        status: "processing",
        s3Key: "inbox/m-2/b.mp3",
        filename: "b.mp3",
      },
    });

    const handler = getRetryHandler();
    const req = { params: { id: "m-2" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Only failed meetings can be retried" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test("DynamoDB 更新字段：status=processing, stage=transcribing, errorMessage 清空", async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          meetingId: "m-3",
          status: "failed",
          s3Key: "inbox/m-3/c.mp3",
          filename: "c.mp3",
          meetingType: "general",
          errorMessage: "previous error",
        },
      })
      .mockResolvedValueOnce({ Attributes: {} });
    mockSendMessage.mockResolvedValueOnce({ MessageId: "msg-3" });

    const handler = getRetryHandler();
    const req = { params: { id: "m-3" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);

    const updateCall = mockSend.mock.calls[1][0];
    expect(updateCall.UpdateExpression).toContain("REMOVE errorMessage");
    expect(updateCall.ExpressionAttributeValues[":s"]).toBe("processing");
    expect(updateCall.ExpressionAttributeValues[":stage"]).toBe("transcribing");
  });

  test("并发重试：ConditionalCheckFailedException -> 返回 409", async () => {
    // GetItem 返回 failed 会议
    mockSend.mockResolvedValueOnce({
      Item: {
        meetingId: "m-race",
        status: "failed",
        s3Key: "inbox/m-race/d.mp3",
        filename: "d.mp3",
        meetingType: "general",
      },
    });
    // UpdateCommand 抛出 ConditionalCheckFailedException（模拟并发第二个请求）
    const condErr = new Error("The conditional request failed");
    condErr.name = "ConditionalCheckFailedException";
    mockSend.mockRejectedValueOnce(condErr);

    const handler = getRetryHandler();
    const req = { params: { id: "m-race" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "会议当前不是失败状态，无法重试" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test("SQS 发送失败 -> 回滚 DynamoDB 到 failed -> 返回 500", async () => {
    // GetItem 返回 failed 会议
    mockSend.mockResolvedValueOnce({
      Item: {
        meetingId: "m-sqsfail",
        status: "failed",
        s3Key: "inbox/m-sqsfail/e.mp3",
        filename: "e.mp3",
        meetingType: "weekly",
      },
    });
    // UpdateCommand (set processing) 成功
    mockSend.mockResolvedValueOnce({ Attributes: {} });
    // SQS sendMessage 失败
    mockSendMessage.mockRejectedValueOnce(new Error("SQS unavailable"));
    // Rollback UpdateCommand (set failed) 成功
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    const handler = getRetryHandler();
    const req = { params: { id: "m-sqsfail" } };
    const res = createRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "重试入队失败，请稍后再试" });

    // 验证回滚 UpdateCommand：状态回退到 failed
    const rollbackCall = mockSend.mock.calls[2][0];
    expect(rollbackCall._type).toBe("UpdateCommand");
    expect(rollbackCall.ExpressionAttributeValues[":s"]).toBe("failed");
    expect(rollbackCall.ExpressionAttributeValues[":stage"]).toBe("failed");
    expect(rollbackCall.ExpressionAttributeValues[":em"]).toContain("SQS 入队失败");
  });
});
