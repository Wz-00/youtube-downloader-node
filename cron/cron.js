const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const downloadsDir = path.resolve(__dirname, '../downloads');

// jalan tiap 3 jam
cron.schedule('0 */3 * * *', () => {
  const now = Date.now();
  const limit = 3 * 60 * 60 * 1000; // 3 jam

  fs.readdirSync(downloadsDir).forEach(f => {
    const filePath = path.join(downloadsDir, f);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > limit) {
      fs.unlinkSync(filePath);
      console.log(`Deleted old file: ${f}`);
    }
  });
});
