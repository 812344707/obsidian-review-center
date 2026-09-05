import type {
  ParsedCardDraft,
  ReviewContent,
  ReviewSectionParseResult,
} from "./types";
import { escapeRegExp, hashText } from "./utils";

const BLOCK_ID_PATTERN = /^\s*\^(rv-[a-z0-9-]+)\s*$/i;
const QUESTION_PATTERN = /^\s*(?:[-*+]\s+)?问[:：]{2}\s*(.*?)\s*$/;
const ANSWER_PATTERN = /^\s*答[:：]{2}\s*(.*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)(?:::(.*?))?\}\}/g;

interface LineRange {
  start: number;
  end: number;
}

export function parseReviewSection(
  markdown: string,
  headingText: string,
  headingLevel: number,
): ReviewSectionParseResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const warnings: string[] = [];
  const headingRegex = new RegExp(
    `^#{${headingLevel}}\\s+${escapeRegExp(headingText.trim())}\\s*$`,
  );
  const visibleLines = maskComments(markdown).replace(/\r\n/g, "\n").split("\n");
  const matches: number[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    fence = updateFence(lines[index], fence);
    if (fence === null && headingRegex.test(visibleLines[index])) matches.push(index);
  }

  if (matches.length === 0) {
    return { found: false, valid: true, cards: [], warnings };
  }
  if (matches.length > 1) {
    return {
      found: true,
      valid: false,
      cards: [],
      warnings: [`检测到 ${matches.length} 个同名复习章节；每篇笔记只能有一个。`],
    };
  }

  const sectionStart = matches[0];
  const sectionEnd = findSectionEnd(lines, sectionStart + 1, headingLevel);
  if (sectionEnd < lines.length) {
    warnings.push("复习章节后还有同级或更高层级章节；建议把复习章节放在笔记末尾。");
  }

  const cards: ParsedCardDraft[] = [];
  const consumedLines = new Set<number>();
  parseQuestionAnswerCards(lines, sectionStart + 1, sectionEnd, cards, warnings, consumedLines);
  parseClozeCards(lines, sectionStart + 1, sectionEnd, cards, warnings, consumedLines);

  return {
    found: true,
    valid: true,
    sectionStartLine: sectionStart,
    sectionEndLine: sectionEnd,
    cards,
    warnings,
  };
}

function findSectionEnd(lines: string[], start: number, rootLevel: number): number {
  let fence: string | null = null;
  for (let index = start; index < lines.length; index += 1) {
    fence = updateFence(lines[index], fence);
    if (fence !== null) continue;
    const heading = lines[index].match(HEADING_PATTERN);
    if (heading && heading[1].length <= rootLevel) return index;
  }
  return lines.length;
}

function parseQuestionAnswerCards(
  lines: string[],
  start: number,
  end: number,
  cards: ParsedCardDraft[],
  warnings: string[],
  consumedLines: Set<number>,
): void {
  let index = start;
  let fence: string | null = null;

  while (index < end) {
    fence = updateFence(lines[index], fence);
    if (fence !== null || isIndentedCode(lines[index]) || consumedLines.has(index) || !QUESTION_PATTERN.test(lines[index])) {
      index += 1;
      continue;
    }

    const questionStart = index;
    const question = lines[index].match(QUESTION_PATTERN)?.[1]?.trim() ?? "";
    if (!question) warnings.push(`第 ${questionStart + 1} 行的问答卡问题为空。`);
    let answerLine = -1;
    let cursor = index + 1;
    let localFence: string | null = null;
    for (; cursor < end; cursor += 1) {
      localFence = updateFence(lines[cursor], localFence);
      if (localFence !== null || isIndentedCode(lines[cursor])) continue;
      if (HEADING_PATTERN.test(lines[cursor]) || QUESTION_PATTERN.test(lines[cursor])) break;
      if (ANSWER_PATTERN.test(lines[cursor])) {
        answerLine = cursor;
        break;
      }
    }

    if (answerLine < 0) {
      warnings.push(`第 ${questionStart + 1} 行的问答卡缺少“答::”。`);
      index += 1;
      continue;
    }

    let blockEnd = answerLine + 1;
    localFence = null;
    while (blockEnd < end) {
      localFence = updateFence(lines[blockEnd], localFence);
      if (
        localFence === null && !isIndentedCode(lines[blockEnd]) &&
        (QUESTION_PATTERN.test(lines[blockEnd]) || HEADING_PATTERN.test(lines[blockEnd]))
      ) {
        break;
      }
      blockEnd += 1;
    }

    const trimmedEnd = trimTrailingBlankLines(lines, answerLine, blockEnd);
    const idInfo = extractTrailingBlockId(lines, answerLine, trimmedEnd);
    const contentEnd = idInfo ? trimTrailingBlankLines(lines, answerLine, idInfo.line) : trimmedEnd;
    const answerFirstLine = lines[answerLine].match(ANSWER_PATTERN)?.[1] ?? "";
    const answerTail = lines.slice(answerLine + 1, contentEnd);
    const answer = [answerFirstLine, ...answerTail].join("\n").trim();
    if (answer.length === 0) {
      warnings.push(`第 ${questionStart + 1} 行的问答卡答案为空。`);
      index = Math.max(blockEnd, index + 1);
      continue;
    }

    const raw = lines.slice(questionStart, contentEnd).join("\n").trim();
    const content: ReviewContent = {
      question,
      answer,
      raw,
      sourceStartLine: questionStart,
      sourceEndLine: Math.max(questionStart, contentEnd - 1),
    };
    cards.push({
      kind: "qa",
      blockId: idInfo?.id,
      hash: hashText(`qa\n${question}\n${answer}`),
      content,
      insertIdAfterLine: Math.max(questionStart, contentEnd - 1),
    });
    for (let line = questionStart; line < blockEnd; line += 1) consumedLines.add(line);
    index = Math.max(blockEnd, index + 1);
  }
}

function parseClozeCards(
  lines: string[],
  start: number,
  end: number,
  cards: ParsedCardDraft[],
  warnings: string[],
  consumedLines: Set<number>,
): void {
  for (const range of collectParagraphs(lines, start, end, consumedLines)) {
    const idInfo = extractTrailingBlockId(lines, range.start, range.end);
    const contentEnd = idInfo ? trimTrailingBlankLines(lines, range.start, idInfo.line) : range.end;
    const raw = lines.slice(range.start, contentEnd).join("\n").trim();
    const searchable = maskCode(raw);
    const clozes = [...searchable.matchAll(CLOZE_PATTERN)];
    if (clozes.length === 0) continue;

    const indices = [...new Set(clozes.map((match) => Number(match[1])))].sort((a, b) => a - b);
    if (indices.some((value) => !Number.isInteger(value) || value < 1)) {
      warnings.push(`第 ${range.start + 1} 行包含无效的挖空编号。`);
      continue;
    }

    for (const clozeIndex of indices) {
      const content: ReviewContent = {
        question: raw,
        answer: raw,
        raw,
        sourceStartLine: range.start,
        sourceEndLine: Math.max(range.start, contentEnd - 1),
      };
      cards.push({
        kind: "cloze",
        blockId: idInfo?.id,
        clozeIndex,
        hash: hashText(`cloze:${clozeIndex}\n${raw}`),
        content,
        insertIdAfterLine: Math.max(range.start, contentEnd - 1),
      });
    }
  }
}

function isIndentedCode(line: string): boolean { return /^(?: {4}|\t)/.test(line); }

/** Preserve offsets so examples can also remain literal when rendering a card. */
function maskCode(markdown: string): string {
  const result: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const before = fence;
    fence = updateFence(line, fence);
    result.push(before === null && fence === null && !isIndentedCode(line) ? line : " ".repeat(line.length));
  }
  const masked = result.join("\n");
  const runs = [...masked.matchAll(/`+/g)];
  let cursor = 0;
  let output = "";
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index];
    const closing = runs.findIndex((run, next) => next > index && run[0].length === opening[0].length);
    if (closing < 0) continue;
    const end = runs[closing].index! + runs[closing][0].length;
    output += masked.slice(cursor, opening.index) + masked.slice(opening.index, end).replace(/[^\n]/g, " ");
    cursor = end; index = closing;
  }
  return output + masked.slice(cursor);
}

function collectParagraphs(
  lines: string[],
  start: number,
  end: number,
  consumedLines: Set<number>,
): LineRange[] {
  const ranges: LineRange[] = [];
  let index = start;
  let fence: string | null = null;
  while (index < end) {
    if (consumedLines.has(index) || isIndentedCode(lines[index]) || lines[index].trim() === "" || HEADING_PATTERN.test(lines[index])) {
      index += 1;
      continue;
    }
    const blockStart = index;
    while (index < end) {
      if (consumedLines.has(index)) break;
      const line = lines[index];
      fence = updateFence(line, fence);
      if (fence === null && (line.trim() === "" || HEADING_PATTERN.test(line))) break;
      index += 1;
    }
    if (fence === null) ranges.push({ start: blockStart, end: index });
    while (index < end && lines[index].trim() === "") index += 1;
  }
  return ranges;
}

function extractTrailingBlockId(
  lines: string[],
  minimumLine: number,
  endExclusive: number,
): { id: string; line: number } | undefined {
  for (let index = endExclusive - 1; index >= minimumLine; index -= 1) {
    if (lines[index].trim() === "") continue;
    const match = lines[index].match(BLOCK_ID_PATTERN);
    return match ? { id: match[1].toLowerCase(), line: index } : undefined;
  }
  return undefined;
}

function trimTrailingBlankLines(lines: string[], minimumLine: number, endExclusive: number): number {
  let result = endExclusive;
  while (result > minimumLine && lines[result - 1].trim() === "") result -= 1;
  return result;
}

function updateFence(line: string, current: string | null): string | null {
  const match = line.match(/^\s*(```+|~~~+)/);
  if (!match) return current;
  const marker = match[1];
  if (current === null) return marker;
  return current[0] === marker[0] && marker.length >= current.length && line.slice((match.index ?? 0) + match[0].length).trim() === "" ? null : current;
}

export function insertMissingBlockIds(
  markdown: string,
  drafts: ParsedCardDraft[],
  makeId: () => string,
): string {
  const missingGroups = new Map<number, ParsedCardDraft[]>();
  for (const draft of drafts) {
    if (draft.blockId) continue;
    const group = missingGroups.get(draft.insertIdAfterLine) ?? [];
    group.push(draft);
    missingGroups.set(draft.insertIdAfterLine, group);
  }
  if (missingGroups.size === 0) return markdown;

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const insertions = [...missingGroups.keys()].sort((a, b) => b - a);
  for (const line of insertions) {
    const id = makeId();
    lines.splice(line + 1, 0, `${missingGroups.get(line)?.[0].insertIdPrefix ?? ""}^${id}`);
  }
  return lines.join("\n");
}

export function renderCloze(raw: string, targetIndex: number, answerSide: boolean): string {
  const searchable = maskCode(raw);
  return raw.replace(CLOZE_PATTERN, (full, indexText: string, answer: string, hint: string | undefined, offset: number) => {
    if (searchable.slice(offset, offset + full.length) !== full) return full;
    const index = Number(indexText);
    if (answerSide) return index === targetIndex ? `==${answer}==` : answer;
    if (index === targetIndex) return hint ? `[${hint}]` : "[…]";
    return answer;
  });
}

export interface CalloutRange {
  type: string;
  start: number;
  end: number;
}

function maskComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)/g, (text) => text.replace(/[^\n]/g, " "));
}

/** Physical line numbers are retained; only the owning quote prefix is stripped. */
export function calloutRanges(markdown: string): CalloutRange[] {
  const lines = maskComments(markdown.replace(/\r\n/g, "\n")).split("\n");
  const ranges: CalloutRange[] = [];
  let fence: string | null = null;
  let frontmatter = lines[0]?.trim() === "---";
  for (let index = frontmatter ? 1 : 0; index < lines.length; index += 1) {
    if (frontmatter) { if (lines[index].trim() === "---") frontmatter = false; continue; }
    fence = updateFence(lines[index], fence);
    if (fence !== null) continue;
    if (!/^ {0,3}>/.test(lines[index])) continue;
    const match = lines[index].match(/^ {0,3}> ?\[!([a-z0-9_-]+)\](?:[+-])?(?:\s.*)?$/i);
    let end = index + 1;
    while (end < lines.length && /^ {0,3}>/.test(lines[end])) end += 1;
    if (match) ranges.push({ type: match[1].toLowerCase(), start: index, end });
    index = end - 1;
  }
  return ranges;
}

export function parseReviewCallouts(markdown: string, types: string[] = ["review"]): ReviewSectionParseResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const normalized = new Set(types.map((type) => type.toLowerCase()));
  const ranges = calloutRanges(markdown).filter((range) => normalized.has(range.type));
  const cards: ParsedCardDraft[] = [];
  const warnings: string[] = [];
  for (const range of ranges) {
    const virtual = [...lines];
    const nested = new Set<number>();
    let fence: string | null = null;
    for (let index = range.start + 1; index < range.end; index += 1) {
      virtual[index] = virtual[index].replace(/^ {0,3}> ?/, "");
      if (/^\s*>/.test(virtual[index])) nested.add(index);
      fence = updateFence(virtual[index], fence);
    }
    if (fence !== null) warnings.push("第 " + (range.start + 1) + " 行的复习块中有未关闭的代码块。");
    const masked = maskComments(virtual.join("\n")).split("\n");
    const before = cards.length;
    parseQuestionAnswerCards(masked, range.start + 1, range.end, cards, warnings, nested);
    parseClozeCards(masked, range.start + 1, range.end, cards, warnings, nested);
    for (const card of cards.slice(before)) card.insertIdPrefix = lines[card.insertIdAfterLine].match(/^ {0,3}> ?/)?.[0] ?? "> ";
  }
  const ids = new Set<string>();
  const owners = new Map<string, number>();
  for (const card of cards) {
    if (!card.blockId) continue;
    const owner = owners.get(card.blockId);
    if (owner !== undefined && owner !== card.content.sourceStartLine) warnings.push("多个卡片块使用同一标识：" + card.blockId);
    owners.set(card.blockId, card.content.sourceStartLine);
    const key = card.blockId + ":" + (card.kind === "qa" ? "qa" : card.clozeIndex);
    if (ids.has(key)) warnings.push("卡片 ID 重复：" + key + "；请保留原进度并修复标识。");
    ids.add(key);
  }
  return { found: ranges.length > 0, valid: warnings.length === 0, cards, warnings };
}

export interface LegacyConversion {
  changed: boolean;
  markdown: string;
  warnings: string[];
}

/** A legacy heading is migration input only, never the active card format. */
export function convertLegacySection(markdown: string, heading: string, level: number, types = ["review"]): LegacyConversion {
  const legacy = parseReviewSection(markdown, heading, level);
  if (!legacy.found) return { changed: false, markdown, warnings: [] };
  const warnings = legacy.warnings.filter((warning) => !warning.includes("建议把复习章节放在笔记末尾"));
  if (!legacy.valid || warnings.length) return { changed: false, markdown, warnings };
  const current = parseReviewCallouts(markdown, types);
  if (!current.valid) return { changed: false, markdown, warnings: current.warnings };
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = legacy.sectionStartLine!;
  let end = legacy.sectionEndLine!;
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  // Existing callouts inside an old section would become nested and cease to be
  // independent containers. Leave ambiguous documents untouched for repair.
  if (calloutRanges(markdown).some((range) => range.start > start && range.start < end)) {
    return { changed: false, markdown, warnings: ["旧复习章节中已有提示块，请先将提示块移到章节外，再重试迁移。"] };
  }
  const replacement = ["> [!review]- " + heading, ...lines.slice(start + 1, end).map((line) => "> " + line)];
  // Separate the block from any neighbouring blockquote.
  if (start > 0 && lines[start - 1].trim()) replacement.unshift("");
  if (end < lines.length && lines[end].trim()) replacement.push("");
  lines.splice(start, end - start, ...replacement);
  let converted = lines.join("\n");
  if (markdown.includes("\r\n")) converted = converted.replace(/\n/g, "\r\n");
  const next = parseReviewCallouts(converted, types);
  const signature = (drafts: ParsedCardDraft[]) => drafts.map((card) =>
    [card.kind, card.clozeIndex ?? null, card.blockId ?? null, card.hash]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!next.valid || JSON.stringify(signature(next.cards)) !== JSON.stringify(signature([...legacy.cards, ...current.cards]))) {
    return { changed: false, markdown, warnings: [...next.warnings, "转换前后卡片内容或标识不一致，已保留原笔记和进度。"] };
  }
  return { changed: true, markdown: converted, warnings: [] };
}
