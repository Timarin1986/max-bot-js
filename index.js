import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFile } from 'fs';
import { promises as fsPromises } from 'fs';

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
const ADMIN_ID = process.env.ADMIN_ID;

if (!ADMIN_ID) {
  console.warn('⚠️ ADMIN_ID не задан – команды /stats и /check_size недоступны.');
}

// ============================
//  2.  ХРАНИЛИЩЕ СТАТИСТИКИ (JSON Lines)
// ============================
const STATS_FILE = join('/tmp', 'stats.jsonl');

async function saveStatsEntry(userId, subject, mode, score, total, percentage) {
  const entry = JSON.stringify({
    userId,
    subject,
    mode,
    score,
    total,
    percentage,
    timestamp: Date.now()
  }) + '\n';
  try {
    await fsPromises.appendFile(STATS_FILE, entry, 'utf8');
  } catch (err) {
    console.error('❌ Ошибка записи stats.jsonl:', err);
    const logDir = join('/tmp', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    await fsPromises.appendFile(
      join(logDir, 'stats_error.log'),
      JSON.stringify({ userId, subject, mode, score, total, percentage, error: err.message }) + '\n',
      'utf8'
    ).catch(() => {});
  }
}

async function loadStats() {
  try {
    const data = await fsPromises.readFile(STATS_FILE, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    const stats = [];
    for (const line of lines) {
      try {
        stats.push(JSON.parse(line));
      } catch (e) {
        console.error('⚠️ Битая строка в stats.jsonl, пропускаем:', line.slice(0, 100));
        const logDir = join('/tmp', 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        await fsPromises.appendFile(
          join(logDir, 'stats_parse_errors.log'),
          `[${new Date().toISOString()}] ${line}\n`,
          'utf8'
        ).catch(() => {});
      }
    }
    return stats;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('Ошибка чтения stats.jsonl:', err);
    return [];
  }
}

async function getStats() {
  const stats = await loadStats();
  if (stats.length === 0) {
    return { total: 0, users: 0, today: 0, bySubject: {}, byMode: { normal: 0, test: 0 }, topUsers: [] };
  }
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTime = todayStart.getTime();
  const result = {
    total: stats.length,
    users: new Set(stats.map(s => s.userId)).size,
    today: stats.filter(s => s.timestamp >= todayTime).length,
    bySubject: {},
    byMode: { normal: 0, test: 0 },
    topUsers: []
  };
  stats.forEach(s => {
    result.bySubject[s.subject] = (result.bySubject[s.subject] || 0) + 1;
    if (s.mode === 'normal') result.byMode.normal++;
    else if (s.mode === 'test') result.byMode.test++;
  });
  const userCounts = {};
  stats.forEach(s => userCounts[s.userId] = (userCounts[s.userId] || 0) + 1);
  const sorted = Object.entries(userCounts).sort((a, b) => b[1] - a[1]);
  result.topUsers = sorted.slice(0, 5).map(([userId, count]) => ({ userId: Number(userId), count }));
  return result;
}

async function checkStatsFileSize() {
  if (!ADMIN_ID) return;
  try {
    const stat = await fsPromises.stat(STATS_FILE);
    const sizeMB = stat.size / 1024 / 1024;
    if (sizeMB > 500) {
      await sendMessage(ADMIN_ID, `⚠️ Размер stats.jsonl достиг ${sizeMB.toFixed(1)} МБ. Рекомендуется очистить.`);
    }
  } catch (e) {}
}

// ============================
//  3.  ЗАГРУЗКА ВОПРОСОВ
// ============================
const questionsPath = join(__dirname, 'questions');
let questionsData = {};
if (fs.existsSync(questionsPath)) {
  fs.readdirSync(questionsPath).forEach(file => {
    if (file.endsWith('.json')) {
      try {
        const parsed = JSON.parse(fs.readFileSync(join(questionsPath, file), 'utf8'));
        if (Array.isArray(parsed) && parsed.length) {
          questionsData[file.replace('.json', '')] = parsed;
          console.log(`✅ Загружена тема: ${file} (${parsed.length} вопросов)`);
        }
      } catch (e) { console.error(`❌ Ошибка в ${file}:`, e.message); }
    }
  });
}
if (Object.keys(questionsData).length === 0) {
  console.error('❌ Нет загруженных тем. Бот остановлен.');
  process.exit(1);
}

// ============================
//  4.  ЛОГГЕР
// ============================
const logDir = join('/tmp', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const writeLog = (filename, data) => {
  appendFile(join(logDir, filename), JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n', 'utf8', () => {});
};
const logger = {
  action: (userId, action, subject = null, detail = null) => writeLog('actions.log', { userId, action, subject, detail }),
  result: (userId, subject, mode, score, total, percentage) => {
    saveStatsEntry(userId, subject, mode, score, total, percentage)
      .catch(err => console.error('❌ Ошибка сохранения статистики:', err));
    writeLog('results.log', { userId, subject, mode, score, total, percentage });
  },
  user: (userId) => writeLog('users.log', { userId, event: 'new_user' }),
  error: (userId, error, context = null) => writeLog('errors.log', { userId, error, context }),
};

// ============================
//  5.  API MAX
// ============================
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function callAPI(method, params = {}) {
  const url = `${API_BASE}/${method}`;
  try {
    const response = await axios.post(url, params, {
      headers: { Authorization: BOT_TOKEN, 'Content-Type': 'application/json' },
      httpsAgent,
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Ошибка ${method}:`, error.response?.status, error.response?.data?.error || error.message);
    throw error;
  }
}

async function sendMessage(userId, text, replyMarkup = null, escape = true) {
  const safeText = escape ? escapeMarkdown(text) : text;
  const params = { text: safeText, format: 'markdown' };
  if (replyMarkup && replyMarkup.keyboard) {
    const buttons = replyMarkup.keyboard.map(row =>
      row.map(btn => ({
        type: 'callback',
        text: escape ? escapeMarkdown(btn.text) : btn.text,
        payload: btn.callback_data || btn.text,
      }))
    );
    params.attachments = [{ type: 'inline_keyboard', payload: { buttons } }];
  }
  return callAPI(`messages?user_id=${userId}`, params);
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ============================
//  6.  КАРТЫ ОТОБРАЖЕНИЯ – 27 ТЕМ
// ============================
function getSubjectDisplay(key) {
  const map = {
    // Старые темы
    natural_gas_questions: '🔥 Природный газ',
    ammonia_questions: '☠️ Аммиак',
    acetylene_questions: '⚡ Ацетилен/Кислород',
    chlorine_questions: '☣️ Хлор',
    work_platforms_questions: '🛗 Люльки',
    pressure_vessels_questions: '⚓ Сосуды под давлением',
    // Новые темы (20 штук)
    v_cart_crane_questions: '🏗️ V-карт (крановщик)',
    acetylene_station_questions: '🧪 Ацетиленовая станция',
    explosion_safety_questions: '💥 Взрывобезопасность',
    instrumentation_and_automation_workers_questions: '📊 КИПиА (рабочие)',
    acids_and_alkalis_workers_questions: '🧪 Кислоты и щелочи (рабочие)',
    paints_varnishes_solvents_production_questions: '🎨 КПО (лаки, краски, растворители)',
    bridge_crane_operator_questions: '🏗️ Крановщик мостового крана',
    jib_crane_operator_questions: '🏗️ Крановщик стрелового крана',
    elevator_operators_questions: '🛗 Лифтёры',
    stacker_crane_operator_questions: '🏗️ Машинист кранов-штабелеров',
    aerial_platform_operator_questions: '🛗 Машинист подъёмника',
    monorail_trolleys_questions: '🚟 Монорельсовые тележки',
    lifting_equipment_operators_remote_control_questions: '🎮 Операторы ПС с пульта',
    lifting_equipment_mechanic_questions: '🔧 Слесарь ПС',
    melts_and_alloys_repair_questions: '🔥 Сплавы и расплавы (ремонт)',
    melts_and_alloys_operation_questions: '🔥 Сплавы и расплавы (эксплуатация)',
    rigger_questions: '🪢 Стропальщик',
    gas_cylinders_transport_and_operation_questions: '🧯 Газовые баллоны (транспорт, эксплуатация)',
    steam_and_hot_water_pipelines_questions: '♨️ Трубопроводы пара и горячей воды',
    electricians_questions: '⚡ Электромонтёры',
    // Новая тема «Работы на высоте»
    height_work_questions: '🪜 Работы на высоте',
  };
  return map[key] || key.replace(/_questions$/, '').replace(/_/g, ' ');
}

function getSubjectName(key) {
  const map = {
    // Старые темы
    natural_gas_questions: 'природному газу',
    ammonia_questions: 'аммиаку',
    acetylene_questions: 'ацетилену и кислороду',
    chlorine_questions: 'хлору',
    work_platforms_questions: 'подъемникам (люлькам)',
    pressure_vessels_questions: 'сосудам под давлением',
    // Новые темы (20 штук)
    v_cart_crane_questions: 'V-карту (крановщик)',
    acetylene_station_questions: 'ацетиленовой станции',
    explosion_safety_questions: 'взрывобезопасности',
    instrumentation_and_automation_workers_questions: 'КИПиА (рабочие)',
    acids_and_alkalis_workers_questions: 'кислотам и щелочам (рабочие)',
    paints_varnishes_solvents_production_questions: 'КПО (лаки, краски, растворители)',
    bridge_crane_operator_questions: 'крановщику мостового крана',
    jib_crane_operator_questions: 'крановщику стрелового крана',
    elevator_operators_questions: 'лифтёрам',
    stacker_crane_operator_questions: 'машинисту кранов-штабелеров',
    aerial_platform_operator_questions: 'машинисту подъёмника',
    monorail_trolleys_questions: 'монорельсовым тележкам',
    lifting_equipment_operators_remote_control_questions: 'операторам ПС с пульта',
    lifting_equipment_mechanic_questions: 'слесарю ПС',
    melts_and_alloys_repair_questions: 'сплавам и расплавам (ремонт)',
    melts_and_alloys_operation_questions: 'сплавам и расплавам (эксплуатация)',
    rigger_questions: 'стропальщику',
    gas_cylinders_transport_and_operation_questions: 'газовым баллонам (транспорт, эксплуатация)',
    steam_and_hot_water_pipelines_questions: 'трубопроводам пара и горячей воды',
    electricians_questions: 'электромонтёрам',
    // Новая тема
    height_work_questions: 'работам на высоте',
  };
  return map[key] || key.replace(/_questions$/, '');
}

// ============================
//  7.  ЛОГИКА БОТА
// ============================
const sessions = new Map();

async function handleStart(userId) {
  logger.user(userId);
  await sendMessage(
    userId,
    '**Добро пожаловать в систему подготовки к проверке знаний по промышленной безопасности и охране труда!** 🛡️\n\nЭтот бот поможет вам проверить свои знания по ключевым темам. Нажмите "Начать тестирование", чтобы выбрать тему.',
    { keyboard: [[{ text: '▶️ Начать тестирование', callback_data: 'start_test' }]] },
    false
  );
}

async function showSubjects(userId) {
  sessions.set(userId, { state: 'SELECTING_SUBJECT', subject: null, mode: null, currentQuestion: 0, score: 0, questions: [], processing: false });
  const subjects = Object.keys(questionsData);
  await sendMessage(userId, 'Выберите тему:', {
    keyboard: subjects.map(s => [{ text: getSubjectDisplay(s), callback_data: s }])
  });
}

async function handleSubjectSelection(userId, text) {
  const session = sessions.get(userId);
  if (!session) return;
  const subjects = Object.keys(questionsData);
  const selected = subjects.find(s => getSubjectDisplay(s) === text || s === text);
  if (!selected) {
    await sendMessage(userId, 'Пожалуйста, выберите тему из списка, нажав на кнопку.');
    return;
  }
  session.subject = selected;
  session.state = 'SELECTING_MODE';
  logger.action(userId, 'select_subject', selected);
  const subjectName = escapeMarkdown(getSubjectName(selected));
  await sendMessage(
    userId,
    `Вы выбрали тему: **${subjectName}**\n\nТеперь выберите режим тестирования:`,
    {
      keyboard: [
        [{ text: '📚 Все вопросы', callback_data: 'normal' }],
        [{ text: '🎯 Тестовый режим (10 вопросов)', callback_data: 'test' }],
        [{ text: '◀️ Назад', callback_data: 'back_to_subjects' }]
      ]
    },
    false
  );
}

async function startTest(userId, subject, mode) {
  if (mode !== 'normal' && mode !== 'test') {
    await sendMessage(userId, 'Некорректный режим.');
    return;
  }
  const questions = questionsData[subject];
  if (!questions || questions.length === 0) {
    await sendMessage(userId, 'По этой теме нет вопросов.');
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
  sessions.set(userId, {
    state: 'ANSWERING',
    subject,
    mode,
    currentQuestion: 0,
    score: 0,
    questions: sequence,
    processing: false,
  });
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
  await startTest(userId, session.subject, text);
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
      callback_data: `q${qIndex}_${i+1}`,
    }]),
  };
  keyboard.keyboard.push([{ text: '🚫 Прервать тестирование', callback_data: 'cancel' }]);

  await sendMessage(userId, `${text}\n\n${optionsText}`, keyboard);
}

async function handleAnswer(userId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  if (session.processing) {
    await sendMessage(userId, '⏳ Подождите, ваш предыдущий ответ ещё обрабатывается.');
    return;
  }

  if (text === 'cancel' || text === '🚫 Прервать тестирование') {
    sessions.delete(userId);
    logger.action(userId, 'interrupt', session.subject);
    await handleStart(userId);
    return;
  }

  session.processing = true;
  try {
    const match = text.match(/^q(\d+)_(\d+)$/);
    if (!match) {
      await sendMessage(userId, 'Неверный формат ответа. Пожалуйста, используйте кнопки.');
      return;
    }

    const questionIndex = parseInt(match[1], 10);
    const answerNum = parseInt(match[2], 10);

    if (questionIndex !== session.currentQuestion) {
      await sendMessage(userId, '⏳ Этот ответ уже не актуален. Ответьте на текущий вопрос.');
      await sendQuestion(userId);
      return;
    }

    const questions = questionsData[session.subject];
    const qData = questions[session.questions[questionIndex]];

    if (isNaN(answerNum) || answerNum < 1 || answerNum > qData.options.length) {
      await sendMessage(userId, 'Пожалуйста, выберите номер ответа (нажмите на кнопку с цифрой).');
      return;
    }

    const isCorrect = (answerNum - 1) === qData.correct;
    if (isCorrect) {
      session.score += 1;
      await sendMessage(userId, '✅ **Правильно!**', null, false);
    } else {
      const correctText = escapeMarkdown(qData.options[qData.correct]);
      await sendMessage(
        userId,
        `❌ **Неправильно!**\nПравильный ответ: ${correctText}`,
        null,
        false
      );
    }

    session.currentQuestion += 1;

    if (session.currentQuestion >= session.questions.length) {
      const total = session.questions.length;
      const score = session.score;
      const percentage = (score / total) * 100;
      let grade;
      if (percentage === 100) grade = 'Отлично! 🎉';
      else if (percentage >= 90) grade = 'Хорошо! 👍';
      else if (percentage >= 80) grade = 'Удовлетворительно 👌';
      else grade = 'Неудовлетворительно 😔';

      const subjectName = escapeMarkdown(getSubjectName(session.subject));
      const resultText =
        `🏁 **Тестирование завершено!**\n\n` +
        `📊 Результаты по теме '**${subjectName}**':\n` +
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
      logger.result(userId, session.subject, session.mode, score, total, percentage);
      sessions.delete(userId);
      await sendMessage(userId, resultText, keyboard, false);
    } else {
      await sendQuestion(userId);
    }
  } finally {
    session.processing = false;
  }
}

// ============================
//  8.  ОБЩАЯ ОБРАБОТКА
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
        await sendMessage(userId, 'Тема или режим не найдены.');
        await showSubjects(userId);
      }
    } else {
      await sendMessage(userId, 'Ошибка формата.');
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
    console.error(err);
    logger.error(userId, err.message, 'action');
    await sendMessage(userId, 'Произошла ошибка. Попробуйте /start заново.');
    sessions.delete(userId);
  }
}

// ============================
//  9.  ВЕБХУК
// ============================
async function handleWebhook(req, res) {
  const update = req.body;
  console.log('📩 Вебхук получен');

  if (update.update_type === 'message_callback' && update.callback) {
    const userId = update.callback.user?.user_id;
    const payload = update.callback.payload;
    if (!userId) return res.sendStatus(200);
    await processUserAction(userId, payload);
    return res.sendStatus(200);
  }

  if (!update || !update.message) return res.sendStatus(200);
  const msg = update.message;
  const userId = msg.sender?.user_id;
  const text = msg.body?.text || '';
  if (!userId) return res.sendStatus(200);

  if (text === '/stats') {
    if (String(userId) !== ADMIN_ID) {
      await sendMessage(userId, '⛔ Команда только для администратора.');
      return res.sendStatus(200);
    }
    try {
      const stats = await getStats();
      let response = `📊 **Статистика бота:**\n`;
      response += `👥 Всего тестировалось: ${stats.users} чел.\n`;
      response += `📝 Всего завершено тестов: ${stats.total}\n`;
      response += `📅 Тестов за сегодня: ${stats.today}\n\n`;
      response += `📈 **По темам:**\n`;
      for (const [subject, count] of Object.entries(stats.bySubject)) {
        const displayName = escapeMarkdown(getSubjectDisplay(subject));
        response += `  • ${displayName}: ${count}\n`;
      }
      response += `\n📋 **По режимам:**\n`;
      response += `  • Все вопросы: ${stats.byMode.normal || 0}\n`;
      response += `  • Тестовый (10 вопросов): ${stats.byMode.test || 0}\n\n`;
      response += `🏆 **Топ-5 пользователей:**\n`;
      stats.topUsers.forEach((u, i) => {
        response += `  ${i+1}. ID: ${u.userId} — ${u.count} тестов\n`;
      });
      await sendMessage(userId, response, null, false);
    } catch (err) {
      await sendMessage(userId, 'Ошибка получения статистики.');
      logger.error(userId, err.message, 'stats');
    }
    return res.sendStatus(200);
  }

  if (text === '/check_size') {
    if (String(userId) !== ADMIN_ID) {
      await sendMessage(userId, '⛔ Команда только для администратора.');
      return res.sendStatus(200);
    }
    try {
      const stat = await fsPromises.stat(STATS_FILE);
      await sendMessage(userId, `📦 Размер stats.jsonl: **${(stat.size / 1024 / 1024).toFixed(1)} МБ**`, null, false);
    } catch (e) {
      await sendMessage(userId, 'Файл статистики ещё не создан.');
    }
    return res.sendStatus(200);
  }

  await processUserAction(userId, text);
  res.sendStatus(200);
}

// ============================
//  10. РЕГИСТРАЦИЯ ВЕБХУКА И ЗАПУСК
// ============================
const app = express();
app.use(express.json());
app.post('/webhook', handleWebhook);

async function registerWebhook(url) {
  try {
    const response = await axios.post(`${API_BASE}/subscriptions`, {
      url,
      update_types: ['message_created', 'bot_started', 'message_callback'],
    }, {
      headers: { Authorization: BOT_TOKEN, 'Content-Type': 'application/json' },
      httpsAgent,
      timeout: 10000,
    });
    console.log('✅ Вебхук зарегистрирован');
    return true;
  } catch (error) {
    console.error('❌ Ошибка регистрации вебхука:', error.response?.data || error.message);
    return false;
  }
}

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`   Ожидаем вебхуки на /webhook`);

    setTimeout(async () => await checkStatsFileSize(), 5000);
    setInterval(async () => await checkStatsFileSize(), 24 * 60 * 60 * 1000);

    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      const fullUrl = webhookUrl.endsWith('/webhook') ? webhookUrl : `${webhookUrl}/webhook`;
      console.log(`🔄 Регистрация вебхука: ${fullUrl}`);
      await registerWebhook(fullUrl);
    } else {
      console.log('ℹ️ WEBHOOK_URL не задан. Зарегистрируйте вебхук вручную.');
    }
  });
}

export { 
  handleStart, showSubjects, handleSubjectSelection, handleModeSelection, 
  startTest, handleAnswer, processUserAction, handleWebhook,
  loadStats, saveStatsEntry, getStats, getSubjectDisplay, getSubjectName,
  questionsData,
  sessions
};