import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  mainMenuKeyboard,
  mainMenuItems,
} from "../toolkit/index.js";
import { ensureProfile, isOwner } from "../services/users.js";

// /start — onboarding + main menu. Features register their own buttons via
// registerMainMenuItem; this handler only renders them (plus owner dashboard).

const composer = new Composer<Ctx>();

export const WELCOME =
  "CryptoWatchr — track prices, set alerts, and get a morning summary.\n\n" +
  "Tap a button below to get started.";

function menuFor(uid: number | undefined) {
  if (isOwner(uid)) {
    const items = mainMenuItems();
    const rows = [];
    const cols = 2;
    for (let i = 0; i < items.length; i += cols) {
      rows.push(
        items.slice(i, i + cols).map((it) => inlineButton(it.label, it.data)),
      );
    }
    rows.push([inlineButton("Owner dashboard", "owner:dashboard")]);
    rows.push([inlineButton("Help", "menu:help")]);
    return inlineKeyboard(rows);
  }
  return mainMenuKeyboard();
}

composer.command("start", async (ctx) => {
  const uid = ctx.from?.id;
  if (uid != null) {
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ");
    await ensureProfile(uid, name);
  }
  ctx.session.step = "idle";
  ctx.session.alertTicker = undefined;
  ctx.session.pendingQuietStart = undefined;
  await ctx.reply(WELCOME, { reply_markup: menuFor(uid) });
});

composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.alertTicker = undefined;
  ctx.session.pendingQuietStart = undefined;
  const uid = ctx.from?.id;
  try {
    await ctx.editMessageText(WELCOME, { reply_markup: menuFor(uid) });
  } catch {
    await ctx.reply(WELCOME, { reply_markup: menuFor(uid) });
  }
});

composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.alertTicker = undefined;
  ctx.session.pendingQuietStart = undefined;
  await ctx.reply("Cancelled. Here's the menu.", {
    reply_markup: menuFor(ctx.from?.id),
  });
});

export default composer;
