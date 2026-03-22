import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { 
  Mic, Globe, MessageSquare, Settings, Square, Zap, Coffee, Briefcase, Utensils, MapPin, Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Scenarios for practice
const SCENARIOS = [
  { id: 'casual', name: 'Casual Chat', icon: MessageSquare, prompt: 'A friendly conversation about daily life.' },
  { id: 'cafe', name: 'At a Café', icon: Coffee, prompt: 'Ordering coffee and a pastry at a local café.' },
  { id: 'interview', name: 'Job Interview', icon: Briefcase, prompt: 'A professional job interview for a marketing position.' },
  { id: 'restaurant', name: 'Restaurant', icon: Utensils, prompt: 'Making a reservation and ordering dinner at a busy restaurant.' },
  { id: 'travel', name: 'Travel Help', icon: MapPin, prompt: 'Asking for directions and travel advice at a train station.' },
];

const LANGUAGES = [
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
];

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState(SCENARIOS[0]);
  const [transcript, setTranscript] = useState<{ role: 'user' | 'ai', text: string }[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Added references to safely clean up the microphone when the call ends
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);

  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
  };

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    // Properly disconnect new audio nodes to free memory
    if (micProcessorRef.current) {
      micProcessorRef.current.disconnect();
      micProcessorRef.current = null;
    }

    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close();
      micAudioCtxRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    setIsConnected(false);
    setIsConnecting(false);
    setAudioLevel(0);
  }, []);

  const startSession = async () => {
    try {
      setIsConnecting(true);
      await initAudio();

      // FIXED: Safely check for the API key using Vite's format so Vercel doesn't crash
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined);
      
      if (!apiKey) {
        throw new Error("Gemini API Key not found. Please set VITE_GEMINI_API_KEY in Vercel.");
      }

      const ai = new GoogleGenAI({ apiKey });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const visualizerCtx = new AudioContext();
      const source = visualizerCtx.createMediaStreamSource(stream);
      const analyzer = visualizerCtx.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      analyzerRef.current = analyzer;

      const updateLevel = () => {
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        setAudioLevel(average / 128);
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: `You are a helpful language learning partner. 
          The user wants to practice ${selectedLanguage.name}. 
          Scenario: ${selectedScenario.prompt}. 
          Always respond in ${selectedLanguage.name} first, then provide a brief English translation if the user seems confused. 
          Keep the conversation natural and encouraging. 
          Correct the user's mistakes gently.`,
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            console.log("Live session opened");
            
            const audioCtx = new AudioContext({ sampleRate: 16000 });
            if (audioCtx.state === 'suspended') {
              audioCtx.resume();
            }

            const micSource = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            
            micProcessorRef.current = processor;
            micAudioCtxRef.current = audioCtx;

            processor.onaudioprocess = (e) => {
              if (!isConnected) return;

              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = new Int16Array(inputData.length);
              let hasAudio = false;

              // Noise gate
              for (let i = 0; i < inputData.length; i++) {
                if (Math.abs(inputData[i]) > 0.01) hasAudio = true; 
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
              }

              if (hasAudio && sessionRef.current) {
                const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
                try {
                  sessionRef.current.sendRealtimeInput([{
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64Data
                  }]);
                } catch (err) {
                  console.error("Failed to send audio chunk:", err);
                }
              }
            };
            
            micSource.connect(processor);
            processor.connect(audioCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              const binaryString = atob(base64Audio);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const pcmData = new Int16Array(bytes.buffer);
              const floatData = new Float32Array(pcmData.length);
              for (let i = 0; i < pcmData.length; i++) {
                floatData[i] = pcmData[i] / 0x7fff;
              }

              const audioBuffer = audioContextRef.current.createBuffer(1, floatData.length, 24000);
              audioBuffer.getChannelData(0).set(floatData);

              const source = audioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioContextRef.current.destination);

              const startTime = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current);
              source.start(startTime);
              nextStartTimeRef.current = startTime + audioBuffer.duration;
            }

            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              setTranscript(prev => [...prev, { role: 'ai', text }]);
            }

            const serverContent = message.serverContent as any;
            if (serverContent?.userTurn?.parts?.[0]?.text) {
              const text = serverContent.userTurn.parts[0].text;
              setTranscript(prev => [...prev, { role: 'user', text }]);
            }
            
            if (message.serverContent?.interrupted) {
              nextStartTimeRef.current = audioContextRef.current?.currentTime || 0;
            }
          },
          onerror: (err) => {
            console.error("Live session error:", err);
            stopSession();
          },
          onclose: () => {
            console.log("Live session closed");
            stopSession();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (error) {
      console.error("Failed to start session:", error);
      setIsConnecting(false);
      alert("Error accessing microphone or connecting to AI. Please ensure you have granted microphone permissions.");
    }
  };

  useEffect(() => {
    const transcriptEnd = document.getElementById('transcript-end');
    if (transcriptEnd) {
      transcriptEnd.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  useEffect(() => {
    return () => stopSession();
  }, [stopSession]);

  return (
    <div className="min-h-screen bg-[#0a0502] text-[#e0d8d0] font-sans selection:bg-[#ff4e00]/30">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div 
          className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-[#3a1510] blur-[120px] opacity-40 animate-pulse"
          style={{ animationDuration: '8s' }}
        />
        <div 
          className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-[#ff4e00] blur-[150px] opacity-10"
          style={{ animationDuration: '12s' }}
        />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-12 gap-12">
        <div className="lg:col-span-4 space-y-8">
          <header className="space-y-2">
            <motion.h1 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-5xl font-light tracking-tighter text-white"
            >
              Lingo<span className="text-[#ff4e00] font-medium">Live</span>
            </motion.h1>
            <p className="text-sm text-[#e0d8d0]/60 uppercase tracking-widest font-medium">
              Real-time Immersive Practice
            </p>
          </header>

          <div className="space-y-6">
            <section className="space-y-4">
              <label className="text-xs font-bold uppercase tracking-widest text-[#ff4e00]/80 flex items-center gap-2">
                <Globe className="w-3 h-3" /> Target Language
              </label>
              <div className="grid grid-cols-2 gap-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => !isConnected && setSelectedLanguage(lang)}
                    disabled={isConnected}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-300",
                      selectedLanguage.code === lang.code 
                        ? "bg-[#ff4e00]/10 border-[#ff4e00] text-white shadow-[0_0_20px_rgba(255,78,0,0.15)]" 
                        : "bg-white/5 border-white/10 hover:bg-white/10 text-[#e0d8d0]/70",
                      isConnected && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <span className="text-xl">{lang.flag}</span>
                    <span className="text-sm font-medium">{lang.name}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <label className="text-xs font-bold uppercase tracking-widest text-[#ff4e00]/80 flex items-center gap-2">
                <Zap className="w-3 h-3" /> Practice Scenario
              </label>
              <div className="space-y-2">
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.id}
                    onClick={() => !isConnected && setSelectedScenario(scenario)}
                    disabled={isConnected}
                    className={cn(
                      "w-full flex items-center gap-4 px-4 py-4 rounded-xl border transition-all duration-300 group",
                      selectedScenario.id === scenario.id 
                        ? "bg-[#ff4e00]/10 border-[#ff4e00] text-white shadow-[0_0_20px_rgba(255,78,0,0.15)]" 
                        : "bg-white/5 border-white/10 hover:bg-white/10 text-[#e0d8d0]/70",
                      isConnected && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className={cn(
                      "p-2 rounded-lg transition-colors",
                      selectedScenario.id === scenario.id ? "bg-[#ff4e00] text-white" : "bg-white/5 group-hover:bg-white/10"
                    )}>
                      <scenario.icon className="w-5 h-5" />
                    </div>
                    <div className="text-left">
                      <div className="text-sm font-bold">{scenario.name}</div>
                      <div className="text-xs opacity-50 line-clamp-1">{scenario.prompt}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>

        <div className="lg:col-span-8 flex flex-col h-[calc(100vh-6rem)]">
          <div className="flex-1 relative rounded-3xl border border-white/10 bg-white/5 backdrop-blur-3xl overflow-hidden flex flex-col">
            <div className="p-8 border-bottom border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={cn(
                  "w-3 h-3 rounded-full animate-pulse",
                  isConnected ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]" : "bg-white/20"
                )} />
                <span className="text-sm font-mono tracking-tighter opacity-60">
                  {isConnected ? "SESSION ACTIVE" : isConnecting ? "ESTABLISHING CONNECTION..." : "READY TO PRACTICE"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono opacity-40">
                <Settings className="w-3 h-3" />
                <span>24KHZ / OPUS / LOW LATENCY</span>
              </div>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-12 relative">
              <AnimatePresence mode="wait">
                {!isConnected && !isConnecting ? (
                  <motion.div 
                    key="start"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.1 }}
                    className="text-center space-y-8"
                  >
                    <div className="w-32 h-32 mx-auto rounded-full bg-[#ff4e00]/10 border border-[#ff4e00]/30 flex items-center justify-center relative">
                      <div className="absolute inset-0 rounded-full bg-[#ff4e00]/5 animate-ping" />
                      <Mic className="w-12 h-12 text-[#ff4e00]" />
                    </div>
                    <div className="space-y-4">
                      <h2 className="text-3xl font-light text-white">Start your session</h2>
                      <p className="max-w-xs mx-auto text-sm text-[#e0d8d0]/60 leading-relaxed">
                        Practice {selectedLanguage.name} in a {selectedScenario.name.toLowerCase()} scenario with our real-time AI partner.
                      </p>
                    </div>
                    <button
                      onClick={startSession}
                      className="px-10 py-4 bg-[#ff4e00] hover:bg-[#ff6a2a] text-white rounded-full font-bold tracking-wide transition-all hover:scale-105 active:scale-95 shadow-[0_10px_30px_rgba(255,78,0,0.3)]"
                    >
                      BEGIN CONVERSATION
                    </button>
                  </motion.div>
                ) : (
                  <motion.div 
                    key="active"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="w-full h-full flex flex-col items-center justify-center space-y-12"
                  >
                    <div className="relative w-64 h-64 flex items-center justify-center">
                      {[...Array(8)].map((_, i) => (
                        <motion.div
                          key={i}
                          className="absolute border border-[#ff4e00]/30 rounded-full"
                          animate={{
                            width: [100 + i * 20, 100 + i * 20 + (audioLevel * 100)],
                            height: [100 + i * 20, 100 + i * 20 + (audioLevel * 100)],
                            opacity: [0.1, 0.3, 0.1],
                          }}
                          transition={{
                            duration: 1,
                            repeat: Infinity,
                            ease: "easeInOut",
                            delay: i * 0.1
                          }}
                        />
                      ))}
                      <div className={cn(
                        "w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300",
                        audioLevel > 0.1 ? "bg-[#ff4e00] shadow-[0_0_50px_rgba(255,78,0,0.5)]" : "bg-white/10"
                      )}>
                        {isConnected ? <Mic className="w-8 h-8 text-white" /> : <Zap className="w-8 h-8 text-white animate-spin" />}
                      </div>
                    </div>

                    <div className="w-full max-w-2xl flex flex-col items-center space-y-8">
                      <div className="relative w-48 h-48 flex items-center justify-center">
                        {[...Array(8)].map((_, i) => (
                          <motion.div
                            key={i}
                            className="absolute border border-[#ff4e00]/30 rounded-full"
                            animate={{
                              width: [80 + i * 15, 80 + i * 15 + (audioLevel * 80)],
                              height: [80 + i * 15, 80 + i * 15 + (audioLevel * 80)],
                              opacity: [0.1, 0.3, 0.1],
                            }}
                            transition={{
                              duration: 1,
                              repeat: Infinity,
                              ease: "easeInOut",
                              delay: i * 0.1
                            }}
                          />
                        ))}
                        <div className={cn(
                          "w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300",
                          audioLevel > 0.1 ? "bg-[#ff4e00] shadow-[0_0_50px_rgba(255,78,0,0.5)]" : "bg-white/10"
                        )}>
                          {isConnected ? <Mic className="w-6 h-6 text-white" /> : <Zap className="w-6 h-6 text-white animate-spin" />}
                        </div>
                      </div>

                      <div className="w-full h-64 overflow-y-auto px-6 space-y-4 scrollbar-hide mask-fade-edges">
                        {transcript.length === 0 ? (
                          <p className="text-center text-sm text-[#e0d8d0]/40 italic">
                            {isConnecting ? "Connecting to AI partner..." : "Start speaking to see the transcript..."}
                          </p>
                        ) : (
                          transcript.map((msg, i) => (
                            <motion.div
                              key={i}
                              initial={{ opacity: 0, x: msg.role === 'user' ? 10 : -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              className={cn(
                                "flex flex-col",
                                msg.role === 'user' ? "items-end" : "items-start"
                              )}
                            >
                              <span className="text-[10px] uppercase tracking-widest opacity-30 font-bold mb-1">
                                {msg.role === 'user' ? 'You' : 'Zephyr'}
                              </span>
                              <div className={cn(
                                "max-w-[80%] px-4 py-2 rounded-2xl text-sm leading-relaxed",
                                msg.role === 'user' 
                                  ? "bg-white/10 text-white rounded-tr-none" 
                                  : "bg-[#ff4e00]/10 border border-[#ff4e00]/20 text-white rounded-tl-none"
                              )}>
                                {msg.text}
                              </div>
                            </motion.div>
                          ))
                        )}
                        <div id="transcript-end" />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="p-8 border-t border-white/5 bg-black/20 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-widest opacity-40 font-bold">Current Partner</span>
                  <span className="text-sm font-medium text-white">Zephyr (AI)</span>
                </div>
              </div>

              {isConnected && (
                <button
                  onClick={stopSession}
                  className="flex items-center gap-2 px-6 py-3 bg-white/5 hover:bg-red-500/20 border border-white/10 hover:border-red-500/50 text-white rounded-full text-sm font-bold transition-all"
                >
                  <Square className="w-4 h-4 fill-current" />
                  END SESSION
                </button>
              )}

              <div className="flex items-center gap-6">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] uppercase tracking-widest opacity-40 font-bold">Latency</span>
                  <span className="text-sm font-mono text-green-500">~120ms</span>
                </div>
                <div className="w-px h-8 bg-white/10" />
                <div className="flex flex-col items-end">
                  <span className="text-[10px] uppercase tracking-widest opacity-40 font-bold">Quality</span>
                  <span className="text-sm font-mono text-white">HD AUDIO</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 rounded-2xl bg-[#ff4e00]/5 border border-[#ff4e00]/10 flex items-start gap-4">
            <Info className="w-5 h-5 text-[#ff4e00] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-bold text-white">Pro Tip</p>
              <p className="text-xs text-[#e0d8d0]/60 leading-relaxed">
                Try to speak naturally. If you get stuck, you can ask "How do I say [word] in {selectedLanguage.name}?" 
                The AI will help you out!
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
