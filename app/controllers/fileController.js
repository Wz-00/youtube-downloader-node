// app/controllers/fileController.js
const path = require('path');
const fs = require('fs');

const PUBLIC_DOWNLOADS = path.join(process.cwd(), 'public', 'downloads');

async function serveDownload(req, res) {
  try {
    // Express sudah decode param, ambil nama file yang aman
    const filename = path.basename(req.params.filename); // prevents path traversal
    const filePath = path.join(PUBLIC_DOWNLOADS, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ status: false, message: 'Not found' });
    }

    // res.download sets Content-Disposition and streams file
    return res.download(filePath, filename, (err) => {
      if (err) {
        console.error('res.download error:', err);
        if (!res.headersSent) res.status(500).end();
      }
    });
  } catch (err) {
    console.error('serveDownload err', err);
    return res.status(500).json({ status: false, message: 'Internal Server Error' });
  }
}

module.exports = { serveDownload };
