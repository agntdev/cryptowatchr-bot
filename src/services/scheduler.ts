/**
 * Lightweight alert poller for the Node/long-poll entry.
 * Workers can call runAlertTick from a cron trigger later; this keeps
 * Node deploys delivering alerts without an external cron.
 *
 * Failures inside a tick (price feed outage, send errors) are swallowed so
 * the interval never dies and the next cycle can recover via cache/fallback.
 */

import type { Api } from "grammy";
import { runAlertTick } from "./alerts.js";
import { getFeedHealth } from "./prices.js";

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
    void (async () => {
      try {
        await runAlertTick(send);
      } catch (err) {
        // Never let an uncaught rejection kill the scheduler.
        const health = getFeedHealth();
        console.error("[scheduler] alert tick failed", err, health);
      }
    })();
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
