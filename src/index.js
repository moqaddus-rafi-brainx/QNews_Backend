// Install dependencies before running:
// npm install express multer @google-cloud/video-intelligence dotenv cors
const express = require('express');
const cors = require('cors');
const { handleVideoUpload, upload } = require('./controllers/videoAnalysisController');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST'], // Allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'] // Allowed headers
}));

// Parse JSON bodies
app.use(express.json());

// POST route to receive video and analyze it
app.post('/analyze-video', upload.single('video'), handleVideoUpload);

app.listen(3002, () => {
  console.log(`Server running at http://localhost:3002`);
});
