const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// --- EKLEME: VİDEOLARI DIŞARIYA AÇ ---
// Bu satır sayesinde n8n /videos/video_ismi.mp4 diyerek videoyu çekebilecek
app.use('/videos', express.static(path.join(__dirname, 'videos')));
// -------------------------------------

// Pexels API key - Tırnak içine alındı ve güvenli hale getirildi
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || 'DXJFzRgdAtA2kNxLcWyfu4kzFKv930mFg9PBevhdYSUSpM8iZmPYIJTt';

// Klasör yolları - Render'ın yazma izni olan dizinlere uygun hale getirildi
const videoJobs = {};
const videosDir = path.join(__dirname, 'videos');
const audioDir = path.join(__dirname, 'audio');

// Klasörleri oluştur (Hata vermemesi için recursive: true eklendi)
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const musicTags = ['upbeat', 'relaxing', 'epic', 'inspiring', 'happy', 'sad', 'energetic', 'calm', 'dramatic', 'peaceful', 'intense', 'cheerful'];

app.get('/api/music-tags', (req, res) => {
    res.json(musicTags);
});

// Pexels'den video indirme fonksiyonu düzeltildi
async function downloadPexelsVideo(searchTerm, outputPath) {
    try {
        console.log('Searching Pexels for:', searchTerm);
        const response = await axios.get('https://api.pexels.com/videos/search', {
            headers: { 'Authorization': PEXELS_API_KEY },
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
            writer.on('finish', () => resolve(outputPath));
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Error downloading video:', error.message);
        throw error;
    }
}

// Ses üretim fonksiyonu (Parametreler düzeltildi)
async function generateSpeech(text, outputPath) {
    try {
        console.log('Generating speech...');
        const ttsUrl = 'https://api.streamelements.com/kappa/v2/speech';
        const response = await axios({
            method: 'get',
            url: ttsUrl,
            params: { voice: 'Brian', text: text },
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(outputPath));
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('TTS Error:', error.message);
        throw error;
    }
}

// Video oluşturma isteği
app.post('/api/short-video', async (req, res) => {
    try {
        const { scenes, config } = req.body;
        if (!scenes || !Array.isArray(scenes)) {
            return res.status(400).json({ error: "Scenes must be an array" });
        }

        const videoId = uuidv4();
        videoJobs[videoId] = {
            status: 'processing',
            scenes: scenes,
            config: config,
            createdAt: new Date(),
            progress: 0
        };

        // n8n'e hemen yanıt dön (Time-out olmaması için)
        res.json({ success: true, videoId: videoId, message: 'Video generation started' });

        // Arka planda işlemi başlat
        processVideo(videoId, scenes, config).catch(error => {
            console.error('Background Error:', error.message);
            videoJobs[videoId].status = 'failed';
            videoJobs[videoId].error = error.message;
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function processVideo(videoId, scenes, config) {
    const sceneFiles = [];
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        videoJobs[videoId].progress = Math.floor((i / scenes.length) * 80);

        const audioPath = path.join(audioDir, `${videoId}_scene${i}.mp3`);
        const videoPath = path.join(videosDir, `${videoId}_scene${i}.mp4`);

        await generateSpeech(scene.text, audioPath);
        const searchTerm = (scene.searchTerms && scene.searchTerms.length > 0) ? scene.searchTerms[0] : 'nature';
        await downloadPexelsVideo(searchTerm, videoPath);

        sceneFiles.push({ video: videoPath, audio: audioPath });
    }

    videoJobs[videoId].status = 'ready';
    videoJobs[videoId].progress = 100;
    // n8n'in kolayca bulabilmesi için dosya adını kaydediyoruz
    videoJobs[videoId].videoName = `${videoId}_scene0.mp4`; 
    videoJobs[videoId].videoPath = sceneFiles[0].video;
}

// Durum sorgulama
app.get('/api/short-video/:videoId/status', (req, res) => {
    const job = videoJobs[req.params.videoId];
    if (!job) return res.status(404).json({ error: 'Video not found' });
    // n8n'in "Ready?" düğümü 'status' alanına bakar.
    res.json(job);
});

// İndirme
app.get('/api/short-video/:videoId', (req, res) => {
    const job = videoJobs[req.params.videoId];
    if (!job || job.status !== 'ready') return res.status(404).json({ error: 'Video not ready or not found' });
    res.download(job.videoPath);
});

// Ana dizin (Health Check)
app.get('/', (req, res) => {
    res.json({ status: 'Live', pexels: !!PEXELS_API_KEY });
});

// PORT AYARI - Render için hayati önem taşır
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
