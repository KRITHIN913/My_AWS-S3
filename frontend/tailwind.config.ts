// tailwind.config.ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.tsx', './components/**/*.tsx'],
  theme: {
    extend: {
      colors: {
        brand: '#ff808f',
        'brand-light': '#ffecdd',
        sidebar: '#0f1c2e',
      },
    },
  },
  plugins: [],
};

export default config;
