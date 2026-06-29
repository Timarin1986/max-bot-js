import { jest } from '@jest/globals';
import axios from 'axios';

// Мокаем axios.post, чтобы не ходить в реальный API
jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });

// Отключаем вывод логов в тестах
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

// Импортируем handleWebhook после мока
const { handleWebhook } = await import('../index.js');

describe('Вебхук', () => {
  let req, res;

  beforeEach(() => {
    req = { body: {} };
    res = { sendStatus: jest.fn() };
    jest.clearAllMocks();
  });

  test('возвращает 200 на пустой вебхук', async () => {
    await handleWebhook(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('обрабатывает текстовое сообщение /start', async () => {
    req.body = {
      update_type: 'message_created',
      message: { sender: { user_id: 123 }, body: { text: '/start' } },
    };
    await handleWebhook(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(axios.post).toHaveBeenCalled();
  });

  test('обрабатывает callback start_test', async () => {
    req.body = {
      update_type: 'message_callback',
      callback: { user: { user_id: 123 }, payload: 'start_test' },
    };
    await handleWebhook(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(axios.post).toHaveBeenCalled();
  });
});