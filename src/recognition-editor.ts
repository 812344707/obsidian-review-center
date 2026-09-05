import { Setting, type App } from "obsidian";
import { folderInput, tagInput } from "./inputs";
import { groupFilter } from "./recognition";
import type { RecognitionRule, ReviewGroup } from "./types";
import { cloneValue } from "./utils";

export function renderRecognitionEditor(app: App, root: HTMLElement, group: ReviewGroup, redraw: () => void, clean: (callback: () => void) => void): void {
  const filter = cloneValue(groupFilter(group));
  const change = () => { group.recognition = cloneValue(filter); };
  new Setting(root).setName("识别范围").setDesc("多条条件组合决定哪些文章进入本组。没有条件时不纳入任何文章。")
    .addDropdown((d) => d.addOption("all", "全部满足（且）").addOption("any", "任意满足（或）").setValue(filter.match).onChange((v) => { filter.match = v as "all" | "any"; change(); }));
  const rows = root.createDiv({ cls: "review-recognition-rules" });
  filter.rules.forEach((rule, index) => {
    const row = rows.createDiv({ cls: "review-recognition-rule" });
    const field = row.createEl("select", { attr: { "aria-label": `条件 ${index + 1} 类型` } });
    for (const [id, name] of [["folder", "文件夹"], ["tag", "标签"]]) field.createEl("option", { value: id, text: name });
    field.value = rule.field;
    field.onchange = () => { rule.field = field.value as RecognitionRule["field"]; rule.value = ""; change(); redraw(); };
    const operator = row.createEl("select", { attr: { "aria-label": `条件 ${index + 1} 关系` } });
    for (const [id, name] of [["is", "是"], ["is-not", "否"], ["contains", "包含"], ["excludes", "排除"]]) operator.createEl("option", { value: id, text: name });
    operator.value = rule.operator;
    operator.onchange = () => { rule.operator = operator.value as RecognitionRule["operator"]; change(); };
    const input = row.createEl("input", { type: "text", value: rule.value, placeholder: rule.field === "folder" ? "文件夹路径，根目录填 /" : "例如 review/伤寒", attr: { "aria-label": `条件 ${index + 1} ${rule.field === "folder" ? "文件夹" : "标签"}` } });
    const changed = (value: string) => { rule.value = value; change(); };
    input.oninput = () => changed(input.value);
    const suggest = rule.field === "folder" ? folderInput(app, input, changed) : tagInput(app, input, changed);
    clean(() => suggest.close());
    row.createEl("button", { text: "删除", attr: { "aria-label": `删除条件 ${index + 1}` } }).onclick = () => { filter.rules.splice(index, 1); change(); redraw(); };
  });
  root.createEl("button", { text: "添加条件" }).onclick = () => { filter.rules.push({ field: "folder", operator: "contains", value: "" }); change(); redraw(); };
  root.createEl("p", { cls: "review-settings-intro", text: "“是／否”精确匹配文件所在文件夹或完整标签；“包含／排除”同时匹配子文件夹、子标签。不是文字片段搜索。例如：全部满足「文件夹 包含 学习」「标签 排除 草稿」。只使用否定条件时，会在全库中排除对应范围。" });
}
