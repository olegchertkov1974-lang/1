# n8n Workflows for Gerchik Trading Bot

Import these workflows into your n8n instance.

## Workflow 1: Signal Filter (bot → n8n → Telegram)

The bot pushes every signal to n8n via webhook. n8n can add extra
validation, forward to Telegram with buttons, or override the AI decision.

### Setup in n8n:

1. Create a **Webhook** node:
   - Method: POST
   - Path: `/webhook/trading-bot`
   - Copy the full URL and paste it into your `.env` as `N8N_WEBHOOK_URL`

2. Add an **IF** node after the webhook:
   - Condition: `{{ $json.event }}` equals `signal_pending`

3. For `signal_pending` events, add an **OpenRouter** (HTTP Request) node:
   - URL: `https://openrouter.ai/api/v1/chat/completions`
   - Method: POST
   - Headers: `Authorization: Bearer YOUR_OPENROUTER_KEY`
   - Body:
     ```json
     {
       "model": "anthropic/claude-sonnet-4-20250514",
       "messages": [{"role": "user", "content": "Confirm this trade: {{ $json.data.signal }}"}],
       "max_tokens": 200
     }
     ```

4. Add a **Telegram** node to send the result to your chat.

## Workflow 2: Daily Report

1. **Schedule Trigger**: every day at 20:00
2. **HTTP Request** node:
   - GET `http://127.0.0.1:3001/status`
   - Header: `x-webhook-secret: YOUR_WEBHOOK_SECRET`
3. **HTTP Request** node:
   - GET `http://127.0.0.1:3001/positions`
   - Header: `x-webhook-secret: YOUR_WEBHOOK_SECRET`
4. **Telegram** node: format and send the summary

## Workflow 3: News Sentiment

1. **Schedule Trigger**: every 30 minutes
2. **RSS Feed Read** node: add crypto news RSS feeds
3. **HTTP Request** to OpenRouter: analyze headlines for sentiment
4. **IF** sentiment is strongly negative:
   - **HTTP Request** POST to `http://127.0.0.1:3001/command`
   - Body: `{"command": "pause"}`
   - This pauses the bot during negative sentiment

## Webhook API Reference

All endpoints require `x-webhook-secret` header if `WEBHOOK_SECRET` is set.

| Method | Endpoint       | Description                          |
|--------|----------------|--------------------------------------|
| GET    | /status        | Bot status, balance, uptime          |
| GET    | /positions     | Open positions                       |
| GET    | /levels?pair=BTC/USDT&timeframe=1h | Current levels     |
| POST   | /command       | Send command: pause/resume/close_all/force_scan |
| POST   | /ai-override   | Override AI decision for pending signal |

### Events pushed to n8n (N8N_WEBHOOK_URL):

| Event            | When                                    |
|------------------|-----------------------------------------|
| bot_started      | Bot starts                              |
| bot_stopped      | Bot stops                               |
| tick_complete    | After each scan cycle                   |
| signal_pending   | New signal found (before execution)     |
| signal_skipped   | Signal skipped (regime/volume filter)   |
| trade_opened     | Position opened                         |
| trade_closed     | Position closed (with PnL)              |
| trade_analysis   | AI post-trade analysis complete         |
| order_rejected   | Risk manager rejected order             |
| order_error      | Exchange error placing order            |
| error            | General error                           |
