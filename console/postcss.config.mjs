/**
 * PostCSS wiring for the console. Tailwind v4 ships its own PostCSS plugin
 * (`@tailwindcss/postcss`); there is no separate `autoprefixer` step and no
 * `tailwind.config.js` — the theme lives in CSS (`app/tailwind.css`) and maps
 * onto the design tokens in `app/theme.css`.
 *
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
