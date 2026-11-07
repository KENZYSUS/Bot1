import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';
import fileUpload from 'express-fileupload';

// --- Web Dashboard Configuration ---
const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: 500 * 1024 * 1024 } })); // 500MB upload ceiling

// Serve static index.html from project directory
app.use(express.static('./'));

// Active SSE client connections map for real-time progress broadcast
const clients = new Map();

function broadcastProgress(jobId, message) {
    const clientRes = clients.get(jobId);
    if (clientRes) {
        clientRes.write(`data: ${JSON.stringify({ message })} \n\n`);
    }
}

// Helper: Convert time string (00:00:12.34) to seconds
function timeToSeconds(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length !== 3) return 0;
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

// Helper: Get visual ASCII progress bar
function getProgressBar(percent) {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percent / 100) * totalBlocks);
    return '█'.repeat(filledBlocks) + '░'.repeat(totalBlocks - filledBlocks);
}

// Helper: Get File Size in Bytes
function getFileSize(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.size;
    } catch {
        return 0;
    }
}

// Helper: Clean up temporary files
function cleanupFiles(...filePaths) {
    filePaths.forEach((fp) => {
        if (fp && fs.existsSync(fp)) {
            try {
                fs.unlinkSync(fp);
            } catch (e) {
                console.error(`Failed to delete temp file ${fp}:`, e);
            }
        }
    });
}

// Preset Configs (Original untouched presets with 'max' 120fps and 30MB safeguard support)
const PRESETS = {
    max: {
        vcodec: 'libx264',
        crf: '18',
        preset: 'medium',
        scale: "scale='min(1080,iw)':-2,fps=120",
        profile: 'high',
        level: '5.1',
        label: 'Maximum Master UHD 120fps (1080p, CRF 18)',
        recommendation: '🔥 Ultimate clarity & 120fps fluid motion'
    },
    ultra: {
        vcodec: 'libx264',
        crf: '20',
        preset: 'veryfast',
        scale: "scale='min(1080,iw)':-2,fps=60",
        profile: 'high',
        level: '4.2',
        label: 'Ultra HD TikTok 60fps (1080p)',
        recommendation: '✨ Maximum clarity 1080p60 (CRF 20)'
    },
    high: {
        vcodec: 'libx264',
        crf: '22',
        preset: 'veryfast',
        scale: "scale='min(720,iw)':-2",
        profile: 'main',
        level: '4.0',
        label: 'High Quality (720p)',
        recommendation: '⚡ Clean 720p HD balance (CRF 22)'
    },
    fast: {
        vcodec: 'libx264',
        crf: '26',
        preset: 'ultrafast',
        scale: "scale='min(480,iw)':-2",
        profile: 'baseline',
        level: '3.1',
        label: 'Fast Compression (480p)',
        recommendation: '🚀 Fast encoding size saver'
    }
};

// Smart FFmpeg Runner (Original untouched 2-thread engine with live SSE piping)
function runSmartFFmpeg(inputPath, outputPath, presetKey, jobId) {
    return new Promise((resolve, reject) => {
        const config = PRESETS[presetKey] || PRESETS.ultra;

        let ffmpegArgs = [
            '-i', inputPath,
            '-vcodec', 'libx264',
            '-crf', config.crf,
            '-preset', config.preset,
            '-maxrate', presetKey === 'max' ? '8M' : '5M',
            '-bufsize', presetKey === 'max' ? '10M' : '6M',
            '-threads', '2', // Limited to 2 threads
            '-pix_fmt', 'yuv420p',
            '-color_primaries', 'bt709',
            '-color_trc', 'bt709',
            '-colorspace', 'bt709',
            '-profile:v', config.profile,
            '-level', config.level,
            '-vf', config.scale,
            '-acodec', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-movflags', '+faststart',
            '-y', outputPath
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let totalDurationSec = 0;

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            const durMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (durMatch && totalDurationSec === 0) {
                totalDurationSec = timeToSeconds(`${durMatch[1]}:${durMatch[2]}:${durMatch[3]}`);
            }

            const match = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
            if (match) {
                const currentTimeStr = match[1];
                if (totalDurationSec > 0) {
                    const currentSec = timeToSeconds(currentTimeStr);
                    let percent = Math.floor((currentSec / totalDurationSec) * 100);
                    if (percent > 100) percent = 100;
                    
                    const progressLine = `⏳ Compressing (${presetKey.toUpperCase()})... Time: ${currentTimeStr} [${getProgressBar(percent)}] ${percent}%`;
                    process.stdout.write(progressLine + '\r');
                    broadcastProgress(jobId, progressLine);
                }
            }
        });

        ffmpeg.on('close', (code) => {
            console.log('\n');
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });

        ffmpeg.on('error', (err) => {
            console.log('\n');
            reject(err);
        });
    });
}

// SSE Live Progress Endpoint
app.get('/api/progress/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    clients.set(jobId, res);

    req.on('close', () => {
        clients.delete(jobId);
    });
});

// Web API endpoint for web-based compression with strict 30MB fallback safeguard
app.post('/api/compress', async (req, res) => {
    if (!req.files || !req.files.video) {
        return res.status(400).json({ success: false, error: 'No video file uploaded.' });
    }

    const uploadedVideo = req.files.video;
    const presetKey = req.body.preset || 'ultra';
    const jobId = req.body.jobId || Date.now().toString();
    const timestamp = Date.now();
    const tempInput = path.resolve(`./web_input_${timestamp}.mp4`);
    const tempOutput = path.resolve(`./web_output_${timestamp}.mp4`);

    try {
        await uploadedVideo.mv(tempInput);
        broadcastProgress(jobId, `Starting conversion pipeline using preset: ${presetKey.toUpperCase()}`);

        // Run initial compression
        await runSmartFFmpeg(tempInput, tempOutput, presetKey, jobId);

        let finalPath = tempOutput;
        let finalSize = getFileSize(finalPath);
        const MAX_SIZE_BYTES = 30 * 1024 * 1024; // 30MB limit safeguard

        if (finalSize > MAX_SIZE_BYTES) {
            const fallbackMsg = `⚠️ Output size exceeded 30MB limit. Automatically applying fallback optimization...`;
            console.log(fallbackMsg);
            broadcastProgress(jobId, fallbackMsg);

            const fallbackOutput = path.resolve(`./web_fallback_${timestamp}.mp4`);
            let config = PRESETS[presetKey] || PRESETS.ultra;
            const fallbackCrf = String(parseInt(config.crf) + 4);
            
            PRESETS._fallback = { ...config, crf: fallbackCrf };
            await runSmartFFmpeg(tempInput, fallbackOutput, '_fallback', jobId);
            delete PRESETS._fallback;

            if (getFileSize(fallbackOutput) > 0) {
                cleanupFiles(tempOutput);
                finalPath = fallbackOutput;
                finalSize = getFileSize(finalPath);
            }
        }

        const outFilename = path.basename(finalPath);
        res.json({
            success: true,
            filename: outFilename,
            sizeMB: (finalSize / 1024 / 1024).toFixed(2)
        });
    } catch (err) {
        console.error('Web API Error:', err);
        broadcastProgress(jobId, `❌ Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanupFiles(tempInput);
    }
});

// Download endpoint for compressed video files
app.get('/api/download/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.resolve(`./${filename}`);
    if (fs.existsSync(filePath)) {
        res.download(filePath, () => {
            cleanupFiles(filePath);
        });
    } else {
        res.status(404).send('File not found or expired.');
    }
});

// Start Express Web Server
app.listen(PORT, () => {
    console.log(`🌐 Standalone MacBook Studio UI running on port ${PORT}`);
});
