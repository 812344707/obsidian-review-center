import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { ReviewCenterSettings } from "./types";

export const DEFAULT_SETTINGS: ReviewCenterSettings = {
  watchedFolders: [],
  excludedFolders: [],
  reviewHeading: "复习",
  reviewHeadingLevel: 2,
  dataFolder: "复习中心数据",
  noteNewLimit: 1,
  noteReviewLimit: 10,
  cardNewLimit: 10,
  cardReviewLimit: 100,
  noteRetention: 0.85,
  cardRetention: 0.9,
  autoOpenDashboard: false,
};

type SettingsHost = Plugin & {
  settings: ReviewCenterSettings;
  updateSettings(next: ReviewCenterSettings): Promise<void>;
};

export class ReviewCenterSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("基本设置").setHeading();

    new Setting(containerEl)
      .setName("纳入复习的文件夹")
      .setDesc("每行一个 Vault 内路径。留空时不会扫描任何笔记；子文件夹自动包含。")
      .addTextArea((text) => {
        text
          .setPlaceholder("资料\n中医求真/笔记")
          .setValue(this.host.settings.watchedFolders.join("\n"))
          .onChange(async (value) => {
            await this.patch({ watchedFolders: splitFolderList(value) });
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("排除的子文件夹")
      .setDesc("每行一个路径，优先级高于纳入目录。")
      .addTextArea((text) => {
        text
          .setPlaceholder("资料/归档\n资料/模板")
          .setValue(this.host.settings.excludedFolders.join("\n"))
          .onChange(async (value) => {
            await this.patch({ excludedFolders: splitFolderList(value) });
          });
        text.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName("复习章节标题")
      .setDesc("每篇笔记由您手动创建；插件不会自动添加章节。")
      .addText((text) =>
        text.setValue(this.host.settings.reviewHeading).onChange(async (value) => {
          const normalized = value.replace(/^#+\s*/, "").trim();
          if (normalized) await this.patch({ reviewHeading: normalized });
        }),
      )
      .addDropdown((dropdown) => {
        for (let level = 1; level <= 6; level += 1) {
          dropdown.addOption(String(level), `${"#".repeat(level)} 标题 ${level}`);
        }
        dropdown
          .setValue(String(this.host.settings.reviewHeadingLevel))
          .onChange(async (value) => {
            await this.patch({ reviewHeadingLevel: Number(value) });
          });
      });

    new Setting(containerEl).setName("每日限额").setHeading();
    this.addIntegerSetting("笔记：每日新内容", "篇", "noteNewLimit", 0, 999);
    this.addIntegerSetting("笔记：每日到期复习", "篇", "noteReviewLimit", 0, 9999);
    this.addIntegerSetting("卡片：每日新内容", "张", "cardNewLimit", 0, 9999);
    this.addIntegerSetting("卡片：每日到期复习", "张", "cardReviewLimit", 0, 99999);

    new Setting(containerEl).setName("FSRS").setHeading();
    this.addRetentionSetting("笔记目标记忆率", "noteRetention");
    this.addRetentionSetting("卡片目标记忆率", "cardRetention");

    new Setting(containerEl)
      .setName("同步数据文件夹")
      .setDesc("普通 Vault 文件夹。请在 Obsidian Sync 中开启“同步其他文件类型”。")
      .addText((text) =>
        text.setValue(this.host.settings.dataFolder).onChange(async (value) => {
          const normalized = value.replace(/^\/+|\/+$/g, "").trim();
          if (normalized) await this.patch({ dataFolder: normalized });
        }),
      );

    new Setting(containerEl)
      .setName("启动时打开复习中心")
      .setDesc("默认关闭。")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.autoOpenDashboard).onChange(async (value) => {
          await this.patch({ autoOpenDashboard: value });
        }),
      );
  }

  private addIntegerSetting(
    name: string,
    unit: string,
    key: "noteNewLimit" | "noteReviewLimit" | "cardNewLimit" | "cardReviewLimit",
    minimum: number,
    maximum: number,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(`单位：${unit}`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(minimum);
        text.inputEl.max = String(maximum);
        text.setValue(String(this.host.settings[key])).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) {
            await this.patch({ [key]: Math.max(minimum, Math.min(maximum, parsed)) });
          }
        });
      });
  }

  private addRetentionSetting(
    name: string,
    key: "noteRetention" | "cardRetention",
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc("70%–99%；更高意味着复习更频繁。")
      .addSlider((slider) =>
        slider
          .setLimits(70, 99, 1)
          .setValue(Math.round(this.host.settings[key] * 100))
          .onChange(async (value) => {
            await this.patch({ [key]: value / 100 });
          }),
      );
  }

  private async patch(patch: Partial<ReviewCenterSettings>): Promise<void> {
    await this.host.updateSettings({ ...this.host.settings, ...patch });
  }
}

function splitFolderList(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((part) => part.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean))];
}
