import { describe, expect, it } from 'vitest';
import { resultsMatch, type ResultSet } from '../eval/grade.js';

const ref = (columns: string[], rows: unknown[][]): ResultSet => ({ columns, rows });

describe('eval grader', () => {
  const reference = ref(['company_name', 'total'], [['QUICK-Stop', '110277.31'], ['Ernst Handel', '104874.98']]);

  it('accepts the same answer with different column names, order, and number formatting', () => {
    const candidate = ref(['spent', 'customer'], [[104874.981, 'ernst handel '], [110277.3053, 'QUICK-Stop']]);
    expect(resultsMatch(candidate, reference, false)).toBe(true);
  });

  it('accepts extra columns', () => {
    const candidate = ref(['id', 'company_name', 'total'], [['QUICK', 'QUICK-Stop', 110277.31], ['ERNSH', 'Ernst Handel', 104874.98]]);
    expect(resultsMatch(candidate, reference, false)).toBe(true);
  });

  it('rejects a plausible but wrong answer: values swapped between rows', () => {
    const candidate = ref(['company_name', 'total'], [['QUICK-Stop', 104874.98], ['Ernst Handel', 110277.31]]);
    expect(resultsMatch(candidate, reference, false)).toBe(false);
  });

  it('rejects a missing column, a missing row and a wrong number', () => {
    expect(resultsMatch(ref(['company_name'], [['QUICK-Stop'], ['Ernst Handel']]), reference, false)).toBe(false);
    expect(resultsMatch(ref(['company_name', 'total'], [['QUICK-Stop', 110277.31]]), reference, false)).toBe(false);
    expect(resultsMatch(ref(['company_name', 'total'], [['QUICK-Stop', 110277.31], ['Ernst Handel', 104875.5]]), reference, false)).toBe(false);
  });

  it('checks row order only for ordered cases', () => {
    const reversed = ref(['company_name', 'total'], [['Ernst Handel', 104874.98], ['QUICK-Stop', 110277.31]]);
    expect(resultsMatch(reversed, reference, false)).toBe(true);
    expect(resultsMatch(reversed, reference, true)).toBe(false);
  });

  it('accepts a ranking whose top row is the answer only when rankingOk is set', () => {
    const top = ref(['name'], [['Margaret Peacock']]);
    const ranking = ref(['name', 'orders'], [['Margaret Peacock', 156], ['Janet Leverling', 127]]);
    const wrongRanking = ref(['name', 'orders'], [['Janet Leverling', 127], ['Margaret Peacock', 156]]);
    expect(resultsMatch(ranking, top, false)).toBe(false);
    expect(resultsMatch(ranking, top, false, true)).toBe(true);
    expect(resultsMatch(wrongRanking, top, false, true)).toBe(false);
  });

  it('treats an empty result as wrong', () => {
    expect(resultsMatch(ref(['company_name', 'total'], []), reference, false)).toBe(false);
  });
});
