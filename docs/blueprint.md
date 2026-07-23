# CryptoWatchr Bot — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A personal Telegram bot that lets users track crypto prices with customizable alerts and watchlists. Users can set price thresholds, percent change alerts, manage quiet hours, and receive daily summaries. The owner gets a usage dashboard with user count and top alerts.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- individual crypto watchers
- Telegram users seeking private price alerts

## Success criteria

- users can add/remove tickers and set alerts
- alerts are delivered according to configured rules
- owner can view usage dashboard with user count and top alerts

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and start the onboarding process
- **Add Common Ticker** (button, actor: user, callback: ticker:add_common) — Show quick-add buttons for common coins like Bitcoin, Ethereum, and Toncoin
- **Add Custom Ticker** (button, actor: user, callback: ticker:add_custom) — Prompt user to enter a custom ticker symbol
- **Configure Alerts** (button, actor: user, callback: alerts:configure) — Open alert configuration menu for selected ticker
- **Set Quiet Hours** (button, actor: user, callback: quiet_hours:configure) — Configure quiet hours for alert suppression
- **Enable Morning Summary** (button, actor: user, callback: summary:enable) — Enable and configure daily morning price summary
- **View Watchlist** (button, actor: user, callback: watchlist:view) — Display current watchlist and alert settings
- **/price** (command, actor: user, command: /price) — Request on-demand price check for a ticker or entire watchlist

## Flows

### Onboarding Flow
_Trigger:_ /start

1. Display welcome message
2. Create user profile with default quiet hours and cooldowns
3. Show main menu

_Data touched:_ User profile

### Add Ticker Flow
_Trigger:_ ticker:add_common or ticker:add_custom

1. Prompt for ticker symbol
2. Validate ticker against price feed
3. Add to watchlist with default alert settings
4. Confirm addition

_Data touched:_ Watchlist item

### Configure Alerts Flow
_Trigger:_ alerts:configure

1. Select ticker to configure
2. Set threshold alerts (above/below)
3. Set percent change alerts (e.g., 5% in 1h)
4. Save and confirm

_Data touched:_ Watchlist item

### Price Check Flow
_Trigger:_ /price

1. Request ticker or 'all'
2. Fetch current price data
3. Display price, 24h change, and last-notified price if available

_Data touched:_ Watchlist item

### Morning Summary Flow
_Trigger:_ summary:enable

1. Prompt for summary time
2. Enable daily summary at specified time
3. Confirm settings

_Data touched:_ User profile

### Quiet Hours Flow
_Trigger:_ quiet_hours:configure

1. Prompt for quiet hours start/end times
2. Update user profile
3. Confirm changes

_Data touched:_ User profile

### Owner Dashboard Flow
_Trigger:_ owner:dashboard

1. Verify owner identity
2. Display total users and top alerts/tickers
3. Refresh data on demand

_Data touched:_ Global stats

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **User profile** _(retention: persistent)_ — Telegram ID, display name, timezone, quiet hours, morning summary settings
  - fields: telegram_id, display_name, timezone, quiet_hours_start, quiet_hours_end, summary_time, enabled
- **Watchlist item** _(retention: persistent)_ — Ticker symbol, display name, alert rules, last-notified price and timestamp, per-alert cooldown timestamps
  - fields: ticker, display_name, threshold_alerts, percent_alerts, last_notified_price, last_notified_time, cooldown_threshold, cooldown_percent
- **Global stats** _(retention: persistent)_ — Total users, alert firing counts per ticker and per alert type
  - fields: total_users, alert_counts

## Integrations

- **Telegram** (required) — Bot API messaging, inline buttons, owner-only dashboard messages
- **Price feed API** (required) — Fetch current crypto prices and validate tickers
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- View usage dashboard with total users and top alerts/tickers
- Access to aggregated statistics only

## Notifications

- Price alerts with coin, old price, new price, and percent change
- Morning summary of watched coins and notable price moves
- Quiet hours alert summary after quiet period ends
- Owner dashboard updates with user count and top alerts

## Permissions & privacy

- All user data is private and not shared with third parties
- Owner can only view aggregated statistics, not individual user data
- Users can delete their watchlists and alert settings at any time

## Edge cases

- Failed price feed requests with retry logic
- Multiple alerts triggering during quiet hours and queued for delivery
- Users adding invalid or unknown tickers with helpful error messages
- Users setting overlapping alert rules with clear confirmation
- Owner dashboard updates with accurate and up-to-date statistics

## Required tests

- Verify alert delivery according to configured rules and quiet hours
- Test morning summary delivery at user-chosen time
- Validate ticker validation and error handling
- Confirm owner dashboard displays correct statistics
- Test alert queuing during quiet hours and delivery after quiet period

## Assumptions

- Price feed API is reliable and available for ticker validation
- Users will follow guided prompts for alert configuration
- Owner will use a single Telegram account for dashboard access
- Default quiet hours and cooldowns are acceptable for most users
