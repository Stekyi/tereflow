/** Trade News bulletin shapes, shared by the Worker and the app. */
export interface TradeNewsItem {
  title: string;
  summary: string;
  link: string;
  source: string;
  published: string;
  image: string | null;
  scope: 'global' | 'country';
  countries: string[];
  region: string;
  topic: string;
}

export interface TradeNewsPayload {
  generated: string;
  fetched: string;
  items: TradeNewsItem[];
  countries: { name: string; count: number }[];
  topics: { name: string; count: number }[];
}
