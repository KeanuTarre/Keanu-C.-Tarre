/**
 * Utility for handling raw PCM audio processing for Gemini Live API.
 */

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private analyzer: AnalyserNode | null = null;

  async startMicrophone(onAudioData: (base64Data: string) => void) {
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyzer = this.audioContext.createAnalyser();
    this.analyzer.fftSize = 256;

    // In a real app, we'd use an AudioWorklet for better performance.
    // For simplicity here, we'll use a ScriptProcessor (deprecated but easier for a quick demo)
    // OR we can just use a simple interval to get data from the analyzer if we just want levels,
    // but for streaming we need the actual samples.
    
    // Let's use a basic ScriptProcessor for now as it's more straightforward for this environment
    // than setting up a separate worklet file.
    const bufferSize = 4096;
    const scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    scriptNode.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      // Convert Float32 to Int16 PCM
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
      }
      
      const base64Data = btoa(
        String.fromCharCode(...new Uint8Array(pcmData.buffer))
      );
      onAudioData(base64Data);
    };

    this.source.connect(this.analyzer);
    this.analyzer.connect(scriptNode);
    scriptNode.connect(this.audioContext.destination);
  }

  stopMicrophone() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.audioContext?.close();
    this.audioContext = null;
    this.stream = null;
  }

  getByteFrequencyData() {
    if (!this.analyzer) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyzer.frequencyBinCount);
    this.analyzer.getByteFrequencyData(dataArray);
    return dataArray;
  }
}

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private isInterrupted: boolean = false;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: 24000 });
  }

  async playChunk(base64Data: string) {
    if (this.isInterrupted) return;
    if (!this.audioContext) return;

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const pcmData = new Int16Array(bytes.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 0x7fff;
    }

    const audioBuffer = this.audioContext.createBuffer(1, floatData.length, 24000);
    audioBuffer.getChannelData(0).set(floatData);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
  }

  interrupt() {
    // In a real implementation, we'd keep track of all active sources and stop them.
    // For this demo, we'll just reset the nextStartTime.
    this.nextStartTime = this.audioContext?.currentTime || 0;
  }

  close() {
    this.audioContext?.close();
  }
}
