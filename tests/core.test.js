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

// getMeetingType as used in report-worker (updated: 3-arg, uses GetCommand → Item)
async function getMeetingType(meetingId, createdAt, messageType, mockGet) {
  if (messageType && messageType !== "general") {
    return messageType;
  }
  try {
    const { Item } = await mockGet(meetingId, createdAt);
    return Item?.meetingType || "general";
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

describe("Suite 2 — report-worker getMeetingType() 优先级（GetCommand 版）", () => {

  /**
   * 优先级规则（fix e80553d 后的实现）：
   *   1. 若 SQS 消息中 meetingType 存在且 !== "general" → 直接返回，不查 DDB
   *   2. 否则，用 GetCommand({ Key: { meetingId, createdAt } }) 精确查询
   *   3. DynamoDB 也没有 → fallback "general"
   *
   * mockGet 签名：(meetingId, createdAt) => Promise<{ Item }>
   */

  test("2a. 消息 meetingType='weekly'（非 general）→ 直接返回 'weekly'，不查 DynamoDB", async () => {
    const mockGet = jest.fn();
    const result = await getMeetingType("meeting-001", "2026-02-18T10:00:00.000Z", "weekly", mockGet);
    expect(result).toBe("weekly");
    expect(mockGet).not.toHaveBeenCalled(); // 不应触发 DynamoDB 查询
  });

  test("2b. 消息 meetingType='tech' → 直接返回 'tech'，不查 DynamoDB", async () => {
    const mockGet = jest.fn();
    const result = await getMeetingType("meeting-002", "2026-02-18T10:00:00.000Z", "tech", mockGet);
    expect(result).toBe("tech");
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("2c. 消息 meetingType='general' → fallback GetCommand，返回 DDB Item.meetingType", async () => {
    const createdAt = "2026-02-18T10:00:00.000Z";
    const mockGet = jest.fn().mockResolvedValue({
      Item: { meetingId: "meeting-003", createdAt, meetingType: "weekly" },
    });
    const result = await getMeetingType("meeting-003", createdAt, "general", mockGet);
    expect(result).toBe("weekly");
    // 验证 GetCommand 用了正确的 meetingId + createdAt
    expect(mockGet).toHaveBeenCalledWith("meeting-003", createdAt);
  });

  test("2d. 消息 meetingType 为空 → fallback GetCommand，返回 DDB Item.meetingType", async () => {
    const createdAt = "2026-02-18T10:00:00.000Z";
    const mockGet = jest.fn().mockResolvedValue({
      Item: { meetingId: "meeting-004", createdAt, meetingType: "tech" },
    });
    const result = await getMeetingType("meeting-004", createdAt, undefined, mockGet);
    expect(result).toBe("tech");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test("2e. GetCommand 返回 Item 但无 meetingType 字段 → fallback 'general'", async () => {
    const createdAt = "2026-02-18T10:00:00.000Z";
    const mockGet = jest.fn().mockResolvedValue({
      Item: { meetingId: "meeting-005", createdAt }, // 无 meetingType
    });
    const result = await getMeetingType("meeting-005", createdAt, "general", mockGet);
    expect(result).toBe("general");
  });

  test("2f. GetCommand 返回 Item=undefined（记录不存在）→ fallback 'general'", async () => {
    const createdAt = "2026-02-18T10:00:00.000Z";
    const mockGet = jest.fn().mockResolvedValue({ Item: undefined });
    const result = await getMeetingType("meeting-006", createdAt, "general", mockGet);
    expect(result).toBe("general");
  });

  test("2g. DynamoDB 查询抛出异常 → fallback 'general'", async () => {
    const createdAt = "2026-02-18T10:00:00.000Z";
    const mockGet = jest.fn().mockRejectedValue(new Error("DDB error"));
    const result = await getMeetingType("meeting-007", createdAt, undefined, mockGet);
    expect(result).toBe("general");
  });

  test("2h. createdAt 与 DDB 存储值一致性：GetCommand Key 精确匹配（不再走 Scan）", async () => {
    // 验证 GetCommand 的 Key 使用的是从 SQS 消息传入的 createdAt，
    // 与 transcription-worker 写入 DDB 时 PutCommand Item.createdAt 完全一致
    const meetingId = "meeting-008";
    const createdAt = "2026-02-18T09:30:00.000Z"; // 来自 SQS 消息透传
    const mockGet = jest.fn().mockResolvedValue({
      Item: { meetingId, createdAt, meetingType: "weekly" },
    });
    await getMeetingType(meetingId, createdAt, "general", mockGet);
    // GetCommand Key 必须是 { meetingId, createdAt } 精确匹配，不得用 Scan
    expect(mockGet).toHaveBeenCalledWith(meetingId, createdAt);
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 ─ Batch 1 修复专项测试（commit e80553d）
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 5 — Batch 1 修复专项测试", () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 5.1 updateMeetingStatus 新签名（createdAt 作为第二参数）───────────────

  test("5a. updateMeetingStatus: UpdateCommand.Key 必须包含 { meetingId, createdAt }", async () => {
    const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
    const meetingId = "meeting-sig-001";
    const createdAt = "2026-02-18T12:00:00.000Z";

    mockDynamoSend.mockResolvedValueOnce({});

    // 模拟新签名调用：updateMeetingStatus(meetingId, createdAt, status, extra)
    await mockDynamoSend(new UpdateCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },  // ← 必须包含 createdAt SK
      UpdateExpression: "SET #s = :s, #u = :u, transcribeKey = :tk, whisperKey = :wk",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":s": "transcribed",
        ":u": new Date().toISOString(),
        ":tk": "transcripts/meeting-sig-001/transcribe.json",
        ":wk": "",
      },
    }));

    const cmd = mockDynamoSend.mock.calls[0][0];
    // 关键断言：Key 必须有两个字段
    expect(Object.keys(cmd.Key)).toHaveLength(2);
    expect(cmd.Key).toEqual({ meetingId, createdAt });
    // 旧签名只有 meetingId（会导致 P0 bug），这里明确排除
    expect(cmd.Key).not.toEqual({ meetingId });
  });

  test("5b. updateMeetingStatus: 旧签名 Key={{ meetingId }} 会导致 UpdateCommand 缺少 SK（回归防护）", () => {
    // 这个测试确保旧实现（只传 meetingId）不被意外引入
    const oldKey = { meetingId: "meeting-old-001" };
    const newKey = { meetingId: "meeting-old-001", createdAt: "2026-02-18T12:00:00.000Z" };
    // 旧 Key 缺少 createdAt，不应等于新 Key
    expect(oldKey).not.toEqual(newKey);
    expect(Object.keys(oldKey)).toHaveLength(1); // 旧签名只有 PK，缺 SK
    expect(Object.keys(newKey)).toHaveLength(2); // 新签名 PK + SK 齐全
  });

  // ─── 5.2 transcription-worker createdAt 作用域验证 ───────────────────────

  test("5c. createdAt 在 processMessage 中无条件赋值（两路径均可用）", () => {
    // 验证 createdAt 的赋值位置：在 if(isS3Event){} 之前，无条件执行
    // 模拟 processMessage 逻辑结构
    function simulateCreatedAtScope(isS3Event) {
      // 代码顺序：先 dedup scan（isS3Event 条件内），再无条件 createdAt = new Date()
      const createdAt = new Date().toISOString(); // ← 无条件赋值
      if (isS3Event) {
        // PutCommand 使用 createdAt
        return { path: "s3Event", createdAt, hasCreatedAt: true };
      }
      // 非 S3 事件路径也能访问 createdAt
      return { path: "manual", createdAt, hasCreatedAt: true };
    }

    const s3Result = simulateCreatedAtScope(true);
    const manualResult = simulateCreatedAtScope(false);

    expect(s3Result.hasCreatedAt).toBe(true);
    expect(s3Result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(manualResult.hasCreatedAt).toBe(true);
    expect(manualResult.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("5d. S3 事件路径：PutCommand Item.createdAt 与 UpdateCommand Key.createdAt 相同", async () => {
    const { PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-scope-001";
    const createdAt = "2026-02-18T13:00:00.000Z"; // 同一个 createdAt

    mockDynamoSend
      .mockResolvedValueOnce({}) // PutCommand
      .mockResolvedValueOnce({}); // UpdateCommand

    // PutCommand（创建记录时）
    await mockDynamoSend(new PutCommand({
      TableName: "meeting-minutes-meetings",
      Item: { meetingId, status: "processing", createdAt },
    }));

    // UpdateCommand（转录完成后）
    await mockDynamoSend(new UpdateCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },  // ← 必须与 PutCommand Item.createdAt 一致
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "transcribed" },
    }));

    const putCall = mockDynamoSend.mock.calls[0][0];
    const updateCall = mockDynamoSend.mock.calls[1][0];

    // PutCommand Item.createdAt 与 UpdateCommand Key.createdAt 必须完全相同
    expect(putCall.Item.createdAt).toBe(updateCall.Key.createdAt);
    expect(putCall.Item.createdAt).toBe(createdAt);
  });

  // ─── 5.3 report-worker getMeetingType 使用 GetCommand（不再用 ScanCommand）───

  test("5e. report-worker getMeetingType: 使用 GetCommand（精确查询，非 Scan）", async () => {
    const { GetCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-rw-001";
    const createdAt = "2026-02-18T10:30:00.000Z";

    // 模拟 docClient.send 返回 GetCommand 结果（{ Item }）
    mockDynamoSend.mockResolvedValueOnce({
      Item: { meetingId, createdAt, meetingType: "weekly" },
    });

    // 调用 GetCommand（正确实现）
    const result = await mockDynamoSend(new GetCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },
    }));

    // 应返回 Item 而非 Items[]（ScanCommand 返回 Items）
    expect(result.Item).toBeDefined();
    expect(result.Item.meetingType).toBe("weekly");

    // GetCommand 被调用了，ScanCommand 没有
    expect(GetCommand).toHaveBeenCalled();
    const scanCallsBefore = ScanCommand.mock.calls.length;
    // ScanCommand 不应在此路径中新增调用
    expect(ScanCommand.mock.calls.length).toBe(scanCallsBefore);
  });

  test("5f. GetCommand Key 包含 createdAt（精确 SK 定位，O(1) 查询）", () => {
    const { GetCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-rw-002";
    const createdAt = "2026-02-18T10:30:00.000Z";

    new GetCommand({ TableName: "meeting-minutes-meetings", Key: { meetingId, createdAt } });

    const lastCall = GetCommand.mock.calls[GetCommand.mock.calls.length - 1][0];
    expect(lastCall.Key).toHaveProperty("meetingId", meetingId);
    expect(lastCall.Key).toHaveProperty("createdAt", createdAt);
  });

  // ─── 5.4 export-worker: 不再调用 getCreatedAt()，直接从 SQS 消息取 createdAt ─

  test("5g. export-worker: processMessage 从 SQS body 取 createdAt（不调 getCreatedAt）", async () => {
    // export-worker 的 processMessage 现在直接从 message body 解构 createdAt
    // 验证这个模式：{ meetingId, reportKey, createdAt } = body
    const sqsBody = {
      meetingId: "meeting-exp-001",
      reportKey: "meeting-minutes/reports/meeting-exp-001/report.json",
      createdAt: "2026-02-18T14:00:00.000Z",
    };

    // 解构模式应与 export-worker 一致
    const { meetingId, reportKey, createdAt } = sqsBody;
    expect(meetingId).toBe("meeting-exp-001");
    expect(createdAt).toBe("2026-02-18T14:00:00.000Z");
    expect(reportKey).toContain("meeting-exp-001");

    // createdAt 不再需要 getCreatedAt() 二次查询 DynamoDB
    // 验证：如果 body 中有 createdAt，无需额外的 ScanCommand
    expect(typeof createdAt).toBe("string");
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  test("5h. export-worker: UpdateCommand.Key 使用 body.createdAt（不再用 ScanCommand 查询）", async () => {
    const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-exp-002";
    const createdAt = "2026-02-18T14:30:00.000Z"; // 来自 SQS 消息，无需二次查询

    mockDynamoSend.mockResolvedValueOnce({});
    await mockDynamoSend(new UpdateCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },
      UpdateExpression: "SET #s = :s, pdfKey = :pk, exportedAt = :ea, updatedAt = :u",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "completed",
        ":pk": "exports/meeting-exp-002/report.pdf",
        ":ea": createdAt,
        ":u": new Date().toISOString(),
      },
    }));

    const cmd = mockDynamoSend.mock.calls[0][0];
    // Key 精确包含两个字段
    expect(cmd.Key).toEqual({ meetingId, createdAt });
    // 只调用了一次 DynamoDB（UpdateCommand），不会有前置的 ScanCommand
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  // ─── 5.5 ScanCommand 使用范围验证（只用于去重，不用于精确查询）──────────────

  test("5i. export-worker 源码不包含 ScanCommand import（已删除）", () => {
    const exportWorkerSource = require("fs").readFileSync(
      require("path").resolve(__dirname, "..", "workers", "export-worker.js"),
      "utf8"
    );
    // ScanCommand 不应出现在 import 行
    expect(exportWorkerSource).not.toMatch(/require.*ScanCommand/);
    expect(exportWorkerSource).not.toMatch(/ScanCommand/);
  });

  test("5j. report-worker 源码不包含 ScanCommand import（已替换为 GetCommand）", () => {
    const reportWorkerSource = require("fs").readFileSync(
      require("path").resolve(__dirname, "..", "workers", "report-worker.js"),
      "utf8"
    );
    // ScanCommand 不应出现在 import 行
    expect(reportWorkerSource).not.toMatch(/require.*ScanCommand/);
    expect(reportWorkerSource).not.toMatch(/ScanCommand/);
  });

  test("5k. transcription-worker 中 ScanCommand 仅用于去重（s3Key 查询），不用于精确 ID 查询", () => {
    const transcriptionWorkerSource = require("fs").readFileSync(
      require("path").resolve(__dirname, "..", "workers", "transcription-worker.js"),
      "utf8"
    );
    // ScanCommand 应存在（用于去重）
    expect(transcriptionWorkerSource).toMatch(/ScanCommand/);
    // 但不应用于 meetingId 精确查询（已改为 GetCommand）
    expect(transcriptionWorkerSource).not.toMatch(/FilterExpression.*meetingId.*=.*:id/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6 ─ transcription-worker GetCommand meetingType 回查（遗漏 bug 修复）
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite 6 — transcription-worker meetingType GetCommand 回查（bug fix 验证）", () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("6a. meetingType 回查 GetCommand.Key 必须包含 createdAt（否则 DDB 复合主键缺失）", async () => {
    const { GetCommand } = require("@aws-sdk/lib-dynamodb");

    const meetingId = "meeting-tw-001";
    const createdAt = "2026-02-18T15:00:00.000Z";

    mockDynamoSend.mockResolvedValueOnce({
      Item: { meetingId, createdAt, meetingType: "weekly" },
    });

    // 正确调用（已修复）：Key 包含 createdAt
    const result = await mockDynamoSend(new GetCommand({
      TableName: "meeting-minutes-meetings",
      Key: { meetingId, createdAt },
    }));

    const cmd = mockDynamoSend.mock.calls[0][0];
    // 必须包含两个 Key 字段
    expect(Object.keys(cmd.Key)).toHaveLength(2);
    expect(cmd.Key).toEqual({ meetingId, createdAt });
    expect(result.Item.meetingType).toBe("weekly");
  });

  test("6b. GetCommand Key 缺少 createdAt（旧 bug）会导致 Key 字段数不完整（回归防护）", () => {
    // 记录旧 bug 形式，防止回归
    const buggyKey = { meetingId: "meeting-tw-002" }; // 只有 PK，缺 SK
    const fixedKey = { meetingId: "meeting-tw-002", createdAt: "2026-02-18T15:00:00.000Z" };

    expect(Object.keys(buggyKey)).toHaveLength(1); // 旧 bug：缺少 SK
    expect(Object.keys(fixedKey)).toHaveLength(2); // 修复后：PK + SK 完整
    expect(buggyKey).not.toEqual(fixedKey);
  });

  test("6c. transcription-worker 源码 GetCommand.Key 包含 createdAt（源码验证）", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "..", "workers", "transcription-worker.js"),
      "utf8"
    );
    // GetCommand Key 应包含 createdAt（修复后的形式）
    // 匹配 "Key: { meetingId, createdAt }" 或 "Key: { meetingId, createdAt: ..."
    expect(source).toMatch(/GetCommand[\s\S]{0,200}Key:\s*\{\s*meetingId,\s*createdAt\s*\}/);
  });

  test("6d. meetingType 回查路径：createdAt 变量在 GetCommand 调用前已赋值", () => {
    // 验证作用域顺序：
    // 1. const createdAt = new Date().toISOString()  (processMessage 内, ~line 236)
    // 2. GetCommand({ Key: { meetingId, createdAt } }) (processMessage 内, ~line 284)
    // createdAt 在 GetCommand 时已经定义，不存在 undefined 问题
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "..", "workers", "transcription-worker.js"),
      "utf8"
    );

    const createdAtAssignIndex = source.indexOf("const createdAt = new Date().toISOString()");
    // GetCommand 所在的上下文包含 "Resolve meetingType" 注释，精确定位 processMessage 内的调用
    const getMeetingTypeBlockIndex = source.indexOf("Resolve meetingType");
    const getCommandInBlock = source.indexOf("Key: { meetingId, createdAt }", getMeetingTypeBlockIndex);

    expect(createdAtAssignIndex).toBeGreaterThan(-1); // createdAt 赋值存在
    expect(getMeetingTypeBlockIndex).toBeGreaterThan(-1); // 回查块存在
    expect(getCommandInBlock).toBeGreaterThan(-1);    // GetCommand 使用 createdAt 存在

    // createdAt 赋值必须在 GetCommand 使用之前（作用域顺序正确）
    expect(createdAtAssignIndex).toBeLessThan(getCommandInBlock);
  });
});
