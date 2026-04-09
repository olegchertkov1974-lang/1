# n8n Workflows для торгового бота

## Импорт в n8n

1. Открой n8n: https://your-n8n-domain.com
2. Перейди в **Workflows**
3. Нажми **⋮** → **Import from File**
4. Загрузи файлы по одному:
   - `1-signal-filter.json` — основной workflow
   - `2-daily-report.json` — ежедневный отчёт
   - `3-news-sentiment.json` — анализ новостей

## Настройка после импорта

### 1. Создай credentials в n8n

**Telegram Bot:**
- Settings → Credentials → Add Credential → Telegram
- Вставь токен от @BotFather

**OpenRouter API:**
- Settings → Credentials → Add Credential → Header Auth
- Name: `Authorization`
- Value: `Bearer ТВОЙ_OPENROUTER_КЛЮЧ`

### 2. Привяжи credentials к нодам

Открой каждый workflow и в нодах Telegram / OpenRouter выбери созданные credentials.

### 3. Задай переменные окружения в n8n

Settings → Variables:
- `TELEGRAM_CHAT_ID` — твой chat ID
- `WEBHOOK_SECRET` — тот же что в .env бота

### 4. Скопируй URL вебхука

В workflow **"Signal Filter"** открой ноду **Webhook** → скопируй **Production URL**.
Вставь его в `.env` бота как `N8N_WEBHOOK_URL`.

### 5. Активируй workflows

Включи тумблер **Active** на каждом workflow.

## Что делает каждый workflow

### 1-signal-filter (основной)
```
Бот находит сигнал → отправляет в n8n webhook
  → n8n отправляет в OpenRouter для AI-анализа
  → результат в Telegram с полным разбором
  → при открытии/закрытии сделки — уведомление
  → при ошибке — алерт
```

### 2-daily-report
```
Каждый день в 20:00
  → запрашивает статус бота (баланс, аптайм)
  → запрашивает статистику сделок (win rate, PnL)
  → отправляет сводку в Telegram
```

### 3-news-sentiment
```
Каждые 30 минут
  → парсит RSS крипто-новости
  → отправляет заголовки в OpenRouter
  → AI оценивает sentiment
  → если сильно негативный → ставит бота на паузу + алерт в Telegram
```

## API бота (для кастомных workflow)

Адрес: `http://127.0.0.1:3001`
Заголовок: `x-webhook-secret: ВАШ_СЕКРЕТ`

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| GET | /status | Статус, баланс, аптайм |
| GET | /positions | Открытые позиции |
| GET | /levels?pair=BTC/USDT&timeframe=1h | Текущие уровни |
| GET | /stats | Статистика сделок |
| GET | /trades?limit=20 | Последние сделки |
| POST | /command | `{"command": "pause\|resume\|stop\|close_all\|force_scan\|daily_report"}` |
| POST | /ai-override | `{"posKey": "...", "approved": true, "reason": "..."}` |
