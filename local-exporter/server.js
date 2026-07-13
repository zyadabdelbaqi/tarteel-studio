const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const PORT = 8181;

function registerProtocol() {
    try {
        const exePath = process.execPath;
        const isPkg = typeof process.pkg !== 'undefined';
        if (!isPkg && !process.argv.includes('--force-register')) return;
        
        if (os.platform() === 'win32') {
            try {
                const check = execSync('reg query "HKCU\\Software\\Classes\\tarteel\\shell\\open\\command" /ve', { encoding: 'utf8', stdio: 'pipe' });
                if (check.includes(exePath)) return;
            } catch(e) {}

            console.log(`[+] Registering tarteel:// custom protocol handler...`);
            execSync(`reg add "HKCU\\Software\\Classes\\tarteel" /ve /t REG_SZ /d "URL:Tarteel Protocol" /f`, {stdio: 'ignore'});
            execSync(`reg add "HKCU\\Software\\Classes\\tarteel" /v "URL Protocol" /t REG_SZ /d "" /f`, {stdio: 'ignore'});
            execSync(`reg add "HKCU\\Software\\Classes\\tarteel\\shell\\open\\command" /ve /t REG_SZ /d "\\"${exePath}\\" \\"%1\\"" /f`, {stdio: 'ignore'});
            console.log(`[+] Windows Registry updated successfully.`);
        } 
        else if (os.platform() === 'linux') {
            const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
            const desktopPath = path.join(appsDir, 'tarteel-exporter.desktop');
            
            if (fs.existsSync(desktopPath)) {
                const content = fs.readFileSync(desktopPath, 'utf8');
                if (content.includes(exePath)) return;
            }

            if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });
            
            let iconPathLine = '';
            try {
                const iconBase64 = fs.readFileSync(path.join(__dirname, 'icon.png'), 'base64');
                const iconsDir = path.join(os.homedir(), '.local', 'share', 'icons');
                if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
                const iconDest = path.join(iconsDir, 'tarteel-exporter.png');
                fs.writeFileSync(iconDest, Buffer.from(iconBase64, 'base64'));
                iconPathLine = `Icon=${iconDest}`;
            } catch (e) {}
            
            const desktopFileContent = `[Desktop Entry]
Name=Tarteel Exporter
Exec="${exePath}" %u
Type=Application
Terminal=true
MimeType=x-scheme-handler/tarteel;
${iconPathLine}
`;
            fs.writeFileSync(desktopPath, desktopFileContent);
            try {
                execSync(`xdg-mime default tarteel-exporter.desktop x-scheme-handler/tarteel`, {stdio: 'ignore'});
                console.log(`[+] Linux protocol registered successfully.`);
            } catch (e) {}
        }
        else if (os.platform() === 'darwin') {
            // For macOS, full auto-registration requires an .app bundle.
            // If the user is running the bare binary, it will just start the server.
            console.log(`[i] Running on macOS. Ensure this binary is kept running for exports.`);
        }
    } catch(err) {
        console.log(`[-] Failed to register protocol:`, err.message);
    }
}

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Tarteel Exporter Running');
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`[!] Tarteel Exporter is already running in the background.`);
        process.exit(0);
    } else {
        console.error(e);
        process.exit(1);
    }
});

server.listen(PORT, () => {
    registerProtocol();
    console.log(`===========================================`);
    console.log(` Tarteel Studio - Local FFmpeg Exporter`);
    console.log(` Server is running on ws://127.0.0.1:${PORT}`);
    console.log(`===========================================\n`);
    console.log(`Waiting for connection from the browser...`);
});

const wss = new WebSocketServer({ server });
wss.on('error', (err) => {
    // Ignore WebSocketServer errors if it's due to port in use
});

wss.on('connection', (ws) => {
    console.log(`[+] Browser connected! Ready to receive export data.`);
    
    let ffmpegProcess = null;
    let audioStream = null;
    let isInitialized = false;
    let audioDone = false;
    let config = null;
    
    const tempDir = os.tmpdir();
    const tempAudioPath = path.join(tempDir, `tarteel_audio_${Date.now()}.wav`);
    const tempVideoPath = path.join(tempDir, `tarteel_video_${Date.now()}.mp4`);
    let videoFd = null;
    const defaultOutputPath = path.join(os.homedir(), 'Desktop', `Tarteel_Export_${Date.now()}.mp4`);

    // Helper to send messages back to the browser
    const sendMessage = (type, data = {}) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type, ...data }));
        }
    };

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            if (!isInitialized) return;

            if (!audioDone && audioStream) {
                // Writing to the audio temp file
                audioStream.write(message);
            } else if (audioDone && videoFd !== null) {
                // message is: [8 bytes Float64 offset] + [MP4 chunk data]
                if (message.length > 8) {
                    const offset = message.readDoubleLE(0);
                    const chunk = message.subarray(8);
                    fs.writeSync(videoFd, chunk, 0, chunk.length, offset);
                }
            }
        } else {
            // Text message
            try {
                const data = JSON.parse(message);
                
                if (data.type === 'init') {
                    config = data;
                    console.log(`\n[+] Export started with config: FPS=${config.fps}, Size=${config.width}x${config.height}`);
                    isInitialized = true;
                    audioDone = false;
                    
                    // Prepare temp files
                    audioStream = fs.createWriteStream(tempAudioPath);
                    videoFd = fs.openSync(tempVideoPath, 'w');

                } else if (data.type === 'audioDone') {
                    console.log(`\n[+] Audio received successfully. Ready for high-speed video chunks...`);
                    if (audioStream) {
                        audioStream.end();
                        audioStream = null;
                    }
                    audioDone = true;
                    sendMessage('readyForFrames');

                } else if (data.type === 'finish') {
                    console.log(`\n[+] Browser finished sending the full MP4 video. Merging with audio...`);
                    
                    if (videoFd !== null) {
                        fs.closeSync(videoFd);
                        videoFd = null;
                    }

                    const outputFilename = config.filename 
                        ? path.join(os.homedir(), 'Desktop', config.filename) 
                        : defaultOutputPath;
                    
                    function getFfmpegPath() {
                        const isPkg = typeof process.pkg !== 'undefined';
                        const ext = os.platform() === 'win32' ? '.exe' : '';
                        
                        if (isPkg) {
                            const bundledPath = path.join(__dirname, 'build-assets', `ffmpeg${ext}`);
                            const tmpPath = path.join(os.tmpdir(), `tarteel-ffmpeg${ext}`);
                            
                            // Only extract if it doesn't exist to save time
                            if (!fs.existsSync(tmpPath)) {
                                try {
                                    const binaryData = fs.readFileSync(bundledPath);
                                    fs.writeFileSync(tmpPath, binaryData);
                                    if (os.platform() !== 'win32') {
                                        fs.chmodSync(tmpPath, 0o755); // Make executable on Mac/Linux
                                    }
                                } catch (e) {
                                    console.error("[!] Failed to extract bundled FFmpeg:", e.message);
                                }
                            }
                            return tmpPath;
                        } else {
                            // Local dev fallback
                            return 'ffmpeg';
                        }
                    }
                    const ffmpegPath = getFfmpegPath();

                    // MUXING (Copying streams without re-encoding!)
                    const ffmpegArgs = [
                        '-y',
                        '-i', tempVideoPath,
                        '-i', tempAudioPath,
                        '-c:v', 'copy', // Zero CPU usage, instantly copies the WebCodecs video
                        '-c:a', 'aac',
                        '-b:a', '192k',
                        '-shortest',
                        outputFilename
                    ];

                    console.log(`[+] Executing: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

                    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

                    ffmpegProcess.stderr.on('data', (errData) => {
                        const str = errData.toString();
                        console.log(`FFmpeg: ${str}`);
                    });

                    ffmpegProcess.on('close', (code) => {
                        console.log(`\n[+] FFmpeg exited with code ${code}`);
                        
                        // Clean up temp files
                        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
                        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
                        
                        if (code === 0) {
                            console.log(`[+] Export SUCCESS! Saved to: ${outputFilename}`);
                            sendMessage('success', { filename: outputFilename });
                        } else {
                            console.log(`[!] Export FAILED.`);
                            sendMessage('error', { message: `FFmpeg exited with code ${code}` });
                        }
                    });

                    ffmpegProcess.on('error', (err) => {
                        console.error(`\n[!] Failed to start FFmpeg:`, err);
                        sendMessage('error', { message: 'Failed to start FFmpeg. Is it installed and in your PATH?' });
                    });
                }
            } catch (err) {
                console.error(`[!] WebSocket Message Error:`, err);
            }
        }
    });

    ws.on('close', () => {
        console.log(`[-] Browser disconnected.`);
        if (ffmpegProcess) {
            try { ffmpegProcess.kill('SIGKILL'); } catch(e) {}
        }
        if (audioStream) {
            audioStream.end();
        }
        if (videoFd !== null) {
            try { fs.closeSync(videoFd); } catch(e) {}
            videoFd = null;
        }
    });
});
