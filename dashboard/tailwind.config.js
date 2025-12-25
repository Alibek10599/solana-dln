/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // DeBridge brand colors
        debridge: {
          purple: '#7B3FE4',
          blue: '#4F46E5',
          dark: '#0F0F1A',
          card: '#1A1A2E',
          border: '#2D2D44',
        },
      },
    },
  },
  plugins: [],
}
