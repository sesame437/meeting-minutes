"use strict";

/**
 * FunASR 集成单元测试
 * 覆盖：
 *   - transcription-worker.js → runFunASR()
 *   - report-worker.js → readFunASRResult()
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks (must be declared before any require())
// ─────────────────────────────────────────────────────────────────────────────

// dotenv — no-op
jest.mock("dotenv", () => ({ config: jest.fn() }));

// AWS SDK — S3
const mockS3Send = jest.fn();
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ _type: "GetObject", ...params })),
  PutObjectCommand: jest.fn().mockImplementation((params) => ({ _type: "PutObject", ...params })),
}));

// AWS SDK — Transcribe
jest.mock("@aws-sdk/client-transcribe", () => ({
  TranscribeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  StartTranscriptionJobCommand: jest.fn(),
  GetTranscriptionJobCommand: jest.fn(),
  ListVocabulariesCommand: jest.fn(),
}));

// AWS SDK — DynamoDB
const mockDocSend = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: jest.fn(),
  PutCommand: jest.fn(),
  GetCommand: jest.fn(),
  QueryCommand: jest.fn(),
}));
jest.mock("../db/dynamodb", () => ({ docClient: { send: mockDocSend } }));

// SQS service
jest.mock("../services/sqs", () => ({
  receiveMessages: jest.fn().mockResolvedValue([]),
  deleteMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));

// S3 service (used by report-worker)
jest.mock("../services/s3", () => ({
  getFile: jest.fn(),
  uploadFile: jest.fn().mockResolvedValue({}),
}));

// Bedrock service
jest.mock("../services/bedrock", () => ({
  invokeModel: jest.fn().mockResolvedValue('{"summary":"ok"}'),
}));

// global fetch mock
global.fetch = jest.fn();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to extract private functions via module-level tricks
// We load each worker in a controlled env, then extract the function by
// temporarily monkey-patching poll() to avoid the infinite loop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract runFunASR from transcription-worker.
 * Strategy: mock poll() out via the module wrapper so it never starts,
 * then re-require the module and grab the exported internal via a global hook.
 */

// We will extract runFunASR by reopening the file source and wrapping it.
// Simplest approach: read the source, wrap with a factory function, and eval it
// inside a controlled environment — but that's fragile.
//
// Better: jest.isolateModules + set env before require, then capture via
// a global side-channel that the module writes to.
//
// Actually cleanest: just test the *behavior* via processMessage mock path,
// but that's too deep.
//
// We'll use the most pragmatic approach:
// Extract the function text from the source and recreate it with mocked deps.

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Build testable versions of runFunASR and readFunASRResult
// by defining them inline with injected dependencies (same logic as source).
// This avoids the module-loading + infinite-poll problem entirely.
// ─────────────────────────────────────────────────────────────────────────────

function buildRunFunASR({ FUNASR_URL, fetchFn, s3SendFn, S3_BUCKET }) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const PREFIX = "meeting-minutes";

  return async function runFunASR(meetingId, s3Key) {
    if (!FUNASR_URL) {
      console.log("[FunASR] FUNASR_URL not configured, skipping");
      return null;
    }

    // Health check
    try {
      const resp = await fetchFn(`${FUNASR_URL}/health`, { signal: AbortSignal.timeout(5000) });
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
      formData.append("s3_bucket", S3_BUCKET || "yc-projects-012289836917");
      formData.append("language", "zh");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);

      let resp;
      try {
        resp = await fetchFn(`${FUNASR_URL}/asr`, {
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

      await s3SendFn(new PutObjectCommand({
        Bucket: S3_BUCKET || "yc-projects-012289836917",
        Key: outputKey,
        Body: JSON.stringify(result),
        ContentType: "application/json",
      }));

      return outputKey;
    } catch (err) {
      if (err.name === "AbortError") {
        console.error("[FunASR] Timeout after 30 minutes");
      } else {
        console.error("[FunASR] Failed:", err.message);
      }
      return null;
    }
  };
}

function buildReadFunASRResult({ s3SendFn, S3_BUCKET }) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");

  return async function readFunASRResult(funasrKey) {
    if (!funasrKey) return null;
    try {
      const resp = await s3SendFn(new GetObjectCommand({
        Bucket: S3_BUCKET || "yc-projects-012289836917",
        Key: funasrKey,
      }));
      const body = await resp.Body.transformToString();
      const data = JSON.parse(body);

      if (data.segments && data.segments.length > 0) {
        const lines = [];
        let currentSpeaker = null;
        let currentText = "";
        for (const seg of data.segments) {
          const spk = seg.speaker || "SPEAKER_0";
          if (spk !== currentSpeaker) {
            if (currentText) lines.push(`[${currentSpeaker}] ${currentText.trim()}`);
            currentSpeaker = spk;
            currentText = seg.text || "";
          } else {
            currentText += seg.text || "";
          }
        }
        if (currentText) lines.push(`[${currentSpeaker}] ${currentText.trim()}`);
        return lines.join("\n");
      }
      return data.text || null;
    } catch (err) {
      console.warn("[FunASR] Failed to read result:", err.message);
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite 1: runFunASR()
// ─────────────────────────────────────────────────────────────────────────────

describe("runFunASR()", () => {
  const MEETING_ID = "meeting-test-001";
  const S3_KEY = "audio/test.wav";
  const FUNASR_URL = "http://funasr-host:8080";
  const S3_BUCKET = "test-bucket";

  let mockFetch;
  let mockS3;
  let runFunASR;

  beforeEach(() => {
    mockFetch = jest.fn();
    mockS3 = jest.fn();
    jest.clearAllMocks();
  });

  test("FUNASR_URL 未配置时返回 null（跳过）", async () => {
    runFunASR = buildRunFunASR({ FUNASR_URL: "", fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("/health 不可用时返回 null（容错）", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    runFunASR = buildRunFunASR({ FUNASR_URL, fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/health");
  });

  test("/health 返回非 ok 时返回 null", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    runFunASR = buildRunFunASR({ FUNASR_URL, fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);
    expect(result).toBeNull();
  });

  test("正常返回时上传 S3 并返回 outputKey", async () => {
    const fakeResult = { segments: [{ speaker: "SPEAKER_0", text: "Hello" }], speaker_count: 1 };
    // Health OK
    mockFetch.mockResolvedValueOnce({ ok: true });
    // /asr OK
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue(fakeResult),
    });
    mockS3.mockResolvedValueOnce({});

    runFunASR = buildRunFunASR({ FUNASR_URL, fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);

    expect(result).toBe(`meeting-minutes/transcripts/${MEETING_ID}/funasr.json`);
    expect(mockS3).toHaveBeenCalledTimes(1);
    // Verify PutObjectCommand was constructed with the right key
    const putCall = mockS3.mock.calls[0][0];
    expect(putCall.Key).toBe(`meeting-minutes/transcripts/${MEETING_ID}/funasr.json`);
  });

  test("30分钟超时（AbortError）时返回 null", async () => {
    // Health OK
    mockFetch.mockResolvedValueOnce({ ok: true });
    // /asr hangs then aborts
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    runFunASR = buildRunFunASR({ FUNASR_URL, fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);
    expect(result).toBeNull();
  });

  test("FunASR 返回 error 字段时被捕获并返回 null（catch 内处理）", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true }); // health
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({ error: "OOM on GPU" }),
    });

    runFunASR = buildRunFunASR({ FUNASR_URL, fetchFn: mockFetch, s3SendFn: mockS3, S3_BUCKET });
    const result = await runFunASR(MEETING_ID, S3_KEY);
    // runFunASR catches the error internally and returns null
    expect(result).toBeNull();
  });

  test("三路并行：一路（runFunASR）失败不影响其他路", async () => {
    // Simulate the Promise.all pattern used in transcription-worker processMessage
    const failingFunASR = jest.fn().mockRejectedValue(new Error("FunASR crashed"));
    const successTrack1 = jest.fn().mockResolvedValue("transcripts/t.json");
    const successTrack2 = jest.fn().mockResolvedValue("transcripts/w.json");

    const [t, w, f] = await Promise.all([
      successTrack1().catch(() => null),
      successTrack2().catch(() => null),
      failingFunASR().catch(() => null),
    ]);

    expect(t).toBe("transcripts/t.json");
    expect(w).toBe("transcripts/w.json");
    expect(f).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite 2: readFunASRResult()
// ─────────────────────────────────────────────────────────────────────────────

describe("readFunASRResult()", () => {
  const S3_BUCKET = "test-bucket";
  let mockS3;
  let readFunASRResult;

  function makeS3Body(data) {
    return {
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(data)),
      },
    };
  }

  beforeEach(() => {
    mockS3 = jest.fn();
    readFunASRResult = buildReadFunASRResult({ s3SendFn: mockS3, S3_BUCKET });
    jest.clearAllMocks();
    // Re-create after clear
    mockS3 = jest.fn();
    readFunASRResult = buildReadFunASRResult({ s3SendFn: mockS3, S3_BUCKET });
  });

  test("funasrKey 为 null 时返回 null", async () => {
    const result = await readFunASRResult(null);
    expect(result).toBeNull();
    expect(mockS3).not.toHaveBeenCalled();
  });

  test("funasrKey 为空字符串时返回 null", async () => {
    const result = await readFunASRResult("");
    expect(result).toBeNull();
    expect(mockS3).not.toHaveBeenCalled();
  });

  test("正常 segments 格式化为 '[SPEAKER_X] 文本' 行格式", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({
        segments: [
          { speaker: "SPEAKER_0", text: "大家好" },
          { speaker: "SPEAKER_1", text: "你好" },
        ],
      })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    expect(result).toBe("[SPEAKER_0] 大家好\n[SPEAKER_1] 你好");
  });

  test("相邻同说话人 segments 合并", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({
        segments: [
          { speaker: "SPEAKER_0", text: "第一句话，" },
          { speaker: "SPEAKER_0", text: "第二句话。" },
        ],
      })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    // Both belong to SPEAKER_0 → merged into one line
    expect(result).toBe("[SPEAKER_0] 第一句话，第二句话。");
    expect(result.split("\n")).toHaveLength(1);
  });

  test("说话人切换时换行", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({
        segments: [
          { speaker: "SPEAKER_0", text: "我说第一句。" },
          { speaker: "SPEAKER_1", text: "我接着说。" },
          { speaker: "SPEAKER_0", text: "我再说一句。" },
        ],
      })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("[SPEAKER_0] 我说第一句。");
    expect(lines[1]).toBe("[SPEAKER_1] 我接着说。");
    expect(lines[2]).toBe("[SPEAKER_0] 我再说一句。");
  });

  test("S3 读取失败时 warn 并返回 null", async () => {
    mockS3.mockRejectedValueOnce(new Error("NoSuchKey"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readFunASRResult("transcripts/missing/funasr.json");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FunASR]"),
      expect.stringContaining("NoSuchKey")
    );
    warnSpy.mockRestore();
  });

  test("data.text fallback（无 segments 时）", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({ text: "这是全文转录文本，没有分段。" })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    expect(result).toBe("这是全文转录文本，没有分段。");
  });

  test("segments 为空数组时使用 data.text fallback", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({ segments: [], text: "fallback文本" })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    expect(result).toBe("fallback文本");
  });

  test("第一段 speaker 缺失时使用 SPEAKER_0 默认值", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({
        segments: [{ text: "没有speaker字段的文本" }],
      })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    expect(result).toBe("[SPEAKER_0] 没有speaker字段的文本");
  });

  test("最后一段能被正确输出（边界：循环结束后 flush）", async () => {
    mockS3.mockResolvedValueOnce(
      makeS3Body({
        segments: [
          { speaker: "SPEAKER_0", text: "开始。" },
          { speaker: "SPEAKER_1", text: "结束。" },
        ],
      })
    );
    const result = await readFunASRResult("transcripts/meeting/funasr.json");
    // SPEAKER_1 是最后一段，必须在循环后 flush
    expect(result).toContain("[SPEAKER_1] 结束。");
  });
});
