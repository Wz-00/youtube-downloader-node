// app/services/ytdlService.js
const youtubedl = require('youtube-dl-exec');

async function getInfo(url) {
  const raw = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    preferFreeFormats: true,
  });
  const info = (typeof raw === 'string') ? JSON.parse(raw) : raw;
  return info;
}

module.exports = { getInfo };
