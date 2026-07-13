const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const png2icons = require('png2icons');
const resedit = require('resedit');

const BUILD_DIR = path.join(__dirname, 'build');
const ASSETS_DIR = path.join(__dirname, 'build-assets');
const ICON_PNG = path.join(__dirname, '../img/favicon/favicon-512.png');
const ICON_ICO = path.join(ASSETS_DIR, 'icon.ico');
const ICON_ICNS = path.join(ASSETS_DIR, 'icon.icns');

console.log("🚀 Starting advanced build process for Tarteel Exporter...");

// 1. Prepare directories & Copy icon for Linux pkg asset
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.copyFileSync(ICON_PNG, path.join(__dirname, 'icon.png'));

// 2. Generate Icons
console.log("🎨 Generating ICO and ICNS from PNG...");
const pngBuffer = fs.readFileSync(ICON_PNG);
const icoBuffer = png2icons.createICO(pngBuffer, png2icons.BICUBIC2, 0, false, true);
if (icoBuffer) fs.writeFileSync(ICON_ICO, icoBuffer);

const icnsBuffer = png2icons.createICNS(pngBuffer, png2icons.BICUBIC2, 0);
if (icnsBuffer) fs.writeFileSync(ICON_ICNS, icnsBuffer);

// 3. Compile binaries using pkg
console.log("📦 Compiling binaries with pkg...");
execSync('npx pkg . --targets node18-win-x64,node18-linux-x64,node18-macos-x64 --out-path build', { stdio: 'inherit' });

// 4. Windows: Inject Icon using resedit
console.log("🪟 Injecting icon into Windows executable...");
const winExePath = path.join(BUILD_DIR, 'tarteel-local-exporter-win.exe');
if (fs.existsSync(winExePath) && fs.existsSync(ICON_ICO)) {
    const exeBuffer = fs.readFileSync(winExePath);
    const exe = resedit.NtExecutable.from(exeBuffer);
    const res = resedit.NtExecutableResource.from(exe);
    
    const iconFile = resedit.Data.IconFile.from(fs.readFileSync(ICON_ICO));
    resedit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries, 1, 1033,
        iconFile.icons.map(item => item.data)
    );
    
    // Set Version Info
    const vi = resedit.Resource.VersionInfo.createEmpty();
    vi.setStringValues(
        { lang: 1033, codepage: 1200 },
        {
            FileDescription: 'Tarteel Studio Exporter',
            ProductName: 'Tarteel Studio Exporter',
            CompanyName: 'Tarteel Studio',
            OriginalFilename: 'tarteel-local-exporter-win.exe'
        }
    );
    vi.outputToResourceEntries(res.entries);
    
    res.outputResource(exe);
    fs.writeFileSync(winExePath, Buffer.from(exe.generate()));
    console.log("✅ Windows icon injected!");
}

// 5. macOS: Create App Bundle
console.log("🍏 Creating macOS App Bundle...");
const macBinPath = path.join(BUILD_DIR, 'tarteel-local-exporter-macos');
const macAppDir = path.join(BUILD_DIR, 'Tarteel Exporter.app');

if (fs.existsSync(macBinPath)) {
    const macOsDir = path.join(macAppDir, 'Contents', 'MacOS');
    const resourcesDir = path.join(macAppDir, 'Contents', 'Resources');
    
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    
    // Move binary
    fs.renameSync(macBinPath, path.join(macOsDir, 'tarteel-exporter'));
    execSync(`chmod +x "${path.join(macOsDir, 'tarteel-exporter')}"`);
    
    // Copy icon
    if (fs.existsSync(ICON_ICNS)) {
        fs.copyFileSync(ICON_ICNS, path.join(resourcesDir, 'icon.icns'));
    }
    
    // Create Info.plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>tarteel-exporter</string>
    <key>CFBundleIconFile</key>
    <string>icon.icns</string>
    <key>CFBundleIdentifier</key>
    <string>com.tarteel.exporter</string>
    <key>CFBundleName</key>
    <string>Tarteel Exporter</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Tarteel Protocol</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>tarteel</string>
            </array>
        </dict>
    </array>
</dict>
</plist>`;
    fs.writeFileSync(path.join(macAppDir, 'Contents', 'Info.plist'), plist);
    
    // Zip the app bundle for easy distribution
    console.log("🗜️ Zipping macOS App Bundle...");
    execSync(`cd "${BUILD_DIR}" && zip -r "Tarteel_Exporter_macOS.zip" "Tarteel Exporter.app"`, { stdio: 'ignore' });
    
    console.log("✅ macOS App Bundle created and zipped!");
}

// Cleanup
if (fs.existsSync(ASSETS_DIR)) fs.rmSync(ASSETS_DIR, { recursive: true, force: true });
console.log("🎉 Build complete!");
