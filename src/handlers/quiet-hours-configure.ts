import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem } from "../toolkit/index.js";
import { ensureProfile, getProfile, saveProfile } from "../services/users.js";
import { parseHHMM } from "../lib/time.js";
import { backKeyboard, cancelKeyboard } from "../lib/ui.js";
import { DEFAULT_QUIET_END, DEFAULT_QUIET_START } from "../lib/models.js";

registerMainMenuItem({
  label: "Quiet hours",
  data: "quiet_hours:configure",
  order: 40,
});

const composer = new Composer<Ctx>();

composer.callbackQuery("quiet_hours:configure", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from?.id;
  if (uid == null) return;
  const profile = await ensureProfile(uid, ctx.from?.first_name ?? "User");
  const start = profile.quiet_hours_start ?? DEFAULT_QUIET_START;
  const end = profile.quiet_hours_end ?? DEFAULT_QUIET_END;
  ctx.session.step = "awaiting_quiet_start";
  ctx.session.pendingQuietStart = undefined;
  const text =
    `Quiet hours mute alert delivery (they're queued and sent when quiet hours end).\n\n` +
    `Current: ${start} – ${end} (${profile.timezone})\n\n` +
    `Send the start time as HH:MM (24h), e.g. 22:00.`;
  try {
    await ctx.editMessageText(text, { reply_markup: cancelKeyboard() });
  } catch {
    await ctx.reply(text, { reply_markup: cancelKeyboard() });
  }
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (step !== "awaiting_quiet_start" && step !== "awaiting_quiet_end") {
    return next();
  }
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();

  const parsed = parseHHMM(text);
  if (!parsed) {
    await ctx.reply("Use 24-hour HH:MM, e.g. 22:00 or 08:30.", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  const uid = ctx.from?.id;
  if (uid == null) return;

  if (step === "awaiting_quiet_start") {
    ctx.session.pendingQuietStart = `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`;
    ctx.session.step = "awaiting_quiet_end";
    await ctx.reply(
      `Start set to ${ctx.session.pendingQuietStart}. Now send the end time (HH:MM), e.g. 08:00.`,
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  const end = `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`;
  const start = ctx.session.pendingQuietStart ?? DEFAULT_QUIET_START;
  const profile = (await getProfile(uid)) ?? (await ensureProfile(uid, ctx.from?.first_name ?? "User"));
  profile.quiet_hours_start = start;
  profile.quiet_hours_end = end;
  await saveProfile(profile);
  ctx.session.step = "idle";
  ctx.session.pendingQuietStart = undefined;
  await ctx.reply(
    `Quiet hours updated: ${start} – ${end} (${profile.timezone}).\n` +
      `Alerts that fire during this window are queued and delivered after it ends.`,
    { reply_markup: backKeyboard() },
  );
});

export default composer;
