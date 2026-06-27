import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFile } from 'fs';

// Разрешаем самоподписанные сертификаты (только для тестов с localtunnel)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================
//  1.  ПРОВЕРКА ТОКЕНА
// ============================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

const API_BASE = 'https://platform-api2.max.ru';

// ============================
//  2.  ЗАГРУЗКА ВОПРОСОВ ИЗ ПАПКИ questions/
// ============================
const questionsPath = join(__dirname, 'questions');
let questionsData = {};

if (fs.existsSync(questionsPath)) {
  const files = fs.readdirSync(questionsPath);
  files.forEach(file => {
    if (file.endsWith('.json')) {
      const topicKey = file.replace('.json', '');
      const filePath = join(questionsPath, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length) {
          questionsData[topicKey] = parsed;
          console.log(`✅ Загружена тема: ${topicKey} (${parsed.length} вопросов)`);
        } else {
          console.warn(`⚠️ Файл ${file} пуст или не массив.`);
        }
      } catch (err) {
        console.error(`❌ Ошибка в ${file}:`, err.message);
      }
    }
  });
} else {
  console.warn('⚠️ Папка questions/ не найдена. Создайте её и добавьте JSON-файлы.');
}

if (Object.keys(questionsData).length === 0) {
  console.error('❌ Нет загруженных тем. Бот остановлен.');
  process.exit(1);
}

// ============================
//  3.  ЛОГГЕР
// ============================
const logDir = join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const writeLog = (filename, data) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n';
  appendFile(join(logDir, filename), line, 'utf8', (err) => {
    if (err) console.error('Ошибка записи лога:', err);
  });
};

const logger = {
  action: (userId, action, subject = null, detail = null) =>
    writeLog('actions.log', { userId, action, subject, detail }),
  result: (userId, subject, score, total, percentage) =>
    writeLog('results.log', { userId, subject, score, total, percentage }),
  user: (userId) =>
    writeLog('users.log', { userId, event: 'new_user' }),
  error: (userId, error, context = null) =>
    writeLog('errors.log', { userId, error, context }),
};

// Автоочистка логов старше 30 дней (раз в сутки)
setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(logDir)
      .map(file => join(logDir, file))
      .filter(filePath => {
        const stats = fs.statSync(filePath);
        return (now - stats.mtimeMs) > 30 * 24 * 60 * 60 * 1000;
      })
      .forEach(filePath => {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Удалён старый лог: ${filePath}`);
      });
  } catch (_) { /* тихо */ }
}, 24 * 60 * 60 * 1000);

// ============================
//  4.  ФУНКЦИИ ДЛЯ РАБОТЫ С API MAX
// ============================
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

// ============================
//  5.  ОТОБРАЖЕНИЕ НАЗВАНИЙ ТЕМ
// ============================
function getSubjectDisplay(key) {
  const map = {
    natural_gas_questions: '🔥 Природный газ',
    ammonia_questions: '☠️ Аммиак',
    acetylene_questions: '⚡ Ацетилен/Кислород',
    chlorine_questions: '☣️ Хлор',
    work_platforms_questions: '🛗 Люльки',
    pressure_vessels_questions: '⚓ Сосуды под давлением',
  };
  return map[key] || key.replace(/_questions$/, '').replace(/_/g, ' ');
}

function getSubjectName(key) {
  const map = {
    natural_gas_questions: 'природному газу',
    ammonia_questions: 'аммиаку',
    acetylene_questions: 'ацетилену и кислороду',
    chlorine_questions: 'хлору',
    work_platforms_questions: 'подъемникам (люлькам)',
    pressure_vessels_questions: 'сосудам под давлением',
  };
  return map[key] || key.replace(/_questions$/, '');
}

// ============================
//  6.  ОБРАБОТЧИКИ СООБЩЕНИЙ
// ============================
const sessions = new Map();

async function handleStart(chatId, userId) {
  logger.user(userId);

  const keyboard = {
    keyboard: [
      [{ text: '▶️ Начать тестирование', callback_data: 'start_test' }]
    ]
  };
  await sendMessage(
    chatId,
    'Добро пожаловать в систему тестирования по промышленной безопасности!\n\nНажмите "Начать", чтобы выбрать тему.',
    keyboard
  );
}

async function showSubjects(chatId, userId) {
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
    'Выберите тему:',
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
  logger.action(userId, 'select_subject', selected);

  const keyboard = {
    keyboard: [
      [{ text: '📚 Все вопросы', callback_data: 'normal' }],
      [{ text: '🎯 Тестовый режим (10 вопросов)', callback_data: 'test' }],
      [{ text: '◀️ Назад', callback_data: 'back_to_subjects' }]
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

  const isNormal = text === 'normal' || text.includes('Все вопросы');
  const isTest = text === 'test' || text.includes('Тестовый');
  if (!isNormal && !isTest) {
    await sendMessage(chatId, 'Пожалуйста, выберите режим, нажав на кнопку.');
    return;
  }

  session.mode = isNormal ? 'normal' : 'test';

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
  logger.action(userId, 'select_mode', session.subject, isNormal ? 'normal' : 'test');

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
      callback_data: String(i+1),
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
    logger.action(userId, 'interrupt', session.subject);
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
    let grade;
    if (percentage === 100) {
      grade = 'Отлично! 🎉';
    } else if (percentage >= 90) {
      grade = 'Хорошо! 👍';
    } else if (percentage >= 80) {
      grade = 'Удовлетворительно 👌';
    } else {
      grade = 'Неудовлетворительно 😔';
    }

    const result =
      `🏁 **Тестирование завершено!**\n\n` +
      `📊 Результаты по теме '${getSubjectName(session.subject)}':\n` +
      `• Правильных ответов: ${score}/${total}\n` +
      `• Процент выполнения: ${percentage.toFixed(1)}%\n` +
      `• Оценка: ${grade}\n\n` +
      `Для начала нового тестирования нажмите /start`;

    logger.result(userId, session.subject, score, total, percentage);
    sessions.delete(userId);
    await sendMessage(chatId, result);
  } else {
    await sendQuestion(chatId, userId);
  }
}

// ============================
//  7.  ОБРАБОТЧИК ВЕБХУКА
// ============================
async function handleWebhook(req, res) {
  const update = req.body;
  console.log('📩 Получен вебхук:', JSON.stringify(update, null, 2));

  // Обработка callback-нажатий
  if (update.update_type === 'message_callback' && update.callback) {
    const userId = update.callback.user?.user_id;
    const chatId = userId;
    const payload = update.callback.payload;
    const text = payload;

    if (!userId) {
      console.error('❌ Не удалось определить userId');
      return res.sendStatus(200);
    }

    console.log(`👤 Callback от пользователя ${userId}, payload: "${payload}"`);

    if (text === '/start' || text === '/cancel') {
      await handleStart(chatId, userId);
      return res.sendStatus(200);
    }
    if (text === 'start_test') {
      await showSubjects(chatId, userId);
      return res.sendStatus(200);
    }
    if (text === 'back_to_subjects') {
      await showSubjects(chatId, userId);
      return res.sendStatus(200);
    }

    const session = sessions.get(userId);
    if (!session) {
      // Если сессии нет, показываем приветствие с кнопкой "Начать"
      await handleStart(chatId, userId);
      return res.sendStatus(200);
    }

    try {
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
    } catch (err) {
      console.error('Ошибка обработки callback:', err);
      logger.error(userId, err.message, 'callback');
      await sendMessage(chatId, 'Произошла ошибка. Попробуйте /start заново.');
      sessions.delete(userId);
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

  if (text === '/start') {
    await handleStart(chatId, userId);
    return res.sendStatus(200);
  }

  if (text === '/stats') {
    const adminId = parseInt(process.env.ADMIN_ID, 10) || 0;
    if (userId !== adminId) {
      await sendMessage(chatId, '⛔ Команда только для администратора.');
      return res.sendStatus(200);
    }

    const resultsPath = join(logDir, 'results.log');
    if (!fs.existsSync(resultsPath)) {
      await sendMessage(chatId, '📭 Логов результатов пока нет.');
      return res.sendStatus(200);
    }

    try {
      const data = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);
      const totalTests = data.length;
      const users = new Set(data.map(line => JSON.parse(line).userId));
      const today = new Date().toISOString().slice(0, 10);
      const todayTests = data.filter(line => line.includes(today));

      await sendMessage(
        chatId,
        `📊 **Статистика бота:**\n` +
        `👥 Всего тестировалось: ${users.size} чел.\n` +
        `📝 Всего завершено тестов: ${totalTests}\n` +
        `📅 Тестов за сегодня: ${todayTests.length}`
      );
    } catch (err) {
      await sendMessage(chatId, 'Ошибка чтения статистики.');
      logger.error(userId, err.message, 'stats');
    }
    return res.sendStatus(200);
  }

  if (text === '/cancel') {
    if (sessions.has(userId)) {
      sessions.delete(userId);
      await sendMessage(chatId, '❌ Тестирование отменено. Для начала нового используйте /start');
      logger.action(userId, 'cancel');
    } else {
      await sendMessage(chatId, 'У вас нет активного тестирования.');
    }
    return res.sendStatus(200);
  }

  const session = sessions.get(userId);
  if (!session) {
    // Если сессии нет, показываем приветствие с кнопкой "Начать"
    await handleStart(chatId, userId);
    return res.sendStatus(200);
  }

  try {
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
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    logger.error(userId, err.message, 'message');
    await sendMessage(chatId, 'Произошла ошибка. Попробуйте /start заново.');
    sessions.delete(userId);
  }

  res.sendStatus(200);
}

// ============================
//  8.  РЕГИСТРАЦИЯ ВЕБХУКА (автоматическая, если задан WEBHOOK_URL)
// ============================
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
    return true;
  } catch (error) {
    console.error('❌ Ошибка регистрации вебхука:', error.response?.data || error.message);
    return false;
  }
}

// ============================
//  9.  ЗАПУСК СЕРВЕРА
// ============================
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
    console.log(`🔄 Пытаемся автоматически зарегистрировать вебхук: ${fullUrl}`);
    const registered = await registerWebhook(fullUrl);
    if (registered) {
      console.log('🎉 Бот готов к работе!');
    } else {
      console.log(`
⚠️  Автоматическая регистрация не удалась.
   Зарегистрируйте вебхук вручную в партнёрском кабинете MAX:
   URL: ${fullUrl}
   Типы обновлений: message_created, bot_started, message_callback
      `);
    }
  } else {
    console.log(`
ℹ️  Переменная WEBHOOK_URL не задана.
   Для тестирования через localtunnel/ngrok добавьте в .env:
   WEBHOOK_URL=https://ваш-адрес.loca.lt

   Или зарегистрируйте вебхук вручную в партнёрском кабинете MAX.
    `);
  }
});