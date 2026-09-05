import { calloutRanges, parseReviewCards } from "./parser";

export type CardAuthoringAction = "review" | "qa" | "cloze" | "standard-qa" | "standard-cloze";
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
  if (action === "standard-qa" || action === "standard-cloze") {
    const at = owner ? Math.min(markdown.length, offsets[owner.end - 1] + lines[owner.end - 1].length) :
      Math.min(markdown.length, offsets[last] + lines[last].length);
    const text = action === "standard-qa"
      ? "\n\nSTART\nBasic\nFront: \nBack: \nEND\n"
      : "\n\nSTART\nCloze\nText: {{c1::}}\nExtra: \nEND\n";
    const marker = action === "standard-qa" ? "Front: " : "{{c1::";
    return result(at, at, text, text.indexOf(marker) + marker.length);
  }
  if (action === "cloze") {
    const selected = markdown.slice(from, to);
    if (!selected.trim()) throw new Error("请先选中需要填空的文字。");
    if (/\{\{|\}\}/.test(selected)) throw new Error("选区已包含填空标记，请只选择原文字词。");
    const qaOwner = parseReviewCards(markdown).cards.find((card) => card.kind === "qa" &&
      first >= card.content.sourceStartLine && last <= card.content.sourceEndLine);
    if (qaOwner || selectionInQaSyntax(lines, first, last, owner)) {
      throw new Error("选中文字属于问答卡，请另起一段制作独立填空题。");
    }
    const directRange = enclosingStandardCloze(lines, first, last) ?? paragraphRange(lines, first, last);
    const context = owner ? lines.slice(owner.start, owner.end).join("\n") : lines.slice(directRange.start, directRange.end).join("\n");
    const numbers = [...context.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
    const n = Math.max(0, ...numbers) + 1;
    // Avoid nesting a new cloze inside an existing one when only its answer is selected.
    for (const match of markdown.matchAll(/\{\{c\d+::[\s\S]*?\}\}/g)) {
      if (from < match.index! + match[0].length && to > match.index!) throw new Error("这段文字已经是填空，请另选文字。");
    }
    if (owner) return result(from, to, `{{c${n}::${selected}}}`);
    if (lines.slice(first, last + 1).some((l) => /^\s*(?:>|```|~~~|---\s*$|\^rv-)/.test(l))) {
      throw new Error("请在普通正文中选中文字制作填空。");
    }
    return result(from, to, `{{c${n}::${selected}}}`);
  }
  if (owner) {
    const at = Math.min(markdown.length, offsets[owner.end - 1] + lines[owner.end - 1].length);
    if (action === "review") {
      const text = "\n\n> [!review]- 复习\n> \n";
      return result(at, at, text, text.length - 1);
    }
    const text = "\n\nQ: \nA: \n";
    return result(at, at, text, text.indexOf("Q: ") + 3);
  }
  const at = Math.min(markdown.length, offsets[last] + lines[last].length);
  if (action === "qa") {
    const text = "\n\nQ: \nA: \n";
    return result(at, at, text, text.indexOf("Q: ") + 3);
  }
  const text = "\n\n> [!review]- 复习\n> \n";
  return result(at, at, text, text.length - 1);
}

function selectionInQaSyntax(
  lines: string[], first: number, last: number, owner: ReturnType<typeof calloutRanges>[number] | undefined,
): boolean {
  if (owner) {
    let active = false;
    for (let line = owner.start + 1; line <= last; line += 1) {
      const body = lines[line].replace(/^ {0,3}> ?/, "");
      if (/^\s*(?:[-*+]\s+)?问[:：]{2}/.test(body)) active = true;
      else if (/^#{1,6}\s+/.test(body)) active = false;
      if (line >= first && active) return true;
    }
    return false;
  }
  const standard = enclosingStandard(lines, first, last);
  if (standard?.type === "basic") return true;
  for (let line = first; line >= 0 && lines[line].trim() !== ""; line -= 1) {
    if (/^\s*Q:/i.test(lines[line])) return true;
    if (/^\s*(?:START|END)\s*$/i.test(lines[line])) break;
  }
  return false;
}

function enclosingStandard(
  lines: string[], first: number, last: number,
): { start: number; end: number; type: "basic" | "cloze" } | undefined {
  let start = first;
  while (start >= 0 && !/^\s*START\s*$/i.test(lines[start])) {
    if (start < first && /^\s*END\s*$/i.test(lines[start])) return undefined;
    start -= 1;
  }
  if (start < 0) return undefined;
  let end = Math.max(last, start + 1);
  while (end < lines.length && !/^\s*END\s*$/i.test(lines[end])) end += 1;
  if (end >= lines.length || last > end) return undefined;
  const type = lines.slice(start + 1, end).find((line) => line.trim())?.trim().toLowerCase();
  return type === "basic" || type === "cloze" ? { start, end: end + 1, type } : undefined;
}

function enclosingStandardCloze(lines: string[], first: number, last: number): { start: number; end: number } | undefined {
  const range = enclosingStandard(lines, first, last);
  return range?.type === "cloze" ? range : undefined;
}

function paragraphRange(lines: string[], first: number, last: number): { start: number; end: number } {
  let start = first, end = last + 1;
  while (start > 0 && lines[start - 1].trim() !== "" && !/^#{1,6}\s+/.test(lines[start - 1])) start -= 1;
  while (end < lines.length && lines[end].trim() !== "" && !/^#{1,6}\s+/.test(lines[end])) end += 1;
  return { start, end };
}
