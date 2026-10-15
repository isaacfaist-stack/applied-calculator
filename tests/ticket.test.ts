import { describe, expect, it } from 'vitest';
import { type TextItem, parseTicket } from '../src/io/ticket';

// Text positions as pdf.js reports them for an Agvance custom application
// ticket (names changed). Labels and values are separate items in columns.
const I = (x: number, y: number, w: number, str: string): TextItem => ({ x, y, w, str });
const PAGE1: TextItem[] = [
  I(380, 743.3, 183.5, 'Custom Application 716331'),
  I(38, 743.3, 203.5, 'Example Co-op - Hometown'),
  I(38, 728.9, 106.6, 'W100 County Road A'),
  I(38, 716.7, 156.1, 'Hometown, WI 53000 / 608-555-0100'),
  I(398, 728.9, 161.6, 'Not Loaded Edited Custom Applied'),
  I(38, 685.7, 58.9, 'Demo Farms'),
  I(38, 664.1, 80.5, '100 Main St'),
  I(38, 653.3, 104.4, 'Anytown, WI 53001'),
  I(275.3, 674.9, 37.2, 'Field ID:'),
  I(259.3, 664.1, 52.8, 'Description:'),
  I(231.2, 653.3, 80, 'County/Township:'),
  I(243.2, 642.5, 68.3, 'Range/Section:'),
  I(431.6, 717.2, 86.1, 'Crop Chemistry:'),
  I(455.4, 707.3, 63.3, 'Ordered Date:'),
  I(494.9, 696.5, 25, 'Time:'),
  I(458.8, 685.7, 60, 'Loaded Date:'),
  I(495.5, 674.9, 24.4, 'Crop:'),
  I(496.6, 664.1, 23.3, 'Acre:'),
  I(469.1, 653.3, 50, 'Placement:'),
  I(479.4, 642.5, 40, 'Ship Via:'),
  I(317, 674.9, 78.3, 'DEMOFA / 12345'),
  I(317, 664.1, 30, 'North 160'),
  I(317, 653.3, 57.8, 'Story/083N'),
  I(317, 642.5, 42.8, '024W/008'),
  I(524, 707.3, 50, '10/14/2026'),
  I(524, 696.5, 37.2, '9:15 AM'),
  I(524, 674.9, 56.1, 'Enlist-Beans'),
  I(524, 664.1, 11.1, '62'),
  I(524, 653.3, 45, 'Broadcast'),
  I(45.2, 625.8, 41.5, 'Product'),
  I(200, 625.8, 206.8, 'Active Ingredient EPA / PCP Reg. Num.'),
  I(421, 625.8, 51.3, 'Rate/Acre'),
  I(511, 625.8, 26.2, 'Total'),
  I(436.8, 615, 150.9, 'Total Blend Weight: 27900.000'),
  I(45.2, 599, 62.8, '0-0-60 Potash'),
  I(416.5, 599, 56.7, '250.000 Lbs'),
  I(488.1, 599, 103.1, '15500 Lbs _________'),
  I(45.2, 588.2, 88.9, '0-46-0 Triple Super'),
  I(416.5, 588.2, 56.7, '200.000 Lbs'),
  I(488.1, 588.2, 103.1, '12400 Lbs _________'),
  I(45.2, 577.4, 92.2, 'Application - Spinner'),
  I(427.9, 577.4, 49.7, '1.000 Acre'),
  I(505.3, 577.4, 85.9, '62 Acre_________'),
  I(308, 557.1, 60, '# of Batches: 1'),
  I(380.4, 557.1, 53, 'Plan: ______'),
  I(308, 546.3, 307.7, 'Applicator 1: ___________________'),
  I(308, 513.9, 137, 'SalesPerson: Pat Example (PatE)'),
  I(38, 282.5, 16.1, 'Lbs'),
  I(99.2, 282.5, 7.2, 'N'),
  I(38, 271.7, 28.3, 'Blend.'),
  I(45.2, 225.4, 64.9, 'Lbs/Acre: 450'),
  I(146, 225.4, 75.9, 'Lbs/Cu Ft: 65.00'),
  I(239.6, 225.4, 80.2, 'Cu Ft/Acre: 6.923'),
  I(347.6, 225.4, 80.7, 'Lbs/Batch: 27900'),
  I(448.4, 225.4, 87.6, 'Acre/Batch: 62.000'),
  I(558.3, 30.6, 34.7, '(Page 1 of 2)'),
];

describe('blend ticket', () => {
  it('reads an Agvance custom application ticket', () => {
    const t = parseTicket([PAGE1]);
    expect(t).toMatchObject({
      ticketNo: '716331',
      supplier: 'Example Co-op - Hometown',
      grower: 'Demo Farms',
      fieldId: 'DEMOFA / 12345',
      growerCode: 'DEMOFA',
      fieldName: 'North 160',
      county: 'Story/083N',
      crop: 'Enlist-Beans',
      acres: 62,
      placement: 'Broadcast',
      rate: 450,
      unit: 'lb',
      total: 27900,
      density: 65,
      batches: 1,
      application: 'Spinner',
    });
    expect(t.products).toEqual([
      { name: '0-0-60 Potash', rate: 250, unit: 'lb', total: 15500 },
      { name: '0-46-0 Triple Super', rate: 200, unit: 'lb', total: 12400 },
    ]);
  });

  it('falls back to the product lines when the footer is missing', () => {
    const t = parseTicket([PAGE1.filter((i) => i.y > 300 && !/Total Blend/.test(i.str))]);
    expect(t.rate).toBe(450);
    expect(t.total).toBe(27900);
    expect(t.density).toBeUndefined();
  });

  it('handles a jumbled item order', () => {
    const shuffled = [...PAGE1].sort((a, b) => (a.str.length * 7919 + a.x) % 13 - (b.str.length * 7919 + b.x) % 13);
    expect(parseTicket([shuffled])).toMatchObject({ grower: 'Demo Farms', fieldName: 'North 160', rate: 450, total: 27900 });
  });
});
