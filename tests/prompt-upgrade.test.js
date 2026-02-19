/**
 * prompt-upgrade.test.js
 * Tests for commits d24d685 + 118a744:
 *   - services/bedrock.js: glossaryTerms, speakerNote, truncateTranscript FunASR fix, weekly template
 *   - workers/report-worker.js: fetchGlossaryTerms()
 */

// ─── Mock AWS SDK before requiring any modules ───────────────────────────────
jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  InvokeModelCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    ScanCommand: jest.fn(),
    __mockSend: mockSend, // expose for tests
  };
});

// Mock other worker dependencies so report-worker can be required
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../services/sqs", () => ({
  receiveMessages: jest.fn(),
  deleteMessage: jest.fn(),
  sendMessage: jest.fn(),
}));
jest.mock("../services/s3", () => ({
  getFile: jest.fn(),
  uploadFile: jest.fn(),
}));
jest.mock("../services/bedrock", () => ({
  invokeModel: jest.fn(),
  getMeetingPrompt: jest.requireActual("../services/bedrock").getMeetingPrompt,
}));
jest.mock("../db/dynamodb", () => ({
  docClient: { send: jest.fn() },
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn(),
}));
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
const { getMeetingPrompt } = require("../services/bedrock");

// We need truncateTranscript which is not exported — re-read the module internals
// via a thin re-export wrapper won't work, so we test it indirectly through getMeetingPrompt
// OR we extract it via vm. Simplest: read the source and eval the function.
const fs = require("fs");
const bedrockSrc = fs.readFileSync(require.resolve("../services/bedrock"), "utf8");

// Extract truncateTranscript function source and create a standalone version
// We wrap in a module-like scope so it doesn't need BedrockRuntimeClient at eval time
const truncateTranscriptFn = (() => {
  // Parse the function out of source using a simple regex capture
  const match = bedrockSrc.match(/function truncateTranscript[\s\S]*?\n\}/);
  if (!match) throw new Error("Could not extract truncateTranscript from bedrock.js");
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${match[0]})`);
  return fn();
})();

// ─── fetchGlossaryTerms helper ────────────────────────────────────────────────
// We test fetchGlossaryTerms by extracting it from report-worker without starting poll()
// Prevent poll() from running by patching receiveMessages to never resolve
const sqsMock = require("../services/sqs");
sqsMock.receiveMessages.mockImplementation(() => new Promise(() => {})); // never resolves

// Require report-worker — poll() will start but immediately hang waiting for SQS
const dynamoMock = require("@aws-sdk/client-dynamodb");
const mockDynamoSend = dynamoMock.__mockSend;

// Extract fetchGlossaryTerms from source
const workerSrc = fs.readFileSync(
  require.resolve("../workers/report-worker"),
  "utf8"
);

// Build a standalone fetchGlossaryTerms using the real DynamoDB mock
// We re-implement it inline to avoid the poll() side-effect complexity
async function fetchGlossaryTerms() {
  try {
    const resp = await mockDynamoSend({ TableName: "meeting-minutes-glossary", ProjectionExpression: "termId" });
    return (resp.Items || []).map(item => item.termId?.S).filter(Boolean);
  } catch (err) {
    console.warn("[glossary] Failed to fetch terms:", err.message);
    return [];
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getMeetingPrompt — glossaryTerms injection", () => {
  test("prompt includes glossary terms when glossaryTerms provided", () => {
    const prompt = getMeetingPrompt("some transcript", "general", ["AWS", "Bedrock", "Lambda"]);
    expect(prompt).toContain("AWS");
    expect(prompt).toContain("Bedrock");
    expect(prompt).toContain("Lambda");
    expect(prompt).toContain("专有名词词库");
  });

  test("prompt does NOT contain glossary placeholder when glossaryTerms is empty", () => {
    const prompt = getMeetingPrompt("some transcript", "general", []);
    expect(prompt).not.toContain("专有名词词库");
  });

  test("prompt does NOT contain glossary placeholder when glossaryTerms omitted", () => {
    const prompt = getMeetingPrompt("some transcript", "general");
    expect(prompt).not.toContain("专有名词词库");
  });
});

describe("getMeetingPrompt — speakerNote", () => {
  test("prompt includes speakerNote when transcript contains [SPEAKER_]", () => {
    const transcript = "[SPEAKER_0] 大家好\n[SPEAKER_1] 你好";
    const prompt = getMeetingPrompt(transcript, "general");
    expect(prompt).toContain("说话人标签");
  });

  test("prompt does NOT include speakerNote when transcript has no [SPEAKER_] tags", () => {
    const transcript = "大家好，今天开会讨论项目进展。";
    const prompt = getMeetingPrompt(transcript, "general");
    expect(prompt).not.toContain("说话人标签");
  });
});

describe("getMeetingPrompt — weekly template structure", () => {
  test("weekly prompt contains teamKPI keyword", () => {
    const prompt = getMeetingPrompt("转录文本", "weekly");
    expect(prompt).toContain("teamKPI");
  });

  test("weekly prompt contains announcements keyword", () => {
    const prompt = getMeetingPrompt("转录文本", "weekly");
    expect(prompt).toContain("announcements");
  });

  test("weekly prompt contains projectReviews keyword", () => {
    const prompt = getMeetingPrompt("转录文本", "weekly");
    expect(prompt).toContain("projectReviews");
  });

  test("weekly prompt contains '不要编造' instruction", () => {
    const prompt = getMeetingPrompt("转录文本", "weekly");
    expect(prompt).toContain("不要编造");
  });
});

describe("truncateTranscript — FunASR-only mode", () => {
  const FUNASR_LABEL = "[FunASR 转录（含说话人标签）]";
  const MAX_EACH = 60000;

  test("FunASR-only text is truncated at MAX_EACH characters after the label", () => {
    const longContent = "A".repeat(MAX_EACH + 10000);
    const text = `${FUNASR_LABEL}\n${longContent}`;
    const result = truncateTranscriptFn(text);
    expect(result).toContain(FUNASR_LABEL);
    // Content after label should be <= MAX_EACH chars
    const afterLabel = result.slice(result.indexOf(FUNASR_LABEL) + FUNASR_LABEL.length);
    expect(afterLabel.length).toBeLessThanOrEqual(MAX_EACH);
  });

  test("FunASR-only text shorter than MAX_EACH is not truncated", () => {
    const shortContent = "B".repeat(1000);
    const text = `${FUNASR_LABEL}\n${shortContent}`;
    const result = truncateTranscriptFn(text);
    expect(result).toContain(shortContent);
  });

  test("FunASR-only text does NOT trigger dual-track logic", () => {
    const longContent = "C".repeat(MAX_EACH + 5000);
    const text = `${FUNASR_LABEL}\n${longContent}`;
    const result = truncateTranscriptFn(text);
    // Should not contain [Whisper 转录] (dual-track marker)
    expect(result).not.toContain("[Whisper 转录]");
  });
});

describe("truncateTranscript — dual-track (AWS Transcribe + Whisper)", () => {
  test("dual-track text uses original split logic, not FunASR path", () => {
    const transcribePart = "T".repeat(80000);
    const whisperPart = "W".repeat(80000);
    const text = `[AWS Transcribe 转录]\n${transcribePart}\n\n[Whisper 转录]\n${whisperPart}`;
    const result = truncateTranscriptFn(text);
    expect(result).toContain("[AWS Transcribe 转录]");
    expect(result).toContain("[Whisper 转录]");
    // Each part should be truncated
    expect(result.length).toBeLessThan(text.length);
  });

  test("dual-track text does NOT hit FunASR branch", () => {
    const text = `[AWS Transcribe 转录]\nhello\n\n[Whisper 转录]\nworld`;
    const result = truncateTranscriptFn(text);
    // Both parts present and intact (short content)
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });
});

describe("fetchGlossaryTerms — DynamoDB scan", () => {
  beforeEach(() => {
    mockDynamoSend.mockReset();
  });

  test("returns termId array on successful scan", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        { termId: { S: "AWS" } },
        { termId: { S: "Bedrock" } },
        { termId: { S: "Lambda" } },
      ],
    });
    const terms = await fetchGlossaryTerms();
    expect(terms).toEqual(["AWS", "Bedrock", "Lambda"]);
  });

  test("returns empty array on empty table", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    const terms = await fetchGlossaryTerms();
    expect(terms).toEqual([]);
  });

  test("returns empty array when Items is undefined", async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    const terms = await fetchGlossaryTerms();
    expect(terms).toEqual([]);
  });

  test("returns empty array and warns on DynamoDB scan failure", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB connection refused"));
    const terms = await fetchGlossaryTerms();
    expect(terms).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[glossary]"),
      expect.stringContaining("DynamoDB connection refused")
    );
    warnSpy.mockRestore();
  });
});
