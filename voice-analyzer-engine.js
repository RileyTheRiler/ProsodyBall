export class VoiceAnalyzerEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;
    this.source = null;
    this.stream = null;
    this.audioElement = null;
    this.isActive = false;

    this.timeDomainData = null;
    this.frequencyData = null;
    this.formantFreqData = null;
    this.hfFrequencyData = null;
    this.recTimeDomainData = null;
  }

  async start(audioFile = null, inputOptions = {}) {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      if (audioFile) {
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioFile);
        this.audioElement.loop = false;

        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        this.source = this.audioCtx.createMediaElementSource(this.audioElement);
        this.source.connect(this.audioCtx.destination);
      } else {
        const requestedConstraints = {
          echoCancellation: inputOptions.echoCancellation !== false,
          noiseSuppression: inputOptions.noiseSuppression !== false,
          autoGainControl: inputOptions.autoGainControl !== false,
        };
        if (inputOptions.deviceId) {
          requestedConstraints.deviceId = { exact: inputOptions.deviceId };
        }
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: requestedConstraints });
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
      }

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.8;
      this.source.connect(this.analyser);

      this.analyserFormant = this.audioCtx.createAnalyser();
      this.analyserFormant.fftSize = 4096;
      this.analyserFormant.smoothingTimeConstant = 0.5;
      this.source.connect(this.analyserFormant);

      this.analyserHF = this.audioCtx.createAnalyser();
      this.analyserHF.fftSize = 1024;
      this.analyserHF.smoothingTimeConstant = 0.3;
      const hfFilter = this.audioCtx.createBiquadFilter();
      hfFilter.type = 'highpass';
      hfFilter.frequency.value = 2000;
      this.source.connect(hfFilter);
      hfFilter.connect(this.analyserHF);

      this.timeDomainData = new Float32Array(this.analyser.fftSize);
      this.frequencyData = new Float32Array(this.analyser.frequencyBinCount);
      this.formantFreqData = new Float32Array(this.analyserFormant.frequencyBinCount);
      this.hfFrequencyData = new Uint8Array(this.analyserHF.frequencyBinCount);

      this.analyserRec = this.audioCtx.createAnalyser();
      this.analyserRec.fftSize = 512;
      this.source.connect(this.analyserRec);
      this.recTimeDomainData = new Float32Array(512);

      this.isActive = true;

      if (this.audioElement) {
        try {
          await this.audioElement.play();
        } catch (playErr) {
          console.error("Autoplay prevented:", playErr);
          return { ok: false, error: "AutoPlayError", message: playErr.message };
        }
      }

      return { ok: true, audioElement: this.audioElement };
    } catch (e) {
      console.error('Mic/Audio access denied:', e);
      return { ok: false, error: e.name, message: e.message };
    }
  }

  stop() {
    this.isActive = false;

    if (this.audioElement) {
      this.audioElement.pause();
      URL.revokeObjectURL(this.audioElement.src);
      this.audioElement.src = "";
      this.audioElement = null;
    }

    if (this.source) { try { this.source.disconnect(); } catch (e) { } }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => { });
    }
    this.audioCtx = null;
    this.analyser = null;
    this.analyserFormant = null;
    this.analyserHF = null;
    this.analyserRec = null;
    this.source = null;
  }

  getFrameBuffers() {
    if (!this.isActive || !this.analyser) return null;

    this.analyser.getFloatTimeDomainData(this.timeDomainData);
    this.analyser.getFloatFrequencyData(this.frequencyData);
    this.analyserFormant.getFloatFrequencyData(this.formantFreqData);
    this.analyserHF.getByteFrequencyData(this.hfFrequencyData);

    return {
      timeDomainData: this.timeDomainData,
      frequencyData: this.frequencyData,
      formantFreqData: this.formantFreqData,
      hfFrequencyData: this.hfFrequencyData,
      sampleRate: this.audioCtx.sampleRate,
      fftSize: this.analyser.fftSize,
      formantFftSize: this.analyserFormant.fftSize
    };
  }
}
