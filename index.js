import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFile } from 'fs';
import { promises as fsPromises } from 'fs';
import Database from 'better-sqlite3';

// Не используем глобальное отключение проверки SSL
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
const ADMIN_ID = process.env.ADMIN_ID; // строка

// ============================
//  2.  ПОДКЛЮЧЕНИЕ К БД (better-sqlite3)
// ============================
const DB_PATH = join(__dirname, 'stats.db');
const db = new Database(DB_PATH);

// Создаём таблицу, если её нет (синхронно)
db.exec(`
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    mode TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    percentage REAL NOT NULL,
    timestamp INTEGER NOT NULL
  )
`);

// ============================
//  3.  ЗАГРУЗКА ВОПРОСОВ
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
//  4.  ЛОГГЕР (текстовые логи + БД)
// ============================
const logDir = join('/tmp', 'logs');
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
  result: (userId, subject, mode, score, total, percentage) => {
    // Сохраняем в SQLite (синхронно)
    const timestamp = Date.now();
    const stmt = db.prepare(`
      INSERT INTO results (user_id, subject, mode, score, total, percentage, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(userId, subject, mode, score, total, percentage, timestamp);
    // Также пишем в файл для совместимости
    writeLog('results.log', { userId, subject, mode, score, total, percentage });
  },
  user: (userId) =>
    writeLog('users.log', { userId, event: 'new_user' }),
  error: (userId, error, context = null) =>
    writeLog('errors.log', { userId, error, context }),
};

// ============================
//  5.  ФУНКЦИИ ДЛЯ РАБОТЫ С API MAX
// ============================
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function callAPI(method, params = {}) {
  const url = `${API_BASE}/${method}`;
  console.log(`📤 Отправка запроса к ${url}`);
  try {
    const response = await axios.post(url, params, {
      headers: {
        Authorization: BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      httpsAgent,
      timeout: 10000,
    });
    console.log(`✅ Ответ получен (код ${response.status})`);
    return response.data;
  } catch (error) {
    console.error(
      `❌ Ошибка вызова ${method}:`,
      error.response?.status || 'нет статуса',
      error.response?.data?.error || error.message
    );
    throw error;
  }
}

async function sendMessage(userId, text, replyMarkup = null) {
  const safeText = escapeMarkdown(text);
  const params = {
    text: safeText,
    format: 'markdown',
  };

  if (replyMarkup && replyMarkup.keyboard) {
    const buttons = replyMarkup.keyboard.map(row =>
      row.map(btn => ({
        type: 'callback',
        text: escapeMarkdown(btn.text),
        payload: btn.callback_data || btn.text,
      }))
    );
    params.attachments = [{
      type: 'inline_keyboard',
      payload: { buttons },
    }];
  }
  return callAPI(`messages?user_id=${userId}`, params);
}

function escapeMarkdown(text) {
  if (!text) return '';
  const specialChars = /([_*[\]()~`>#+\-=|{}.!])/g;
  return text.replace(specialChars, '\\$1');
}

// ============================
//  6.  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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

// Проверка размера БД
async function checkDbSize() {
  if (!ADMIN_ID) return;
  try {
    const stats = await fsPromises.stat(DB_PATH);
    const sizeMB = stats.size / 1024 / 1024;
    if (sizeMB > 500) {
      const message = `⚠️ **Внимание!**\nРазмер базы данных статистики достиг **${sizeMB.toFixed(1)} МБ**.\nРекомендуется очистить или выгрузить данные.\nДля очистки используйте /clear_stats (если реализовано).`;
      await sendMessage(ADMIN_ID, message);
    }
  } catch (err) {
    console.error('Ошибка проверки размера БД:', err);
  }
}

// Получение расширенной статистики (синхронно)
function getDetailedStats() {
  const stats = {
    total: 0,
    users: 0,
    today: 0,
    bySubject: {},
    byMode: { normal: 0, test: 0 },
    topUsers: []
  };

  // Общее количество тестов
  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM results`).get();
  stats.total = totalRow.count;

  // Уникальные пользователи
  const usersRow = db.prepare(`SELECT COUNT(DISTINCT user_id) as count FROM results`).get();
  stats.users = usersRow.count;

  // Сегодняшние тесты
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRow = db.prepare(`SELECT COUNT(*) as count FROM results WHERE timestamp >= ?`).get(todayStart.getTime());
  stats.today = todayRow.count;

  // По темам
  const subjectRows = db.prepare(`SELECT subject, COUNT(*) as count FROM results GROUP BY subject`).all();
  subjectRows.forEach(r => {
    stats.bySubject[r.subject] = r.count;
  });

  // По режимам
  const modeRows = db.prepare(`SELECT mode, COUNT(*) as count FROM results GROUP BY mode`).all();
  modeRows.forEach(r => {
    stats.byMode[r.mode] = r.count;
  });

  // Топ-5 пользователей
  const topRows = db.prepare(`SELECT user_id, COUNT(*) as count FROM results GROUP BY user_id ORDER BY count DESC LIMIT 5`).all();
  stats.topUsers = topRows.map(r => ({ userId: r.user_id, count: r.count }));

  return stats;
}

// ============================
//  7.  ОСНОВНАЯ ЛОГИКА БОТА
// ============================
const sessions = new Map();

async function handleStart(userId) {
  logger.user(userId);
  const keyboard = {
    keyboard: [
      [{ text: '▶️ Начать тестирование', callback_data: 'start_test' }]
    ]
  };
  await sendMessage(
    userId,
    'Добро пожаловать в систему тестирования по промышленной безопасности!\n\nНажмите "Начать", чтобы выбрать тему.',
    keyboard
  );
}

async function showSubjects(userId) {
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
  await sendMessage(userId, 'Выберите тему:', keyboard);
}

async function handleSubjectSelection(userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  const subjects = Object.keys(questionsData);
  const selected = subjects.find(
    (s) => getSubjectDisplay(s) === text || s === text
  );
  if (!selected) {
    await sendMessage(userId, 'Пожалуйста, выберите тему из списка, нажав на кнопку.');
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
    userId,
    `Вы выбрали тему: ${getSubjectName(selected)}\n\nТеперь выберите режим тестирования:`,
    keyboard
  );
}

async function startTest(userId, subject, mode) {
  if (mode !== 'normal' && mode !== 'test') {
    await sendMessage(userId, 'Некорректный режим. Попробуйте снова.');
    return;
  }

  const questions = questionsData[subject];
  if (!questions || questions.length === 0) {
    await sendMessage(userId, 'По этой теме нет вопросов. Попробуйте другую тему.');
    return;
  }

  let sequence;
  if (mode === 'normal') {
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

  const session = {
    state: 'ANSWERING',
    subject: subject,
    mode: mode,
    currentQuestion: 0,
    score: 0,
    questions: sequence,
  };
  sessions.set(userId, session);
  logger.action(userId, 'start_test', subject, mode);
  await sendQuestion(userId);
}

async function handleModeSelection(userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  if (text !== 'normal' && text !== 'test') {
    await sendMessage(userId, 'Пожалуйста, выберите режим, нажав на кнопку.');
    return;
  }

  const mode = text;
  const subject = session.subject;
  await startTest(userId, subject, mode);
}

async function sendQuestion(userId) {
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

  await sendMessage(userId, `${text}\n\n${optionsText}`, keyboard);
}

async function handleAnswer(userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  if (text === 'cancel' || text === '🚫 Прервать тестирование') {
    sessions.delete(userId);
    await sendMessage(userId, 'Тестирование прервано. Для начала нового используйте /start');
    logger.action(userId, 'interrupt', session.subject);
    return;
  }

  const answerNum = parseInt(text, 10);
  const questions = questionsData[session.subject];
  const qIndex = session.currentQuestion;
  const qData = questions[session.questions[qIndex]];

  if (isNaN(answerNum) || answerNum < 1 || answerNum > qData.options.length) {
    await sendMessage(userId, 'Пожалуйста, выберите номер ответа (нажмите на кнопку с цифрой).');
    return;
  }

  const isCorrect = (answerNum - 1) === qData.correct;

  if (isCorrect) {
    session.score += 1;
    await sendMessage(userId, '✅ **Правильно!**');
  } else {
    const correctText = qData.options[qData.correct];
    await sendMessage(userId, `❌ **Неправильно!**\nПравильный ответ: ${correctText}`);
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

    const resultText =
      `🏁 **Тестирование завершено!**\n\n` +
      `📊 Результаты по теме '${getSubjectName(session.subject)}':\n` +
      `• Правильных ответов: ${score}/${total}\n` +
      `• Процент выполнения: ${percentage.toFixed(1)}%\n` +
      `• Оценка: ${grade}\n\n` +
      `Выберите действие:`;

    const keyboard = {
      keyboard: [
        [{ text: '🔄 Пройти ещё раз', callback_data: `retry:${session.subject}:${session.mode}` }],
        [{ text: '📋 Выбрать другую тему', callback_data: 'choose_subject' }]
      ]
    };

    // Сохраняем результат в БД и лог
    logger.result(userId, session.subject, session.mode, score, total, percentage);
    sessions.delete(userId);
    await sendMessage(userId, resultText, keyboard);
  } else {
    await sendQuestion(userId);
  }
}

// ============================
//  8.  ОБЩАЯ ЛОГИКА ОБРАБОТКИ
// ============================
async function processUserAction(userId, payload) {
  if (!userId) return;

  if (payload === '/start' || payload === '/cancel') {
    await handleStart(userId);
    return;
  }
  if (payload === 'start_test') {
    await showSubjects(userId);
    return;
  }
  if (payload === 'back_to_subjects' || payload === 'choose_subject') {
    await showSubjects(userId);
    return;
  }
  if (payload.startsWith('retry:')) {
    const parts = payload.split(':');
    if (parts.length === 3) {
      const subject = parts[1];
      const mode = parts[2];
      if (questionsData[subject] && (mode === 'normal' || mode === 'test')) {
        await startTest(userId, subject, mode);
      } else {
        await sendMessage(userId, 'Тема или режим не найдены. Выберите тему заново.');
        await showSubjects(userId);
      }
    } else {
      await sendMessage(userId, 'Ошибка формата. Попробуйте снова.');
    }
    return;
  }

  const session = sessions.get(userId);
  if (!session) {
    await handleStart(userId);
    return;
  }

  try {
    switch (session.state) {
      case 'SELECTING_SUBJECT':
        await handleSubjectSelection(userId, payload);
        break;
      case 'SELECTING_MODE':
        await handleModeSelection(userId, payload);
        break;
      case 'ANSWERING':
        await handleAnswer(userId, payload);
        break;
      default:
        await sendMessage(userId, 'Неизвестное состояние. Начните с /start');
    }
  } catch (err) {
    console.error('Ошибка обработки действия:', err);
    logger.error(userId, err.message, 'action');
    await sendMessage(userId, 'Произошла ошибка. Попробуйте /start заново.');
    sessions.delete(userId);
  }
}

// ============================
//  9.  ОБРАБОТЧИК ВЕБХУКА
// ============================
async function handleWebhook(req, res) {
  const update = req.body;
  console.log('📩 Получен вебхук (кратко):', JSON.stringify(update).slice(0, 200) + '...');

  if (update.update_type === 'message_callback' && update.callback) {
    const userId = update.callback.user?.user_id;
    const payload = update.callback.payload;
    if (!userId) {
      console.error('❌ Не удалось определить userId');
      return res.sendStatus(200);
    }
    console.log(`👤 Callback от пользователя ${userId}, payload: "${payload}"`);
    await processUserAction(userId, payload);
    return res.sendStatus(200);
  }

  if (!update || !update.message) {
    return res.sendStatus(200);
  }

  const msg = update.message;
  const userId = msg.sender?.user_id;
  const text = msg.body?.text || '';

  if (!userId) {
    console.error('❌ Не удалось определить userId');
    return res.sendStatus(200);
  }

  console.log(`👤 Пользователь ${userId}, текст: "${text}"`);

  // Админские команды
  if (text === '/stats') {
    if (String(userId) !== ADMIN_ID) {
      await sendMessage(userId, '⛔ Команда только для администратора.');
      return res.sendStatus(200);
    }
    try {
      const stats = getDetailedStats(); // теперь синхронно
      let response = `📊 **Статистика бота:**\n`;
      response += `👥 Всего тестировалось: ${stats.users} чел.\n`;
      response += `📝 Всего завершено тестов: ${stats.total}\n`;
      response += `📅 Тестов за сегодня: ${stats.today}\n\n`;
      response += `📈 **По темам:**\n`;
      for (const [subject, count] of Object.entries(stats.bySubject)) {
        response += `  • ${getSubjectDisplay(subject)}: ${count}\n`;
      }
      response += `\n📋 **По режимам:**\n`;
      response += `  • Все вопросы: ${stats.byMode.normal || 0}\n`;
      response += `  • Тестовый (10 вопросов): ${stats.byMode.test || 0}\n\n`;
      response += `🏆 **Топ-5 пользователей:**\n`;
      stats.topUsers.forEach((u, i) => {
        response += `  ${i+1}. ID: ${u.userId} — ${u.count} тестов\n`;
      });
      await sendMessage(userId, response);
    } catch (err) {
      await sendMessage(userId, 'Ошибка получения статистики.');
      logger.error(userId, err.message, 'stats_detailed');
    }
    return res.sendStatus(200);
  }

  if (text === '/check_size') {
    if (String(userId) !== ADMIN_ID) {
      await sendMessage(userId, '⛔ Команда только для администратора.');
      return res.sendStatus(200);
    }
    try {
      const stats = await fsPromises.stat(DB_PATH);
      const sizeMB = stats.size / 1024 / 1024;
      await sendMessage(userId, `📦 Размер базы данных: **${sizeMB.toFixed(1)} МБ**`);
    } catch (err) {
      await sendMessage(userId, 'Ошибка получения размера БД.');
    }
    return res.sendStatus(200);
  }

  await processUserAction(userId, text);
  res.sendStatus(200);
}

// ============================
//  10. РЕГИСТРАЦИЯ ВЕБХУКА
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
        httpsAgent,
        timeout: 10000,
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
//  11. ЗАПУСК СЕРВЕРА
// ============================
const app = express();
app.use(express.json());
app.post('/webhook', handleWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`   Ожидаем вебхуки на /webhook`);

  // Проверка размера БД при старте
  setTimeout(async () => {
    await checkDbSize();
  }, 5000);

  // Периодическая проверка (раз в сутки)
  setInterval(async () => {
    await checkDbSize();
  }, 24 * 60 * 60 * 1000);

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