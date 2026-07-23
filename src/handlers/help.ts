import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "CryptoWatchr keeps an eye on the coins you care about.\n\n" +
  "• Add coins to your watchlist\n" +
  "• Set price and percent-change alerts\n" +
  "• Silence alerts during quiet hours\n" +
  "• Get a daily morning summary\n" +
  "• Check prices anytime with /price\n\n" +
  "Tap /start to open the menu — everything is a button.";

const backToMenu = inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(HELP, { reply_markup: backToMenu });
  } catch {
    await ctx.reply(HELP, { reply_markup: backToMenu });
  }
});

export default composer;
