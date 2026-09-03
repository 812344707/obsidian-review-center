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
  buriedUntil?: string;
  buriedBy?: string;
  leech?: boolean;
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
  | "change-reset"
  | "bury"
  | "unbury"
  | "reschedule";

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
  mode?: ReviewMode;
  groupId?: string;
  wasNew?: boolean;
  tagPath?: string;
  sourceTags?: string[];
  presetId?: string;
  durationMs?: number;
  /** Captured at rating time; optional so older histories and backups remain readable. */
  beforeSchedule?: SerializedFsrsCard;
  undoOf?: string;
  after: ReviewItem | null;
}

export interface ReviewParameters {
  newLimit: number;
  reviewLimit: number;
  retention: number;
  learningSteps: string[];
  relearningSteps: string[];
  maximumInterval: number;
  newIgnoreReviewLimit?: boolean;
  limitsFromTop?: boolean;
  insertion?: "sequential" | "random";
  newGather?: "created" | "created-desc" | "group" | "random-note" | "random-card";
  newSort?: "gather" | "type" | "random-note" | "random";
  newOrder?: "before" | "mixed" | "after";
  interdayOrder?: "before" | "mixed" | "after";
  reviewSort?: "due" | "due-random" | "group" | "interval" | "interval-desc" | "difficulty" | "difficulty-desc" | "retention" | "retention-desc" | "random";
  leechThreshold?: number;
  leechAction?: "tag" | "suspend";
  buryNew?: boolean;
  buryReview?: boolean;
  buryInterday?: boolean;
  weights?: number[];
  historyFilter?: string;
  healthCheck?: boolean;
  rescheduleOnChange?: boolean;
}

export interface ReviewPreset { id: string; name: string; mode: ReviewMode; parameters: ReviewParameters }
export interface NodeOptions {
  presetId?: string;
  limits?: { newLimit?: number; reviewLimit?: number };
  today?: { date: string; newLimit?: number; reviewLimit?: number };
  retention?: number;
}
export interface ReviewScope { mode: ReviewMode; groupId: string; tagPath?: string }
export interface ReviewGroup {
  id: string;
  name: string;
  tags: string[];
  presetId?: string;
  nodes?: Record<string, NodeOptions>;
  parameters: ReviewParameters;
}

export interface ReviewCenterSettings {
  noteGroups: ReviewGroup[];
  cardGroups: ReviewGroup[];
  showNoteHeatmap: boolean;
  showCardHeatmap: boolean;
  reviewHeading: string;
  reviewHeadingLevel: number;
  reviewCalloutTypes: string[];
  dataFolder: string;
  autoOpenDashboard: boolean;
  presets?: ReviewPreset[];
}

export interface StoredPluginData {
  schemaVersion: 4;
  settings: ReviewCenterSettings;
}

export interface ParsedCardDraft {
  kind: "qa" | "cloze";
  blockId?: string;
  clozeIndex?: number;
  hash: string;
  content: ReviewContent;
  insertIdAfterLine: number;
  insertIdPrefix?: string;
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
  group: ReviewGroup;
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
  tags: string[];
  item: ReviewItem;
  isNew: boolean;
  tagPath?: string;
  presetId?: string;
}

export interface QueueCounts {
  due: number;
  learning: number;
  review: number;
  new: number;
  suspended: number;
  pendingChanges: number;
  warnings: number;
}

export type ReviewMode = "note" | "card";

export interface ReviewSession {
  id: string;
  mode: ReviewMode;
  groupId?: string;
  tagPath?: string;
  extra?: boolean;
  entryKeys: string[];
  currentIndex: number;
  answerVisible: boolean;
  startedAt: string;
  currentStartedAt?: string;
  currentElapsedMs?: number;
  orderSeed?: string;
}

export interface UndoEntry {
  eventId: string;
  sourceId: string;
  itemId: string;
  before: ReviewItem;
  after: ReviewItem;
  siblings?: Array<{ before: ReviewItem; after: ReviewItem; eventId: string }>;
}

export interface FullBackup {
  schemaVersion: 1 | 2 | 3 | 4;
  kind?: "full" | "scope";
  scope?: ReviewScope;
  itemKeys?: string[];
  exportedAt: string;
  pluginVersion: string;
  settings: ReviewCenterSettings;
  records: SourceRecord[];
  history: HistoryEvent[];
}
