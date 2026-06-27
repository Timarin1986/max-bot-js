// ═══════════════════════════════════════════════════════════════
//  Тестовый бот для MAX (эхо) — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ═══════════════════════════════════════════════════════════════

// ВРЕМЕННО отключаем проверку SSL (только для теста)
// В production эту строку нужно УДАЛИТЬ!
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// ─── Проверка токена ───────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Ошибка: токен не задан в файле .env (BOT_TOKEN)');
  process.exit(1);
}

// ─── Сервер ────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── Функция отправки сообщения ──────────────────────────────
async function sendMessage(chatId, text) {
  // Правильный эндпоинт: platform-api2.max.ru/messages?user_id=...
  const url = `https://platform-api2.max.ru/messages?user_id=${chatId}`;
  try {
    const response = await axios.post(
      url,
      { text },
      {
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✅ Сообщение отправлено пользователю ${chatId}:`, response.status);
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data || error.message;
    console.error(`❌ Ошибка отправки сообщения (${status}):`, data);
    // Дополнительная диагностика
    if (status === 404) {
      console.error('   ➜ Проверьте, что вы используете правильный user_id (не chat_id)');
    }
    throw error;
  }
}

// ─── Обработчик вебхука (с подробным логированием) ───────────
app.post('/webhook', async (req, res) => {
  console.log('🔥 ВЕБХУК ВЫЗВАН!');
  const update = req.body;
  console.log('📩 Полный update:', JSON.stringify(update, null, 2));

  const msg = update.message;
  if (!msg) {
    console.log('⚠️ Нет поля message');
    res.sendStatus(200);
    return;
  }

  // ✅ Правильное извлечение ID получателя:
  // Для ответа в диалоге используем ID отправителя (sender.user_id)
  const chatId = msg.sender?.user_id ||   // приоритет – ID пользователя, написавшего сообщение
                 msg.recipient?.chat_id || // запасной вариант
                 msg.chat?.id ||
                 msg.from?.id;
  console.log(`🔍 Найден chatId (user_id): ${chatId}`);

  const text = msg.body?.text || msg.text;
  console.log(`🔍 Найден текст: "${text}"`);

  if (chatId && text) {
    console.log(`👤 Отправляем ответ пользователю ${chatId}`);
    await sendMessage(chatId, 'я на связи');
  } else {
    console.log(`⚠️ Нет данных для ответа: chatId=${chatId}, text=${text}`);
  }

  res.sendStatus(200);
});

// ─── Регистрация вебхука ──────────────────────────────────────
async function registerWebhook(webhookUrl) {
  const fullUrl = webhookUrl.endsWith('/webhook') ? webhookUrl : `${webhookUrl}/webhook`;

  try {
    const response = await axios.post(
      'https://platform-api2.max.ru/subscriptions',
      {
        url: fullUrl,
        update_types: ['message_created', 'bot_started'],
      },
      {
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Вебхук зарегистрирован:', response.data);
  } catch (error) {
    console.error(
      '❌ Ошибка регистрации вебхука:',
      error.response?.status,
      error.response?.data || error.message
    );
  }
}

// ─── Запуск сервера ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`   Ожидаем вебхуки на /webhook`);

  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    await registerWebhook(webhookUrl);
  } else {
    console.log('⚠️ Переменная WEBHOOK_URL не задана — вебхук не зарегистрирован');
  }
});