// import dependencies
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { sequelize } = require('./app/models'); 
const xss = require('xss');
const app = express();

// Middlewares & Security
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// xss protection
function xssMiddleware(req, res, next) {
  if (req.body) {
    for (let key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = xss(req.body[key]);
      }
    }
  }
  if (req.query) {
    for (let key in req.query) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = xss(req.query[key]);
      }
    }
  }
  next();
}

app.use(xssMiddleware);


// rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { status: false, message: 'Too many requests, please try again later.' },
}); app.use(limiter);

app.use((req, res, next) => {
  // do not rate-limit job status polling (useful for frontend polling during development)
  if (req.path.startsWith('/api/job')) {
    return next();
  }
  return limiter(req, res, next);
});

// Routes
const route = require('./routes/video');
app.use('/api', route);

// start server
const PORT = process.env.PORT || 3000;
sequelize.authenticate()
  .then(() => {
    console.log('Database connected');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('DB Connection Error:', err);
    process.exit(1);
  });

module.exports = app;