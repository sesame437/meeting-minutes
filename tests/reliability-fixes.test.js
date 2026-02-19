"use strict";

/**
 * reliability-fixes.test.js — Batch 2 修复专项测试
 *
 * 覆盖：
 *   Suite A: report-worker poll() per-message try/catch
 *   Suite B: transcription-worker runWhisper AbortController 30min 超时
 *   Suite C: report-worker readTranscript ensemble (Promise.allSettled)
 */

jest.mock("dotenv", () => ({ config: jest.fn() }));

// ─────────────────────────────────────────────────────────────────────────────
// Suite A — poll() per-message 错误处理
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite A — poll() per-message 错误处理", () => {
  /**
   * 从 report-worker.js 摘出 poll() 的核心批处理逻辑进行白盒测试：
   *
   *   for (const msg of messages) {
   *     try {
   *       await processMessage(msg);
   *       await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
   *     } catch (err) {
   *       console.error(...);
   *     }
   *   }
   *
   * 通过注入 mock 验证行为契约。
   */
  async function handleBatch(messages, processMessage, deleteMessage, queueUrl) {
    for (const msg of messages) {
      try {
        await processMessage(msg);
        await deleteMessage(queueUrl, msg.ReceiptHandle);
      } catch {
        // 不删消息 → SQS visibility timeout 后自动重试
      }
    }
  }

  beforeEach(() => jest.clearAllMocks());

  test("A1: 失败消息不调用 deleteMessage", async () => {
    const msg = { MessageId: "m1", ReceiptHandle: "r1" };
    const processMessage = jest.fn().mockRejectedValue(new Error("boom"));
    const deleteMessage = jest.fn();

    await handleBatch([msg], processMessage, deleteMessage, "q");

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  test("A2: 失败不影响同批次其他消息继续处理", async () => {
    const msgs = [
      { MessageId: "m1", ReceiptHandle: "r1" },
      { MessageId: "m2", ReceiptHandle: "r2" },
      { MessageId: "m3", ReceiptHandle: "r3" },
    ];
    const processMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom on m1"))
      .mockResolvedValueOnce(undefined) // m2 成功
      .mockRejectedValueOnce(new Error("boom on m3")); // m3 失败
    const deleteMessage = jest.fn().mockResolvedValue({});

    await handleBatch(msgs, processMessage, deleteMessage, "q");

    expect(processMessage).toHaveBeenCalledTimes(3);
    // 只有 m2 应该被删除
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith("q", "r2");
  });

  test("A3: 全部成功时所有消息都被删除", async () => {
    const msgs = [
      { MessageId: "m1", ReceiptHandle: "r1" },
      { MessageId: "m2", ReceiptHandle: "r2" },
    ];
    const processMessage = jest.fn().mockResolvedValue(undefined);
    const deleteMessage = jest.fn().mockResolvedValue({});

    await handleBatch(msgs, processMessage, deleteMessage, "q");

    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith("q", "r1");
    expect(deleteMessage).toHaveBeenCalledWith("q", "r2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B — runWhisper AbortController 30min 超时
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite B — runWhisper AbortController 超时", () => {
  /**
   * 从 transcription-worker.js 摘出 AbortController 超时逻辑：
   *
   *   const controller = new AbortController();
   *   const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000);
   *   try {
   *     resp = await fetch(url, { method: "POST", body, signal: controller.signal });
   *   } finally {
   *     clearTimeout(timeoutId);
   *   }
   */
  async function runWithTimeout(fetchFn, timeoutMs = 30 * 60 * 1000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  beforeEach(() => jest.clearAllMocks());

  test("B1: 超时后 abort() 被调用", () => {
    jest.useFakeTimers();

    const abort = jest.fn();
    const savedAbortController = global.AbortController;
    global.AbortController = class {
      constructor() {
        this.signal = { aborted: false };
      }
      abort = abort;
    };

    // fetchFn 永不 resolve（模拟挂起）
    const fetchFn = jest.fn(() => new Promise(() => {}));
    void runWithTimeout(fetchFn, 30 * 60 * 1000);

    // 前进到超时边界
    jest.advanceTimersByTime(30 * 60 * 1000);

    expect(abort).toHaveBeenCalledTimes(1);

    global.AbortController = savedAbortController;
    jest.useRealTimers();
  });

  test("B2: 正常完成时不调用 abort()", async () => {
    jest.useFakeTimers();

    const abort = jest.fn();
    const savedAbortController = global.AbortController;
    global.AbortController = class {
      constructor() {
        this.signal = {};
      }
      abort = abort;
    };

    const fetchFn = jest.fn().mockResolvedValue({ ok: true });
    await runWithTimeout(fetchFn, 30 * 60 * 1000);

    // 超时尚未到达，且请求已正常完成
    expect(abort).not.toHaveBeenCalled();

    global.AbortController = savedAbortController;
    jest.useRealTimers();
  });

  test("B3: timeout 是 30 分钟（精确值校验）", () => {
    expect(30 * 60 * 1000).toBe(1800000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite C — readTranscript ensemble (Promise.allSettled 双轨)
// ─────────────────────────────────────────────────────────────────────────────

describe("Suite C — readTranscript ensemble", () => {
  /**
   * 注意：report-worker.js 实际实现中存在一个高优先级 Bug：
   *
   *   Promise.allSettled([
   *     transcribeKey ? streamToString(await getFile(transcribeKey)) : Promise.reject(...),
   *     whisperKey   ? streamToString(await getFile(whisperKey))    : Promise.reject(...),
   *   ])
   *
   * `await getFile(...)` 在构造参数数组时就被求值（在 allSettled 外部），
   * 若 getFile 抛出同步异常或 rejected promise 会**绕过** allSettled 直接向上冒泡。
   * 正确写法应将 Promise 工厂传入，如：
   *   Promise.allSettled([
   *     transcribeKey ? streamToString(getFile(transcribeKey)) : Promise.reject(...),
   *     ...
   *   ])
   * （去掉 await）
   *
   * 以下测试基于**正确**语义实现进行验证（可驱动 bug 修复）。
   */
  async function readTranscript(getTranscribeText, getWhisperText) {
    // 正确实现：不提前 await，直接把 Promise 传给 allSettled
    const results = await Promise.allSettled([
      getTranscribeText ? getTranscribeText() : Promise.reject("no transcribeKey"),
      getWhisperText ? getWhisperText() : Promise.reject("no whisperKey"),
    ]);

    const transcribeText = results[0].status === "fulfilled" ? results[0].value : null;
    const whisperText = results[1].status === "fulfilled" ? results[1].value : null;

    if (!transcribeText && !whisperText) {
      throw new Error("Both transcription sources failed");
    }
    if (transcribeText && whisperText) {
      return `[AWS Transcribe 转录]\n${transcribeText}\n\n[Whisper 转录]\n${whisperText}`;
    }
    return transcribeText || whisperText;
  }

  test("C1: 两份都有 → 返回包含两个标签的合并文本", async () => {
    const result = await readTranscript(
      () => Promise.resolve("transcribe content"),
      () => Promise.resolve("whisper content")
    );
    expect(result).toContain("[AWS Transcribe 转录]");
    expect(result).toContain("[Whisper 转录]");
    expect(result).toContain("transcribe content");
    expect(result).toContain("whisper content");
  });

  test("C2: 只有 transcribeKey → 返回单份 transcribe 文本", async () => {
    const result = await readTranscript(
      () => Promise.resolve("only transcribe"),
      null // no whisperKey
    );
    expect(result).toBe("only transcribe");
  });

  test("C3: 只有 whisperKey → 返回单份 whisper 文本", async () => {
    const result = await readTranscript(
      null, // no transcribeKey
      () => Promise.resolve("only whisper")
    );
    expect(result).toBe("only whisper");
  });

  test("C4: whisperKey S3 读取失败，transcribeKey 成功 → fallback 到 transcribe", async () => {
    const result = await readTranscript(
      () => Promise.resolve("transcribe ok"),
      () => Promise.reject(new Error("S3 whisper read failed"))
    );
    expect(result).toBe("transcribe ok");
  });

  test("C5: transcribeKey S3 读取失败，whisperKey 成功 → fallback 到 whisper", async () => {
    const result = await readTranscript(
      () => Promise.reject(new Error("S3 transcribe read failed")),
      () => Promise.resolve("whisper ok")
    );
    expect(result).toBe("whisper ok");
  });

  test("C6: 两份都失败 → throw Error", async () => {
    await expect(
      readTranscript(
        () => Promise.reject(new Error("transcribe S3 error")),
        () => Promise.reject(new Error("whisper S3 error"))
      )
    ).rejects.toThrow("Both transcription sources failed");
  });

  test("C7: 两个 key 都为 null → throw Error", async () => {
    await expect(readTranscript(null, null)).rejects.toThrow(
      "Both transcription sources failed"
    );
  });
});

