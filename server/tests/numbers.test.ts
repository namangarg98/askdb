import { describe, expect, it } from 'vitest';
import { numbersIn, ungroundedNumbers } from '../src/agent/numbers.js';

const months1997 = ['61258.07', '38483.63', '38547.22', '53032.95', '53781.29', '36362.80',
  '51020.86', '47287.67', '55629.24', '66749.23', '43533.81', '71398.43'];

describe('answer number grounding', () => {
  it('catches a total the model added up itself (the real bug)', () => {
    const sources = numbersIn(['1997-01-01', ...months1997]);
    const answer = 'Revenue ranged from 36,362.80 in June to 71,398.43 in December, totalling about 597,094.42.';
    expect(ungroundedNumbers(answer, sources)).toEqual(['597,094.42']);
  });

  it('accepts numbers written with currency signs, separators and the answer\'s own rounding', () => {
    const sources = numbersIn(['110277.31', '104874.98', '0.0446']);
    expect(ungroundedNumbers('QUICK-Stop spent $110,277.31, about 110K, roughly $0.1M; Ernst Handel $104,875.', sources)).toEqual([]);
    expect(ungroundedNumbers('4.46% of orders shipped late.', sources)).toEqual([]);
  });

  it('accepts years and dates that appear in the results or the question', () => {
    const sources = numbersIn(['1997-12-01', 'How many orders in 1996?']);
    expect(ungroundedNumbers('December 1997 was the busiest month; 1996 was quieter.', sources)).toEqual([]);
  });

  it('ignores small whole numbers used as counts in the wording', () => {
    expect(ungroundedNumbers('The top 5 customers, across 3 countries, in 12 months.', numbersIn(['12']))).toEqual([]);
  });

  it('rejects a rounded number that is outside its own precision', () => {
    // 110277.31 rounds to 110K, not 120K.
    expect(ungroundedNumbers('About 120K in revenue.', numbersIn(['110277.31']))).toEqual(['120K']);
  });
});
