# QNews AI - Video Analysis Module (Backend)

This is the backend service for the **QNews AI App**'s video analysis feature. It processes uploaded videos, extracts transcripts, determines if the video is news-related, categorizes the content, identifies relevant segments, and clips the video accordingly.

## 🧠 Powered By

- [OpenAI API](https://platform.openai.com/)
- [Google Cloud Video Intelligence API](https://cloud.google.com/video-intelligence)
- [Cloudinary](https://cloudinary.com/) – for video hosting
- [Shotstack](https://shotstack.io/) – for programmatic video clipping

---

## 🚀 Features

- Analyze video transcripts using **Google Cloud Video Intelligence**
- Use **OpenAI** to:
  - Detect whether video is news-related
  - Classify news type (e.g., sports, politics)
  - Identify key segments and irrelevant parts
  - Generate summaries and main topic
- Upload and store video on **Cloudinary** as shotstack requires a public url for the video.
- Clip out irrelevant segments using **Shotstack**
- Return a downloadable or streamable clipped video link
