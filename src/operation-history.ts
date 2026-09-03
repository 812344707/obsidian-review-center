import { Modal, Setting } from "obsidian";
import type ReviewCenterPlugin from "./main";
import { runTagJob, type TagJob } from "./tag-operations";
import { runRescheduleJob, type RescheduleJob } from "./reschedule";
export type OperationJob = TagJob | RescheduleJob;
export class OperationHistoryModal extends Modal {
  constructor(private readonly host: ReviewCenterPlugin) { super(host.app); }
  onOpen(): void { this.titleEl.setText("批量操作记录"); void this.draw(); }
  private async draw(): Promise<void> {
    this.contentEl.empty();
    const jobs = await this.host.store.loadJobs<OperationJob>();
    if (!jobs.length) this.contentEl.createEl("p", { text: "暂无批量操作记录。" });
    for (const { id, data } of jobs) {
      const box = this.contentEl.createEl("details", { cls: "review-options-section" });
      box.createEl("summary", { text: `${data.kind === "tags" ? "标签修改" : "重新排程"} · ${new Date(data.createdAt).toLocaleString("zh-CN")} · ${data.state === "done" ? "已完成" : "待继续"}` });
      box.createEl("p", { text: "复习数据备份：" + (data.backup ?? "尚未开始写入") });
      if (data.kind === "tags") {
        box.createEl("p", { text: `#${data.operation.from} → ${data.operation.to ? "#" + data.operation.to : "删除标签"}` });
        for (const file of data.files) {
          const row = box.createEl("details"); row.createEl("summary", { text: `${file.path} · ${file.status === "done" ? "完成" : file.error ?? "未选择"}` });
          row.createEl("pre", { text: file.original, cls: "review-operation-original" });
        }
      } else for (const entry of data.entries) box.createEl("p", { text: `${entry.path} · ${entry.error ?? (entry.done ? "完成" : "待处理")} · ${entry.before.schedule.due} → ${entry.after.schedule.due}` });
      if (data.state === "pending") new Setting(box).addButton((b) => b.setButtonText("继续未完成操作").onClick(() => {
        b.setDisabled(true); const run = data.kind === "tags" ? runTagJob(this.host, id, data) : runRescheduleJob(this.host, id, data);
        void run.then(() => this.draw()).catch((e) => { box.createEl("p", { text: String(e), attr: { role: "alert" } }); b.setDisabled(false); });
      }));
    }
  }
}
