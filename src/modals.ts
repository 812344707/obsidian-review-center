import { Modal, Notice, Setting } from "obsidian";
import type { ReviewService } from "./service";

export class ChangedCardsModal extends Modal {
  private choices = new Map<string, boolean>();

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly service: ReviewService,
    private readonly sourceId: string | undefined,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "处理已修改的卡片" });
    contentEl.createEl("p", {
      text: "文字已经更新。请逐张选择保留原复习进度，或把它作为新知识重新开始。",
    });
    const pending = this.service.pendingChanges(this.sourceId);
    if (pending.length === 0) {
      contentEl.createEl("p", { text: "没有待处理的卡片。" });
      return;
    }

    for (const { record, item } of pending) {
      const key = `${record.reviewId}::${item.id}`;
      if (!this.choices.has(key)) this.choices.set(key, false);
      new Setting(contentEl)
        .setName(item.content.question.slice(0, 90) || "挖空卡")
        .setDesc(record.sourceTitle)
        .addDropdown((dropdown) =>
          dropdown
            .addOption("keep", "保留进度")
            .addOption("reset", "重置为新卡")
            .setValue(this.choices.get(key) ? "reset" : "keep")
            .onChange((value) => this.choices.set(key, value === "reset")),
        );
    }

    const batch = contentEl.createDiv({ cls: "review-center-modal-actions" });
    batch.createEl("button", { text: "全部保留" }).addEventListener("click", () => {
      for (const key of this.choices.keys()) this.choices.set(key, false);
      this.render();
    });
    batch.createEl("button", { text: "全部重置" }).addEventListener("click", () => {
      for (const key of this.choices.keys()) this.choices.set(key, true);
      this.render();
    });
    const confirm = batch.createEl("button", { cls: "mod-cta", text: "确认" });
    confirm.addEventListener("click", () => {
      void (async () => {
        confirm.disabled = true;
        const choices = pending.map(({ record, item }) => ({
          sourceId: record.reviewId,
          itemId: item.id,
          reset: this.choices.get(`${record.reviewId}::${item.id}`) ?? false,
        }));
        await this.service.resolveChanges(choices);
        new Notice(`已处理 ${choices.length} 张修改卡片`);
        this.close();
        this.onDone();
      })();
    });
  }
}

export class BackupPickerModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly paths: string[],
    private readonly onSelect: (path: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "选择要恢复的备份" });
    if (this.paths.length === 0) {
      contentEl.createEl("p", { text: "导出目录里还没有 JSON 备份。" });
      return;
    }
    for (const path of this.paths) {
      new Setting(contentEl)
        .setName(path.split("/").at(-1) ?? path)
        .setDesc(path)
        .addButton((button) =>
          button.setButtonText("选择").onClick(() => {
            this.close();
            new ConfirmRestoreModal(this.app, path, this.onSelect).open();
          }),
        );
    }
  }
}

class ConfirmRestoreModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly path: string,
    private readonly onConfirm: (path: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: "确认恢复备份" });
    this.contentEl.createEl("p", {
      text: "恢复会用备份中的排程替换当前排程。插件会先自动生成一份 pre-restore 备份。",
    });
    this.contentEl.createEl("code", { text: this.path });
    const actions = this.contentEl.createDiv({ cls: "review-center-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-warning", text: "恢复" });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm(this.path);
    });
  }
}
