import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  fetchPrice,
  formatPct,
  formatUsd,
  resolveTicker,
  staleSuffix,
} from "../services/prices.js";
import { ensureProfile } from "../services/users.js";
import { addTicker } from "../services/watchlist.js";
import { cancelKeyboard, backKeyboard } from "../lib/ui.js";

registerMainMenuItem({ label: "Add custom", data: "ticker:add_custom", order: 20 });

const composer = new Composer<Ctx>();

const PROMPT =
  "Send a ticker symbol or coin name (e.g. SOL or Solana).\n" +
  "I'll validate it against the price feed.";

composer.callbackQuery("ticker:add_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_custom_ticker";
  try {
    await ctx.editMessageText(PROMPT, { reply_markup: cancelKeyboard() });
  } catch {
    await ctx.reply(PROMPT, { reply_markup: cancelKeyboard() });
  }
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_custom_ticker") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();

  const uid = ctx.from?.id;
  if (uid == null) return;
  await ensureProfile(uid, ctx.from?.first_name ?? "User");

  const info = await resolveTicker(text);
  if (!info) {
    await ctx.reply(
      "Couldn't find that coin — check the spelling and try again, or tap Cancel.",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  // Resolved tickers are valid even if the live feed is down — use cache/stale.
  let quote = null;
  try {
    quote = await fetchPrice(info.id);
  } catch {
    quote = null;
  }

  const { item, created } = await addTicker(uid, info);
  ctx.session.step = "idle";
  const priceLine = quote
    ? `${formatUsd(quote.price_usd)}${staleSuffix(quote)} (${formatPct(quote.change_24h)} 24h)`
    : "Price will appear once the feed recovers.";

  if (!created) {
    await ctx.reply(
      `${item.display_name} (${item.ticker}) is already on your watchlist.\n${priceLine}`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Configure alerts", `alerts:pick:${item.ticker}`)],
          [inlineButton("Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  await ctx.reply(
    `Added ${item.display_name} (${item.ticker}) to your watchlist.\n` +
      `${priceLine}\n\n` +
      `Default alerts are off — tap Configure alerts to set thresholds.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Configure alerts", `alerts:pick:${item.ticker}`)],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
