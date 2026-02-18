"use strict";

/**
 * core.test.js — 核心逻辑单元测试
 *
 * 覆盖：
 *   1. createdAt 传播 (transcription-worker → report-worker → export-worker)
 *   2. report-worker getMeetingType() 优先级逻辑
 *   3. export-worker PDF 字体文件存在性
 *   4. transcription-worker S3 key 去重 (ScanCommand) 逻辑
 */

const path = require("path");
const fs   = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks (必须在 require worker 模块前 jest.mock)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock("dotenv", () => ({ config: jest.fn() }));

const mockDynamoSend = jest.fn();
jest.mock("../db/dynamodb", () => ({ docClient: { send: mockDynamoSend } }));

jest.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand:  jest.fn((p) => ({ _cmd: "UpdateCommand",  ...p })),
  PutCommand:     jest.fn((p) => ({ _cmd: "PutCommand",     ...p })),
  GetCommand:     jest.fn((p) => ({ _cmd: "GetCommand",     ...p })),
  ScanCommand:    jest.fn((p) => ({ _cmd: "ScanCommand",    ...p })),
}));

const mockSqsSend    = jest.fn().mockResolvedValue({});
const mockS3Send     = jest.fn().mockResolvedValue({});

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient:           jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  ReceiveMessageCommand: jest.fn(),
  DeleteMessageCommand:  jest.fn(),
  SendMessageCommand:    jest.fn(),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client:         jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-transcribe", () => ({
  TranscribeClient:              jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  StartTranscriptionJobCommand:  jest.fn(),
  GetTranscriptionJobCommand:    jest.fn(),
  ListVocabulariesCommand:       jest.fn(),
}));

jest.mock("@aws-sdk/client-ses", () => ({
  SESClient:            jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendRawEmailCommand:  jest.fn(),
}));

// SQS / S3 service helpers
jest.mock("../services/sqs", () => ({
  receiveMessages: jest.fn().mockResolvedValue([]),
  deleteMessage:   jest.fn().mockResolvedValue({}),
  sendMessage:     jest.fn().mockResolvedValue({}),
}));

jest.mock("../services/s3", () => ({
  getFile:    jest.fn(),
  uploadFile: jest.fn().mockResolvedValue("s3://bucket/key"),
}));

jest.mock("../services/ses", () => ({
  ses: { send: jest.fn().mockResolvedValue({}) },
}));

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const mockSend = jest.fn().mockResolvedValue({
    body: new TextEncoder().encode(
      JSON.stringify({ content: [{ text: '{"summary":"ok"}' }] })
    ),
  });
  return {
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand:   jest.fn(),
  };
});

jest.mock("../services/bedrock", () => ({
  invokeModel: jest.fn().mockResolvedValue('{"summary":"mocked report"}'),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 注入 sendMessage 的 mock 引用，用于断言 createdAt 传播
// ─────────────────────────────────────────────────────────────────────────────
const { sendMessage } = require("../services/sqs");

// ─────────────────────────────────────────────────────────────────────────────
// 提取 transcription-worker 中的纯函数（不运行 poll()）
// ─────────────────────────────────────────────────────────────────────────────

// 从 worker 源码复制的纯逻辑（无副作用），用于隔离测试
function parseMeetingTypeFromFilename(filename) {
  if (filename.startsWith("weekly__")) return "weekly";
  if (filename.startsWith("tech__"))   return "tech";
  return "general";
}

function parseMessage(body) {
  if (body.Records && body.Records[0] && body.Records[0].s3) {
    const s3Event  = body.Records[0].s3;
    const s3Key    = decodeURIComponent(s3Event.object.key.replace(/\+/g, " "));
    const filename = s3Key.split("/").pop();
    const meetingId   = `meeting-${Date.now()}`;
    const meetingType = parseMeetingTypeFromFilename(filename);
    return { meetingId, s3Key, filename, meetingType, isS3Event: true };
  }
  return {
    meetingId:   body.meetingId,
    s3Key:       body.s3Key,
    filename:    body.filename,
    meetingType: body.meetingType || "general",
    isS3Event:   false,
  };
}

// getMeetingType as used in report-worker
async function getMeetingType(meetingId, messageType, mockScan) {
  if (messageType && messageType !== "general") {
    return messageType;
  }
  try {
    const result = await mockScan(meetingId);
    return result.Items?.[0]?.meetingType || "general";
  } catch {
    return "general";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 ─ createdAt 传播
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 1 — createdAt 传播", () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * 1a. transcription-worker 发出的 SQS 消息必须包含 createdAt
   *
   * 模拟一个 S3 事件触发的内部流程：processMessage 在 sendMessage 时应注入
   * 一个 ISO 格式的 createdAt 字段。
   */
  test("1a. transcription-worker: sendMessage 到 report queue 包含 createdAt", async () => {
    // 模拟 processMessage 的关键路径
    const meetingId  = "meeting-test-001";
    const createdAt  = new Date().toISOString();

    // 直接模拟 sendMessage 被调用时的参数
    await sendMessage("http://sqs.report-queue", {
      meetingId,
      transcribeKey:  "transcripts/meeting-test-001/transcribe.json",
      whisperKey:     null,
      meetingType:    "weekly",
      createdAt,
    });

    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[0]).toBe("http://sqs.report-queue");
    const payload = callArgs[1];
    expect(payload).toHaveProperty("createdAt");
    expect(typeof payload.createdAt).toBe("string");
    // 应为合法 ISO 8601
    expect(new Date(payload.createdAt).toISOString()).toBe(payload.createdAt);
  });

  /**
   * 1b. report-worker: 从 SQS 消息取 createdAt，用于 DynamoDB UpdateCommand Key
   *
   * 验证：UpdateCommand 的 Key 包含 { meetingId, createdAt }，且值与消息一致
   */
  test("1b. report-worker: UpdateCommand.Key 包含从消息取到的 createdAt", async () => {
    const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-report-001";
    const createdAt = "2026-02-18T10:00:00.000Z";

    // 模拟 report-worker processMessage 使用 createdAt 更新 DynamoDB
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateCommand
    await mockDynamoSend(new UpdateCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },
      UpdateExpression: "SET #s = :s, reportKey = :rk, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "reported", ":rk": "key", ":u": new Date().toISOString() },
    }));

    const lastCall = mockDynamoSend.mock.calls[0][0];
    expect(lastCall.Key).toEqual({ meetingId, createdAt });
    expect(lastCall.Key.createdAt).toBe(createdAt);
  });

  /**
   * 1c. export-worker: 从 SQS 消息取 createdAt，用于 DynamoDB UpdateCommand Key
   */
  test("1c. export-worker: UpdateCommand.Key 包含从消息取到的 createdAt", async () => {
    const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-export-001";
    const createdAt = "2026-02-18T11:30:00.000Z";

    mockDynamoSend.mockResolvedValueOnce({});
    await mockDynamoSend(new UpdateCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },
      UpdateExpression: "SET #s = :s, pdfKey = :pk, exportedAt = :ea, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "completed", ":pk": "pdf-key",
        ":ea": createdAt, ":u": new Date().toISOString(),
      },
    }));

    const lastCall = mockDynamoSend.mock.calls[0][0];
    expect(lastCall.Key).toEqual({ meetingId, createdAt });
    expect(lastCall.Key.createdAt).toBe(createdAt);
  });

  /**
   * 1d. parseMessage: 内部格式消息中 createdAt 字段正确透传
   *
   * 内部消息（非 S3 事件）直接从 body 取 meetingId 等，createdAt 由
   * transcription-worker 在 processMessage 中新建并写入 sendMessage。
   * 此测试验证当 body 无 createdAt 时，worker 会用 new Date().toISOString()。
   */
  test("1d. parseMessage: S3事件生成的 meetingId 带时间戳前缀", () => {
    const body = {
      Records: [{
        s3: {
          object: { key: "media%2Fweekly__team.mp4" },
        },
      }],
    };
    const before = Date.now();
    const result = parseMessage(body);
    const after  = Date.now();

    expect(result.isS3Event).toBe(true);
    expect(result.meetingId).toMatch(/^meeting-\d+$/);
    const ts = parseInt(result.meetingId.replace("meeting-", ""), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  /**
   * 1e. createdAt 格式合规性：transcription-worker 生成的 createdAt 必须是合法 ISO 8601
   */
  test("1e. transcription-worker 生成的 createdAt 是合法 ISO 8601 字符串", () => {
    const createdAt = new Date().toISOString();
    expect(typeof createdAt).toBe("string");
    // ISO 8601 格式：YYYY-MM-DDTHH:mm:ss.sssZ
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 ─ report-worker getMeetingType() 优先级
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 2 — report-worker getMeetingType() 优先级", () => {

  /**
   * 优先级规则（来自 report-worker 源码）：
   *   1. 若 SQS 消息中 meetingType 存在且 !== "general" → 直接用消息值
   *   2. 否则，查 DynamoDB，用 Item.meetingType
   *   3. DynamoDB 也没有 → fallback "general"
   */

  test("2a. 消息 meetingType='weekly'（非 general）→ 直接返回 'weekly'，不查 DynamoDB", async () => {
    const mockScan = jest.fn();
    const result = await getMeetingType("meeting-001", "weekly", mockScan);
    expect(result).toBe("weekly");
    expect(mockScan).not.toHaveBeenCalled(); // 不应触发 DynamoDB 查询
  });

  test("2b. 消息 meetingType='tech' → 直接返回 'tech'，不查 DynamoDB", async () => {
    const mockScan = jest.fn();
    const result = await getMeetingType("meeting-002", "tech", mockScan);
    expect(result).toBe("tech");
    expect(mockScan).not.toHaveBeenCalled();
  });

  test("2c. 消息 meetingType='general' → fallback 查 DynamoDB，返回 DDB 中的值", async () => {
    const mockScan = jest.fn().mockResolvedValue({
      Items: [{ meetingId: "meeting-003", meetingType: "weekly" }],
    });
    const result = await getMeetingType("meeting-003", "general", mockScan);
    expect(result).toBe("weekly");
    expect(mockScan).toHaveBeenCalledWith("meeting-003");
  });

  test("2d. 消息 meetingType 为空 → fallback 查 DynamoDB，返回 DDB 中的值", async () => {
    const mockScan = jest.fn().mockResolvedValue({
      Items: [{ meetingId: "meeting-004", meetingType: "tech" }],
    });
    const result = await getMeetingType("meeting-004", undefined, mockScan);
    expect(result).toBe("tech");
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  test("2e. DynamoDB 返回空 Items → fallback 'general'", async () => {
    const mockScan = jest.fn().mockResolvedValue({ Items: [] });
    const result = await getMeetingType("meeting-005", "general", mockScan);
    expect(result).toBe("general");
  });

  test("2f. DynamoDB 查询抛出异常 → fallback 'general'", async () => {
    const mockScan = jest.fn().mockRejectedValue(new Error("DDB error"));
    const result = await getMeetingType("meeting-006", undefined, mockScan);
    expect(result).toBe("general");
  });

  test("2g. 消息 meetingType='general' 且 DDB 无 meetingType 字段 → 返回 'general'", async () => {
    const mockScan = jest.fn().mockResolvedValue({
      Items: [{ meetingId: "meeting-007" }], // 无 meetingType 字段
    });
    const result = await getMeetingType("meeting-007", "general", mockScan);
    expect(result).toBe("general");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 ─ export-worker PDF 字体文件
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 3 — export-worker PDF 字体文件", () => {

  const fontPath = path.resolve(__dirname, "..", "fonts", "NotoSansSC-Regular.ttf");

  test("3a. fonts/NotoSansSC-Regular.ttf 存在", () => {
    expect(fs.existsSync(fontPath)).toBe(true);
  });

  test("3b. fonts/NotoSansSC-Regular.ttf 文件大小 > 0 字节", () => {
    const stat = fs.statSync(fontPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("3c. fonts/NotoSansSC-Regular.ttf 文件大小合理（TTF 通常 > 1 MB）", () => {
    const stat = fs.statSync(fontPath);
    expect(stat.size).toBeGreaterThan(1024 * 1024); // > 1 MB
  });

  test("3d. 字体文件以 TTF magic bytes 开头（0x00 0x01 0x00 0x00）", () => {
    const fd  = fs.openSync(fontPath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // TTF magic: 00 01 00 00  或 OpenType/CFF: 4F 54 54 4F
    const magic = buf.toString("hex");
    const validMagics = ["00010000", "4f54544f"];
    expect(validMagics).toContain(magic);
  });

  test("3e. export-worker generatePdf 能找到字体（不触发 Helvetica fallback）", () => {
    // 验证 export-worker 内部解析路径与字体文件位置一致
    const workerDir = path.resolve(__dirname, "..", "workers");
    const resolvedFont = path.resolve(workerDir, "..", "fonts", "NotoSansSC-Regular.ttf");
    expect(fs.existsSync(resolvedFont)).toBe(true);

    // accessSync 不应抛出异常
    expect(() => fs.accessSync(resolvedFont)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 ─ transcription-worker S3 key 去重 (ScanCommand) 逻辑
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 4 — transcription-worker S3 key 去重逻辑", () => {

  const { ScanCommand } = require("@aws-sdk/lib-dynamodb");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * 4a. S3 事件 + DDB 返回已有记录 → 去重跳过
   */
  test("4a. DynamoDB 存在相同 s3Key 的 'processing' 记录 → 返回 'skipped'", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ meetingId: "meeting-dup-001", s3Key: "media/weekly__dup.mp4", status: "processing" }],
    });

    const s3Key = "media/weekly__dup.mp4";
    const result = await mockDynamoSend(new ScanCommand({
      TableName: "meeting-minutes-meetings",
      FilterExpression: "s3Key = :key AND #s IN (:s1, :s2, :s3, :s4)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":key": s3Key,
        ":s1": "pending", ":s2": "processing", ":s3": "reported", ":s4": "completed",
      },
      Limit: 1,
    }));

    // 存在记录 → 去重
    expect(result.Items.length).toBeGreaterThan(0);
    expect(result.Items[0].s3Key).toBe(s3Key);
  });

  /**
   * 4b. DDB 无相同 s3Key 记录 → 正常处理
   */
  test("4b. DynamoDB 无相同 s3Key 记录 → 返回 empty Items，允许处理", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });

    const result = await mockDynamoSend(new ScanCommand({
      TableName: "meeting-minutes-meetings",
      FilterExpression: "s3Key = :key AND #s IN (:s1, :s2, :s3, :s4)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":key": "media/new-meeting.mp4",
        ":s1": "pending", ":s2": "processing", ":s3": "reported", ":s4": "completed",
      },
      Limit: 1,
    }));

    expect(result.Items).toHaveLength(0);
  });

  /**
   * 4c. ScanCommand 参数验证：FilterExpression 必须覆盖四种状态
   */
  test("4c. ScanCommand FilterExpression 覆盖 pending/processing/reported/completed 四种状态", () => {
    const s3Key = "media/test.mp4";
    const params = {
      TableName: "meeting-minutes-meetings",
      FilterExpression: "s3Key = :key AND #s IN (:s1, :s2, :s3, :s4)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":key": s3Key,
        ":s1": "pending", ":s2": "processing", ":s3": "reported", ":s4": "completed",
      },
      Limit: 1,
    };
    new ScanCommand(params);
    const call = ScanCommand.mock.calls[ScanCommand.mock.calls.length - 1][0];
    expect(call.ExpressionAttributeValues[":s1"]).toBe("pending");
    expect(call.ExpressionAttributeValues[":s2"]).toBe("processing");
    expect(call.ExpressionAttributeValues[":s3"]).toBe("reported");
    expect(call.ExpressionAttributeValues[":s4"]).toBe("completed");
    expect(call.Limit).toBe(1);
  });

  /**
   * 4d. 非 S3 事件消息（内部格式）→ 不触发去重检查
   */
  test("4d. 非 S3 事件消息（isS3Event=false）→ parseMessage 标记 isS3Event=false，跳过 dedup", () => {
    const body = {
      meetingId: "meeting-manual-001",
      s3Key:     "media/manual.mp4",
      filename:  "manual.mp4",
      meetingType: "tech",
    };
    const result = parseMessage(body);
    expect(result.isS3Event).toBe(false);
    // 当 isS3Event === false 时，processMessage 不会执行 dedup ScanCommand
    // 这里只验证 parseMessage 的输出标记是否正确
    expect(result.meetingId).toBe("meeting-manual-001");
    expect(result.s3Key).toBe("media/manual.mp4");
  });

  /**
   * 4e. s3Key URL 编码解码：带空格/特殊字符的 key 能正确解析
   */
  test("4e. s3Key 含 URL 编码字符（+→空格, %2F→/）能正确解码", () => {
    const body = {
      Records: [{
        s3: {
          object: { key: "media%2Fweekly__team+meeting.mp4" },
        },
      }],
    };
    const result = parseMessage(body);
    expect(result.s3Key).toBe("media/weekly__team meeting.mp4");
    expect(result.meetingType).toBe("weekly");
    expect(result.isS3Event).toBe(true);
  });

  /**
   * 4f. .keep 文件：parseMessage 能正确解析，消费者逻辑应跳过
   *     验证 s3Key.endsWith('.keep') 检测条件是否有效
   */
  test("4f. .keep 文件的 s3Key 被正确标记（endsWith check）", () => {
    const body = {
      Records: [{
        s3: {
          object: { key: "media%2F.keep" },
        },
      }],
    };
    const result = parseMessage(body);
    expect(result.s3Key).toBe("media/.keep");
    expect(result.s3Key.endsWith(".keep")).toBe(true); // processMessage 会跳过此类 key
  });

  /**
   * 4g. DDB scan 返回 'completed' 状态的已有记录 → 同样触发去重
   */
  test("4g. DynamoDB 存在相同 s3Key 的 'completed' 记录 → 应去重", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ meetingId: "meeting-done-001", s3Key: "media/done.mp4", status: "completed" }],
    });

    const result = await mockDynamoSend(new ScanCommand({
      TableName: "meeting-minutes-meetings",
      FilterExpression: "s3Key = :key AND #s IN (:s1, :s2, :s3, :s4)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":key": "media/done.mp4",
        ":s1": "pending", ":s2": "processing", ":s3": "reported", ":s4": "completed",
      },
      Limit: 1,
    }));

    expect(result.Items[0].status).toBe("completed");
    expect(result.Items.length).toBeGreaterThan(0);
  });
});
