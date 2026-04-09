# Gerchik Bot — Все команды

## 1. Подключение к VPS

Открой командную строку Windows (Win+R → cmd) и введи:
```
ssh root@YOUR_VPS_IP
```
Пароль: введи при запросе

---

## 2. Запуск бота (одна строка)

```
cd /opt/trading-bot/trading-bot && pm2 start src/bot.js --name gerchik-bot && pm2 save
```

---

## 3. Управление ботом через PM2

```bash
# Статус бота
pm2 status

# Перезапустить бота
pm2 restart gerchik-bot

# Остановить бота
pm2 stop gerchik-bot

# Запустить остановленного бота
pm2 start gerchik-bot

# Удалить бота из PM2
pm2 delete gerchik-bot

# Мониторинг CPU/RAM (выход Ctrl+C)
pm2 monit
```

---

## 4. Логи

```bash
# Последние 30 строк (разово)
pm2 logs gerchik-bot --lines 30 --nostream

# Логи в реальном времени (выход Ctrl+C)
pm2 logs gerchik-bot --lines 50

# Только ошибки
pm2 logs gerchik-bot --err --lines 30 --nostream

# Очистить все логи
pm2 flush gerchik-bot
```

---

## 5. Обновление бота (после изменений в GitHub)

```
cd /opt/trading-bot && git pull origin claude/add-gerchik-level-strategy-UwVY3 && cd trading-bot && pm2 restart gerchik-bot
```

---

## 6. Автозапуск при перезагрузке VPS

```bash
# Включить автозапуск (один раз)
pm2 startup && pm2 save

# Отключить автозапуск
pm2 unstartup
```

---

## 7. Настройки бота (.env)

```bash
# Посмотреть настройки
cat /opt/trading-bot/trading-bot/.env

# Редактировать настройки (сохранить: Ctrl+X → Y → Enter)
nano /opt/trading-bot/trading-bot/.env

# После изменения .env обязательно перезапустить
pm2 restart gerchik-bot
```

---

## 8. API бота (curl запросы на VPS)

```bash
# Статус бота
curl http://localhost:3001/status

# Открытые позиции
curl http://localhost:3001/positions

# Найденные уровни Герчика
curl http://localhost:3001/levels

# Статистика торговли
curl http://localhost:3001/stats

# История сделок
curl http://localhost:3001/trades
```

---

## 9. Управление через API

```bash
# Поставить на паузу
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"pause"}'

# Возобновить работу
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"resume"}'

# Остановить бота
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"stop"}'

# Закрыть все позиции
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"close_all"}'

# Принудительное сканирование
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"force_scan"}'

# Дневной отчёт
curl -X POST http://localhost:3001/command -H "Content-Type: application/json" -d '{"command":"daily_report"}'
```

---

## 10. Telegram команды

Напиши боту в Telegram:

| Команда | Описание |
|---------|----------|
| /menu   | Панель управления с кнопками |
| /status | Баланс, позиции, статистика |
| /positions | Список позиций с кнопками закрытия |
| /pause  | Приостановить сканирование |
| /resume | Возобновить сканирование |
| /stop   | Остановить бота |
| /close_all | Закрыть все позиции |

---

## 11. Полезные команды Linux

```bash
# Проверить свободное место на диске
df -h

# Проверить использование RAM
free -h

# Перезагрузить VPS
reboot

# Проверить запущенные процессы
htop
```

---

## 12. Быстрый старт с нуля (если бот удалён)

```bash
# 1. Клонировать репозиторий
cd /opt && git clone https://github.com/olegchertkov1974-lang/1.git trading-bot

# 2. Переключиться на ветку
cd trading-bot && git checkout claude/add-gerchik-level-strategy-UwVY3

# 3. Установить зависимости
cd trading-bot && npm install

# 4. Создать .env (заполнить ключи)
cp .env.example .env && nano .env

# 5. Запустить бота
pm2 start src/bot.js --name gerchik-bot && pm2 save && pm2 startup
```
