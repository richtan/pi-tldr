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
import { sanitizeTldrText } from "./sanitize.js";

const WIDGET_KEY = "pi-tldr";
const MODEL_WARNING_WIDGET_KEY = "pi-tldr-model-warning";
const NO_TLDR_MODEL_AUTH_MESSAGE = "no tldr model authenticated";
const TITLE = " tldr ";
const MIN_BOX_WIDTH = 12;

class WarningLine implements Component {
  private readonly theme: Theme;
  private readonly message: string;

  constructor(theme: Theme, message: string) {
    this.theme = theme;
    this.message = message;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.theme.fg("warning", truncateToWidth(this.message, width))];
  }
}

// The widget is immutable: each rendered TLDR gets its own component instance,
// which keeps width wrapping and theme application local to pi-tui's render pass.
class PiTldrBox implements Component {
  private readonly theme: Theme;
  private readonly tldr: string;

  constructor(theme: Theme, tldr: string) {
    this.theme = theme;
    this.tldr = tldr;
  }

  invalidate(): void {}

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

  private topBorder(width: number): string {
    const rightWidth = Math.max(1, width - visibleWidth(TITLE) - 2);
    return this.theme.fg("borderMuted", `╭${TITLE}${"─".repeat(rightWidth)}╮`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
  }

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

export function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function clearNoModelWarning(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(MODEL_WARNING_WIDGET_KEY, undefined);
}

export function showNoModelWarning(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    MODEL_WARNING_WIDGET_KEY,
    (_tui, theme) => new WarningLine(theme, NO_TLDR_MODEL_AUTH_MESSAGE),
    { placement: "aboveEditor" },
  );
}

export function showWidget(ctx: ExtensionContext, tldr: string): void {
  if (!ctx.hasUI) return;

  const safeTldr = sanitizeTldrText(tldr);
  if (!safeTldr) {
    clearWidget(ctx);
    return;
  }

  // pi supplies the active theme only when it later renders the widget, so the
  // factory closes over sanitized text instead of constructing the box here.
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new PiTldrBox(theme, safeTldr));
}

export function notifyUser(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "error",
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, level);
}
