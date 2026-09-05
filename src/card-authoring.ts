import { calloutRanges } from "./parser";

export type CardAuthoringAction = "review" | "qa" | "cloze";
export interface AuthoringEdit { from: number; to: number; text: string; cursor: number }

/** All offsets refer to the editor's current text. Never discard selected source text. */
export function cardAuthoringEdit(markdown: string, from: number, to: number, action: CardAuthoringAction): AuthoringEdit {
  if (from < 0 || to < from || to > markdown.length) throw new Error("选区已经变化，请重新选择。");
  const lines = markdown.split("\n"), offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const lineAt = (offset: number) => markdown.slice(0, offset).split("\n").length - 1;
  const first = lineAt(from), last = lineAt(to > from ? to - 1 : to);
  let fence: { char: string; length: number } | undefined;
  let frontmatter = /^\uFEFF?---\s*$/.test(lines[0]);
  for (let i = 0; i <= last; i++) {
    if (frontmatter) {
      if (i > 0 && /^---\s*$/.test(lines[i])) frontmatter = false;
      else if (i >= first) throw new Error("请在正文中制卡，不能在笔记属性中插入。");
      continue;
    }
    const match = /^ {0,3}(?:> ?)?(`{3,}|~{3,})/.exec(lines[i]);
    if (match) {
      if (i >= first) throw new Error("请在代码块之外制卡。");
      if (fence && match[1][0] === fence.char && match[1].length >= fence.length) fence = undefined;
      else if (!fence) fence = { char: match[1][0], length: match[1].length };
    }
    if (fence && i >= first) throw new Error("请在代码块之外制卡。");
  }
  const ranges = calloutRanges(markdown);
  const owner = ranges.find((r) => first > r.start && last < r.end);
  if (ranges.some((r) => first <= r.start && last >= r.start) || (owner && owner.type !== "review")) {
    throw new Error("请在普通正文或 [!review] 块的内容中操作，不要选中提示块标题。");
  }
  const result = (a: number, b: number, text: string, cursor = text.length): AuthoringEdit => ({ from: a, to: b, text, cursor: a + cursor });
  if (action === "cloze") {
    const selected = markdown.slice(from, to);
    if (!selected.trim()) throw new Error("请先选中需要填空的文字。");
    if (/\{\{|\}\}/.test(selected)) throw new Error("选区已包含填空标记，请只选择原文字词。");
    const context = owner ? lines.slice(owner.start, owner.end).join("\n") : lines.slice(first, last + 1).join("\n");
    const numbers = [...context.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
    const n = Math.max(0, ...numbers) + 1;
    // Avoid nesting a new cloze inside an existing one when only its answer is selected.
    for (const match of markdown.matchAll(/\{\{c\d+::[\s\S]*?\}\}/g)) {
      if (from < match.index! + match[0].length && to > match.index!) throw new Error("这段文字已经是填空，请另选文字。");
    }
    if (owner) return result(from, to, `{{c${n}::${selected}}}`);
    const start = offsets[first], end = Math.min(markdown.length, offsets[last] + lines[last].length);
    if (lines.slice(first, last + 1).some((l) => /^\s*(?:>|```|~~~|---\s*$|\^rv-)/.test(l))) {
      throw new Error("请在普通正文中选中文字，或先插入复习块后制作填空。");
    }
    const content = markdown.slice(start, from) + `{{c${n}::${selected}}}` + markdown.slice(to, end);
    const text = "\n> [!review]- 复习\n" + content.split("\n").map((l) => "> " + l).join("\n") + "\n";
    return result(start, end, text);
  }
  if (owner) {
    const at = Math.min(markdown.length, offsets[owner.end - 1] + lines[owner.end - 1].length);
    if (action === "review") {
      const text = "\n\n> [!review]- 复习\n> \n";
      return result(at, at, text, text.length - 1);
    }
    return result(at, at, "\n>\n> 问:: \n> 答:: ", "\n>\n> 问:: ".length);
  }
  const at = Math.min(markdown.length, offsets[last] + lines[last].length);
  const body = action === "qa" ? "> 问:: \n> 答:: " : "> ";
  const text = "\n\n> [!review]- 复习\n" + body + "\n";
  return result(at, at, text, action === "qa" ? text.indexOf("问:: ") + 4 : text.length - 1);
}
