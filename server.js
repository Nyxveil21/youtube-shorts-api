const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Pexels API key
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';

// Temporary storage
const videoJobs = {};
const videosDir = path.join(__dirname, 'videos');
const audioDir = path.join(__dirname, 'audio');

// Create directories
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir);
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

// Music tags
const musicTags = [
  'upbeat', 'relaxing', 'epic', 'inspiring', 
  'happy', 'sad', 'energetic', 'calm',
  'dramatic', 'peaceful', 'intense', 'cheerful'
];

app.get('/api/music-tags', (req, res) => {
  res.json(musicTags);
});

// Download video from Pexels
async function downloadPexelsVideo(searchTerm, outputPath) {
  try {
    console.log('Searching Pexels for:', searchTerm);
    
    const response = await axios.get('https://api.pexels.com/videos/search', {
      headers: {
        'Authorization': DXJFzRgdAtA2kNxLcWyfu4kzFKv930mFg9PBevhdYSUSpM8iZmPYIJTt
      },
      params: {
        query: searchTerm,
        per_page: 5,
        orientation: 'portrait'
      }
    });

    if (!response.data.videos || response.data.videos.length === 0) {
      throw new Error('No videos found for: ' + searchTerm);
    }

    const video = response.data.videos[0];
    const videoFile = video.video_files.find(f => f.quality === 'hd') || video.video_files[0];

    console.log('Downloading video from:', videoFile.link);
    
    const videoResponse = await axios({
      method: 'get',
      url: videoFile.link,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(outputPath);
    videoResponse.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('Video downloaded successfully');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error downloading video:', error.message);
    throw error;
  }
}

// Generate speech using Google Cloud TTS API
async function generateSpeech(text, outputPath) {
  try {
    console.log('Generating speech for:', text.substring(0, 50) + '...');
    
    // Using a free TTS service
    const ttsUrl = 'https://api.streamelements.com/kappa/v2/speech';
    const params = new URLSearchParams({
      voice: 'Brian',
      text: text
    });

    const response = await axios({
      method: 'get',
      url: ttsUrl + '?' + params.toString(),
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('Speech generated successfully');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error generating speech:', error.message);
    throw error;
  }
}

// Start video generation
app.post('/api/short-video', async (req, res) => {
  try {
    const { scenes, config } = req.body;
    const videoId = uuidv4();
    
    console.log('Starting video generation:', videoId);
    console.log('Number of scenes:', scenes.length);
    
    videoJobs[videoId] = {
      status: 'processing',
      scenes: scenes,
      config: config,
      createdAt: new Date(),
      progress: 0
    };
    
    res.json({ 
      success: true, 
      videoId: videoId,
      message: 'Video generation started'
    });

    // Process video in background
    processVideo(videoId, scenes, config).catch(error => {
      console.error('Error processing video:', videoId, error.message);
      videoJobs[videoId].status = 'failed';
      videoJobs[videoId].error = error.message;
    });

  } catch (error) {
    console.error('Error starting video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function processVideo(videoId, scenes, config) {
  try {
    console.log('Processing video:', videoId);
    
    const sceneFiles = [];
    
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log('Processing scene', i + 1, 'of', scenes.length);
      
      videoJobs[videoId].progress = Math.floor((i / scenes.length) * 80);
      
      // Generate speech
      const audioPath = path.join(audioDir, videoId + '_scene' + i + '.mp3');
      await generateSpeech(scene.text, audioPath);
      console.log('Speech generated for scene', i + 1);
      
      // Download background video
      const searchTerm = scene.searchTerms && scene.searchTerms.length > 0 
        ? scene.searchTerms[0] 
        : 'nature';
      
      const videoPath = path.join(videosDir, videoId + '_scene' + i + '.mp4');
      await downloadPexelsVideo(searchTerm, videoPath);
      console.log('Background video downloaded for scene', i + 1);
      
      sceneFiles.push({ 
        video: videoPath, 
        audio: audioPath 
      });
    }
    
    videoJobs[videoId].progress = 90;
    
    console.log('Video processing complete:', videoId);
    
    videoJobs[videoId].status = 'ready';
    videoJobs[videoId].progress = 100;
    videoJobs[videoId].videoPath = sceneFiles[0].video;
    videoJobs[videoId].sceneFiles = sceneFiles;
    
  } catch (error) {
    console.error('Error in processVideo:', error.message);
    throw error;
  }
}

// Check video status
app.get('/api/short-video/:videoId/status', (req, res) => {
  const videoId = req.params.videoId;
  const job = videoJobs[videoId];
  
  if (!job) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  res.json({ 
    status: job.status,
    progress: job.progress || 0,
    videoId: videoId,
    error: job.error || null
  });
});

// Download video
app.get('/api/short-video/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  const job = videoJobs[videoId];
  
  if (!job) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  if (job.status !== 'ready') {
    return res.status(400).json({ 
      error: 'Video not ready yet',
      status: job.status,
      progress: job.progress
    });
  }
  
  const videoPath = job.videoPath;
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video file not found' });
  }
  
  res.download(videoPath);
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'YouTube Shorts Generator API is running',
    version: '1.0.0',
    pexelsConfigured: PEXELS_API_KEY ? true : false,
    endpoints: {
      musicTags: 'GET /api/music-tags',
      startVideo: 'POST /api/short-video',
      checkStatus: 'GET /api/short-video/:id/status',
      downloadVideo: 'GET /api/short-video/:id'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
  console.log('Pexels API configured:', PEXELS_API_KEY ? 'Yes' : 'No');
});