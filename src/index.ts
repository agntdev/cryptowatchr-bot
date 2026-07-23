import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startAlertScheduler } from "./services/scheduler.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list. /price is the only free-form power shortcut
  // beyond /start and /help; everything else is button-driven.
  await setDefaultCommands(bot, [
    { command: "price", description: "Check a price or your watchlist" },
  ]);
  startAlertScheduler(bot.api);
  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
