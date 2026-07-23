import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { ensureProfile } from "../services/users.js";
import {
  clearWatchlist,
  describeAlerts,
  listItems,
  removeTicker,
} from "../services/watchlist.js";
import { backKeyboard, withBack } from "../lib/ui.js";

registerMainMenuItem({ label: "Watchlist", data: "watchlist:view", order: 60 });

const composer = new Composer<Ctx>();

const EMPTY =
  "No coins yet — tap Add common or Add custom to start tracking.";

async function renderWatchlist(uid: number): Promise<{ text: string; empty: boolean }> {
  const items = await listItems(uid);
  if (items.length === 0) return { text: EMPTY, empty: true };
  const lines = items.map(
    (it) => `• ${it.display_name} (${it.ticker}) — ${describeAlerts(it)}`,
  );
  return {
    text: `Your watchlist (${items.length}):\n\n${lines.join("\n")}`,
    empty: false,
  };
}

function actionKeyboard(tickers: string[]) {
  const rows = tickers.map((t) => [
    inlineButton(`Remove ${t}`, `watchlist:rm:${t}`),
    inlineButton(`Alerts ${t}`, `alerts:pick:${t}`),
  ]);
  rows.push([inlineButton("Clear all", "watchlist:clear")]);
  return withBack(rows);
}

composer.callbackQuery("watchlist:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  await ensureProfile(uid, ctx.from?.first_name ?? "User");
  const { text, empty } = await renderWatchlist(uid);
  const items = empty ? [] : await listItems(uid);
  const kb = empty
    ? backKeyboard()
    : actionKeyboard(items.map((i) => i.ticker));
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
});

composer.callbackQuery(/^watchlist:rm:([A-Z0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticker = ctx.match[1]!;
  const uid = ctx.from?.id;
  if (uid == null) return;
  const ok = await removeTicker(uid, ticker);
  if (!ok) {
    await ctx.reply(`${ticker} wasn't on your watchlist.`, {
      reply_markup: backKeyboard(),
    });
    return;
  }
  const { text, empty } = await renderWatchlist(uid);
  const items = empty ? [] : await listItems(uid);
  await ctx.reply(`Removed ${ticker}.\n\n${text}`, {
    reply_markup: empty
      ? backKeyboard()
      : actionKeyboard(items.map((i) => i.ticker)),
  });
});

composer.callbackQuery("watchlist:clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Clear your entire watchlist and all alert settings?", {
    reply_markup: inlineKeyboard([
      [inlineButton("Clear watchlist", "watchlist:clear:yes")],
      [inlineButton("Cancel", "watchlist:view")],
    ]),
  });
});

composer.callbackQuery("watchlist:clear:yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  const n = await clearWatchlist(uid);
  await ctx.reply(
    n === 0
      ? EMPTY
      : `Cleared ${n} coin${n === 1 ? "" : "s"} from your watchlist.`,
    { reply_markup: backKeyboard() },
  );
});

export default composer;
