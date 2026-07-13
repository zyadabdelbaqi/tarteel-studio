const fs = require('fs');
const path = require('path');

const version = Date.now().toString();
console.log('Running cache buster with version:', version);

function updateFile(filePath, replacers) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    for (const replacer of replacers) {
        content = content.replace(replacer.regex, replacer.replace);
    }
    if (content !== original) {
        fs.writeFileSync(filePath, content);
        console.log(`Updated cache version in: ${path.basename(filePath)}`);
    }
}

// 1. Update index.html and other HTML files
const htmlFiles = ['index.html'].map(f => path.join(__dirname, f));

htmlFiles.forEach(file => {
    updateFile(file, [
        // Update CSS links
        {
            regex: /(href="css\/[a-zA-Z0-9_-]+\.css)\?v=[a-zA-Z0-9\.]+"/g,
            replace: `$1?v=${version}"`
        },
        // Update app.js injection (the first time, it might be new Date().getTime())
        {
            regex: /(`js\/app\.js)\?v=\$\{new Date\(\)\.getTime\(\)\}`/g,
            replace: `$1?v=${version}\``
        },
        // For subsequent runs
        {
            regex: /(`js\/app\.js)\?v=[a-zA-Z0-9\.]+`/g,
            replace: `$1?v=${version}\``
        },
        {
            regex: /('js\/app\.js)\?v=[a-zA-Z0-9\.]+'/g,
            replace: `$1?v=${version}'`
        },
        {
            regex: /("js\/app\.js)\?v=[a-zA-Z0-9\.]+"/g,
            replace: `$1?v=${version}"`
        }
    ]);
});

// 2. Update JS imports in all files inside js/ directory
const jsDir = path.join(__dirname, 'js');
if (fs.existsSync(jsDir)) {
    const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
    jsFiles.forEach(file => {
        const filePath = path.join(jsDir, file);
        updateFile(filePath, [
            // Static imports
            // Matches: import { something } from './module.js?v=old'
            // Captures: 1: 'import { something } from "'  2: './module.js'  3: '"'
            {
                regex: /(import\s+.*?from\s+['"])(\.\/[a-zA-Z0-9_-]+\.js)(?:\?v=[a-zA-Z0-9\.]+)?(['"])/g,
                replace: `$1$2?v=${version}$3`
            },
            // Static imports (no bindings)
            {
                regex: /(import\s+['"])(\.\/[a-zA-Z0-9_-]+\.js)(?:\?v=[a-zA-Z0-9\.]+)?(['"])/g,
                replace: `$1$2?v=${version}$3`
            }
        ]);
    });
}

console.log('Cache busting complete.');
