#!/bin/bash
# ============================================
# Gerchik Trading Bot — Auto Deploy to n8n
# ============================================
# This script imports all 6 workflows into n8n
# via the n8n REST API.
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Requirements: curl, bash
# ============================================

set -e

# === CONFIGURATION ===
# Set these via environment variables or edit here
N8N_URL="${N8N_URL:-https://your-n8n-instance.example.com}"
N8N_API_KEY="${N8N_API_KEY:-your_n8n_api_key_here}"

# === COLORS ===
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOWS_DIR="$SCRIPT_DIR/workflows"

echo "============================================"
echo "  Gerchik Trading Bot — n8n Auto Deploy"
echo "============================================"
echo ""

# Check connection
echo -n "Проверяю подключение к n8n... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_URL/api/v1/workflows" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}OK${NC}"
elif [ "$HTTP_CODE" = "401" ]; then
  echo -e "${RED}ОШИБКА: Неверный API-ключ${NC}"
  exit 1
else
  echo -e "${RED}ОШИБКА: Не удалось подключиться (HTTP $HTTP_CODE)${NC}"
  echo "Проверьте URL и доступность n8n"
  exit 1
fi

# Import workflows
WORKFLOW_FILES=(
  "01-market-scanner.json"
  "02-trade-executor.json"
  "03-position-manager.json"
  "04-risk-guardian.json"
  "05-telegram-control.json"
  "06-watchdog.json"
)

echo ""
echo "Импорт воркфлоу..."
echo ""

IMPORTED=0
FAILED=0

for wf_file in "${WORKFLOW_FILES[@]}"; do
  filepath="$WORKFLOWS_DIR/$wf_file"

  if [ ! -f "$filepath" ]; then
    echo -e "  ${RED}✗${NC} $wf_file — файл не найден"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Import workflow via n8n API
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d @"$filepath" \
    "$N8N_URL/api/v1/workflows" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    WF_ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    WF_NAME=$(echo "$BODY" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo -e "  ${GREEN}✓${NC} $WF_NAME (ID: $WF_ID)"
    IMPORTED=$((IMPORTED + 1))
  else
    echo -e "  ${RED}✗${NC} $wf_file — ошибка (HTTP $HTTP_CODE)"
    # Show error detail
    ERROR_MSG=$(echo "$BODY" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$ERROR_MSG" ]; then
      echo "     $ERROR_MSG"
    fi
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "============================================"
echo -e "  Импортировано: ${GREEN}$IMPORTED${NC} / Ошибки: ${RED}$FAILED${NC}"
echo "============================================"

if [ $IMPORTED -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}Следующие шаги:${NC}"
  echo "1. Откройте n8n: $N8N_URL"
  echo "2. Settings → Variables — добавьте переменные окружения:"
  echo "   - OPENROUTER_API_KEY"
  echo "   - BYBIT_API_KEY, BYBIT_API_SECRET"
  echo "   - TELEGRAM_CHAT_ID"
  echo "   - BYBIT_TESTNET=true"
  echo "   - и остальные из .env.example"
  echo "3. Credentials → Add → Telegram API → вставьте токен бота"
  echo "4. В каждом воркфлоу обновите Telegram credentials"
  echo "5. Активируйте воркфлоу (начните с WF5 и WF6)"
  echo ""
fi
