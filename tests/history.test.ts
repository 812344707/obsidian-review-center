import { describe, expect, it } from "vitest";
import { createHistoryEvent, resolveItemHistory } from "../src/history";
import { createSchedule } from "../src/scheduler";
import type { ReviewItem } from "../src/types";

function item(revision: number, answer: string): ReviewItem {
  return {
    id: "card",
    kind: "qa",
    revision,
    introducedAt: "2026-09-01T00:00:00.000Z",
    acceptedHash: answer,
    content: {
      question: "问题",
      answer,
      raw: answer,
      sourceStartLine: 1,
      sourceEndLine: 2,
    },
    schedule: createSchedule(new Date("2026-09-01T00:00:00.000Z")),
    status: "active",
  };
}

describe("history conflict reconciliation", () => {
  it("keeps the later event when two devices change the same base revision", () => {
    const created = item(1, "初始");
    const phone = item(2, "手机分支");
    const desktop = item(2, "电脑分支");
    const events = [
      createHistoryEvent({
        sessionId: "create",
        deviceId: "phone",
        sourceId: "source",
        itemId: "card",
        action: "create",
        baseRevision: 0,
        after: created,
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
      createHistoryEvent({
        sessionId: "phone-review",
        deviceId: "phone",
        sourceId: "source",
        itemId: "card",
        action: "review",
        baseRevision: 1,
        after: phone,
        now: new Date("2026-09-01T01:00:00.000Z"),
      }),
      createHistoryEvent({
        sessionId: "desktop-review",
        deviceId: "desktop",
        sourceId: "source",
        itemId: "card",
        action: "review",
        baseRevision: 1,
        after: desktop,
        now: new Date("2026-09-01T02:00:00.000Z"),
      }),
    ];

    const result = resolveItemHistory(undefined, events);
    expect(result.conflicts).toBe(1);
    expect(result.item?.content.answer).toBe("电脑分支");
    expect(result.revision).toBe(2);
  });

  it("keeps a delete tombstone as the end of the chain", () => {
    const created = item(1, "初始");
    const events = [
      createHistoryEvent({
        sessionId: "create",
        deviceId: "phone",
        sourceId: "source",
        itemId: "card",
        action: "create",
        baseRevision: 0,
        after: created,
      }),
      createHistoryEvent({
        sessionId: "delete",
        deviceId: "phone",
        sourceId: "source",
        itemId: "card",
        action: "delete",
        baseRevision: 1,
        after: null,
      }),
    ];

    const result = resolveItemHistory(undefined, events);
    expect(result.item).toBeNull();
    expect(result.revision).toBe(2);
  });
});
