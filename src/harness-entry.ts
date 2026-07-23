import { buildBot } from "./bot.js";
import { freezeAt, resetClock } from "./lib/clock.js";
import { resetDurableStore } from "./lib/store.js";
import { resetPriceFetch } from "./services/prices.js";

// Noon UTC on a fixed day — outside the default quiet-hours window (22:00–08:00)
// so alert-delivery specs are deterministic.
const HARNESS_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

// The Tests-gate harness imports THIS module and calls makeBot() with no args,
// replaying dialog specs tokenlessly (it fakes the Bot API transport — no real
// Telegram call is made). The token is a placeholder for replay. The agntdev-ci
// orchestrator points AGNTDEV_BOT_MODULE at the compiled dist/harness-entry.js.
export async function makeBot() {
  // Isolate durable domain state + clock between specs.
  resetDurableStore();
  resetClock();
  freezeAt(HARNESS_NOW);
  resetPriceFetch();
  return buildBot(process.env.BOT_TOKEN ?? "harness-test-token");
}
