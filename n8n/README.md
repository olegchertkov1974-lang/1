# Bybit Trading Assistant for n8n

Набор воркфлоу для автоматизированной торговли на бирже Bybit через n8n с уведомлениями в Telegram.

## Воркфлоу

### 1. Price Monitor (`01-price-monitor.json`)
Мониторинг цен монет каждые 5 минут с алертами в Telegram.

**Функции:**
- Отслеживание списка монет (BTC, ETH, SOL и др.)
- Алерты при достижении целевых уровней цены
- Алерты при высокой волатильности (>5% за 24ч)
- Кулдаун 15 мин между одинаковыми алертами

**Настройка:** Отредактируйте массив `WATCHLIST` в ноде "Check Price Alerts".

### 2. Auto Trader - DCA (`02-auto-trader.json`)
Автоматическая DCA-стратегия (Dollar Cost Averaging) с тейк-профитом и стоп-лоссом.

**Функции:**
- Покупка при падении цены на заданный процент
- Автоматический тейк-профит и стоп-лосс
- Лимит максимальных вложений
- Расчёт средней цены и P&L
- Уведомления обо всех действиях в Telegram

**Настройка:** Отредактируйте объект `CONFIG` в ноде "Strategy Config":
- `symbol` — торговая пара (по умолчанию BTCUSDT)
- `orderAmountUSDT` — сумма одной покупки
- `dipThreshold` — порог падения для покупки (%)
- `takeProfitPct` — тейк-профит (%)
- `stopLossPct` — стоп-лосс (%)
- `maxTotalInvestment` — максимум вложений
- `useTestnet` — **true** для тестнета!

### 3. Signal Copier (`03-signal-copier.json`)
Копирование торговых сигналов из Telegram на Bybit.

**Поддерживаемые форматы сигналов:**
```
BUY BTCUSDT 95000
SELL ETHUSDT market
LONG SOLUSDT 180 TP:200 SL:170
```

**Настройка:**
- Добавьте ID разрешённых чатов в массив `ALLOWED_CHATS`
- Установите `ORDER_AMOUNT_USDT` — сумма ордера на сигнал
- Установите `USE_TESTNET = true` для тестирования

## Установка

### 1. Переменные окружения n8n

Добавьте в настройки n8n (Settings → Environment Variables) или в файл `.env`:

```env
BYBIT_API_KEY=ваш_api_key
BYBIT_API_SECRET=ваш_api_secret
TELEGRAM_CHAT_ID=ваш_chat_id
```

### 2. Создание Telegram-бота

1. Напишите [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot` и следуйте инструкциям
3. Сохраните полученный токен бота
4. В n8n: **Credentials → Add → Telegram API** → вставьте токен

### 3. Получение Chat ID

1. Напишите вашему боту `/start`
2. Откройте в браузере: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Найдите `"chat":{"id":123456789}` — это ваш Chat ID

### 4. API-ключи Bybit

1. Войдите на [bybit.com](https://www.bybit.com)
2. **Account → API Management → Create New Key**
3. Выберите тип: **System-Generated**
4. Разрешения: **Read + Trade** (НЕ давайте Withdraw!)
5. Привяжите к IP вашего сервера для безопасности

### 5. Импорт воркфлоу

1. Откройте n8n в браузере
2. **Workflows → Import from File**
3. Импортируйте JSON-файлы из папки `workflows/`
4. В каждом воркфлоу обновите Telegram credentials (нажмите на Telegram-ноды)
5. Активируйте воркфлоу

## Безопасность

- **Всегда начинайте с тестнета Bybit** (`useTestnet: true`)
- Привяжите API-ключи к IP сервера
- Не давайте API-ключу права на вывод средств (Withdraw)
- Установите лимиты инвестиций (`maxTotalInvestment`)
- Используйте стоп-лоссы
- Мониторьте работу бота через Telegram-уведомления

## Структура файлов

```
n8n/
├── docker-compose.yml        # Docker конфигурация n8n + PostgreSQL
├── .env.example              # Пример переменных окружения
├── README.md                 # Эта инструкция
└── workflows/
    ├── 01-price-monitor.json # Мониторинг цен
    ├── 02-auto-trader.json   # DCA автоторговля
    └── 03-signal-copier.json # Копирование сигналов
```

## Disclaimer

Торговля криптовалютами несёт финансовые риски. Автоматическая торговля может привести к потере средств. Используйте на свой страх и риск. Тестируйте стратегии на тестнете перед запуском на реальные средства.
