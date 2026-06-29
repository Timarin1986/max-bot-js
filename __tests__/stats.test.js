import fs from 'fs';
import { jest } from '@jest/globals';

describe('Статистика (JSON Lines)', () => {
  const TEST_FILE = '/tmp/stats_test.jsonl';

  // Используем те же функции, но с fsPromises и асинхронностью
  async function loadStats() {
    try {
      const data = await fs.promises.readFile(TEST_FILE, 'utf8');
      return data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (e) {
      return [];
    }
  }

  async function saveStatsEntry(userId, subject, mode, score, total, percentage) {
    const entry = JSON.stringify({ userId, subject, mode, score, total, percentage, timestamp: Date.now() }) + '\n';
    await fs.promises.appendFile(TEST_FILE, entry, 'utf8');
  }

  async function getStats() {
    const stats = await loadStats();
    if (stats.length === 0) return { total: 0, users: 0, today: 0, bySubject: {}, byMode: { normal: 0, test: 0 }, topUsers: [] };
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

  beforeEach(async () => {
    try { await fs.promises.unlink(TEST_FILE); } catch (e) {}
  });

  afterEach(async () => {
    try { await fs.promises.unlink(TEST_FILE); } catch (e) {}
  });

  test('loadStats возвращает пустой массив, если файла нет', async () => {
    expect(await loadStats()).toEqual([]);
  });

  test('saveStatsEntry добавляет запись', async () => {
    await saveStatsEntry(123, 'test', 'normal', 5, 10, 50);
    const stats = await loadStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      userId: 123,
      subject: 'test',
      mode: 'normal',
      score: 5,
      total: 10,
      percentage: 50,
    });
  });

  test('getStats корректно агрегирует данные', async () => {
    await saveStatsEntry(1, 'subject1', 'normal', 8, 10, 80);
    await saveStatsEntry(1, 'subject1', 'test', 5, 10, 50);
    await saveStatsEntry(2, 'subject2', 'normal', 10, 10, 100);

    const stats = await getStats();
    expect(stats.total).toBe(3);
    expect(stats.users).toBe(2);
    expect(stats.bySubject.subject1).toBe(2);
    expect(stats.byMode.normal).toBe(2);
    expect(stats.topUsers).toHaveLength(2);
    expect(stats.topUsers[0].userId).toBe(1);
    expect(stats.topUsers[0].count).toBe(2);
  });
});