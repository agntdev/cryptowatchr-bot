import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { ensureProfile, getProfile, saveProfile } from "../services/users.js";
import { parseHHMM } from "../lib/time.js";
import { backKeyboard, cancelKeyboard } from "../lib/ui.js";

registerMainMenuItem({
  label: "Morning summary",
  data: "summary:enable",
  order: 50,
});

const composer = new Composer<Ctx>();

composer.callbackQuery("summary:enable", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  const profile = await ensureProfile(uid, ctx.from?.first_name ?? "User");
  const status = profile.summary_enabled
    ? `On at ${profile.summary_time} (${profile.timezone})`
    : "Off";
  ctx.session.step = "awaiting_summary_time";
  const text =
    `Daily morning summary of your watchlist.\n\n` +
    `Status: ${status}\n\n` +
    `Send the delivery time as HH:MM (24h), e.g. 09:00.\n` +
    `Or tap Disable to turn it off.`;
  const kb = inlineKeyboard([
    [inlineButton("Disable", "summary:disable")],
    [inlineButton("Cancel", "flow:cancel")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
});

composer.callbackQuery("summary:disable", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  const profile = await ensureProfile(uid, ctx.from?.first_name ?? "User");
  profile.summary_enabled = false;
  profile.summary_time = null;
  await saveProfile(profile);
  ctx.session.step = "idle";
  await ctx.reply("Morning summary disabled.", { reply_markup: backKeyboard() });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_summary_time") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();

  const parsed = parseHHMM(text);
  if (!parsed) {
    await ctx.reply("Use 24-hour HH:MM, e.g. 09:00.", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  const uid = ctx.from?.id;
  if (uid == null) return;
  const time = `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`;
  const profile =
    (await getProfile(uid)) ??
    (await ensureProfile(uid, ctx.from?.first_name ?? "User"));
  profile.summary_enabled = true;
  profile.summary_time = time;
  profile.last_summary_date = undefined;
  await saveProfile(profile);
  ctx.session.step = "idle";
  await ctx.reply(
    `Morning summary enabled at ${time} (${profile.timezone}).\n` +
      `You'll get a daily snapshot of your watchlist around that time.`,
    { reply_markup: backKeyboard() },
  );
});

export default composer;
