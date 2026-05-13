/**
 * @fileoverview Terminal UI rendering and notifications for pi-tldr.
 *
 * This module contains the compact bordered widget displayed above pi's input bar
 * and small helpers for showing, clearing, and notifying through pi's extension
 * UI context.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-tldr";
const TITLE = " tldr ";
const MIN_BOX_WIDTH = 12;

/** Boxed widget component that renders the latest TLDR above pi's input bar. */
class PiTldrBox implements Component {
  private readonly theme: Theme;
  private readonly tldr: string;

  /**
   * Creates a renderable TLDR widget.
   *
   * @param theme Active pi theme used for border/text colors.
   * @param tldr Plain-English TLDR to display.
   */
  constructor(theme: Theme, tldr: string) {
    this.theme = theme;
    this.tldr = tldr;
  }

  /** pi-tui invalidation hook; TLDR boxes are immutable after creation. */
  invalidate(): void {}

  /** Renders the TLDR into a bordered, width-aware widget. */
  render(width: number): string[] {
    if (width < MIN_BOX_WIDTH) {
      return [truncateToWidth(`${TITLE.trim()}: ${this.tldr}`, width)];
    }

    const contentWidth = width - 4;
    const lines = wrapTextWithAnsi(this.tldr, contentWidth);
    const contentLines = lines.length === 0 ? [""] : lines;
    return [
      this.topBorder(width),
      ...this.contentLines(contentLines, contentWidth),
      this.bottomBorder(width),
    ];
  }

  /** Renders the title-bearing top border. */
  private topBorder(width: number): string {
    const rightWidth = Math.max(1, width - visibleWidth(TITLE) - 2);
    return this.theme.fg("borderMuted", `╭${TITLE}${"─".repeat(rightWidth)}╮`);
  }

  /** Renders the bottom border. */
  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
  }

  /** Renders all padded TLDR lines inside the box. */
  private contentLines(
    lines: readonly string[],
    contentWidth: number,
  ): string[] {
    const renderedLines: string[] = [];
    for (const line of lines) {
      renderedLines.push(this.contentLine(line, contentWidth));
    }
    return renderedLines;
  }

  /** Renders one padded TLDR line inside the box. */
  private contentLine(line: string, contentWidth: number): string {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return [
      this.theme.fg("borderMuted", "│ "),
      this.theme.fg("text", line),
      padding,
      this.theme.fg("borderMuted", " │"),
    ].join("");
  }
}

/** Clears the TLDR widget when a run/session no longer has a current TLDR. */
export function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/** Displays a new TLDR widget when a UI is available. */
export function showWidget(ctx: ExtensionContext, tldr: string): void {
  if (!ctx.hasUI) return;

  // pi calls this factory when rendering the widget.
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new PiTldrBox(theme, tldr));
}

/** Sends a user-visible pi notification when a UI is available. */
export function notifyUser(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "error",
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, level);
}
