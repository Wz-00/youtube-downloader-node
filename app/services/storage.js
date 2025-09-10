// app/services/storage.js
const fs = require('fs-extra');
const path = require('path');

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bucket = process.env.S3_BUCKET;
const region = process.env.S3_REGION || 'us-east-1';

// local fallback folder
const PUBLIC_DOWNLOADS = path.resolve(process.cwd(), 'public', 'downloads');
fs.ensureDirSync(PUBLIC_DOWNLOADS);

let s3 = null;
let s3Enabled = false;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && bucket) {
  const s3Config = { region };
  if (process.env.S3_ENDPOINT) {
    s3Config.endpoint = process.env.S3_ENDPOINT;
    s3Config.forcePathStyle = true; // for MinIO
  }
  s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    ... (s3Config.endpoint ? { endpoint: s3Config.endpoint, forcePathStyle: true } : {})
  });
  s3Enabled = true;
}

async function uploadFile(localPath, key) {
  // key is the object key, e.g. merged/filename.mp4
  if (s3Enabled) {
    // Upload to S3
    const put = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(localPath)
    });
    await s3.send(put);

    // generate presigned GET URL
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const url = await getSignedUrl(s3, getCmd, { expiresIn: Number(process.env.S3_PRESIGNED_EXPIRES || 3600) });
    return url;
  } else {
    // Local fallback: copy/move file to public/downloads and return local URL
    await fs.ensureDir(PUBLIC_DOWNLOADS);
    const filename = path.basename(localPath);
    const dest = path.join(PUBLIC_DOWNLOADS, filename);

    // Move (rename) localPath into public downloads to avoid duplicates
    await fs.move(localPath, dest, { overwrite: true });

    const API_PREFIX = process.env.API_PREFIX ?? '/api';
    const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT || 4000}`;
    return `${PUBLIC_BASE_URL.replace(/\/$/,'')}${API_PREFIX.startsWith('/')?API_PREFIX:'/'+API_PREFIX}/downloads/${encodeURIComponent(filename)}`;
  }
}

module.exports = { uploadFile, s3Enabled };
