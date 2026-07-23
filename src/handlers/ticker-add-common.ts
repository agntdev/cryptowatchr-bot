import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { COMMON_COINS, fetchPrice, formatPct, formatUsd } from "../services/prices.js";
import { ensureProfile } from "../services/users.js";
import { addTicker } from "../services/watchlist.js";
import { backKeyboard, withBack } from "../lib/ui.js";

registerMainMenuItem({ label: "Add common", data: "ticker:add_common", order: 10 });

const composer = new Composer<Ctx>();

const PICK =
  "Quick-add a popular coin. Tap one to add it to your watchlist.";

function commonKeyboard() {
  const rows = COMMON_COINS.map((c) => [
    inlineButton(`${c.name} (${c.symbol})`, `ticker:common:${c.symbol}`),
  ]);
  return withBack(rows);
}

composer.callbackQuery("ticker:add_common", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  try {
    await ctx.editMessageText(PICK, { reply_markup: commonKeyboard() });
  } catch {
    await ctx.reply(PICK, { reply_markup: commonKeyboard() });
  }
});

composer.callbackQuery(/^ticker:common:(BTC|ETH|TON)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const symbol = ctx.match[1]!;
  const info = COMMON_COINS.find((c) => c.symbol === symbol);
  if (!info) {
    await ctx.reply("Couldn't find that coin. Try again.", {
      reply_markup: backKeyboard(),
    });
    return;
  }

  const uid = ctx.from?.id;
  if (uid == null) return;
  await ensureProfile(uid, ctx.from?.first_name ?? "User");

  let quote;
  try {
    quote = await fetchPrice(info.id);
  } catch {
    await ctx.reply(
      "Price feed is unavailable right now. Try again in a moment.",
      { reply_markup: backKeyboard() },
    );
    return;
  }
  if (!quote) {
    await ctx.reply(
      "Couldn't validate that ticker against the price feed. Try again later.",
      { reply_markup: backKeyboard() },
    );
    return;
  }

  const { item, created } = await addTicker(uid, info);
  const priceLine = `${formatUsd(quote.price_usd)} (${formatPct(quote.change_24h)} 24h)`;
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
