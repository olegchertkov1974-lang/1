# Gerchik Trading Bot — n8n + Claude AI + Bybit

Автоматический торговый бот на основе системы Александра Герчика.
Использует Claude Sonnet для анализа рынка и принятия торговых решений.

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    n8n Orchestrator                          │
│                                                             │
│  WF1: Market Scanner ──webhook──▶ WF2: Trade Executor       │
│       (каждые 15 мин)                 (по сигналу)          │
│                                                             │
│  WF3: Position Manager              WF4: Risk Guardian      │
│       (каждую 1 мин)                     (каждые 5 мин)     │
│                                                             │
│  WF5: Telegram Control Bot           WF6: Watchdog          │
│       (по команде)                       (каждые 10 мин)    │
└──────────┬──────────┬───────────┬──────────┬────────────────┘
           │          │           │          │
   OpenRouter    Bybit API   Telegram   Monitoring
   (Claude AI)
```

## Воркфлоу

### WF1 — Market Scanner (`01-market-scanner.json`)
- Запуск каждые 15 минут
- Получает топ-20 пар по объёму (>$50M за 24ч)
- Загружает свечи по 3 таймфреймам (4H, 1H, 15m)
- Вычисляет уровни поддержки/сопротивления
- Claude анализирует каждую пару по системе Герчика
- Фильтрует сигналы: confidence >= 75, R:R >= 3, alignment = true
- Отправляет сигнал в WF2 через webhook

### WF2 — Trade Executor (`02-trade-executor.json`)
- Принимает сигнал от WF1
- Claude подтверждает сигнал (2-е мнение, риск-менеджмент)
- Проверяет баланс, кол-во открытых позиций, дневной лимит потерь
- Рассчитывает размер позиции (1% риск)
- Выставляет ордер + стоп-лосс + тейк-профит
- Уведомление в Telegram

### WF3 — Position Manager (`03-position-manager.json`)
- Запуск каждую минуту
- Получает все открытые позиции
- Claude анализирует каждую позицию
- Переносит стоп в безубыток при 1R прибыли
- Частичная фиксация на TP1/TP2 (30%/30%)
- Полное закрытие на TP3 или при изменении структуры рынка

### WF4 — Risk Guardian (`04-risk-guardian.json`)
- Запуск каждые 5 минут
- Проверяет дневной P&L (закрытый + нереализованный)
- При превышении 3% дневной потери:
  - Отменяет все ордера
  - Закрывает все позиции
  - Останавливает бота
  - Отправляет экстренный алерт

### WF5 — Telegram Control Bot (`05-telegram-control.json`)
Команды:
- `/status` — позиции, P&L, баланс, статус бота
- `/stop` — экстренная остановка (отмена ордеров)
- `/start` — возобновление работы
- `/report` — P&L за день
- `/report week` — P&L за неделю
- `/pairs` — текущий список торговых пар по объёму
- `/set_risk 0.5` — изменить % риска на сделку (0.1—3%)
- `/mode spot|futures|both` — переключение режима торговли
- `/help` — справка

### WF6 — Watchdog (`06-watchdog.json`)
- Запуск каждые 10 минут
- Проверяет доступность Bybit API
- Проверяет доступность OpenRouter (Claude)
- Проверяет env-переменные
- Алерт в Telegram при проблемах

## Установка

### 1. Конфигурация (через Config ноду в каждом workflow)

> **Важно:** n8n Cloud не поддерживает Environment Variables без Enterprise плана.
> Все настройки хранятся в **Config** ноде в начале каждого workflow.

После импорта каждого workflow откройте ноду **"Config"** и замените placeholder-значения (`YOUR_...`) на реальные:

```
BYBIT_API_KEY — ваш API ключ Bybit
BYBIT_API_SECRET — ваш API секрет Bybit
BYBIT_TESTNET — 'true' для тестнета, 'false' для mainnet
OPENROUTER_API_KEY — ваш ключ OpenRouter
OPENROUTER_MODEL — anthropic/claude-sonnet-4-20250514
TELEGRAM_CHAT_ID — ваш chat ID в Telegram
MAX_RISK_PER_TRADE — 1 (процент риска на сделку)
MAX_DAILY_LOSS — 3 (макс. дневные потери в %)
MAX_OPEN_POSITIONS — 3
MIN_RISK_REWARD — 3
MIN_CONFIDENCE — 75
MIN_VOLUME_24H — 50000000
WEBHOOK_URL — URL вашего n8n (например https://your-n8n.beget.app/)
```

После первого запуска значения сохраняются автоматически — повторно вводить не нужно.

### 2. Bybit API ключи

1. Войдите на [bybit.com](https://www.bybit.com) (или testnet.bybit.com для тестнета)
2. **Account → API Management → Create New Key**
3. Тип: **System-Generated**
4. Разрешения: **Read + Trade** (НЕ давайте Withdraw!)
5. IP Whitelist: добавьте IP вашего сервера
6. Для тестнета: создайте отдельные ключи на testnet.bybit.com

### 3. Telegram бот

1. Напишите [@BotFather](https://t.me/BotFather)
2. `/newbot` → следуйте инструкциям
3. Сохраните токен
4. В n8n: **Credentials → Add → Telegram API** → вставьте токен
5. Получите Chat ID:
   - Напишите боту `/start`
   - Откройте `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Найдите `"chat":{"id":123456789}`

### 4. OpenRouter API ключ (Claude через OpenRouter)

1. Зарегистрируйтесь на [openrouter.ai](https://openrouter.ai)
2. **Keys → Create Key**
3. Сохраните ключ
4. Убедитесь, что на балансе OpenRouter есть средства
5. Модель по умолчанию: `anthropic/claude-sonnet-4-20250514`
6. Можно сменить модель через `OPENROUTER_MODEL` env-переменную

### 5. Импорт воркфлоу

1. Откройте n8n
2. **Workflows → Import from File**
3. Импортируйте файлы из `workflows/` **по порядку** (01 → 06)
4. В каждом воркфлоу: кликните на Telegram-ноды → обновите credentials
5. Обновите `WEBHOOK_URL` в env — должен совпадать с URL вашего n8n

### 6. Настройка credentials в n8n

В интерфейсе n8n создайте:
- **Telegram API** → Bot Token
- Env vars добавьте через Settings → Environment Variables

API-ключи Bybit и OpenRouter хранятся в Config-ноде каждого workflow (через `$getWorkflowStaticData`). Telegram Bot Token — в n8n Credentials.

## Чек-лист: запуск на тестнете

- [ ] `BYBIT_TESTNET=true` в env
- [ ] API ключи от testnet.bybit.com
- [ ] Telegram бот создан и работает (`/help` отвечает)
- [ ] OpenRouter API ключ валидный (Watchdog показывает OK)
- [ ] Импортированы все 6 воркфлоу
- [ ] Telegram credentials обновлены во всех воркфлоу
- [ ] WEBHOOK_URL указывает на ваш n8n сервер
- [ ] Активированы WF5 (Telegram Control) и WF6 (Watchdog)
- [ ] Отправьте `/status` боту — должен показать баланс тестнета
- [ ] Активируйте WF4 (Risk Guardian)
- [ ] Активируйте WF3 (Position Manager)
- [ ] Активируйте WF1 (Market Scanner) — он автоматически вызовет WF2
- [ ] Наблюдайте минимум 2 недели
- [ ] Проверьте, что Risk Guardian корректно срабатывает (симулируйте потери)

## Чек-лист: переход на mainnet

- [ ] Тестнет работал стабильно минимум 2 недели
- [ ] Win rate > 50% на тестнете
- [ ] Risk Guardian тестирован и работает
- [ ] `/stop` команда тестирована
- [ ] Создайте НОВЫЕ API ключи на mainnet bybit.com
- [ ] IP Whitelist настроен на mainnet ключах
- [ ] Разрешения: ТОЛЬКО Read + Trade (не Withdraw!)
- [ ] Замените `BYBIT_TESTNET=false`
- [ ] Замените `BYBIT_API_KEY` и `BYBIT_API_SECRET` на mainnet ключи
- [ ] Начните с уменьшенных лимитов: `MAX_RISK_PER_TRADE=0.5`
- [ ] Первые дни активно мониторьте через Telegram
- [ ] Постепенно увеличивайте `MAX_RISK_PER_TRADE` до 1%

## Безопасность

- API ключи ТОЛЬКО в env-переменных, не в коде
- Bybit ключи БЕЗ права на вывод (Withdraw)
- IP whitelist на Bybit API = IP сервера
- Telegram бот реагирует только на ваш chat ID
- `BYBIT_TESTNET=true` по умолчанию
- Risk Guardian автоматически останавливает при потерях > 3%
- Watchdog мониторит здоровье всех систем
- Если OpenRouter/Claude недоступен — бот НЕ торгует

## Структура файлов

```
n8n/
├── docker-compose.yml              # Docker: n8n + PostgreSQL
├── .env.example                    # Шаблон переменных окружения
├── README.md                       # Эта документация
├── utils/
│   ├── bybit-helpers.js            # Утилиты для Bybit API
│   └── claude-prompts.js           # Системные промты для Claude
└── workflows/
    ├── 00-config-setup.json        # Настройка конфигурации (запустить первым)
    ├── 01-market-scanner.json      # Сканер рынка
    ├── 02-trade-executor.json      # Исполнение ордеров
    ├── 03-position-manager.json    # Управление позициями
    ├── 04-risk-guardian.json       # Контроль рисков
    ├── 05-telegram-control.json    # Telegram команды
    └── 06-watchdog.json            # Мониторинг системы
```

## Disclaimer

Торговля криптовалютами несёт финансовые риски. Автоматическая торговля может привести к полной потере средств. Используйте на свой страх и риск. Обязательно тестируйте на тестнете минимум 2 недели перед переходом на реальные средства. Прошлые результаты не гарантируют будущих.
