export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {
    fontFamily: { sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'], serif: ['"IBM Plex Serif"', 'Georgia', 'serif'] },
    colors: { ink: { 950: '#0f1b24', 900: '#16252f', 700: '#2c4150', 500: '#5b6f7d', 300: '#a9b7c1', 100: '#e6ecef', 50: '#f3f6f7' }, signal: { DEFAULT: '#0e7c7b', dark: '#0a5c5b', soft: '#dff1f0' }, amber2: '#b86e00', risk: '#b3372f', gain: '#2c7a4b' },
  } },
  plugins: [],
};
