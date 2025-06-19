// Install dependencies before running:
// npm install express multer @google-cloud/video-intelligence dotenv cors
const express = require('express');
const cors = require('cors');
const { handleVideoUpload, upload } = require('./controllers/videoAnalysisController');
require('dotenv').config();

const { File } = require('node:buffer');
global.File = File;

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


// POST route to receive video and analyze it
app.post('/api/v2/analyze-video', upload.single('video'), handleVideoUpload);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
