import { resolve, join, relative } from 'path';
import { defineConfig } from 'vite';
import fs from 'fs';

// دالة مساعدة لجلب جميع ملفات HTML من مجلد معين بشكل متداخل (Recursive)
function getHtmlEntries(dir) {
  const entries = {};
  if (!fs.existsSync(dir)) return entries;

  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = join(dir, file.name);
    if (file.isDirectory()) {
      // دمج النتائج من المجلدات الفرعية
      Object.assign(entries, getHtmlEntries(fullPath));
    } else if (file.name.endsWith('.html')) {
      // إنشاء اسم فريد للمدخل بناءً على المسار النسبي
      const name = relative(__dirname, fullPath).replace(/\\/g, '/').replace('.html', '');
      entries[name] = fullPath;
      }
    }
  return entries;
}

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        refund: resolve(__dirname, 'refund.html'),
        terms: resolve(__dirname, 'terms.html'),
        
        // دمج جميع صفحات الـ SEO الموجودة في المجلدات والمسارات الفرعية بشكل تلقائي
        ...getHtmlEntries(resolve(__dirname, 'seo-pages'))
      }
    }
  }
});