import { describe, expect, it } from "vitest";
import { issueAdvice } from "../src/review-issues";
describe("actionable material issues", () => {
  it("points incomplete cards to the correct physical source line", () => {
    expect(issueAdvice("第 23 行的问答卡答案为空。")).toMatchObject({ title: "问答尚未写完整", line: 22 });
  });
  it("protects original identities for duplicate cards and explains synchronization conflicts", () => {
    expect(issueAdvice("多个卡片块使用同一标识：rv-123").solution).toContain("保留原卡片");
    expect(issueAdvice("同步冲突：note").solution).toContain("不要通过重置全部进度");
  });
});
