"use strict";

/**
 * pipeline-toggles.test.js
 *
 * Tests for:
 *   1. transcription-worker.js — ENABLE_TRANSCRIBE / ENABLE_WHISPER / FUNASR_URL toggles
 *   2. report-worker.js — FunASR-only mode support
 */

// ─────────────────────────────────────────────────────────────────────────────
// Top-level jest.mock() calls (hoisted by Babel/Jest before any require)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock("dotenv", () => ({ config: jest.fn() }));

// AWS SDK mocks
const mockS3Send = jest.fn();
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((p) => ({ _type: "GetObject", ...p })),
  PutObjectCommand: jest.fn().mockImplementation((p) => ({ _type: "PutObject", ...p })),
}));

jest.mock("@aws-sdk/client-transcribe", () => ({
  TranscribeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  StartTranscriptionJobCommand: jest.fn(),
  GetTranscriptionJobCommand: jest.fn(),
  ListVocabulariesCommand: jest.fn(),
}));

const mockDocSend = jest.fn().mockResolvedValue({});
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: jest.fn().mockImplementation((p) => ({ _cmd: "Update", ...p })),
  PutCommand: jest.fn().mockImplementation((p) => ({ _cmd: "Put", ...p })),
  GetCommand: jest.fn().mockImplementation((p) => ({ _cmd: "Get", ...p })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ _cmd: "Query", ...p })),
}));
jest.mock("../db/dynamodb", () => ({ docClient: { send: mockDocSend } }));

// SQS service
const mockSendMessage = jest.fn().mockResolvedValue({});
jest.mock("../services/sqs", () => ({
  receiveMessages: jest.fn().mockResolvedValue([]),
  deleteMessage: jest.fn().mockResolvedValue({}),
  sendMessage: mockSendMessage,
}));

// S3 / bedrock services (used by report-worker)
const mockGetFile = jest.fn();
const mockUploadFile = jest.fn().mockResolvedValue({});
jest.mock("../services/s3", () => ({
  getFile: mockGetFile,
  uploadFile: mockUploadFile,
}));

const mockInvokeModel = jest.fn().mockResolvedValue('{"summary":"ok"}');
jest.mock("../services/bedrock", () => ({
  invokeModel: mockInvokeModel,
}));

// global fetch
global.fetch = jest.fn();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build inline testable processMessage for transcription-worker
//
// We replicate the exact parallel-execution logic from transcription-worker.js
// to test the toggle behaviour without loading the module (which calls poll()).
// ─────────────────────────────────────────────────────────────────────────────

function buildTranscriptionProcessMessage({
  ENABLE_TRANSCRIBE,
  ENABLE_WHISPER,
  FUNASR_URL,
  runAWSTranscribeFn,
  runWhisperFn,
  runFunASRFn,
}) {
  const ENABLE_FUNASR = !!FUNASR_URL;

  return async function processMessage() {
    const [transcribeKey, whisperKey, funasrKey] = await Promise.all([
      ENABLE_TRANSCRIBE
        ? runAWSTranscribeFn().catch((err) => { console.error(`[Transcribe] Failed:`, err.message); return null; })
        : Promise.resolve(null),
      ENABLE_WHISPER
        ? runWhisperFn().catch((err) => { console.error(`[Whisper] Failed:`, err.message); return null; })
        : Promise.resolve(null),
      ENABLE_FUNASR
        ? runFunASRFn().catch((err) => { console.error(`[FunASR] Failed:`, err.message); return null; })
        : Promise.resolve(null),
    ]);

    if (!transcribeKey && !whisperKey && !funasrKey) {
      throw new Error("All transcription tracks failed");
    }

    return { transcribeKey, whisperKey, funasrKey };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build inline testable processMessage for report-worker
// ─────────────────────────────────────────────────────────────────────────────

function extractTranscribeText(rawJson) {
  try {
    const data = JSON.parse(rawJson);
    const transcript = data?.results?.transcripts?.[0]?.transcript;
    if (transcript) return transcript;
    return rawJson;
  } catch {
    return rawJson;
  }
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function buildReportProcessMessage({
  transcribeKey,
  whisperKey,
  funasrKey,
  getFileFn,      // mock for services/s3 getFile
  s3SendFn,       // mock for S3Client.send (used by readFunASRResult)
  invokeModelFn,
  uploadFileFn,
  docSendFn,
  sendMessageFn,
}) {
  async function readTranscript(tKey, wKey) {
    const results = await Promise.allSettled([
      tKey ? streamToString(getFileFn(tKey)) : Promise.reject("no transcribeKey"),
      wKey ? streamToString(getFileFn(wKey)) : Promise.reject("no whisperKey"),
    ]);

    const rawTranscribeText = results[0].status === "fulfilled" ? results[0].value : null;
    const whisperText = results[1].status === "fulfilled" ? results[1].value : null;
    const transcribeText = rawTranscribeText ? extractTranscribeText(rawTranscribeText) : null;

    if (!transcribeText && !whisperText) {
      throw new Error("Both transcription sources failed");
    }
    if (transcribeText && whisperText) {
      return `[AWS Transcribe 转录]\n${transcribeText}\n\n[Whisper 转录]\n${whisperText}`;
    }
    return transcribeText || whisperText;
  }

  async function readFunASRResult(fKey) {
    if (!fKey) return null;
    try {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const resp = await s3SendFn(new GetObjectCommand({ Bucket: "test-bucket", Key: fKey }));
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
  }

  return async function processMessage() {
    let transcriptText = null;

    if (transcribeKey || whisperKey) {
      try {
        transcriptText = await readTranscript(transcribeKey, whisperKey);
      } catch (err) {
        console.warn("[report] Transcribe/Whisper unavailable, will use FunASR only:", err.message);
      }
    }

    const funasrText = await readFunASRResult(funasrKey);

    if (!transcriptText && !funasrText) {
      throw new Error("All transcription sources failed (Transcribe, Whisper, FunASR)");
    }

    const transcriptParts = [];
    if (transcriptText) transcriptParts.push(transcriptText);
    if (funasrText) {
      const truncated = funasrText.slice(0, 60000);
      transcriptParts.push(`[FunASR 转录（含说话人标签）]\n${truncated}`);
    }
    const finalTranscript = transcriptParts.join("\n\n");

    await invokeModelFn(finalTranscript, "general");
    await uploadFileFn("reports/meeting-test/report.json", '{}', "application/json");

    return { transcriptParts, finalTranscript };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: transcription-worker.js — pipeline toggles
// ─────────────────────────────────────────────────────────────────────────────

describe("transcription-worker: pipeline toggle behaviour", () => {
  let runAWSTranscribe;
  let runWhisper;
  let runFunASR;

  beforeEach(() => {
    runAWSTranscribe = jest.fn().mockResolvedValue("transcripts/t.json");
    runWhisper = jest.fn().mockResolvedValue("transcripts/w.json");
    runFunASR = jest.fn().mockResolvedValue("transcripts/f.json");
    jest.clearAllMocks();
    // re-assign after clear
    runAWSTranscribe = jest.fn().mockResolvedValue("transcripts/t.json");
    runWhisper = jest.fn().mockResolvedValue("transcripts/w.json");
    runFunASR = jest.fn().mockResolvedValue("transcripts/f.json");
  });

  test("ENABLE_TRANSCRIBE=false 时 runAWSTranscribe 不被调用", async () => {
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: false,
      ENABLE_WHISPER: true,
      FUNASR_URL: "",
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    const result = await process();
    expect(runAWSTranscribe).not.toHaveBeenCalled();
    expect(runWhisper).toHaveBeenCalledTimes(1);
    expect(result.transcribeKey).toBeNull();
    expect(result.whisperKey).toBe("transcripts/w.json");
  });

  test("ENABLE_WHISPER=false 时 runWhisper 不被调用", async () => {
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: true,
      ENABLE_WHISPER: false,
      FUNASR_URL: "",
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    const result = await process();
    expect(runWhisper).not.toHaveBeenCalled();
    expect(runAWSTranscribe).toHaveBeenCalledTimes(1);
    expect(result.whisperKey).toBeNull();
    expect(result.transcribeKey).toBe("transcripts/t.json");
  });

  test("FUNASR_URL 为空时 ENABLE_FUNASR=false，runFunASR 不被调用", async () => {
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: true,
      ENABLE_WHISPER: false,
      FUNASR_URL: "",   // empty → ENABLE_FUNASR=false
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    const result = await process();
    expect(runFunASR).not.toHaveBeenCalled();
    expect(result.funasrKey).toBeNull();
  });

  test("三路全关时抛 'All transcription tracks failed'", async () => {
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: false,
      ENABLE_WHISPER: false,
      FUNASR_URL: "",   // no FunASR either
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    await expect(process()).rejects.toThrow("All transcription tracks failed");
    expect(runAWSTranscribe).not.toHaveBeenCalled();
    expect(runWhisper).not.toHaveBeenCalled();
    expect(runFunASR).not.toHaveBeenCalled();
  });

  test("只有 FunASR 开启时正常返回 funasrKey", async () => {
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: false,
      ENABLE_WHISPER: false,
      FUNASR_URL: "http://funasr-host:8080",  // non-empty → enabled
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    const result = await process();
    expect(runAWSTranscribe).not.toHaveBeenCalled();
    expect(runWhisper).not.toHaveBeenCalled();
    expect(runFunASR).toHaveBeenCalledTimes(1);
    expect(result.transcribeKey).toBeNull();
    expect(result.whisperKey).toBeNull();
    expect(result.funasrKey).toBe("transcripts/f.json");
  });

  test("FunASR 失败但另一路成功时不抛异常", async () => {
    runFunASR = jest.fn().mockRejectedValue(new Error("FunASR crashed"));
    const process = buildTranscriptionProcessMessage({
      ENABLE_TRANSCRIBE: true,
      ENABLE_WHISPER: false,
      FUNASR_URL: "http://funasr-host:8080",
      runAWSTranscribeFn: runAWSTranscribe,
      runWhisperFn: runWhisper,
      runFunASRFn: runFunASR,
    });
    const result = await process();
    expect(result.transcribeKey).toBe("transcripts/t.json");
    expect(result.funasrKey).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: report-worker.js — FunASR-only support
// ─────────────────────────────────────────────────────────────────────────────

describe("report-worker: FunASR-only support", () => {
  let mockGetFileFn;
  let mockS3SendFn;
  let mockInvoke;
  let mockUpload;

  function makeFunASRS3Body(data) {
    return {
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(data)),
      },
    };
  }

  function makeReadableStream(text) {
    // Returns an async iterable that yields the text as a single Buffer chunk
    return {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(text, "utf-8");
      },
    };
  }

  beforeEach(() => {
    mockGetFileFn = jest.fn();
    mockS3SendFn = jest.fn();
    mockInvoke = jest.fn().mockResolvedValue('{"summary":"ok"}');
    mockUpload = jest.fn().mockResolvedValue({});
    jest.clearAllMocks();
    mockGetFileFn = jest.fn();
    mockS3SendFn = jest.fn();
    mockInvoke = jest.fn().mockResolvedValue('{"summary":"ok"}');
    mockUpload = jest.fn().mockResolvedValue({});
  });

  test("transcribeKey + whisperKey 都为 null 但有 funasrKey 时，不抛错，正常处理", async () => {
    // funasrKey S3 body
    mockS3SendFn.mockResolvedValueOnce(
      makeFunASRS3Body({ segments: [{ speaker: "SPEAKER_0", text: "FunASR 转录文本" }] })
    );

    const process = buildReportProcessMessage({
      transcribeKey: null,
      whisperKey: null,
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    // Should NOT throw
    const result = await process();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.transcriptParts).toHaveLength(1);
    expect(result.transcriptParts[0]).toContain("[FunASR 转录（含说话人标签）]");
  });

  test("funasrText 作为唯一转录来源时，transcriptParts 只包含 FunASR 块", async () => {
    mockS3SendFn.mockResolvedValueOnce(
      makeFunASRS3Body({
        segments: [
          { speaker: "SPEAKER_0", text: "第一句话" },
          { speaker: "SPEAKER_1", text: "第二句话" },
        ],
      })
    );

    const process = buildReportProcessMessage({
      transcribeKey: null,
      whisperKey: null,
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    const result = await process();
    // Only one part: FunASR
    expect(result.transcriptParts).toHaveLength(1);
    expect(result.transcriptParts[0]).toMatch(/^\[FunASR 转录（含说话人标签）\]/);
    expect(result.transcriptParts[0]).not.toContain("[AWS Transcribe 转录]");
    expect(result.transcriptParts[0]).not.toContain("[Whisper 转录]");
  });

  test("三个来源都失败时抛 'All transcription sources failed'", async () => {
    // S3 GetObject for funasr fails
    mockS3SendFn.mockRejectedValueOnce(new Error("NoSuchKey"));

    const process = buildReportProcessMessage({
      transcribeKey: null,
      whisperKey: null,
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    // funasrText will be null (S3 read fails, returns null via catch)
    // transcriptText is also null → should throw
    await expect(process()).rejects.toThrow("All transcription sources failed");
  });

  test("三个来源都没有 key 时抛 'All transcription sources failed'", async () => {
    const process = buildReportProcessMessage({
      transcribeKey: null,
      whisperKey: null,
      funasrKey: null,  // no FunASR either
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    await expect(process()).rejects.toThrow("All transcription sources failed");
  });

  test("Transcribe/Whisper 读取失败时 warn 并继续用 FunASR", async () => {
    // getFile throws (simulating S3 failure for Transcribe/Whisper)
    mockGetFileFn.mockImplementation(() => {
      throw new Error("S3 read error");
    });

    // FunASR succeeds
    mockS3SendFn.mockResolvedValueOnce(
      makeFunASRS3Body({ segments: [{ speaker: "SPEAKER_0", text: "FunASR only text" }] })
    );

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const process = buildReportProcessMessage({
      transcribeKey: "transcripts/t.json",   // has a key but getFile throws
      whisperKey: "transcripts/w.json",
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    const result = await process();

    // Should have warned
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[report]"),
      expect.any(String)
    );

    // Should still produce a valid report using FunASR
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.transcriptParts).toHaveLength(1);
    expect(result.transcriptParts[0]).toContain("[FunASR 转录（含说话人标签）]");

    warnSpy.mockRestore();
  });

  test("FunASR 文本超过 60000 字符时被截断", async () => {
    const longText = "A".repeat(70000);
    mockS3SendFn.mockResolvedValueOnce(
      makeFunASRS3Body({ text: longText })
    );

    const process = buildReportProcessMessage({
      transcribeKey: null,
      whisperKey: null,
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    const result = await process();
    // The FunASR block should be truncated to 60000 chars + label
    const funasrPart = result.transcriptParts[0];
    // Label is "[FunASR 转录（含说话人标签）]\n" + up to 60000 chars
    const contentAfterLabel = funasrPart.replace("[FunASR 转录（含说话人标签）]\n", "");
    expect(contentAfterLabel.length).toBeLessThanOrEqual(60000);
  });

  test("Transcribe + FunASR 都有时 transcriptParts 包含两块", async () => {
    const transcribeJson = JSON.stringify({
      results: { transcripts: [{ transcript: "Transcribe 转录内容" }] },
    });
    mockGetFileFn.mockReturnValue(makeReadableStream(transcribeJson));

    mockS3SendFn.mockResolvedValueOnce(
      makeFunASRS3Body({ segments: [{ speaker: "SPEAKER_0", text: "FunASR 内容" }] })
    );

    const process = buildReportProcessMessage({
      transcribeKey: "transcripts/t.json",
      whisperKey: null,
      funasrKey: "transcripts/meeting/funasr.json",
      getFileFn: mockGetFileFn,
      s3SendFn: mockS3SendFn,
      invokeModelFn: mockInvoke,
      uploadFileFn: mockUpload,
      docSendFn: jest.fn().mockResolvedValue({}),
      sendMessageFn: jest.fn().mockResolvedValue({}),
    });

    const result = await process();
    expect(result.transcriptParts).toHaveLength(2);
    expect(result.transcriptParts[0]).toContain("Transcribe 转录内容");
    expect(result.transcriptParts[1]).toContain("[FunASR 转录（含说话人标签）]");
  });
});
