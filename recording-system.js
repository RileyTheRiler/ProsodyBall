// ============================================
// RECORDING — AnalyserNode time-domain polling + WAV encoding
// The ONLY reliable approach in sandboxed iframes:
// - MediaRecorder: stream consumed by Web Audio → silence
// - ScriptProcessorNode: needs ctx.destination → blocked in sandbox
// - AnalyserNode.getFloatTimeDomainData: WORKS (proven — the ball moves!)
// We poll a dedicated small-FFT analyser at matched intervals
// to capture approximately non-overlapping sample windows.
//
// Also owns Delayed Auditory Feedback (DAF): re-plays the mic input on a short
// delay through the audio graph. Both features read the live mic via the shared
// VoiceAnalyzer; everything else (state + the recordings list UI) lives here.
// ============================================
export class RecordingSystem {
  constructor(analyzer) {
    this.analyzer = analyzer;

    // Recording — AnalyserNode polling approach
    this.isRecording = false;
    this._recInterval = null;
    this._recBuffers = [];
    this._recSampleRate = 48000;
    this.recordings = []; // { blob, dataUrl, duration, timestamp, name }
    this.recordingStartTime = 0;
    this.currentPlayback = null;

    // Delayed Auditory Feedback
    this.dafEnabled = localStorage.getItem('vox:daf:enabled') === 'true';
    this.dafDelayMs = parseInt(localStorage.getItem('vox:daf:delayMs') || '75');
    // Default OFF so DAF plays back the full raw voice band instead of cutting bass.
    this.dafBassFilter = localStorage.getItem('vox:daf:bassFilter') === 'true';
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    this._dafInterval = null;
    this._dafGain = null;
    this._dafFilter = null;
  }

  startRecording() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this.isRecording) return;
    try {
      this._recSampleRate = a.audioCtx.sampleRate;
      this._recBuffers = [];
      const fftSize = a.analyserRec.fftSize; // 512

      // Poll interval = window duration in ms (e.g. 512/44100*1000 ≈ 11.6ms)
      const intervalMs = Math.round(1000 * fftSize / this._recSampleRate);

      this._recInterval = setInterval(() => {
        if (!this.isRecording || !a.analyserRec) return;
        a.analyserRec.getFloatTimeDomainData(a.recTimeDomainData);

        // Speech gate: compute local RMS and check against analyzer's noise floor
        // plus pitch confidence. Non-speech frames become silence (preserves timing).
        const data = a.recTimeDomainData;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const localRms = Math.sqrt(sum / data.length);
        const threshold = a.isCalibrated ? a.noiseFloor * 2.5 : 0.02;
        const isSpeech = localRms > threshold || a.pitchConfidence > 0.3;

        if (isSpeech) {
          this._recBuffers.push(new Float32Array(data));
        } else {
          // Push silence to keep timing intact (avoids clicks/jumps)
          this._recBuffers.push(new Float32Array(data.length));
        }
      }, intervalMs);

      this.recordingStartTime = performance.now();
      this.isRecording = true;
    } catch (e) {
      console.error('Recording failed:', e);
    }
  }

  stopRecording() {
    if (!this.isRecording) return Promise.resolve();
    this.isRecording = false;

    if (this._recInterval) {
      clearInterval(this._recInterval);
      this._recInterval = null;
    }

    return new Promise((resolve) => {
      try {
        if (this._recBuffers.length === 0) { resolve(); return; }

        // Merge all Float32 buffers
        // ⚡ Bolt: Replace reduce with traditional loop for performance
        let totalLen = 0;
        for (let i = 0; i < this._recBuffers.length; i++) {
          totalLen += this._recBuffers[i].length;
        }
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const buf of this._recBuffers) {
          merged.set(buf, offset);
          offset += buf.length;
        }
        this._recBuffers = [];

        // Encode as WAV (PCM 16-bit mono)
        const wavBlob = this._encodeWAV(merged, this._recSampleRate);
        const duration = (performance.now() - this.recordingStartTime) / 1000;
        const now = new Date();
        const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const fileTs = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Convert to data URL for universal playback in sandbox
        const reader = new FileReader();
        reader.onloadend = () => {
          this.recordings.push({
            blob: wavBlob,
            dataUrl: reader.result,
            duration,
            timestamp: ts,
            name: `vox-ball-${fileTs}`,
            mimeType: 'audio/wav'
          });
          this.updateRecordingsUI();
          resolve();
        };
        reader.onerror = () => { resolve(); };
        reader.readAsDataURL(wavBlob);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`Recording save error (${e && e.name || 'Error'}): ${msg}`, e);
        resolve();
      }
    });
  }

  startDAF() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this._dafInterval) return;
    const fftSize = a.analyserRec.fftSize;
    const sampleRate = a.audioCtx.sampleRate;
    const intervalMs = Math.round(1000 * fftSize / sampleRate);

    this._dafGain = a.audioCtx.createGain();
    this._dafGain.gain.value = 0.9;
    if (this.dafBassFilter) {
      this._dafFilter = a.audioCtx.createBiquadFilter();
      this._dafFilter.type = 'highpass';
      this._dafFilter.frequency.value = 150;
      this._dafGain.connect(this._dafFilter);
      this._dafFilter.connect(a.audioCtx.destination);
    } else {
      this._dafGain.connect(a.audioCtx.destination);
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;

    this._dafInterval = setInterval(() => {
      if (!a.analyserRec) return;
      const samples = new Float32Array(fftSize);
      a.analyserRec.getFloatTimeDomainData(samples);
      this._dafBuffer.push({ samples, captureTime: performance.now() });

      const threshold = performance.now() - this.dafDelayMs;
      while (this._dafBuffer.length > 0 && this._dafBuffer[0].captureTime <= threshold) {
        const { samples: s } = this._dafBuffer.shift();
        const buf = a.audioCtx.createBuffer(1, s.length, sampleRate);
        buf.copyToChannel(s, 0);
        const src = a.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this._dafGain);
        if (this._dafNextPlayTime < a.audioCtx.currentTime) {
          this._dafNextPlayTime = a.audioCtx.currentTime;
        }
        src.start(this._dafNextPlayTime);
        this._dafNextPlayTime += buf.duration;
      }
    }, intervalMs);
  }

  stopDAF() {
    if (this._dafInterval) {
      clearInterval(this._dafInterval);
      this._dafInterval = null;
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    if (this._dafFilter) { this._dafFilter.disconnect(); this._dafFilter = null; }
    if (this._dafGain) { this._dafGain.disconnect(); this._dafGain = null; }
  }

  _encodeWAV(samples, sampleRate) {
    // PCM 16-bit mono WAV
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataLength = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Convert Float32 [-1,1] to Int16
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  playRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    this.stopPlayback();

    const audio = new Audio();
    audio.volume = 1.0;
    this.currentPlayback = { audio, index };
    this.updateRecItemState(index, true);
    this._updateVoiceRecBtn();

    audio.addEventListener('timeupdate', () => {
      const progress = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = progress + '%';
    });

    audio.addEventListener('ended', () => {
      this.updateRecItemState(index, false);
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    });

    audio.addEventListener('error', (e) => {
      const detail = audio.error ? `${audio.error.code}: ${audio.error.message}` : String(e);
      console.error(`Audio playback error: ${detail}`);
      this.updateRecItemState(index, false);
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    });

    // Wait for audio to be loadable before playing
    audio.addEventListener('canplay', () => {
      audio.play().catch(e => {
        console.error('Playback failed:', e);
        this.updateRecItemState(index, false);
        this.currentPlayback = null;
        this._updateVoiceRecBtn();
      });
    }, { once: true });

    // Use data URL (works in sandboxed iframes, unlike blob: URLs)
    audio.src = rec.dataUrl;
    audio.load();
  }

  stopPlayback() {
    if (this.currentPlayback) {
      const audio = this.currentPlayback.audio;
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // release media resources
      this.updateRecItemState(this.currentPlayback.index, false);
      const el = document.getElementById(`rec-progress-${this.currentPlayback.index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    }
  }

  updateRecItemState(index, isPlaying) {
    const btn = document.getElementById(`rec-play-${index}`);
    if (btn) {
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.classList.toggle('playing', isPlaying);
    }
  }

  // Keep the always-visible top-bar Record/Play buttons in sync with recording + playback state.
  _updateVoiceRecBtn() {
    const recBtn = document.getElementById('voiceRecBtn');
    if (recBtn) {
      recBtn.classList.toggle('recording', !!this.isRecording);
      recBtn.setAttribute('aria-pressed', String(!!this.isRecording));
      const label = recBtn.querySelector('.voice-rec-label');
      if (label) label.textContent = this.isRecording ? 'Stop' : 'Record';
    }
    const playBtn = document.getElementById('voicePlayBtn');
    if (playBtn) {
      const lastIdx = this.recordings.length - 1;
      const playingLast = !!(this.currentPlayback && this.currentPlayback.index === lastIdx);
      playBtn.disabled = lastIdx < 0 || this.isRecording;
      playBtn.classList.toggle('playing', playingLast);
      const plabel = playBtn.querySelector('.voice-play-label');
      if (plabel) plabel.textContent = playingLast ? ' Stop' : ' Play';
    }
  }

  downloadRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rec.name}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke immediately — the download has already been initiated by click()
    URL.revokeObjectURL(url);
  }

  deleteRecording(index) {
    if (this.currentPlayback && this.currentPlayback.index === index) {
      this.stopPlayback();
    }
    this.recordings.splice(index, 1);
    this.updateRecordingsUI();
  }

  clearAllRecordings() {
    this.stopPlayback();
    this.recordings = [];
    this.updateRecordingsUI();
  }

  formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  updateRecordingsUI() {
    const list = document.getElementById('recordingsList');
    const empty = document.getElementById('recsEmpty');
    const badge = document.getElementById('recBadge');
    const recBtn = document.getElementById('recordingsBtn');
    const clearAllBtn = document.getElementById('clearAllRecs');

    badge.textContent = this.recordings.length;
    recBtn.classList.toggle('visible', this.recordings.length > 0);
    if (clearAllBtn) {
      clearAllBtn.disabled = this.recordings.length === 0;
    }
    this._updateVoiceRecBtn();

    if (this.recordings.length === 0) {
      list.textContent = '';
      list.appendChild(empty);
      empty.style.display = '';
      return;
    }

    list.textContent = '';
    for (let i = this.recordings.length - 1; i >= 0; i--) {
      const rec = this.recordings[i];
      const item = document.createElement('div');
      item.className = 'rec-item';

      const info = Object.assign(document.createElement('div'), { className: 'rec-item-info' });
      info.append(
        Object.assign(document.createElement('div'), { className: 'rec-item-name', textContent: `Recording ${i + 1}` }),
        Object.assign(document.createElement('div'), { className: 'rec-item-meta', textContent: `${rec.timestamp} · ${this.formatDuration(rec.duration)}` })
      );

      const progress = Object.assign(document.createElement('div'), { className: 'rec-progress' });
      progress.appendChild(Object.assign(document.createElement('div'), { className: 'rec-progress-fill', id: `rec-progress-${i}` }));
      info.appendChild(progress);

      const actions = Object.assign(document.createElement('div'), { className: 'rec-item-actions' });
      actions.append(
        Object.assign(document.createElement('button'), { className: 'rec-btn', id: `rec-play-${i}`, title: 'Play', ariaLabel: 'Play Recording', textContent: '▶' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn', title: 'Download', ariaLabel: 'Download Recording', textContent: '⬇' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn delete', title: 'Delete', ariaLabel: 'Delete Recording', textContent: '✕' })
      );

      // Set data attributes
      actions.children[0].dataset.action = 'play'; actions.children[0].dataset.index = i;
      actions.children[1].dataset.action = 'download'; actions.children[1].dataset.index = i;
      actions.children[2].dataset.action = 'delete'; actions.children[2].dataset.index = i;

      item.append(info, actions);
      list.appendChild(item);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index, 10);
      if (action === 'play') {
        if (this.currentPlayback && this.currentPlayback.index === idx) {
          this.stopPlayback();
        } else {
          this.playRecording(idx);
        }
      } else if (action === 'download') {
        this.downloadRecording(idx);
      } else if (action === 'delete') {
        this.deleteRecording(idx);
      }
    };
  }
}
