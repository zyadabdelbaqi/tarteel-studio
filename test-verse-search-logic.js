// اختبار شامل لوظيفة البحث عن الآيات
function runComprehensiveTests() {
    console.log('🚀 بدء اختبارات وظيفة البحث عن الآيات...\n');
    
    let testsPassed = 0;
    let testsFailed = 0;
    
    // اختبار 1: البحث عن آية واحدة
    console.log('اختبار 1: البحث عن آية واحدة (2:255)');
    const test1 = testVerseSearch('2:255', { surah: 2, startAyah: 255, endAyah: 255 });
    if (test1) {
        console.log('✅ نجح: تم العثور على السورة 2، الآية 255\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // اختبار 2: البحث عن مجموعة آيات
    console.log('اختبار 2: البحث عن مجموعة آيات (2:255-257)');
    const test2 = testVerseSearch('2:255-257', { surah: 2, startAyah: 255, endAyah: 257 });
    if (test2) {
        console.log('✅ نجح: تم العثور على السورة 2، الآيات 255-257\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // اختبار 3: استخدام علامة القسمة
    console.log('اختبار 3: استخدام علامة القسمة (2/255)');
    const test3 = testVerseSearch('2/255', { surah: 2, startAyah: 255, endAyah: 255 });
    if (test3) {
        console.log('✅ نجح: تم العثور على السورة 2، الآية 255 باستخدام علامة القسمة\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // اختبار 4: أول آية في القرآن
    console.log('اختبار 4: أول آية في القرآن (1:1)');
    const test4 = testVerseSearch('1:1', { surah: 1, startAyah: 1, endAyah: 1 });
    if (test4) {
        console.log('✅ نجح: تم العثور على السورة 1، الآية 1\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // اختبار 5: آية من الفاتحة
    console.log('اختبار 5: عدة آيات من الفاتحة (1:1-3)');
    const test5 = testVerseSearch('1:1-3', { surah: 1, startAyah: 1, endAyah: 3 });
    if (test5) {
        console.log('✅ نجح: تم العثور على السورة 1، الآيات 1-3\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // اختبار 6: بحث غير صالح
    console.log('اختبار 6: بحث غير صالح (abc)');
    const test6 = testVerseSearch('abc', null);
    if (!test6) {
        console.log('✅ نجح: تم رفض البحث غير الصالح\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: يجب رفض البحث غير الصالح\n');
        testsFailed++;
    }
    
    // اختبار 7: حقل فارغ
    console.log('اختبار 7: حقل فارغ');
    const test7 = testVerseSearch('', null);
    if (!test7) {
        console.log('✅ نجح: تم التعامل مع الحقل الفارغ\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: يجب التعامل مع الحقل الفارغ\n');
        testsFailed++;
    }
    
    // اختبار 8: رقم سورة غير صالح
    console.log('اختبار 8: رقم سورة غير صالح (200:1)');
    const test8 = testVerseSearch('200:1', null);
    if (!test8) {
        console.log('✅ نجح: تم رفض رقم السورة غير الصالح\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: يجب رفض رقم السورة غير الصالح\n');
        testsFailed++;
    }
    
    // اختبار 9: رقم آية سالب
    console.log('اختبار 9: رقم آية غير صالح (1:-5)');
    const test9 = testVerseSearch('1:-5', null);
    if (!test9) {
        console.log('✅ نجح: تم رفض رقم الآية غير الصالح\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: يجب رفض رقم الآية غير الصالح\n');
        testsFailed++;
    }
    
    // اختبار 10: آية ختامية
    console.log('اختبار 10: آية ختامية (114:6)');
    const test10 = testVerseSearch('114:6', { surah: 114, startAyah: 6, endAyah: 6 });
    if (test10) {
        console.log('✅ نجح: تم العثور على السورة 114، الآية 6\n');
        testsPassed++;
    } else {
        console.log('❌ فشل: لم يتم العثور على النتائج المتوقعة\n');
        testsFailed++;
    }
    
    // عرض النتائج النهائية
    console.log('='.repeat(50));
    console.log('📊 نتائج الاختبارات النهائية:');
    console.log(`✅ الاختبارات الناجحة: ${testsPassed}`);
    console.log(`❌ الاختبارات الفاشلة: ${testsFailed}`);
    console.log(`📈 نسبة النجاح: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);
    console.log('='.repeat(50));
    
    return testsFailed === 0;
}

// دالة لاختبار منطق البحث
function testVerseSearch(query, expectedResult) {
    const searchPattern = /^(\d{1,3})[:/]\s*(\d{1,3})\s*(?:-\s*(\d{1,3}))?$/;
    const match = query.match(searchPattern);
    
    // الحالات التي لا تطابق النمط تماماً
    if (!match) {
        // نمط غير صالح - إرجاع false
        return false;
    }
    
    const surahNum = parseInt(match[1]);
    const startAyah = parseInt(match[2]);
    const endAyah = match[3] ? parseInt(match[3]) : startAyah;
    
    // التحقق من النطاق المسموح (1-114 للسور، موجب للآيات)
    const isValidSurah = surahNum >= 1 && surahNum <= 114;
    const isValidAyahStart = startAyah >= 1;
    const isValidRange = endAyah >= startAyah;
    const isValidOverall = isValidSurah && isValidAyahStart && isValidRange;
    
    // إذا كان غير صالح
    if (!isValidOverall) {
        // إذا كان المتوقع هو null (لا نتائج)، فهذا صحيح
        return expectedResult === null;
    }
    
    // التحقق من النتيجة المتوقعة
    if (expectedResult) {
        return surahNum === expectedResult.surah && 
               startAyah === expectedResult.startAyah && 
               endAyah === expectedResult.endAyah;
    }
    
    // نمط صالح ولكن لا نتائج متوقعة - هذا صحيح (النمط صالح)
    return true;
}

console.log('🧪 تم تحميل مكتبة اختبار البحث عن الآيات');
console.log('💡 استخدم runComprehensiveTests() لتشغيل جميع الاختبارات\n');
