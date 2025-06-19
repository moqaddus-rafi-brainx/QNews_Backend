// Install dependencies before running:
// npm install express multer @google-cloud/video-intelligence dotenv cors
const express = require('express');
const cors = require('cors');
const { handleVideoUpload, upload } = require('./controllers/videoAnalysisController');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 7000;

// Enable CORS for all routes
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST'], // Allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'] // Allowed headers
}));

// Parse JSON bodies
app.use(express.json());

// Default GET route for health check
app.get('/', (req, res) => {
  res.json({
    message: 'QNews Video Analysis API is running',
    status: 'healthy',
    // version: '2.0',
    // endpoints: {
    //   analyze: 'POST /api/v2/analyze-video'
    // }
  });
});

// POST route to receive video and analyze it
app.post('/api/v2/analyze-video', upload.single('video'), handleVideoUpload);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
