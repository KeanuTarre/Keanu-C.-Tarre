const stopSession = useCallback(() => {
    if (sessionRef.current) {
      // Clean up the processor and audio context to prevent memory leaks
      if (sessionRef.current.processor) {
        sessionRef.current.processor.disconnect();
      }
      if (sessionRef.current.audioCtx) {
        sessionRef.current.audioCtx.close();
      }
      
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    // Stop the microphone stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Stop the visualizer animation
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    // Reset UI states
    setIsConnected(false);
    setIsConnecting(false);
    setAudioLevel(0);
  }, []);

  const startSession = async () => {
    try {
      setIsConnecting(true);
      await initAudio();

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API Key not found. Please set it in the environment.");
      }

      const ai = new GoogleGenAI({ apiKey });
      
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Setup Visualizer
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
        setAudioLevel(average / 128); // Normalize to 0-1
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      // Connect to Gemini Live
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
            
            // 1. Start processing audio safely
            const audioCtx = new AudioContext({ sampleRate: 16000 });
            if (audioCtx.state === 'suspended') {
              audioCtx.resume();
            }

            const micSource = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              // 2. Stop processing if the session was closed
              if (!sessionRef.current) return;

              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = new Int16Array(inputData.length);
              let hasAudio = false;

              // 3. Apply a noise gate to prevent sending pure silence
              for (let i = 0; i < inputData.length; i++) {
                if (Math.abs(inputData[i]) > 0.01) hasAudio = true; 
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
              }

              // 4. Only send data if there is actual sound, using the correct format
              if (hasAudio) {
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

            // Store references so stopSession can clean them up later
            sessionRef.current.processor = processor;
            sessionRef.current.audioCtx = audioCtx;
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
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

            // Handle transcription
            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              setTranscript(prev => [...prev, { role: 'ai', text }]);
            }

            // Handle user transcription
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
