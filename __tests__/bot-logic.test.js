import { jest } from '@jest/globals';
import axios from 'axios';

const axiosPostMock = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });

const { 
  handleSubjectSelection, 
  handleModeSelection, 
  handleAnswer,
  sessions,
  questionsData
} = await import('../index.js');

describe('Бизнес-логика', () => {
  const userId = 123;
  const testSubject = Object.keys(questionsData)[0];
  const testQuestions = questionsData[testSubject];
  const twoQuestionsIndices = [0, 1];
  const oneQuestionIndex = [0];

  beforeEach(() => {
    jest.clearAllMocks();
    sessions.clear();
    sessions.set(userId, {
      state: 'SELECTING_SUBJECT',
      subject: null,
      mode: null,
      currentQuestion: 0,
      score: 0,
      questions: []
    });
  });

  test('handleSubjectSelection выбирает тему и переходит в SELECTING_MODE', async () => {
    await handleSubjectSelection(userId, testSubject);
    const session = sessions.get(userId);
    expect(session.subject).toBe(testSubject);
    expect(session.state).toBe('SELECTING_MODE');
    expect(axiosPostMock).toHaveBeenCalled();
  });

  test('handleModeSelection запускает тест в режиме normal', async () => {
    sessions.set(userId, {
      state: 'SELECTING_MODE',
      subject: testSubject,
      mode: null,
      currentQuestion: 0,
      score: 0,
      questions: []
    });
    await handleModeSelection(userId, 'normal');
    const session = sessions.get(userId);
    expect(session.state).toBe('ANSWERING');
    expect(session.mode).toBe('normal');
    expect(session.questions).toHaveLength(testQuestions.length);
    expect(axiosPostMock).toHaveBeenCalled();
  });

  test('handleAnswer обрабатывает правильный ответ', async () => {
    sessions.set(userId, {
      state: 'ANSWERING',
      subject: testSubject,
      mode: 'normal',
      currentQuestion: 0,
      score: 0,
      questions: twoQuestionsIndices
    });
    const correctAnswerNum = testQuestions[0].correct + 1;
    const payload = `q0_${correctAnswerNum}`;
    await handleAnswer(userId, payload);
    const session = sessions.get(userId);
    expect(session).toBeDefined();
    expect(session.score).toBe(1);
    expect(axiosPostMock).toHaveBeenCalled();
  });

  test('handleAnswer обрабатывает неправильный ответ', async () => {
    sessions.set(userId, {
      state: 'ANSWERING',
      subject: testSubject,
      mode: 'normal',
      currentQuestion: 0,
      score: 0,
      questions: twoQuestionsIndices
    });
    const correctAnswerNum = testQuestions[0].correct + 1;
    const wrongAnswerNum = correctAnswerNum === 1 ? 2 : 1;
    const payload = `q0_${wrongAnswerNum}`;
    await handleAnswer(userId, payload);
    const session = sessions.get(userId);
    expect(session).toBeDefined();
    expect(session.score).toBe(0);
    expect(axiosPostMock).toHaveBeenCalled();
  });

  test('handleAnswer завершает тест и показывает результат', async () => {
    sessions.set(userId, {
      state: 'ANSWERING',
      subject: testSubject,
      mode: 'normal',
      currentQuestion: 0,
      score: 0,
      questions: oneQuestionIndex
    });
    const correctAnswerNum = testQuestions[0].correct + 1;
    const wrongAnswerNum = correctAnswerNum === 1 ? 2 : 1;
    const payload = `q0_${wrongAnswerNum}`;
    await handleAnswer(userId, payload);
    expect(sessions.has(userId)).toBe(false);
    expect(axiosPostMock).toHaveBeenCalled();
  });

  test('handleAnswer обрабатывает прерывание (cancel)', async () => {
    sessions.set(userId, {
      state: 'ANSWERING',
      subject: testSubject,
      mode: 'normal',
      currentQuestion: 0,
      score: 0,
      questions: oneQuestionIndex
    });
    await handleAnswer(userId, 'cancel');
    expect(sessions.has(userId)).toBe(false);
    expect(axiosPostMock).toHaveBeenCalled();
  });
});