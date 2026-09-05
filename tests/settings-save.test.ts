import { describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({ buttons: [] as any[], assimilations: 0 }));
vi.mock("obsidian", () => {
  class Base {}
  class Setting {
    setName() { return this; } setDesc() { return this; }
    addButton(make: (button: any) => void) {
      const button = {
        text: "", disabled: false, click: () => {},
        setButtonText(text: string) { this.text = text; return this; },
        setCta() { return this; },
        setDisabled(value: boolean) { this.disabled = value; return this; },
        onClick(click: () => void) { this.click = click; return this; },
        then(resolve: (value: undefined) => void) { ui.assimilations++; resolve(undefined); },
      };
      make(button); ui.buttons.push(button); return this;
    }
  }
  return { App: Base, PluginSettingTab: Base, Modal: Base, AbstractInputSuggest: Base, TFolder: Base, Setting, Notice: vi.fn(), Platform: {} };
});
import { ReviewCenterSettingTab } from "../src/settings";

describe("saving settings with Obsidian thenable buttons", () => {
  it.each([false, true])("finishes settings save without assimilating the button (failure=%s)", async (failure) => {
    ui.buttons = []; ui.assimilations = 0;
    const root = { createDiv: vi.fn(() => ({ setText: vi.fn() })) };
    const tab = new ReviewCenterSettingTab({} as never, {} as never);
    Object.assign(tab, { containerEl: root });
    vi.spyOn(tab, "display").mockImplementation(() => {});
    Reflect.get(tab, "saveRow").call(tab, root, "保存", "", async () => { if (failure) throw new Error("test failure"); }, () => {});
    const button = ui.buttons.find(b => b.text === "保存"); button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(button.disabled).toBe(false);
    expect(ui.assimilations).toBe(0);
    expect(tab.display).toHaveBeenCalledTimes(failure ? 0 : 1);
  });
});
