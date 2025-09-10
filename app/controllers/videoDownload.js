// app/controllers/downloadController.js
const Queue = require('bull');
const Redis = require('ioredis');
const path = require('path');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const queueName = 'mergeQueue';
const mergeQueue = new Queue(queueName, redisUrl);
const redisClient = new Redis(redisUrl);

async function postDownload(req, res) {
  try {
    const { url, itag, output = 'mp4', filename } = req.body;
    if (!url || !itag) return res.status(400).json({ status:false, message: 'Missing url or itag' });

    // Enqueue job
    const job = await mergeQueue.add({ url, itag, filename, output }, {
      removeOnComplete: false,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 2
    });

    return res.status(202).json({ status: true, jobId: job.id, message: 'Job queued' });
  } catch (err) {
    console.error('postDownload err', err);
    return res.status(500).json({ status:false, message: 'Internal Server Error' });
  }
}

// app/controllers/downloadController.js
async function getJobStatus(req, res) {
  try {
    const jobId = req.params.id;
    if (!jobId) return res.status(400).json({ status:false, message: 'Missing job id' });

    const job = await mergeQueue.getJob(jobId);

    // If job not found in Bull (maybe removed), try to read result from Redis
    const resultKey = `jobResult:${jobId}`;
    const raw = await redisClient.get(resultKey);
    const resultFromRedis = raw ? JSON.parse(raw) : null;

    if (!job) {
      if (resultFromRedis) {
        // Worker already finished and stored result; report completed
        return res.json({
          status: true,
          jobId,
          state: 'completed',
          progress: 100,
          result: resultFromRedis
        });
      }
      // no job and no redis result -> not found
      return res.status(404).json({ status:false, message: 'Job not found' });
    }

    // job exists in Bull — compute state/progress
    const state = await job.getState();
    let progress = 0;
    try {
      const p = await job.progress();
      progress = (typeof p === 'number') ? p : (p && p.progress) ? Number(p.progress) : (typeof job._progress === 'number' ? job._progress : 0);
    } catch (e) {
      progress = (typeof job._progress === 'number') ? job._progress : 0;
    }

    // prefer the redis result if present
    const result = resultFromRedis || null;

    return res.json({
      status: true,
      jobId: job.id,
      state,
      progress,
      result
    });

  } catch (err) {
    console.error('getJobStatus err', err);
    return res.status(500).json({ status:false, message: 'Internal Server Error' });
  }
}


module.exports = { postDownload, getJobStatus };
