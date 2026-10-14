export interface Product {
  slug: string;
  name: string;
  price: number;
  description: string;
}

/** The products the shop sells. */
const products: readonly Product[] = [
  {
    slug: 'trail-shoes',
    name: 'Trail shoes',
    price: 89,
    description: 'Light shoes with a grippy sole for muddy paths.',
  },
  { slug: 'rain-jacket', name: 'Rain jacket', price: 129, description: 'A packable jacket that keeps the rain out.' },
  { slug: 'water-bottle', name: 'Water bottle', price: 19, description: 'Half a litre, keeps water cool for hours.' },
];

export const all = (): readonly Product[] => products;

export const find = (slug: string): Product | undefined => products.find((product) => product.slug === slug);
