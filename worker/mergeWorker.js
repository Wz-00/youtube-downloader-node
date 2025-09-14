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
const { Videos } = require('../app/models');

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
async function downloadWithYtdlp(formatOrItag, outputPath, url, opts = {}) {
  // opts: { extractAudio: boolean, audioFormat: 'mp3'|'m4a'|..., quiet: bool }
  const exe = locateYtdlpExecutable();
  const fmt = String(formatOrItag);

  // Build CLI args for executable path (yt-dlp)
  if (exe) {
    try {
      const args = ['-f', fmt, '-o', outputPath];
      if (opts.extractAudio) {
        // extract audio via yt-dlp: -x --audio-format <fmt>
        args.push('-x', '--audio-format', String(opts.audioFormat || 'mp3'));
      }
      if (opts.quiet) args.push('-q');
      console.log('Using yt-dlp executable:', exe, 'args=', args.join(' '));
      await runCommand(exe, args, { env: process.env });
      return;
    } catch (err) {
      console.warn('yt-dlp executable failed, falling back to youtube-dl-exec:', err.message || err);
      // fallthrough to npm wrapper
    }
  } else {
    console.log('yt-dlp executable not found in PATH/project; using youtube-dl-exec (npm wrapper)');
  }

  // fallback: use youtube-dl-exec (npm)
  const ytdlOpts = {
    output: outputPath,
    format: fmt,
    noWarnings: true,
    preferFreeFormats: true,
    quiet: !!opts.quiet
  };

  if (opts.extractAudio) {
    // youtube-dl-exec uses extractAudio / audioFormat keys
    ytdlOpts.extractAudio = true;
    ytdlOpts.audioFormat = opts.audioFormat || 'mp3';
    // if format was an audio itag, better to just download that audio (use format instead of extract)
    // but extractAudio will re-encode if necessary
  }

  await youtubedlExec(url, ytdlOpts);
}

// MAIN PROCESS PATCH: replace the previous large if/else block with this logic
mergeQueue.process(MAX_CONCURRENT, async (job) => {
  const { url, itag, filename, output } = job.data;
  console.log(`Processing job ${job.id}: itag=${itag} url=${url}`);

  try {
    if (job && typeof job.progress === 'function') job.progress(5);

    const info = await getInfo(url);
    if (job && typeof job.progress === 'function') job.progress(10);

    const format = (info.formats || []).find(f => String(f.format_id || f.itag) === String(itag));
    if (!format) throw new Error('Format not found in metadata');

    const safeName = (filename || info.title || `video_${Date.now()}`).replace(/[^\w\-_. ]+/g, '_').substring(0,200);
    const outExt = output || (format.ext || 'mp4');
    const uniqueSuffix = `${job.id}-${Date.now()}`;
    const outBasename = `${safeName}-${uniqueSuffix}.${outExt}`;
    const outPath = path.join(TEMP_DIR, outBasename);

    const audioOutputs = new Set(['mp3','m4a','aac','wav','opus']);
    const wantAudioOnly = audioOutputs.has(String(outExt).toLowerCase());

    const hasAudioInFormat = format.acodec && String(format.acodec) !== 'none';
    const hasVideoInFormat = format.vcodec && String(format.vcodec) !== 'none';

    
    // CASE 1: muxed (contains audio + video) => download as-is
    if (hasAudioInFormat && hasVideoInFormat && format.url) {
      if (job && typeof job.progress === 'function') job.progress(20);
      console.log('Downloading muxed format to', outPath);
      await downloadWithYtdlp(itag, outPath, url, { quiet: true });
      if (job && typeof job.progress === 'function') job.progress(60);
    } else if (hasAudioInFormat && !hasVideoInFormat) {
      if (wantAudioOnly) {
        // download audio directly (no merge)
        if (job && typeof job.progress === 'function') job.progress(20);
        console.log('Downloading audio-only format to', outPath, 'format-itag=', itag);
        await downloadWithYtdlp(itag, outPath, url, { extractAudio: true, audioFormat: outExt, quiet: true });
        if (job && typeof job.progress === 'function') job.progress(80);
      } else {
        // Defensive fallback: try to find a video format matching requested resolution (if any)
        const tryDesiredHeight = (() => {
          const m = String(outExt).match(/^(\d+)p$/); // not likely; adjust if you send resolution separately
          return m ? Number(m[1]) : null;
        })();

        // first try to find any video with same itag? better: find best mp4 video
        const mp4Videos = (info.formats || []).filter(f => f.vcodec && String(f.vcodec) !== 'none' && (f.ext || f.container || '').toLowerCase() === 'mp4');
        // attempt to pick nearest quality (prefer >= desired)
        let candidateVideo = null;
        if (tryDesiredHeight && mp4Videos.length) {
          mp4Videos.sort((a,b) => (a.height||0) - (b.height||0));
          candidateVideo = mp4Videos.find(v => v.height === tryDesiredHeight) || mp4Videos.find(v => v.height && v.height >= tryDesiredHeight) || mp4Videos.slice().sort((a,b)=> (b.height||0)-(a.height||0))[0];
        } else if (mp4Videos.length) {
          candidateVideo = mp4Videos.slice().sort((a,b)=> (b.height||0)-(a.height||0))[0];
        }

        if (candidateVideo) {
          console.warn('Selected format was audio-only but user requested video output; falling back to video itag=', candidateVideo.format_id || candidateVideo.itag);
          // replace format & continue processing route as video-only branch
          // WARNING: careful to avoid infinite recursion; do inline: download video then audio and merge
          const videoFmtId = candidateVideo.format_id || candidateVideo.itag;
          const videoTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.video.${candidateVideo.ext || 'mp4'}`);
          const audioTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.audio.m4a`);

          console.log('Downloading fallback video stream to', videoTmp);
          await downloadWithYtdlp(videoFmtId, videoTmp, url, { quiet: true });

          const audios = (info.formats || []).filter(f => f.acodec && String(f.acodec) !== 'none' && (f.format_id || f.itag));
          audios.sort((a,b) => (b.abr || b.audioBitrate || 0) - (a.abr || a.audioBitrate || 0));
          if (!audios.length) throw new Error('No audio stream available to merge (fallback)');
          const audioFormatId = audios[0].format_id || audios[0].itag;
          console.log('Downloading audio stream to', audioTmp, 'formatId=', audioFormatId);
          await downloadWithYtdlp(audioFormatId, audioTmp, url, { quiet: true });
          if (job && typeof job.progress === 'function') job.progress(50);

          const ffmpegArgs = [
            '-y', '-hide_banner', '-loglevel', 'error',
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

          // cleanup
          try { if (await fs.pathExists(videoTmp)) await fs.remove(videoTmp); } catch(e){ console.warn('cleanup videoTmp', e); }
          try { if (await fs.pathExists(audioTmp)) await fs.remove(audioTmp); } catch(e){ console.warn('cleanup audioTmp', e); }
        } else {
          // no fallback -> explicit clear error
          throw new Error('Selected format contains only audio but requested video output');
        }
      }
    } else if (!hasAudioInFormat && hasVideoInFormat) {
      // CASE 3: video-only -> need to download video then pick best audio and merge
      if (job && typeof job.progress === 'function') job.progress(20);
      const videoTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.video.${format.ext || 'mp4'}`);
      const audioTmp = path.join(TEMP_DIR, `${safeName}-${uniqueSuffix}.audio.m4a`);

      console.log('Downloading video-only stream to', videoTmp);
      await downloadWithYtdlp(itag, videoTmp, url, { quiet: true });

      // pick best audio from metadata
      const audios = (info.formats || []).filter(f => f.acodec && String(f.acodec) !== 'none' && (f.format_id || f.itag));
      audios.sort((a,b) => (b.abr || b.audioBitrate || 0) - (a.abr || a.audioBitrate || 0));
      if (!audios.length) throw new Error('No audio stream available to merge');
      const audioFormatId = audios[0].format_id || audios[0].itag;
      console.log('Downloading audio stream to', audioTmp, 'formatId=', audioFormatId);
      await downloadWithYtdlp(audioFormatId, audioTmp, url, { quiet: true });
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

    } else {
      throw new Error('Unknown stream type (no audio & no video)');
    }

    // upload result (same as before)
    const key = `merged/${path.basename(outPath)}`;
    console.log('Uploading', outPath, '->', key);
    if (job && typeof job.progress === 'function') job.progress(85);
    const downloadUrl = await uploadFile(outPath, key);
    if (job && typeof job.progress === 'function') job.progress(100);

    let filesizeStr = null;
    try {
      // jika outPath masih ada local (uploadFile mungkin memindah/meng-copy) -> stat
      if (await fs.pathExists(outPath)) {
        const st = await fs.stat(outPath);
        filesizeStr = `${(st.size / (1024 * 1024)).toFixed(2)} MB`;
      } else {
        // jika file sudah tidak ada lokal (upload moved it), attempt to get size via upload response if available
        // uploadFile should ideally return size or you can skip; fallback to null
        filesizeStr = null;
      }
    } catch (e) {
      console.warn('stat failed for outPath:', e);
      filesizeStr = null;
    }

    // --- determine final filename & resolution & format ---
    const finalFilename = path.basename(outPath);
    const finalExt = outExt || (format && format.ext) || (String(output || '').toLowerCase()) || path.extname(finalFilename).replace('.', '');
    let finalResolution = null; // compute if we can
    // prefer format.height if available (note: ensure `format` variable still in scope)
    if (format && format.height) finalResolution = `${format.height}p`;
    // else if requested resolution given in job.data.requestedResolution, use that as fallback
    if (!finalResolution && job.data && job.data.requestedResolution) {
      finalResolution = (typeof job.data.requestedResolution === 'string' && /^\d+$/.test(job.data.requestedResolution))
        ? `${job.data.requestedResolution}p`
        : job.data.requestedResolution;
    }

    // Now create the DB record (only after success)
    try {
      await Videos.create({
        iplog: job.data?.iplog || null,
        url: job.data?.url || url,
        resolution: finalResolution || 'unknown',
        format: finalExt || 'mp4',
        filename: finalFilename,
        filesize: filesizeStr || 'unknown'
      });
      console.log('Videos record created for job', job.id);
    } catch (dbErr) {
      console.error('Failed to create Videos record:', dbErr);
    }

    const resultKey = `jobResult:${job.id}`;
    await redisClient.set(resultKey, JSON.stringify({ downloadUrl, key }), 'EX', Number(process.env.JOB_RESULT_TTL || 86400));
    try { if (await fs.pathExists(outPath)) await fs.remove(outPath); } catch(e){ console.warn('cleanup outPath', e); }

    return { downloadUrl, key };
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    throw err;
  }
});


mergeQueue.on('completed', (job, result) => {
  console.log('Job completed', job.id);
});

mergeQueue.on('failed', (job, err) => {
  console.error('Job failed', job.id, err);
});
