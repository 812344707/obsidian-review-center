import { Component, Platform, setIcon, type MarkdownView, type WorkspaceLeaf } from "obsidian";
import type { Grade } from "ts-fsrs";
import { GRADE_LABELS, REVIEW_GRADES } from "./scheduler";
import type { QueueEntry } from "./types";
import type { CardAuthoringAction } from "./card-authoring";

export type OverlayMode = "note" | "context";

interface OverlayHost {
  getOverlayEntry(): QueueEntry | null;
  getOverlayMode(): OverlayMode | null;
  previewCurrent(): ReturnType<import("./service").ReviewService["preview"]> | null;
  gradeActiveNote(rating: Grade): Promise<void>;
  canUndoReview(): boolean;
  undoActiveNote(): Promise<void>;
  returnToReview(): Promise<void>;
  exitReview(): Promise<void>;
  captureCardSelection(): void;
  authorCurrentNote(action: CardAuthoringAction): Promise<void>;
}

export class ReviewOverlay extends Component {
  private rootEl: HTMLElement | null = null;
  private ownerDocument: Document | null = null;
  private keyboardCleanup: (() => void) | null = null;

  constructor(private readonly host: OverlayHost) {
    super();
  }

  sync(leaf: WorkspaceLeaf | null, force = false): void {
    const mode = this.host.getOverlayMode();
    const entry = this.host.getOverlayEntry();
    const state = leaf?.getViewState();
    const stateFile = typeof state?.state?.file === "string" ? state.state.file : null;
    const viewFile = (leaf?.view as MarkdownView | undefined)?.file?.path ?? null;
    const isMarkdown = state?.type === "markdown" || leaf?.view.getViewType() === "markdown";
    if (
      !mode ||
      !entry ||
      !leaf ||
      (!force && (!isMarkdown || (viewFile ?? stateFile) !== entry.sourcePath))
    ) {
      this.detach();
      return;
    }
    const ownerDocument = leaf.view.containerEl.doc;
    if (this.ownerDocument !== ownerDocument) {
      this.detach();
      this.ownerDocument = ownerDocument;
    }
    if (!this.rootEl) {
      this.rootEl = ownerDocument.body.createDiv({ cls: "review-center-overlay" });
      ownerDocument.body.addClass("review-center-overlay-open");
      this.register(() => this.detach());
    }
    this.render(mode);
  }

  detach(): void {
    this.keyboardCleanup?.();
    this.keyboardCleanup = null;
    this.rootEl?.remove();
    this.ownerDocument?.body.removeClass("review-center-overlay-open");
    this.rootEl = null;
    this.ownerDocument = null;
  }

  private render(mode: OverlayMode): void {
    if (!this.rootEl) return;
    this.rootEl.empty();
    if (mode === "context") {
      const button = this.rootEl.createEl("button", {
        cls: "mod-cta review-center-return-button",
        text: "返回复习",
      });
      const icon = button.createSpan({ cls: "review-center-button-icon" });
      setIcon(icon, "undo-2");
      button.prepend(icon);
      button.addEventListener("click", () => void this.host.returnToReview());
      this.bindKeyboardVisibility();
      return;
    }

    const preview = this.host.previewCurrent();
    if (!preview) return;
    const entry = this.host.getOverlayEntry();
    const label = this.rootEl.createDiv({ cls: "review-center-overlay-label" });
    label.createSpan({ text: entry?.sourceTitle ?? "笔记复习" });
    const tools = label.createDiv({ cls: "review-authoring-actions" });
    for (const [action, title] of [["review", "制卡"], ["qa", "问答"], ["cloze", "填空"]] as const) {
      const button = tools.createEl("button", { text: title, attr: { "aria-label": title, "data-author-card": action } });
      button.onpointerdown = (event) => { this.host.captureCardSelection(); event.preventDefault(); };
      button.onclick = () => void this.host.authorCurrentNote(action);
    }
    const actions = this.rootEl.createDiv({ cls: "review-center-overlay-actions" });
    for (const grade of REVIEW_GRADES) {
      const button = actions.createEl("button", { cls: `review-grade grade-${grade}` });
      button.createSpan({ cls: "review-grade-name", text: GRADE_LABELS[grade] });
      button.createSpan({ cls: "review-grade-interval", text: preview[grade].interval });
      button.addEventListener("click", () => void this.host.gradeActiveNote(grade));
    }
    const undoButton = actions.createEl("button", {
      cls: "review-center-icon-button",
      attr: { "aria-label": "撤销上一次" },
    });
    setIcon(undoButton, "undo-2");
    undoButton.disabled = !this.host.canUndoReview();
    undoButton.addEventListener("click", () => void this.host.undoActiveNote());
    const exitButton = actions.createEl("button", {
      cls: "review-center-icon-button",
      attr: { "aria-label": "退出复习" },
    });
    setIcon(exitButton, "x");
    exitButton.addEventListener("click", () => void this.host.exitReview());
    this.bindKeyboardVisibility();
  }

  private bindKeyboardVisibility(): void {
    if (!this.rootEl || !this.ownerDocument) return;
    this.keyboardCleanup?.();
    const root = this.rootEl;
    const document = this.ownerDocument;
    const focusIn = () => {
      if (
        Platform.isMobile &&
        document.activeElement?.matches("input, textarea, [contenteditable=true]")
      ) {
        root.addClass("is-keyboard-active");
      }
    };
    const focusOut = () => {
      document.defaultView?.setTimeout(() => root.removeClass("is-keyboard-active"), 120);
    };
    const viewport = document.defaultView?.visualViewport;
    const position = () => root.style.setProperty("--review-keyboard-inset", Platform.isMobile && viewport ? `${Math.max(0, document.defaultView!.innerHeight - viewport.height - viewport.offsetTop)}px` : "0px");
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    focusIn();
    position();
    this.keyboardCleanup = () => {
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }
}
