// app/controllers/videoControllers.js
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs');
const { Videos } = require('../models');

const videoControllers = {
  // GET /api/ → ambil semua data video
  async getVideos(req, res) {
    try {
      const videos = await Videos.findAll({
        order: [['createdAt', 'DESC']],
      });
      return res.json({ status: true, data: videos });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ status: false, message: 'Internal Server Error' });
    }
  },

  // POST /api/download → download video
  // inside app/controllers/videoControllers.js - replace downloadVideo with this
  async downloadVideo(req, res) {
    try {
      const { url, resolution, format } = req.body;
      if (!url || !/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(url)) {
        return res.status(400).json({ status: false, message: 'Invalid YouTube URL' });
      }

      // Fetch metadata first (dumpSingleJson)
      let info = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificate: true,
        youtubeSkipDashManifest: true,
      });
      if (typeof info === 'string') {
        try { info = JSON.parse(info); } catch (e) { /* ignore */ }
      }

      const titleRaw = info && (info.title || info.fulltitle || `video_${Date.now()}`);
      let title = String(titleRaw).replace(/[^\w\s\-_.]/gi, '_');
      title = title.replace(/\.(mp4|webm|mkv|mov|avi|flac|mp3|wav)$/i, '').trim();

      const requestedFormat = (format || 'mp4').toLowerCase();
      const resParam = (resolution || 'highest').toString().toLowerCase();
      let maxHeight = null;
      if (!['highest', 'best', 'auto'].includes(resParam)) {
        const m = resParam.match(/(\d{3,4})/);
        if (m) maxHeight = parseInt(m[1], 10); // e.g. 1080, 720
      }
      const downloadsDir = path.resolve(__dirname, '../../downloads');
      if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

      const outputTemplate = path.resolve(downloadsDir, `${title}.%(ext)s`);
      const ytdlOpts = {
        output: outputTemplate,
        restrictFilenames: true,
        noCheckCertificate: true,
        noWarnings: true,
        youtubeSkipDashManifest: true,
        // don't set preferFreeFormats globally — we'll control it per format
      };

      // Choose format string and conversion behavior based on requestedFormat
      if (requestedFormat === 'mp3') {
        ytdlOpts.extractAudio = true;
        ytdlOpts.audioFormat = 'mp3';
        ytdlOpts.audioQuality = 0;
      } else if (requestedFormat === 'mp4') {
        // Prefer mp4 streams, fallback to recode to mp4 if needed
        // This picks mp4 streams first; if unavailable, recodeVideo ensures final .mp4
        // ytdlOpts.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

        // Prefer mp4 streams, optionally constrain by height (e.g. 1080, 720)
        if (maxHeight) {
          ytdlOpts.format = `bestvideo[ext=mp4][height<=${maxHeight}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${maxHeight}]/best[height<=${maxHeight}]`;
        } else {
          ytdlOpts.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        }
        // If the selected streams are not mp4, recodeVideo will try to convert/remux to mp4
        // Requires ffmpeg installed.
        ytdlOpts.recodeVideo = 'mp4';
        // Avoid preferring free formats (webm) when we want mp4
        ytdlOpts.preferFreeFormats = false;
      } else if (requestedFormat === 'webm') {
        // ytdlOpts.format = 'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]/best';

        if (maxHeight) {
          ytdlOpts.format = `bestvideo[ext=webm][height<=${maxHeight}]+bestaudio[ext=webm]/best[ext=webm][height<=${maxHeight}]/best[height<=${maxHeight}]`;
        } else {
          ytdlOpts.format = 'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]/best';
        }
        // It's fine to prefer free formats for webm
        ytdlOpts.preferFreeFormats = true;
      } else {
        // generic: keep bestvideo+bestaudio, but do not prefer free formats by default
        ytdlOpts.format = 'bestvideo+bestaudio/best';
        // generic: keep bestvideo+bestaudio, optionally constrain by height
        if (maxHeight) {
          ytdlOpts.format = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;
        } else {
          ytdlOpts.format = 'bestvideo+bestaudio/best';
        }
        ytdlOpts.preferFreeFormats = false;
      }

      console.log('ytdl options:', ytdlOpts);

      // run download
      const result = await youtubedl(url, ytdlOpts).catch(err => {
        console.error('ytdl error:', err);
        throw err;
      });
      console.log('ytdl result:', typeof result === 'string' ? result.slice(0, 400) : result);

      // more robust file search: match files that contain sanitized title (restrictFilenames may modify it)
      const files = fs.readdirSync(downloadsDir)
        .filter(f => !f.endsWith('.part') && f.toLowerCase().includes(title.toLowerCase()));

      if (files.length === 0) {
        // fallback: list all files created in last 120 seconds (last downloads) — helpful in some environments
        const fallbackFiles = fs.readdirSync(downloadsDir)
          .filter(f => !f.endsWith('.part'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5)
          .map(x => x.name);
        if (fallbackFiles.length === 0) {
          console.error('No downloaded file found for title:', title, 'checked dir:', downloadsDir);
          return res.status(500).json({ status: false, message: 'Download failed (no file)' });
        }
        // use fallback list
        files.push(...fallbackFiles);
      }

      // choose the largest file among candidates (most likely the merged file)
      let bestFile = null;
      let bestSize = -1;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(downloadsDir, f));
          if (stat.size > bestSize) {
            bestSize = stat.size;
            bestFile = f;
          }
        } catch (e) { /* ignore */ }
      }

      if (!bestFile) {
        console.error('Could not determine final file from candidates:', files);
        return res.status(500).json({ status: false, message: 'Download failed (no final file)' });
      }

      const filePath = path.resolve(downloadsDir, bestFile);
      const filesize = fs.statSync(filePath).size;

      const newVideo = await Videos.create({
        iplog: req.ip,
        url,
        resolution: resolution || 'highest',
        format: path.extname(bestFile).replace('.', '') || requestedFormat,
        filename: bestFile,
        filesize: `${(filesize / (1024 * 1024)).toFixed(2)} MB`,
      });

      return res.json({
        status: true,
        message: 'Download completed',
        data: newVideo,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ status: false, message: 'Internal Server Error' });
    }
  }

};

module.exports = videoControllers;
