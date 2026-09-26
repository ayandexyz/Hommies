/** Desktop notifications through the freedesktop `notify-send` client. */
import { execFile } from "node:child_process";

export interface BridgeNotification {
  /** Notifications with the same key replace each other (one per session). */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly urgency: "low" | "normal" | "critical";
}

export type BridgeNotifier = (notification: BridgeNotification) => void;

/**
 * Returns a notifier that shells out to `notify-send` without a shell, so
 * titles and summaries are never interpreted as commands. Failures (no
 * notification daemon, missing binary) are ignored: notifications are an
 * extra surface, never required.
 */
export function createDesktopNotifier(command = "notify-send"): BridgeNotifier {
  const ids = new Map<string, string>();
  return (notification) => {
    const args = ["--app-name=agent-fold", `--urgency=${notification.urgency}`, "--print-id"];
    const previous = ids.get(notification.key);
    if (previous !== undefined) args.push(`--replace-id=${previous}`);
    // Servers that advertise body-markup parse the body as markup.
    args.push("--", notification.title, escapeMarkup(notification.body));
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => {
      if (error) return;
      const id = String(stdout).trim();
      if (/^\d+$/.test(id)) ids.set(notification.key, id);
    });
  };
}

export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
