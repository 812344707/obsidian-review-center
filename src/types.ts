export type ReviewKind = "note" | "qa" | "cloze";

export type ReviewItemStatus = "active" | "suspended" | "removed" | "pending-change";

export type SourceStatus = "active" | "out-of-scope" | "deleted" | "parse-error";

export interface SerializedFsrsCard {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string;
}

export interface ReviewContent {
  question: string;
  answer: string;
  raw: string;
  sourceStartLine: number;
  sourceEndLine: number;
}

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  blockId?: string;
  clozeIndex?: number;
  revision: number;
  introducedAt: string;
  acceptedHash: string;
  pendingHash?: string;
  content: ReviewContent;
  schedule: SerializedFsrsCard;
  status: ReviewItemStatus;
  lastReviewedAt?: string;
}

export interface SourceRecord {
  schemaVersion: 1;
  reviewId: string;
  sourcePath: string;
  sourceTitle: string;
  sourceCreatedAt: string;
  updatedAt: string;
  tags: string[];
  sourceStatus: SourceStatus;
  warnings: string[];
  note: ReviewItem;
  cards: Record<string, ReviewItem>;
  tombstones: Record<string, number>;
}

export type HistoryAction =
  | "create"
  | "review"
  | "undo"
  | "reset"
  | "suspend"
  | "resume"
  | "remove"
  | "delete"
  | "change-keep"
  | "change-reset";

export interface HistoryEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  deviceId: string;
  sourceId: string;
  itemId: string;
  action: HistoryAction;
  occurredAt: string;
  baseRevision: number;
  nextRevision: number;
  rating?: number;
  after: ReviewItem | null;
}

export interface ReviewCenterSettings {
  watchedFolders: string[];
  excludedFolders: string[];
  reviewHeading: string;
  reviewHeadingLevel: number;
  dataFolder: string;
  noteNewLimit: number;
  noteReviewLimit: number;
  cardNewLimit: number;
  cardReviewLimit: number;
  noteRetention: number;
  cardRetention: number;
  autoOpenDashboard: boolean;
}

export interface StoredPluginData {
  schemaVersion: 1;
  settings: ReviewCenterSettings;
}

export interface ParsedCardDraft {
  kind: "qa" | "cloze";
  blockId?: string;
  clozeIndex?: number;
  hash: string;
  content: ReviewContent;
  insertIdAfterLine: number;
}

export interface ReviewSectionParseResult {
  found: boolean;
  valid: boolean;
  sectionStartLine?: number;
  sectionEndLine?: number;
  cards: ParsedCardDraft[];
  warnings: string[];
}

export interface QueueEntry {
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
  tags: string[];
  item: ReviewItem;
  isNew: boolean;
}

export interface QueueCounts {
  due: number;
  new: number;
  suspended: number;
  pendingChanges: number;
  warnings: number;
}

export type ReviewMode = "note" | "card";

export interface ReviewSession {
  id: string;
  mode: ReviewMode;
  entryKeys: string[];
  currentIndex: number;
  answerVisible: boolean;
  startedAt: string;
}

export interface UndoEntry {
  sourceId: string;
  itemId: string;
  before: ReviewItem;
  after: ReviewItem;
}

export interface FullBackup {
  schemaVersion: 1;
  exportedAt: string;
  pluginVersion: string;
  settings: ReviewCenterSettings;
  records: SourceRecord[];
  history: HistoryEvent[];
}
