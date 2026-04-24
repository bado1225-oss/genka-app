/**
 * 魚マスター
 * 飲食店・食品製造向けの原価計算基準単価
 *
 * 野菜・肉・調味料マスターと統合可能な食材マスタ台帳の一部。
 * 魚介は季節変動・市場価格変動が大きいため、
 * アプリ側では price_type='都度入力' で扱い、レシピごとに単価を上書き推奨。
 *
 * - price_per_g = standard_price_per_kg / 1000
 * - practical_price_1_2x/1_5x = standard × 1.2/1.5
 * - yield_rate は可食部比率 (0-1)
 *   丸魚:50-60% / 三枚おろし:60-70% / 切り身:80-90%
 *   貝類:30-50% / エビ殻付き:50-60% / イカ・タコ:80% / 加工品:95-100%
 */

export type FishCategory =
  | '魚（青魚）'
  | '魚（白身）'
  | '高級魚'
  | '貝類'
  | '甲殻類'
  | '加工品'
  | 'その他';

export interface FishMasterItem {
  id: string;
  item_name: string;
  category: FishCategory;
  purchase_unit: 'kg';
  standard_price_per_kg: number;
  price_per_g: number;
  yield_rate: number;
  practical_price_1_2x: number;
  practical_price_1_5x: number;
  memo: string;
}

export const fishMaster: FishMasterItem[] = [
  { id: 'F001', item_name: 'アジ',             category: '魚（青魚）', purchase_unit: 'kg', standard_price_per_kg: 800,  price_per_g: 0.800, yield_rate: 0.60, practical_price_1_2x: 960,  practical_price_1_5x: 1200, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 丸魚' },
  { id: 'F002', item_name: 'イワシ',           category: '魚（青魚）', purchase_unit: 'kg', standard_price_per_kg: 600,  price_per_g: 0.600, yield_rate: 0.50, practical_price_1_2x: 720,  practical_price_1_5x: 900,  memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 丸魚' },
  { id: 'F003', item_name: 'サバ',             category: '魚（青魚）', purchase_unit: 'kg', standard_price_per_kg: 700,  price_per_g: 0.700, yield_rate: 0.60, practical_price_1_2x: 840,  practical_price_1_5x: 1050, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 丸魚〜三枚おろし' },
  { id: 'F004', item_name: 'タイ',             category: '魚（白身）', purchase_unit: 'kg', standard_price_per_kg: 2000, price_per_g: 2.000, yield_rate: 0.65, practical_price_1_2x: 2400, practical_price_1_5x: 3000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 三枚おろし' },
  { id: 'F005', item_name: 'ヒラメ',           category: '魚（白身）', purchase_unit: 'kg', standard_price_per_kg: 2500, price_per_g: 2.500, yield_rate: 0.65, practical_price_1_2x: 3000, practical_price_1_5x: 3750, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 三枚おろし' },
  { id: 'F006', item_name: 'カレイ',           category: '魚（白身）', purchase_unit: 'kg', standard_price_per_kg: 1500, price_per_g: 1.500, yield_rate: 0.65, practical_price_1_2x: 1800, practical_price_1_5x: 2250, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 三枚おろし' },
  { id: 'F007', item_name: 'マグロ(赤身)',     category: '高級魚',     purchase_unit: 'kg', standard_price_per_kg: 2500, price_per_g: 2.500, yield_rate: 0.85, practical_price_1_2x: 3000, practical_price_1_5x: 3750, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / ブロック/切り身' },
  { id: 'F008', item_name: 'サーモン',         category: '高級魚',     purchase_unit: 'kg', standard_price_per_kg: 2000, price_per_g: 2.000, yield_rate: 0.85, practical_price_1_2x: 2400, practical_price_1_5x: 3000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / フィレ' },
  { id: 'F009', item_name: 'ブリ',             category: '高級魚',     purchase_unit: 'kg', standard_price_per_kg: 1800, price_per_g: 1.800, yield_rate: 0.65, practical_price_1_2x: 2160, practical_price_1_5x: 2700, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 三枚おろし' },
  { id: 'F010', item_name: 'うなぎ',           category: '高級魚',     purchase_unit: 'kg', standard_price_per_kg: 4000, price_per_g: 4.000, yield_rate: 0.60, practical_price_1_2x: 4800, practical_price_1_5x: 6000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 活鰻想定・裂き処理' },
  { id: 'F011', item_name: 'あさり',           category: '貝類',       purchase_unit: 'kg', standard_price_per_kg: 800,  price_per_g: 0.800, yield_rate: 0.30, practical_price_1_2x: 960,  practical_price_1_5x: 1200, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き' },
  { id: 'F012', item_name: 'しじみ',           category: '貝類',       purchase_unit: 'kg', standard_price_per_kg: 700,  price_per_g: 0.700, yield_rate: 0.30, practical_price_1_2x: 840,  practical_price_1_5x: 1050, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き' },
  { id: 'F013', item_name: 'ホタテ',           category: '貝類',       purchase_unit: 'kg', standard_price_per_kg: 2000, price_per_g: 2.000, yield_rate: 0.50, practical_price_1_2x: 2400, practical_price_1_5x: 3000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き想定' },
  { id: 'F014', item_name: 'エビ',             category: '甲殻類',     purchase_unit: 'kg', standard_price_per_kg: 1800, price_per_g: 1.800, yield_rate: 0.55, practical_price_1_2x: 2160, practical_price_1_5x: 2700, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き' },
  { id: 'F015', item_name: 'ブラックタイガー', category: '甲殻類',     purchase_unit: 'kg', standard_price_per_kg: 2000, price_per_g: 2.000, yield_rate: 0.55, practical_price_1_2x: 2400, practical_price_1_5x: 3000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き' },
  { id: 'F016', item_name: 'カニ',             category: '甲殻類',     purchase_unit: 'kg', standard_price_per_kg: 4000, price_per_g: 4.000, yield_rate: 0.40, practical_price_1_2x: 4800, practical_price_1_5x: 6000, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 殻付き丸ごと' },
  { id: 'F017', item_name: 'イカ',             category: 'その他',     purchase_unit: 'kg', standard_price_per_kg: 1200, price_per_g: 1.200, yield_rate: 0.80, practical_price_1_2x: 1440, practical_price_1_5x: 1800, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 内臓処理後' },
  { id: 'F018', item_name: 'タコ',             category: 'その他',     purchase_unit: 'kg', standard_price_per_kg: 1800, price_per_g: 1.800, yield_rate: 0.80, practical_price_1_2x: 2160, practical_price_1_5x: 2700, memo: '業務用平均価格 / 季節変動が大きい / 市場価格依存 / 下処理後' },
  { id: 'F019', item_name: 'ちくわ',           category: '加工品',     purchase_unit: 'kg', standard_price_per_kg: 800,  price_per_g: 0.800, yield_rate: 1.00, practical_price_1_2x: 960,  practical_price_1_5x: 1200, memo: '業務用平均価格 / 加工品は全量可食' },
  { id: 'F020', item_name: 'かまぼこ',         category: '加工品',     purchase_unit: 'kg', standard_price_per_kg: 1000, price_per_g: 1.000, yield_rate: 1.00, practical_price_1_2x: 1200, practical_price_1_5x: 1500, memo: '業務用平均価格 / 加工品は全量可食' },
];

export default fishMaster;
