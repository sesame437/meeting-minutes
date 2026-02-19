"use strict";

// Mirrors filter logic in public/js/app.js -> renderFilteredMeetings()
function applyMeetingFilters(meetings, filterType, searchQuery) {
  let filtered = meetings;

  if (filterType !== "all") {
    filtered = filtered.filter((m) => m.meetingType === filterType);
  }

  const q = (searchQuery || "").trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((m) => {
      const title = (m.title || m.meetingId || "").toLowerCase();
      return title.includes(q);
    });
  }

  return filtered;
}

describe("Meeting filter/search logic", () => {
  const meetings = [
    { meetingId: "1", title: "Weekly Sync", meetingType: "weekly" },
    { meetingId: "2", title: "Tech Design Review", meetingType: "tech" },
    { meetingId: "3", title: "Customer Kickoff", meetingType: "customer" },
    { meetingId: "4", title: "General Planning", meetingType: "general" },
  ];

  test("类型过滤：weekly 只返回 weekly", () => {
    const result = applyMeetingFilters(meetings, "weekly", "");
    expect(result).toHaveLength(1);
    expect(result[0].meetingType).toBe("weekly");
  });

  test("类型过滤：all 返回全部", () => {
    const result = applyMeetingFilters(meetings, "all", "");
    expect(result).toHaveLength(4);
  });

  test("搜索过滤：title 包含关键词（不区分大小写）", () => {
    const result = applyMeetingFilters(meetings, "all", "dEsIgN");
    expect(result).toHaveLength(1);
    expect(result[0].meetingId).toBe("2");
  });

  test("组合过滤：类型 + 搜索同时生效", () => {
    const input = [
      ...meetings,
      { meetingId: "5", title: "Weekly Hiring", meetingType: "weekly" },
    ];
    const result = applyMeetingFilters(input, "weekly", "sync");
    expect(result).toHaveLength(1);
    expect(result[0].meetingId).toBe("1");
  });

  test("空结果：返回空数组", () => {
    const result = applyMeetingFilters(meetings, "customer", "architecture");
    expect(result).toEqual([]);
  });

  test("搜索空字符串：不过滤", () => {
    const result = applyMeetingFilters(meetings, "tech", "   ");
    expect(result).toHaveLength(1);
    expect(result[0].meetingId).toBe("2");
  });
});
