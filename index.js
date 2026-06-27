import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

const API_BASE = 'https://platform-api2.max.ru';
const questionsPath = join(__dirname, 'questions.json');
let questionsData;
try {
  questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
} catch (err) {
  console.error('❌ Ошибка чтения questions.json:', err.message);
  process.exit(1);
}

const sessions = new Map();

async function callAPI(method, params = {}) {
  const url = `${API_BASE}/${method}`;
  console.log(`📤 Отправка запроса к ${url}`, JSON.stringify(params, null, 2));
  try {
    const response = await axios.post(url, params, {
      headers: {
        Authorization: BOT_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ Ответ:`, response.data);
    return response.data;
  } catch (error) {
    console.error(
      `❌ Ошибка вызова ${method}:`,
      error.response?.status,
      error.response?.data || error.message
    );
    throw error;
  }
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const params = {
    text: text,
    format: 'markdown',
  };

  if (replyMarkup && replyMarkup.keyboard) {
    const buttons = replyMarkup.keyboard.map(row =>
      row.map(btn => ({
        type: 'callback',
        text: btn.text,
        payload: btn.callback_data || btn.text,
      }))
    );

    params.attachments = [{
      type: 'inline_keyboard',
      payload: { buttons },
    }];
  }

  return callAPI(`messages?user_id=${chatId}`, params);
}

function getSubjectDisplay(key) {
  const map = {
    gas: '🔥 Природный газ',
    ammonia: '☠️ Аммиак',
    acetylene: '⚡ Ацетилен/Кислород',
    chlorine: '☣️ Хлор',
    lulki: '🛗 Люльки',
    vessels: '⚓ Сосуды под давлением',
  };
  return map[key] || key;
}

function getSubjectName(key) {
  const map = {
    gas: 'природному газу',
    ammonia: 'аммиаку',
    acetylene: 'ацетилену и кислороду',
    chlorine: 'хлору',
    lulki: 'подъемникам (люлькам)',
    vessels: 'сосудам под давлением',
  };
  return map[key] || key;
}

async function handleStart(chatId, userId) {
  sessions.set(userId, {
    state: 'SELECTING_SUBJECT',
    subject: null,
    mode: null,
    currentQuestion: 0,
    score: 0,
    questions: [],
  });

  const subjects = Object.keys(questionsData);
  const keyboard = {
    keyboard: subjects.map((s) => [{ 
      text: getSubjectDisplay(s),
      callback_data: s,
    }]),
  };
  await sendMessage(
    chatId,
    'Добро пожаловать в систему тестирования по промышленной безопасности!\n\nВыберите тему:',
    keyboard
  );
}

async function handleSubjectSelection(chatId, userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  const subjects = Object.keys(questionsData);
  const selected = subjects.find(
    (s) => getSubjectDisplay(s) === text || s === text
  );
  if (!selected) {
    await sendMessage(chatId, 'Пожалуйста, выберите тему из списка, нажав на кнопку.');
    return;
  }

  session.subject = selected;
  session.state = 'SELECTING_MODE';

  const keyboard = {
    keyboard: [
      [{ text: '📚 Обычный режим', callback_data: 'normal' }],
      [{ text: '🎯 Тестовый режим (10 вопросов)', callback_data: 'test' }],
    ],
  };
  await sendMessage(
    chatId,
    `Вы выбрали тему: ${getSubjectName(selected)}\n\nТеперь выберите режим тестирования:`,
    keyboard
  );
}

async function handleModeSelection(chatId, userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  const isNormal = text === 'normal' || text.includes('Обычный');
  const isTest = text === 'test' || text.includes('Тестовый');
  if (!isNormal && !isTest) {
    await sendMessage(chatId, 'Пожалуйста, выберите режим, нажав на кнопку.');
    return;
  }

  const questions = questionsData[session.subject];
  if (!questions || questions.length === 0) {
    await sendMessage(chatId, 'По этой теме нет вопросов. Попробуйте другую тему.');
    return;
  }

  let sequence;
  if (isNormal) {
    sequence = questions.map((_, i) => i);
  } else {
    const count = Math.min(10, questions.length);
    const shuffled = [...Array(questions.length).keys()];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    sequence = shuffled.slice(0, count);
  }

  session.questions = sequence;
  session.currentQuestion = 0;
  session.score = 0;
  session.state = 'ANSWERING';

  await sendQuestion(chatId, userId);
}

async function sendQuestion(chatId, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  const qIndex = session.currentQuestion;
  const questions = questionsData[session.subject];
  const qData = questions[session.questions[qIndex]];
  const total = session.questions.length;

  const text = `❓ **Вопрос ${qIndex + 1} из ${total}**\n\n${qData.question}`;
  const optionsText = qData.options.map((opt, i) => `${i+1}. ${opt}`).join('\n');

  const keyboard = {
    keyboard: qData.options.map((_, i) => [{ 
      text: String(i+1),
      callback_data: String(i),
    }]),
  };
  keyboard.keyboard.push([{ text: '🚫 Прервать тестирование', callback_data: 'cancel' }]);

  await sendMessage(chatId, `${text}\n\n${optionsText}`, keyboard);
}

async function handleAnswer(chatId, userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  if (text === 'cancel' || text === '🚫 Прервать тестирование') {
    sessions.delete(userId);
    await sendMessage(chatId, 'Тестирование прервано. Для начала нового используйте /start');
    return;
  }

  const answerNum = parseInt(text, 10);
  if (isNaN(answerNum) || answerNum < 1) {
    await sendMessage(chatId, 'Пожалуйста, выберите номер ответа (нажмите на кнопку с цифрой).');
    return;
  }

  const questions = questionsData[session.subject];
  const qIndex = session.currentQuestion;
  const qData = questions[session.questions[qIndex]];
  const isCorrect = (answerNum - 1) === qData.correct;

  if (isCorrect) {
    session.score += 1;
    await sendMessage(chatId, '✅ **Правильно!**');
  } else {
    const correctText = qData.options[qData.correct];
    await sendMessage(chatId, `❌ **Неправильно!**\nПравильный ответ: ${correctText}`);
  }

  session.currentQuestion += 1;

  if (session.currentQuestion >= session.questions.length) {
    const total = session.questions.length;
    const score = session.score;
    const percentage = (score / total) * 100;
    let grade = 'Неудовлетворительно 😔';
    if (percentage >= 90) grade = 'Отлично! 🎉';
    else if (percentage >= 75) grade = 'Хорошо! 👍';
    else if (percentage >= 60) grade = 'Удовлетворительно 👌';

    const result =
      `🏁 **Тестирование завершено!**\n\n` +
      `📊 Результаты по теме '${getSubjectName(session.subject)}':\n` +
      `• Правильных ответов: ${score}/${total}\n` +
      `• Процент выполнения: ${percentage.toFixed(1)}%\n` +
      `• Оценка: ${grade}\n\n` +
      `Для начала нового тестирования нажмите /start`;

    sessions.delete(userId);
    await sendMessage(chatId, result);
  } else {
    await sendQuestion(chatId, userId);
  }
}

async function handleWebhook(req, res) {
  const update = req.body;
  console.log('📩 Получен вебхук:', JSON.stringify(update, null, 2));

  // Обработка callback-нажатий
  if (update.update_type === 'message_callback' && update.callback) {
    const userId = update.callback.user?.user_id; // Исправлено: user, а не sender
    const chatId = userId;
    const payload = update.callback.payload;
    const text = payload;

    if (!userId) {
      console.error('❌ Не удалось определить userId');
      return res.sendStatus(200);
    }

    console.log(`👤 Callback от пользователя ${userId}, payload: "${payload}"`);

    // Обрабатываем callback как обычное текстовое сообщение
    if (text === '/start' || text === '/cancel') {
      await handleStart(chatId, userId);
      return res.sendStatus(200);
    }

    const session = sessions.get(userId);
    if (!session) {
      await sendMessage(chatId, 'Начните с команды /start');
      return res.sendStatus(200);
    }

    switch (session.state) {
      case 'SELECTING_SUBJECT':
        await handleSubjectSelection(chatId, userId, text);
        break;
      case 'SELECTING_MODE':
        await handleModeSelection(chatId, userId, text);
        break;
      case 'ANSWERING':
        await handleAnswer(chatId, userId, text);
        break;
      default:
        await sendMessage(chatId, 'Неизвестное состояние. Начните с /start');
    }

    return res.sendStatus(200);
  }

  // Обработка текстовых сообщений
  if (!update || !update.message) {
    return res.sendStatus(200);
  }

  const msg = update.message;
  const userId = msg.sender?.user_id;
  const chatId = userId;
  const text = msg.body?.text || '';

  if (!userId) {
    console.error('❌ Не удалось определить userId');
    return res.sendStatus(200);
  }

  console.log(`👤 Пользователь ${userId}, текст: "${text}"`);

  if (text === '/start' || text === '/cancel') {
    await handleStart(chatId, userId);
    return res.sendStatus(200);
  }

  const session = sessions.get(userId);
  if (!session) {
    await sendMessage(chatId, 'Начните с команды /start');
    return res.sendStatus(200);
  }

  switch (session.state) {
    case 'SELECTING_SUBJECT':
      await handleSubjectSelection(chatId, userId, text);
      break;
    case 'SELECTING_MODE':
      await handleModeSelection(chatId, userId, text);
      break;
    case 'ANSWERING':
      await handleAnswer(chatId, userId, text);
      break;
    default:
      await sendMessage(chatId, 'Неизвестное состояние. Начните с /start');
  }

  res.sendStatus(200);
}

async function registerWebhook(url) {
  try {
    const response = await axios.post(
      `${API_BASE}/subscriptions`,
      {
        url: url,
        update_types: ['message_created', 'bot_started', 'message_callback'],
      },
      {
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Вебхук успешно зарегистрирован:', response.data);
  } catch (error) {
    console.error('❌ Ошибка регистрации вебхука:', error.response?.data || error.message);
  }
}

const app = express();
app.use(express.json());
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`   Ожидаем вебхуки на /webhook`);

  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    const fullUrl = webhookUrl.endsWith('/webhook') ? webhookUrl : `${webhookUrl}/webhook`;
    await registerWebhook(fullUrl);
  } else {
    console.log(`
⚠️  Вебхук не зарегистрирован.
   Укажите переменную окружения WEBHOOK_URL при запуске:
   WEBHOOK_URL=https://ваш-адрес.ngrok.io node index.js
   (или используйте localtunnel / bore)
    `);
  }
});