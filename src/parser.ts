import type {
  ParsedCardDraft,
  ReviewContent,
  ReviewSectionParseResult,
} from "./types";
import { escapeRegExp, hashText } from "./utils";

const BLOCK_ID_PATTERN = /^\s*\^(rv-[a-z0-9-]+)\s*$/i;
const QUESTION_PATTERN = /^\s*(?:[-*+]\s+)?问::\s*(.+?)\s*$/;
const ANSWER_PATTERN = /^\s*答::\s*(.*)$/;
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
  const matches: number[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    fence = updateFence(lines[index], fence);
    if (fence === null && headingRegex.test(lines[index])) matches.push(index);
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
    if (fence !== null || !QUESTION_PATTERN.test(lines[index])) {
      index += 1;
      continue;
    }

    const questionStart = index;
    const question = lines[index].match(QUESTION_PATTERN)?.[1]?.trim() ?? "";
    let answerLine = -1;
    let cursor = index + 1;
    let localFence: string | null = null;
    for (; cursor < end; cursor += 1) {
      localFence = updateFence(lines[cursor], localFence);
      if (localFence !== null) continue;
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
        localFence === null &&
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
    const searchable = removeFencedCode(raw);
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

function removeFencedCode(markdown: string): string {
  const result: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const before = fence;
    fence = updateFence(line, fence);
    if (before === null && fence === null) result.push(line);
  }
  return result.join("\n");
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
    if (consumedLines.has(index) || lines[index].trim() === "" || HEADING_PATTERN.test(lines[index])) {
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
  const marker = match[1][0];
  if (current === null) return marker;
  return current === marker ? null : current;
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
    lines.splice(line + 1, 0, `^${id}`);
  }
  return lines.join("\n");
}

export function renderCloze(raw: string, targetIndex: number, answerSide: boolean): string {
  return raw.replace(CLOZE_PATTERN, (_full, indexText: string, answer: string, hint?: string) => {
    const index = Number(indexText);
    if (answerSide) return index === targetIndex ? `==${answer}==` : answer;
    if (index === targetIndex) return hint ? `[${hint}]` : "[…]";
    return answer;
  });
}
