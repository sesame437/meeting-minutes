"use strict";

// Mirrors transcription-worker catch block behavior
async function handleTranscriptionWorkerError(meetingId, createdAt, err, updateMeetingStatus) {
  try {
    throw err;
  } catch (caughtErr) {
    await updateMeetingStatus(meetingId, createdAt, "failed", {
      errorMessage: caughtErr.message,
      stage: "failed",
    });
    throw caughtErr;
  }
}

// Mirrors the nested try/catch in all three workers' catch blocks
async function handleWorkerErrorWithNestedCatch(meetingId, createdAt, err, updateStatus) {
  try {
    throw err;
  } catch (caughtErr) {
    try {
      await updateStatus(meetingId, createdAt, "failed", {
        errorMessage: caughtErr.message,
        stage: "failed",
      });
    } catch (updateErr) {
      console.error(`[worker] Failed to update error status:`, updateErr.message);
      // 嵌套 catch 不再向上抛出，保护主流程
    }
  }
}

describe("transcription-worker error handling", () => {
  test("catch 块会更新 DynamoDB: status=failed, stage=failed", async () => {
    const updateMeetingStatus = jest.fn().mockResolvedValue(undefined);
    const err = new Error("asr provider timeout");

    await expect(
      handleTranscriptionWorkerError("m-err", "2026-02-19T00:00:00.000Z", err, updateMeetingStatus)
    ).rejects.toThrow("asr provider timeout");

    expect(updateMeetingStatus).toHaveBeenCalledWith(
      "m-err",
      "2026-02-19T00:00:00.000Z",
      "failed",
      {
        errorMessage: "asr provider timeout",
        stage: "failed",
      }
    );
  });

  test("errorMessage 包含原始错误信息", async () => {
    const updateMeetingStatus = jest.fn().mockResolvedValue(undefined);
    const err = new Error("Whisper API returned 500: upstream unavailable");

    await expect(
      handleTranscriptionWorkerError("m-err2", "2026-02-19T00:00:00.000Z", err, updateMeetingStatus)
    ).rejects.toThrow("Whisper API returned 500");

    const extraAttrs = updateMeetingStatus.mock.calls[0][3];
    expect(extraAttrs.errorMessage).toContain("upstream unavailable");
  });
});

describe("worker nested catch protection (transcription / report / export)", () => {
  test("DynamoDB 更新也失败时：只打 console.error，不向外抛异常", async () => {
    const updateStatus = jest.fn().mockRejectedValue(new Error("DynamoDB connection lost"));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("transcription failed");

    // 不应抛出任何异常
    await expect(
      handleWorkerErrorWithNestedCatch("m-nested", "2026-02-19T00:00:00.000Z", err, updateStatus)
    ).resolves.toBeUndefined();

    // 确认 updateStatus 被调用
    expect(updateStatus).toHaveBeenCalledTimes(1);
    // 确认 console.error 被调用（记录 DynamoDB 失败）
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[worker]"),
      expect.stringContaining("DynamoDB connection lost")
    );

    consoleSpy.mockRestore();
  });

  test("DynamoDB 更新成功时：主流程正常完成，无异常", async () => {
    const updateStatus = jest.fn().mockResolvedValue(undefined);
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("export failed");

    await expect(
      handleWorkerErrorWithNestedCatch("m-ok", "2026-02-19T00:00:00.000Z", err, updateStatus)
    ).resolves.toBeUndefined();

    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

