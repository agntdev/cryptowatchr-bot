import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  fetchPrice,
  fetchPrices,
  formatPct,
  formatUsd,
  resolveTicker,
} from "../services/prices.js";
import { ensureProfile } from "../services/users.js";
import { getItem, listItems } from "../services/watchlist.js";
import { backKeyboard, cancelKeyboard } from "../lib/ui.js";
import { evaluateUserAlerts } from "../services/alerts.js";

const composer = new Composer<Ctx>();

const PROMPT =
  "Send a ticker (e.g. BTC) or all for every coin on your watchlist.";

composer.command("price", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from?.id;
  if (uid != null) await ensureProfile(uid, ctx.from?.first_name ?? "User");

  if (arg) {
    await handlePriceQuery(ctx, arg);
    return;
  }
  ctx.session.step = "awaiting_price_ticker";
  await ctx.reply(PROMPT, {
    reply_markup: inlineKeyboard([
      [inlineButton("All watchlist", "price:all")],
      [inlineButton("Cancel", "flow:cancel")],
      [inlineButton("Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery("price:all", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await handlePriceQuery(ctx, "all");
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_price_ticker") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  ctx.session.step = "idle";
  await handlePriceQuery(ctx, text);
});

async function handlePriceQuery(
  ctx: Ctx,
  raw: string,
): Promise<void> {
  const uid = ctx.from?.id;
  const q = raw.trim();
  if (!q) {
    await ctx.reply(PROMPT, { reply_markup: cancelKeyboard() });
    return;
  }

  if (q.toLowerCase() === "all") {
    if (uid == null) return;
    const items = await listItems(uid);
    if (items.length === 0) {
      await ctx.reply(
        "Your watchlist is empty — add a coin first, or send a single ticker.",
        { reply_markup: backKeyboard() },
      );
      return;
    }
    let quotes;
    try {
      quotes = await fetchPrices(items.map((i) => i.coingecko_id));
    } catch {
      await ctx.reply("Price feed is unavailable right now. Try again shortly.", {
        reply_markup: backKeyboard(),
      });
      return;
    }
    const lines: string[] = ["Watchlist prices:"];
    for (const item of items) {
      const quote = quotes.get(item.coingecko_id);
      if (!quote) {
        lines.push(`• ${item.ticker}: unavailable`);
        continue;
      }
      const last =
        item.last_notified_price != null
          ? ` · last alert ${formatUsd(item.last_notified_price)}`
          : "";
      lines.push(
        `• ${item.display_name} (${item.ticker}): ${formatUsd(quote.price_usd)} (${formatPct(quote.change_24h)} 24h)${last}`,
      );
    }
    await ctx.reply(lines.join("\n"), { reply_markup: backKeyboard() });

    // Opportunistic alert evaluation on price check
    try {
      await evaluateUserAlerts(uid, async (chatId, text) => {
        await ctx.api.sendMessage(chatId, text);
      });
    } catch {
      /* non-fatal */
    }
    return;
  }

  const info = await resolveTicker(q);
  if (!info) {
    await ctx.reply(
      "Couldn't find that coin — check the spelling and try again.",
      { reply_markup: backKeyboard() },
    );
    return;
  }
  let quote;
  try {
    quote = await fetchPrice(info.id);
  } catch {
    await ctx.reply("Price feed is unavailable right now. Try again shortly.", {
      reply_markup: backKeyboard(),
    });
    return;
  }
  if (!quote) {
    await ctx.reply("No price data for that ticker right now.", {
      reply_markup: backKeyboard(),
    });
    return;
  }

  let lastLine = "";
  if (uid != null) {
    const item = await getItem(uid, info.symbol);
    if (item?.last_notified_price != null) {
      lastLine = `\nLast alert price: ${formatUsd(item.last_notified_price)}`;
    }
  }

  await ctx.reply(
    `${quote.name} (${quote.symbol})\n` +
      `Price: ${formatUsd(quote.price_usd)}\n` +
      `24h change: ${formatPct(quote.change_24h)}` +
      lastLine,
    { reply_markup: backKeyboard() },
  );
}

export default composer;
