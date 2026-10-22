import { describe, expect, it } from 'vitest';
import { combineReports, parseOpsReport } from '../src/io/jdReport';
import type { TextItem } from '../src/io/ticket';

// Text positions as pdf.js reports them for an Operations Center job report
// (names and serial changed). Labels, colons and values are separate items.
const I = (x: number, y: number, w: number, str: string): TextItem => ({ x, y, w, str });
const PAGE: TextItem[] = [
  I(18, 76.9, 43.3, 'Products'),
  I(18, 54.4, 31.3, 'Potash'),
  I(18, 805.9, 222.8, '2026 Application: Potash'),
  I(18, 787.9, 50, 'Field: Home'),
  I(18, 746.7, 21.6, 'Start'),
  I(39.6, 746.7, 2.6, ':'),
  I(45.2, 746.7, 95.9, 'Oct 21, 2026 9:21 AM'),
  I(18, 731.7, 17.4, 'End'),
  I(35.4, 731.7, 2.6, ':'),
  I(41, 731.7, 101.5, 'Oct 21, 2026 11:06 AM'),
  I(94.8, 767.7, 5.4, '|'),
  I(18, 767.7, 72.8, 'Demo Farms'),
  I(105.3, 767.7, 27.6, 'Home'),
  I(18, 704.7, 58.1, 'Work Totals'),
  I(18, 686.7, 58.1, 'Area Applied'),
  I(76.1, 686.7, 2.6, ':'),
  I(81.7, 686.7, 37.5, '198.3 ac'),
  I(298.1, 686.7, 57.4, 'Applied Rate'),
  I(355.5, 686.7, 2.6, ':'),
  I(361.1, 686.7, 41.3, '247 lb/ac'),
  I(18, 671.7, 59.6, 'Applied Total'),
  I(77.6, 671.7, 2.6, ':'),
  I(83.2, 671.7, 41.2, '48,991 lb'),
  I(298.1, 671.7, 51.9, 'Target Rate'),
  I(350.1, 671.7, 2.6, ':'),
  I(355.7, 671.7, 41.3, '250 lb/ac'),
  I(18, 656.7, 54.2, 'Target Total'),
  I(72.2, 656.7, 2.6, ':'),
  I(77.8, 656.7, 55, '49,582.75 lb'),
  I(18, 641.7, 63.3, 'Rate Accuracy'),
  I(81.3, 641.7, 2.6, ':'),
  I(86.9, 641.7, 29.9, '96.8 %'),
  I(18, 596.7, 75.8, 'Application Time'),
  I(93.8, 596.7, 2.6, ':'),
  I(99.4, 596.7, 31.2, '53 min'),
  I(298.1, 596.7, 28.2, 'Speed'),
  I(326.4, 596.7, 2.6, ':'),
  I(332, 596.7, 46.9, '20.5 mi/hr'),
  I(18, 539.7, 21.3, 'Map'),
  I(39.3, 539.7, 2.6, ':'),
  I(44.9, 539.7, 57.4, 'Applied Rate'),
  I(422.2, 499.2, 21.1, '261.8'),
  I(422.2, 481.2, 21.1, '255.5'),
  I(422.2, 463.2, 21.1, '250.3'),
  I(422.2, 445.2, 21.1, '245.5'),
  I(422.2, 427.2, 21.1, '240.8'),
  I(422.2, 409.2, 21.1, '234.2'),
  I(438.5, 391.2, 4.7, '0'),
  I(409.5, 518.7, 24.1, 'lb/ac'),
  I(18, 125.7, 53.2, 'Equipment'),
  I(18, 107.7, 79.1, 'John Deere 22-7A'),
  I(100.1, 107.7, 99.2, '1N0000TESTSERIAL1'),
  I(492.2, 496.9, 14.9, '4 %'),
  I(487.1, 478.9, 20, '15 %'),
  I(487.1, 460.9, 20, '16 %'),
  I(487.1, 442.9, 20, '20 %'),
  I(487.1, 424.9, 20, '24 %'),
  I(487.1, 406.9, 20, '15 %'),
  I(492.2, 388.9, 14.9, '5 %'),
  I(34.5, 21.4, 140.8, 'Operations Center | Oct 21, 2026'),
  I(534.3, 21.4, 44.6, 'Page 1 of 1'),
];

describe('Operations Center job report', () => {
  it('reads the work totals', () => {
    const r = parseOpsReport([PAGE]);
    expect(r).toMatchObject({
      field: 'Home',
      farm: 'Demo Farms',
      product: 'Potash',
      areaAc: 198.3,
      appliedTotal: 48991,
      appliedRate: 247,
      targetRate: 250,
      targetTotal: 49582.75,
      rateAccuracy: 96.8,
      unit: 'lb',
      speedMph: 20.5,
      minutes: 53,
      equipment: 'John Deere 22-7A 1N0000TESTSERIAL1',
      serial: '1N0000TESTSERIAL1',
    });
    expect(r.start?.getHours()).toBe(9);
    expect(r.end?.getMinutes()).toBe(6);
    expect(r.rateBins).toHaveLength(7);
    expect(r.rateBins[r.rateBins.length - 1]).toEqual({ rate: 0, pct: 5 });
    expect(r.rateBins.reduce((s, b) => s + b.pct, 0)).toBe(99);
    expect(r.lagAreaPct).toBeCloseTo(0.05, 6);
    expect(r.lagBelow).toBe(234.2);
  });

  it('rejects something that is not a job report', () => {
    expect(() => parseOpsReport([[I(10, 10, 50, 'Total Blend Weight: 27900')]])).toThrow(/Operations Center/);
  });

  it('adds up one report per field', () => {
    const a = parseOpsReport([PAGE]);
    const b = { ...a, field: 'East', areaAc: 50, appliedTotal: 12000, targetTotal: 12500, minutes: 20 };
    const c = combineReports([a, b])!;
    expect(c.field).toBe('Home + East');
    expect(c.areaAc).toBeCloseTo(248.3, 6);
    expect(c.appliedTotal).toBe(60991);
    expect(c.appliedRate).toBeCloseTo(60991 / 248.3, 6);
    expect(c.minutes).toBe(73);
  });
});
