import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { getSubjectDisplay, getSubjectName, questionsData } from '../index.js';

describe('Загрузка вопросов', () => {
  test('getSubjectDisplay возвращает человеческое название', () => {
    expect(getSubjectDisplay('natural_gas_questions')).toBe('🔥 Природный газ');
    expect(getSubjectDisplay('unknown')).toBe('unknown');
  });

  test('getSubjectName возвращает родительный падеж', () => {
    expect(getSubjectName('ammonia_questions')).toBe('аммиаку');
  });

  test('интеграционный: загружает все JSON-файлы из папки questions', () => {
    const questionsPath = path.join(process.cwd(), 'questions');
    if (!fs.existsSync(questionsPath)) {
      console.warn('Папка questions не найдена, пропускаем интеграционный тест');
      return;
    }
    const files = fs.readdirSync(questionsPath).filter(f => f.endsWith('.json'));
    const topics = Object.keys(questionsData);
    
    expect(topics.length).toBe(files.length);
    
    files.forEach(file => {
      const topic = file.replace('.json', '');
      expect(questionsData).toHaveProperty(topic);
      expect(Array.isArray(questionsData[topic])).toBe(true);
      expect(questionsData[topic].length).toBeGreaterThan(0);
      
      const firstQuestion = questionsData[topic][0];
      expect(firstQuestion).toHaveProperty('question');
      expect(firstQuestion).toHaveProperty('options');
      expect(Array.isArray(firstQuestion.options)).toBe(true);
      expect(firstQuestion).toHaveProperty('correct');
      expect(typeof firstQuestion.correct).toBe('number');
    });
  });
});