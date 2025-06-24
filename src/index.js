const { File } = require('node:buffer');
global.File = File;
const express = require('express');
const cors = require('cors');
const videoSummaryRoutes = require('./routes/videoSummaryRoute');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 7000;

app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST'], 
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));


app.use(express.json());

app.use('/api/v2', videoSummaryRoutes);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
