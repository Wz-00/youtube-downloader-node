// worker/mergeWorker.js
require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const { spawn, spawnSync } = require('child_process');
const Queue = require('bull');
const Redis = require('ioredis');
const youtubedlExec = require('youtube-dl-exec'); // fallback npm wrapper
const { getInfo } = require('../app/services/ytdlService');
const { uploadFile } = require('../app/services/storage');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const queueName = 'mergeQueue';
const mergeQueue = new Queue(queueName, redisUrl);
const redisClient = new Redis(redisUrl);

const TEMP_DIR = process.env.TEMP_DIR || path.resolve(__dirname, '../tmp');
fs.ensureDirSync(TEMP_DIR);

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_MERGES || 1);

console.log('Worker started — listening to queue', queueName, 'TEMP_DIR=', TEMP_DIR);

// runCommand: spawn a process and capture stderr for debugging
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    p.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      console.error(cmd, s.trim());
    });
    p.on('error', err => reject(err));
    p.on('close', code => (code === 0 ? resolve({ code, stderr }) : reject(new Error(`${cmd} exited ${code} - ${stderr}`))));
  });
}

// locateYtdlp: attempt a few locations (env, project/bin, PATH)
function locateYtdlpExecutable() {
  const envPath = process.env.YTDLP_PATH;
  if (envPath && fs.pathExistsSync(envPath)) return envPath;

  // project local bin (convention)
  const localBin = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.pathExistsSync(localBin)) return localBin;

  // try to detect in PATH by calling `yt-dlp --version` synchronously
  try {
    const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const res = spawnSync(exe, ['--version'], { stdio: 'ignore' });
    if (!res.error) return exe;
  } catch (e) {
    // ignored
  }

  // not found; return null to signal fallback to youtube-dl-exec
  return null;
}

// downloadWithYtdlp: try spawning yt-dlp executable; if not available or fails, fallback to youtube-dl-exec npm wrapper
async function downloadWithYtdlp(formatOrItag, outputPath, url) {
  const exe = locateYtdlpExecutable();
  if (exe) {
    try {
      console.log('Using yt-dlp executable:', exe, 'to download format:', formatOrItag, '->', outputPath);
      await runCommand(exe, ['-f', String(formatOrItag), '-o', outputPath, url]);
      return;
    } catch (err) {
      console.warn('yt-dlp executable failed, falling back to youtube-dl-exec:', err.message || err);
      // fallthrough to npm wrapper
    }
  } else {
    console.log('yt-dlp executable not found in PATH/project; using youtube-dl-exec (npm wrapper)');
  }

  // fallback using youtube-dl-exec (this will use bundled yt-dlp if available)
  // options: format, output, noWarnings, preferFreeFormats
  await youtubedlExec(url, {
    format: String(formatOrItag),
    output: outputPath,
    noWarnings: true,
    preferFreeFormats: true,
    // disable progress streaming to stdout for cleaner logs
    quiet: true
  });
}

mergeQueue.process(MAX_CONCURRENT, async (job) => {
  const { url, itag, filename, output } = job.data;
  console.log(`Processing job ${job.id}: itag=${itag} url=${url}`);

  try {
    if (job && typeof job.progress === 'function') job.progress(5);

    // fetch metadata
    const info = await getInfo(url);
    if (job && typeof job.progress === 'function') job.progress(10);

    // find format metadata
    const format = (info.formats || []).find(f => String(f.format_id || f.itag) === String(itag));
    if (!format) throw new Error('Format not found in metadata');

    // prepare filenames (unique)
    const safeName = (filename || info.title || `video_${Date.now()}`).replace(/[^\w\-_. ]+/g, '_').substring(0,200);
    const outExt = output || (format.ext || 'mp4');
    const uniqueSuffix = `${job.id}-${Date.now()}`;
    const outBasename = `${safeName}-${uniqueSuffix}.${outExt}`;
    const outPath = path.join(TEMP_DIR, outBasename);

    // temp files for video/audio
    const videoTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.video.${format.ext || 'mp4'}`);
    const audioTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.audio.m4a`);

    const hasAudioInFormat = format.acodec && String(format.acodec) !== 'none';
    const hasVideoInFormat = format.vcodec && String(format.vcodec) !== 'none';

    // If format is muxed (contains both audio & video), download directly to outPath
    if (hasAudioInFormat && hasVideoInFormat && format.url) {
      if (job && typeof job.progress === 'function') job.progress(20);
      console.log('Downloading muxed format to', outPath);
      await downloadWithYtdlp(itag, outPath, url);
      if (job && typeof job.progress === 'function') job.progress(60);
    } else {
      // video-only: download video stream then download best audio, then merge locally
      if (job && typeof job.progress === 'function') job.progress(20);
      console.log('Downloading video-only stream to', videoTmp);
      await downloadWithYtdlp(itag, videoTmp, url);

      // pick best audio from metadata
      const audios = (info.formats || []).filter(f => f.acodec && String(f.acodec) !== 'none' && (f.format_id || f.itag));
      audios.sort((a,b) => (b.abr || b.audioBitrate || 0) - (a.abr || a.audioBitrate || 0));
      if (!audios.length) throw new Error('No audio stream available to merge');
      const audioFormatId = audios[0].format_id || audios[0].itag;
      console.log('Downloading audio stream to', audioTmp, 'formatId=', audioFormatId);
      await downloadWithYtdlp(audioFormatId, audioTmp, url);
      if (job && typeof job.progress === 'function') job.progress(50);

      // merge via ffmpeg from local files (copy video stream)
      const ffmpegArgs = [
        '-y',
        '-hide_banner', '-loglevel', 'error',
        '-i', videoTmp,
        '-i', audioTmp,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-f', outExt,
        outPath
      ];
      console.log('Merging via ffmpeg ->', outPath);
      await runCommand('ffmpeg', ffmpegArgs);
      if (job && typeof job.progress === 'function') job.progress(80);

      // cleanup video/audio tmp files
      try { if (await fs.pathExists(videoTmp)) await fs.remove(videoTmp); } catch(e){ console.warn('cleanup videoTmp', e); }
      try { if (await fs.pathExists(audioTmp)) await fs.remove(audioTmp); } catch(e){ console.warn('cleanup audioTmp', e); }
    }

    // Upload or move result (storage module decides S3 vs local)
    const key = `merged/${path.basename(outPath)}`;
    console.log('Uploading', outPath, '->', key);
    if (job && typeof job.progress === 'function') job.progress(85);
    const downloadUrl = await uploadFile(outPath, key);
    if (job && typeof job.progress === 'function') job.progress(100);

    // save result in Redis for quick retrieval by API
    const resultKey = `jobResult:${job.id}`;
    await redisClient.set(resultKey, JSON.stringify({ downloadUrl, key }), 'EX', Number(process.env.JOB_RESULT_TTL || 86400));

    // cleanup outPath if still exists (uploadFile may have moved it)
    try { if (await fs.pathExists(outPath)) await fs.remove(outPath); } catch(e){ console.warn('cleanup outPath', e); }

    return { downloadUrl, key };
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    // rethrow so Bull marks job as failed
    throw err;
  }
});

mergeQueue.on('completed', (job, result) => {
  console.log('Job completed', job.id);
});

mergeQueue.on('failed', (job, err) => {
  console.error('Job failed', job.id, err);
});
