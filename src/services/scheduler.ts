/**
 * Lightweight alert poller for the Node/long-poll entry.
 * Workers can call runAlertTick from a cron trigger later; this keeps
 * Node deploys delivering alerts without an external cron.
 */

import type { Api } from "grammy";
import { runAlertTick } from "./alerts.js";

let timer: ReturnType<typeof setInterval> | null = null;

export function startAlertScheduler(api: Api, intervalMs = 60_000): void {
  if (timer) return;
  const send = async (chatId: number, text: string) => {
    try {
      await api.sendMessage(chatId, text);
    } catch {
      // tolerate 403 blocked users
    }
  };
  // Don't fire immediately on boot — wait one interval.
  timer = setInterval(() => {
    void runAlertTick(send);
  }, intervalMs);
  // unref so the timer doesn't keep the process alive alone (tests/node exit)
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
}

export function stopAlertScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
