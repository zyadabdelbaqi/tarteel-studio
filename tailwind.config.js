module.exports = {
  content: [
    "./index.html",
    "./*.html", // للتعرف على الصفحات الأخرى مثل privacy.html
    "./seo-pages/**/*.html",
    "./js/**/*.js"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
