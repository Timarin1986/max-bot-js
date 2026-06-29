import fs from 'fs';
import { jest } from '@jest/globals';

export function createTempStatsFile(data = []) {
  const path = '/tmp/stats_test.json';
  fs.writeFileSync(path, JSON.stringify(data));
  return path;
}

export function createQuestion(overrides = {}) {
  return {
    question: 'Тестовый вопрос?',
    options: ['A', 'B', 'C', 'D'],
    correct: 0,
    ...overrides,
  };
}

export const mockSendMessage = jest.fn();

export const mockLogger = {
  action: jest.fn(),
  result: jest.fn(),
  user: jest.fn(),
  error: jest.fn(),
};

export function clearAllMocks() {
  jest.clearAllMocks();
}