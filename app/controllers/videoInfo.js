// app/controllers/videoInfo.js
const { getInfo } = require('../services/ytdlService');

async function postVideoInfo(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ status:false, message:'Missing url' });
    const info = await getInfo(url);
    // map formats
    const formats = (info.formats || []).map(f => ({
      itag: f.format_id || f.itag,
      ext: f.ext || f.container,
      qualityLabel: f.format_note || (f.height ? `${f.height}p` : null),
      hasVideo: !!(f.vcodec && f.vcodec !== 'none'),
      hasAudio: !!(f.acodec && f.acodec !== 'none'),
      filesize: f.filesize || f.filesize_approx || f.contentLength || null
    }));
    return res.json({ status: true, data: { title: info.title, duration: info.duration, thumbnail: info.thumbnail, formats } });
  } catch (err) {
    console.error('postVideoInfo err', err);
    return res.status(500).json({ status:false, message:'Internal Server Error' });
  }
}

module.exports = { postVideoInfo };
