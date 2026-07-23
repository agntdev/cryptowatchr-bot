import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { ensureProfile } from "../services/users.js";
import {
  describeAlerts,
  getItem,
  listItems,
  setPercentAlert,
  setThresholds,
} from "../services/watchlist.js";
import { backKeyboard, cancelKeyboard, withBack } from "../lib/ui.js";
import { formatUsd } from "../services/prices.js";

registerMainMenuItem({ label: "Configure alerts", data: "alerts:configure", order: 30 });

const composer = new Composer<Ctx>();

const EMPTY =
  "No coins on your watchlist yet — tap Add common or Add custom first.";

async function pickMenu(uid: number) {
  const items = await listItems(uid);
  if (items.length === 0) return null;
  const rows = items.map((it) => [
    inlineButton(
      `${it.ticker} · ${describeAlerts(it)}`.slice(0, 60),
      `alerts:pick:${it.ticker}`,
    ),
  ]);
  return withBack(rows);
}

function configMenu(ticker: string) {
  return withBack([
    [inlineButton("Above price", `alerts:th_above:${ticker}`)],
    [inlineButton("Below price", `alerts:th_below:${ticker}`)],
    [inlineButton("Percent change", `alerts:pct:${ticker}`)],
    [inlineButton("Clear alerts", `alerts:clear:${ticker}`)],
  ]);
}

composer.callbackQuery("alerts:configure", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  await ensureProfile(uid, ctx.from?.first_name ?? "User");
  const kb = await pickMenu(uid);
  if (!kb) {
    try {
      await ctx.editMessageText(EMPTY, { reply_markup: backKeyboard() });
    } catch {
      await ctx.reply(EMPTY, { reply_markup: backKeyboard() });
    }
    return;
  }
  const text = "Pick a coin to configure alerts.";
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
});

composer.callbackQuery(/^alerts:pick:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  const uid = ctx.from?.id;
  if (uid == null) return;
  const item = await getItem(uid, ticker);
  if (!item) {
    await ctx.reply("That coin isn't on your watchlist anymore.", {
      reply_markup: backKeyboard(),
    });
    return;
  }
  ctx.session.alertTicker = ticker;
  ctx.session.step = "idle";
  const text =
    `${item.display_name} (${item.ticker})\n` +
    `Current rules: ${describeAlerts(item)}\n\n` +
    `Choose what to set.`;
  try {
    await ctx.editMessageText(text, { reply_markup: configMenu(ticker) });
  } catch {
    await ctx.reply(text, { reply_markup: configMenu(ticker) });
  }
});

composer.callbackQuery(/^alerts:th_above:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  ctx.session.alertTicker = ticker;
  ctx.session.step = "awaiting_threshold_above";
  await ctx.reply(
    `Send the USD price above which you want an alert for ${ticker} (e.g. 70000).`,
    { reply_markup: cancelKeyboard() },
  );
});

composer.callbackQuery(/^alerts:th_below:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  ctx.session.alertTicker = ticker;
  ctx.session.step = "awaiting_threshold_below";
  await ctx.reply(
    `Send the USD price below which you want an alert for ${ticker} (e.g. 60000).`,
    { reply_markup: cancelKeyboard() },
  );
});

composer.callbackQuery(/^alerts:pct:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  ctx.session.alertTicker = ticker;
  ctx.session.step = "awaiting_percent";
  await ctx.reply(
    `Send a percent move and window for ${ticker}, like 5 1 (5% in 1 hour).\n` +
      `Format: <percent> <hours>`,
    { reply_markup: cancelKeyboard() },
  );
});

composer.callbackQuery(/^alerts:clear:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  const uid = ctx.from?.id;
  if (uid == null) return;
  const item = await getItem(uid, ticker);
  if (!item) {
    await ctx.reply("That coin isn't on your watchlist anymore.", {
      reply_markup: backKeyboard(),
    });
    return;
  }
  item.threshold_alerts = {};
  item.percent_alerts = [];
  item.window_price = undefined;
  item.window_started_at = undefined;
  const { saveItem } = await import("../services/watchlist.js");
  await saveItem(uid, item);
  await ctx.reply(`Cleared all alerts for ${ticker}.`, {
    reply_markup: configMenu(ticker),
  });
});

function parsePrice(text: string): number | null {
  const cleaned = text.trim().replace(/[$,]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (
    step !== "awaiting_threshold_above" &&
    step !== "awaiting_threshold_below" &&
    step !== "awaiting_percent"
  ) {
    return next();
  }
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();

  const uid = ctx.from?.id;
  const ticker = ctx.session.alertTicker;
  if (uid == null || !ticker) {
    ctx.session.step = "idle";
    await ctx.reply("Session expired — open Configure alerts again.", {
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (step === "awaiting_threshold_above" || step === "awaiting_threshold_below") {
    const price = parsePrice(text);
    if (price == null) {
      await ctx.reply("That doesn't look like a price. Send a positive number (e.g. 65000).", {
        reply_markup: cancelKeyboard(),
      });
      return;
    }
    const existing = await getItem(uid, ticker);
    const nextAlerts = { ...(existing?.threshold_alerts ?? {}) };
    if (step === "awaiting_threshold_above") nextAlerts.above = price;
    else nextAlerts.below = price;

    // Overlap note
    let note = "";
    if (
      nextAlerts.above != null &&
      nextAlerts.below != null &&
      nextAlerts.below >= nextAlerts.above
    ) {
      note =
        "\n\nNote: your below threshold is at or above the above threshold — both can fire together.";
    }

    await setThresholds(uid, ticker, nextAlerts, "replace");
    ctx.session.step = "idle";
    const label = step === "awaiting_threshold_above" ? "above" : "below";
    await ctx.reply(
      `Saved: alert when ${ticker} is ${label} ${formatUsd(price)}.${note}`,
      { reply_markup: configMenu(ticker) },
    );
    return;
  }

  // percent
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const percent = Number(parts[0]);
  const hours = Number(parts[1] ?? "1");
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    await ctx.reply("Send a percent between 0 and 100, then hours — e.g. 5 1.", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    await ctx.reply("Hours must be between 1 and 168 (one week). Example: 5 1", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  const existing = await getItem(uid, ticker);
  let overlap = "";
  if (existing && (existing.threshold_alerts.above != null || existing.threshold_alerts.below != null)) {
    overlap =
      "\n\nYou also have threshold alerts on this coin — both types can fire.";
  }

  await setPercentAlert(uid, ticker, { percent, window_hours: hours });
  ctx.session.step = "idle";
  await ctx.reply(
    `Saved: alert when ${ticker} moves ${percent}% within ${hours}h.${overlap}`,
    { reply_markup: configMenu(ticker) },
  );
});

export default composer;
