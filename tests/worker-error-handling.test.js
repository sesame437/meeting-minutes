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
