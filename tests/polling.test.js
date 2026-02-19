"use strict";

// Test hasActiveJobs logic inline (mirrors the logic in public/js/app.js)
function hasActiveJobs(meetings) {
  const activeStatuses = ["pending", "processing", "transcribing", "reporting"];
  return meetings.some((m) => activeStatuses.includes(m.status));
}

describe("hasActiveJobs()", () => {
  test("空数组 → false", () => {
    expect(hasActiveJobs([])).toBe(false);
  });

  test("全部 completed → false", () => {
    expect(
      hasActiveJobs([
        { status: "completed" },
        { status: "completed" },
      ])
    ).toBe(false);
  });

  test("含一个 processing → true", () => {
    expect(
      hasActiveJobs([{ status: "completed" }, { status: "processing" }])
    ).toBe(true);
  });

  test("含一个 pending → true", () => {
    expect(hasActiveJobs([{ status: "pending" }])).toBe(true);
  });

  test("含一个 transcribing → true", () => {
    expect(hasActiveJobs([{ status: "transcribing" }])).toBe(true);
  });

  test("含一个 reporting → true", () => {
    expect(hasActiveJobs([{ status: "reporting" }])).toBe(true);
  });

  test("mixed（completed + processing）→ true", () => {
    expect(
      hasActiveJobs([
        { status: "completed" },
        { status: "completed" },
        { status: "processing" },
      ])
    ).toBe(true);
  });
});
