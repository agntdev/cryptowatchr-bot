import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getFeedHealth } from "../services/prices.js";
import { getStats, isOwner } from "../services/users.js";
import { backKeyboard } from "../lib/ui.js";

const composer = new Composer<Ctx>();

async function dashboardText(): Promise<string> {
  const stats = await getStats();
  const counts = Object.entries(stats.alert_counts).sort((a, b) => b[1] - a[1]);
  const top =
    counts.length === 0
      ? "No alerts fired yet."
      : counts
          .slice(0, 5)
          .map(([t, n], i) => `${i + 1}. ${t} — ${n} alert${n === 1 ? "" : "s"}`)
          .join("\n");

  const types = Object.entries(stats.alert_type_counts).sort((a, b) => b[1] - a[1]);
  const typeLine =
    types.length === 0
      ? "—"
      : types.map(([k, n]) => `${k}: ${n}`).join(", ");

  const health = getFeedHealth();
  const feedLine =
    `Price feed: CoinGecko ${health.coingecko.state}, Binance ${health.binance.state}` +
    (health.last_error ? `\nLast feed error: ${health.last_error}` : "");

  return (
    `Owner dashboard\n\n` +
    `Total users: ${stats.total_users}\n\n` +
    `Top alerts by ticker:\n${top}\n\n` +
    `By type: ${typeLine}\n\n` +
    `${feedLine}\n\n` +
    `Aggregated stats only — no individual user data.`
  );
}

function dashKeyboard() {
  return inlineKeyboard([
    [inlineButton("Refresh", "owner:dashboard")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
}

composer.callbackQuery("owner:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (!isOwner(uid)) {
    await ctx.reply("That dashboard is only available to the bot owner.", {
      reply_markup: backKeyboard(),
    });
    return;
  }
  const text = await dashboardText();
  try {
    await ctx.editMessageText(text, { reply_markup: dashKeyboard() });
  } catch {
    await ctx.reply(text, { reply_markup: dashKeyboard() });
  }
});

export default composer;
