import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { getGenAIClient } from './services/geminiService';
import { LiveStatus, LogMessage, VoiceName } from './types';
import { AudioVisualizer } from './components/AudioVisualizer';
import { decodeBase64, float32ToPcmBlob, pcmToAudioBuffer } from './utils/audioUtils';
import { MicrophoneIcon, StopIcon, SpeakerWaveIcon, Cog6ToothIcon, XMarkIcon, KeyIcon, ClockIcon, ChatBubbleBottomCenterTextIcon, VideoCameraIcon, VideoCameraSlashIcon, ComputerDesktopIcon } from '@heroicons/react/24/solid';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

export default function App() {
  // --- State ---
  const [status, setStatus] = useState<LiveStatus>(LiveStatus.DISCONNECTED);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [streamingLog, setStreamingLog] = useState<{ role: 'user' | 'model', text: string } | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>('Puck');
  const [volume, setVolume] = useState<number>(0);
  const [showSettings, setShowSettings] = useState(false);
  const [videoMode, setVideoMode] = useState<'none' | 'camera' | 'screen'>('none');

  // Auth State
  const [authMode, setAuthMode] = useState<'apiKey' | 'token'>(() => {
    return (localStorage.getItem('gemini_auth_mode') as 'apiKey' | 'token') || 'apiKey';
  });
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('gemini_api_key') || process.env.API_KEY || '';
  });

  // System Instruction State
  const [systemInstruction, setSystemInstruction] = useState<string>(() => {
    return localStorage.getItem('gemini_system_instruction') || "You are a helpful and witty AI assistant. Keep responses concise and conversational.";
  });

  // --- Refs for Audio & Session Management ---
  const sessionRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);

  // Streams
  const audioStreamRef = useRef<MediaStream | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);

  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Track the current turn's text content to accumulate streaming parts
  const currentTranscriptRef = useRef<{ role: 'user' | 'model', text: string } | null>(null);

  // --- Helpers ---
  const addLog = useCallback((role: LogMessage['role'], text: string) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date(),
      role,
      text
    }]);
  }, []);

  const scrollToBottom = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [logs, streamingLog]);

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const key = formData.get('apiKey') as string;
    const instruction = formData.get('systemInstruction') as string;

    setApiKey(key);
    setSystemInstruction(instruction);

    localStorage.setItem('gemini_api_key', key);
    localStorage.setItem('gemini_auth_mode', authMode);
    localStorage.setItem('gemini_system_instruction', instruction);

    setShowSettings(false);
    addLog('system', 'Configuration updated.');
  };

  // --- Cleanup Function ---
  const cleanup = useCallback(() => {
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    audioSourcesRef.current.clear();

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioSourceRef.current) {
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }

    // Stop Audio Stream
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }

    // Stop Video Stream (Camera or Screen)
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(track => track.stop());
      videoStreamRef.current = null;
    }

    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    nextStartTimeRef.current = 0;
    sessionRef.current = null;
    currentTranscriptRef.current = null;
    setStreamingLog(null);

    setStatus(LiveStatus.DISCONNECTED);
    addLog('system', 'Session ended');
  }, [addLog]);

  // --- Connection Logic ---
  const connect = async () => {
    try {
      const cleanKey = apiKey.trim();
      if (!cleanKey) {
        addLog('system', 'Credentials missing. Please configure in settings.');
        setShowSettings(true);
        return;
      }

      setStatus(LiveStatus.CONNECTING);
      addLog('system', 'Initializing devices...');

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000
      });

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000
      });

      // 1. Setup Audio (Microphone) - Always required
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = audioStream;

      // 2. Setup Video (Camera or Screen) - Optional
      let videoStream: MediaStream | null = null;
      try {
        if (videoMode === 'camera') {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
          });
        } else if (videoMode === 'screen') {
          videoStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: 1920, height: 1080 },
            audio: false // We use microphone for audio
          });
          // Handle user stopping share via browser UI
          videoStream.getVideoTracks()[0].onended = () => {
            setVideoMode('none');
            addLog('system', 'Screen sharing stopped by user.');
          };
        }
      } catch (e) {
        console.error("Video setup failed", e);
        addLog('system', 'Video/Screen access denied or cancelled. Continuing with audio only.');
        setVideoMode('none');
      }
      videoStreamRef.current = videoStream;

      // Attach video stream to UI element
      if (videoStream && videoRef.current) {
        videoRef.current.srcObject = videoStream;
        await videoRef.current.play().catch(e => console.error("Video play failed", e));
      }

      const analyser = inputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      addLog('system', 'Connecting to Gemini Live...');
      const client = getGenAIClient(cleanKey);

      const sessionPromise = client.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Wrap system instruction in a Content part to ensure robust serialization
          systemInstruction: { parts: [{ text: systemInstruction }] }
        },
        callbacks: {
          onopen: async () => {
            setStatus(LiveStatus.CONNECTED);
            addLog('system', 'Connected! Start talking.');

            if (!inputAudioContextRef.current || !audioStreamRef.current) return;

            // --- Audio Input Setup ---
            const inputCtx = inputAudioContextRef.current;

            // Ensure context is running (crucial if screen selection took a while)
            if (inputCtx.state === 'suspended') {
              await inputCtx.resume();
            }

            // Use the audioStream we captured explicitly
            const source = inputCtx.createMediaStreamSource(audioStreamRef.current);
            audioSourceRef.current = source;

            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);

              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              const pcmBlob = float32ToPcmBlob(inputData);

              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(analyser);
            source.connect(processor);
            processor.connect(inputCtx.destination);

            // --- Video/Screen Input Setup (if enabled) ---
            if (videoStream && videoRef.current) {
              const videoEl = videoRef.current;
              if (!videoCanvasRef.current) {
                videoCanvasRef.current = document.createElement('canvas');
              }
              const canvas = videoCanvasRef.current;
              const ctx = canvas.getContext('2d');

              if (videoEl && ctx) {
                addLog('system', `Streaming ${videoMode === 'screen' ? 'screen' : 'camera'} feed...`);

                // Send frames at ~5 FPS to avoid saturating bandwidth
                frameIntervalRef.current = window.setInterval(() => {
                  if (videoEl.readyState >= 2) { // HTMLMediaElement.HAVE_CURRENT_DATA
                    // Downscale massive screens to prevent bandwidth saturation
                    const MAX_WIDTH = 640;
                    const videoWidth = videoEl.videoWidth;
                    const videoHeight = videoEl.videoHeight;
                    const scale = Math.min(1, MAX_WIDTH / videoWidth);

                    canvas.width = videoWidth * scale;
                    canvas.height = videoHeight * scale;

                    // Draw scaled image
                    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

                    // Convert to base64 JPEG
                    const base64Data = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];

                    sessionPromise.then((session) => {
                      session.sendRealtimeInput({
                        media: {
                          mimeType: 'image/jpeg',
                          data: base64Data
                        }
                      });
                    });
                  }
                }, 200);
              }
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // --- Handle Audio Output ---
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              const ctx = audioContextRef.current;
              const audioBuffer = pcmToAudioBuffer(decodeBase64(base64Audio), ctx);

              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;

              audioSourcesRef.current.add(source);
              source.onended = () => audioSourcesRef.current.delete(source);
            }

            // --- Handle Transcriptions ---

            // 1. User Input Transcription
            const inputTr = message.serverContent?.inputTranscription?.text;
            if (inputTr) {
              // If we were tracking a model turn, finish it before starting user turn
              if (currentTranscriptRef.current && currentTranscriptRef.current.role !== 'user') {
                addLog(currentTranscriptRef.current.role, currentTranscriptRef.current.text);
                currentTranscriptRef.current = null;
              }

              if (!currentTranscriptRef.current) {
                currentTranscriptRef.current = { role: 'user', text: '' };
              }
              currentTranscriptRef.current.text += inputTr;
              setStreamingLog({ ...currentTranscriptRef.current });
            }

            // 2. Model Output Transcription
            const outputTr = message.serverContent?.outputTranscription?.text;
            if (outputTr) {
              // If we were tracking user turn, finish it
              if (currentTranscriptRef.current && currentTranscriptRef.current.role !== 'model') {
                addLog(currentTranscriptRef.current.role, currentTranscriptRef.current.text);
                currentTranscriptRef.current = null;
              }

              if (!currentTranscriptRef.current) {
                currentTranscriptRef.current = { role: 'model', text: '' };
              }
              currentTranscriptRef.current.text += outputTr;
              setStreamingLog({ ...currentTranscriptRef.current });
            }

            // 3. Turn Completion
            if (message.serverContent?.turnComplete) {
              if (currentTranscriptRef.current) {
                addLog(currentTranscriptRef.current.role, currentTranscriptRef.current.text);
                currentTranscriptRef.current = null;
                setStreamingLog(null);
              }
            }

            // 4. Interruption
            if (message.serverContent?.interrupted) {
              addLog('system', 'Interrupted by user.');
              audioSourcesRef.current.forEach(s => s.stop());
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;

              // If we were streaming model text, save it partially
              if (currentTranscriptRef.current && currentTranscriptRef.current.role === 'model') {
                addLog('model', currentTranscriptRef.current.text + " [Interrupted]");
                currentTranscriptRef.current = null;
                setStreamingLog(null);
              }
            }
          },
          onclose: () => {
            addLog('system', 'Connection closed.');
            setStatus(LiveStatus.DISCONNECTED);
            currentTranscriptRef.current = null;
            setStreamingLog(null);
          },
          onerror: (err) => {
            console.error(err);
            addLog('system', 'Error occurred. Check console.');
            setStatus(LiveStatus.ERROR);
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (error: any) {
      console.error("Connection failed", error);
      if (error.message && error.message.includes("503")) {
        addLog('system', `Service Unavailable (503). The model may be overloaded or the region is temporarily down. Please try again shortly.`);
      } else {
        addLog('system', `Connection failed: ${error.message || 'Network Error. Check API Key.'}`);
      }
      cleanup();
    }
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col text-white selection:bg-blue-500 selection:text-white relative overflow-hidden">
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-fade-in-up max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-white">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white transition-colors">
                <XMarkIcon className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-6">
              {/* Auth Mode Toggle */}
              <div className="p-1 bg-slate-950 rounded-lg flex border border-slate-800">
                <button
                  type="button"
                  onClick={() => setAuthMode('apiKey')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-all ${authMode === 'apiKey' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
                    }`}
                >
                  <KeyIcon className="w-4 h-4" />
                  API Key
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode('token')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-all ${authMode === 'token' ? 'bg-purple-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
                    }`}
                >
                  <ClockIcon className="w-4 h-4" />
                  Ephemeral Token
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  {authMode === 'apiKey' ? 'Gemini API Key' : 'Access Token'}
                </label>
                <div className="relative">
                  <input
                    type="password"
                    name="apiKey"
                    defaultValue={apiKey}
                    placeholder={authMode === 'apiKey' ? "AIza..." : "Paste your temporary token..."}
                    className={`w-full bg-slate-950 border rounded-lg px-4 py-3 text-white focus:ring-2 outline-none transition-all ${authMode === 'apiKey'
                        ? 'border-slate-800 focus:border-blue-500 focus:ring-blue-500/20'
                        : 'border-purple-900/50 focus:border-purple-500 focus:ring-purple-500/20'
                      }`}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  {authMode === 'apiKey'
                    ? "Your key is stored locally in your browser's localStorage."
                    : "Use an ephemeral token provided by your backend. Valid for a limited time."}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2 flex items-center gap-2">
                  <ChatBubbleBottomCenterTextIcon className="w-4 h-4" />
                  System Instructions
                </label>
                <textarea
                  name="systemInstruction"
                  defaultValue={systemInstruction}
                  rows={3}
                  placeholder="e.g. You are a helpful assistant..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:border-blue-500 focus:ring-blue-500/20 outline-none transition-all resize-none text-sm leading-relaxed"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Define the persona and behavior of the AI model.
                </p>
              </div>

              <button
                type="submit"
                className={`w-full py-3 rounded-lg font-semibold text-white transition-all shadow-lg active:scale-95 ${authMode === 'apiKey'
                    ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20'
                    : 'bg-purple-600 hover:bg-purple-500 shadow-purple-500/20'
                  }`}
              >
                Save Configuration
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex-none p-4 sm:p-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/50 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
            <SpeakerWaveIcon className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg sm:text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400 hidden sm:block">
            Gemini Live
          </h1>
          <h1 className="text-lg font-bold text-white sm:hidden">Gemini</h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className={`flex items-center gap-2 px-2 py-1 rounded-full text-xs font-medium border ${status === LiveStatus.CONNECTED ? 'bg-green-500/10 border-green-500/20 text-green-400' :
                status === LiveStatus.CONNECTING ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' :
                  status === LiveStatus.ERROR ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                    'bg-slate-800 border-slate-700 text-slate-400'
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status === LiveStatus.CONNECTED ? 'bg-green-400 animate-pulse' :
                  status === LiveStatus.CONNECTING ? 'bg-yellow-400' :
                    status === LiveStatus.ERROR ? 'bg-red-500' :
                      'bg-slate-500'
                }`}></span>
              <span className="hidden sm:inline">{status.toUpperCase()}</span>
            </span>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className={`p-2 rounded-lg bg-slate-800 transition-all ${!apiKey ? 'text-red-400 animate-pulse ring-1 ring-red-500' : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            title="Configure API Key"
          >
            <Cog6ToothIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content Container - Strict Layout */}
      <main className="flex-1 flex flex-col lg:flex-row min-h-0 p-4 gap-4 max-w-7xl mx-auto w-full">

        {/* Left Panel: Visualizer & Controls */}
        {/* Mobile: Fixed 45vh height. We use w-full to ensure alignment. */}
        <div className="flex flex-col gap-4 min-h-0 lg:flex-1 h-[45vh] lg:h-auto flex-none w-full">

          {/* Visualizer Card (Flexible height) */}
          {/* Updated: min-h-[100px] on mobile instead of 180px to prevent overflow covering the next section */}
          <div className="flex-1 bg-slate-900 rounded-2xl border border-slate-800 relative overflow-hidden shadow-2xl shadow-black/50 min-h-[100px] sm:min-h-[250px] min-w-0 group">

            {/* 0. Background Glow (Only if no video) */}
            {videoMode === 'none' && (
              <div className={`absolute inset-0 bg-gradient-to-b from-blue-500/5 to-transparent transition-opacity duration-700 ${status === LiveStatus.CONNECTED ? 'opacity-100' : 'opacity-0'}`}></div>
            )}

            {/* Video Element (Camera or Screen) */}
            <video
              ref={videoRef}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${videoMode !== 'none' && status === LiveStatus.CONNECTED ? 'opacity-100' : 'opacity-0'}`}
              autoPlay
              muted
              playsInline
            />

            {/* 1. Visualizer Canvas (Bottom Aligned & Behind Captions) */}
            <div className="absolute bottom-0 left-0 right-0 h-32 sm:h-48 z-10 opacity-60 pointer-events-none mix-blend-screen">
              <AudioVisualizer
                analyser={analyserRef.current}
                isListening={status === LiveStatus.CONNECTED}
              />
            </div>

            {/* 2. Speaker Icon (Absolute Center - "Adaptive Center") */}
            {/* Hide if video is enabled and connected */}
            {(videoMode === 'none' || status !== LiveStatus.CONNECTED) && (
              <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                <div className="relative flex-shrink-0">
                  {status === LiveStatus.CONNECTED ? (
                    <div className="relative flex items-center justify-center w-24 h-24 sm:w-32 sm:h-32">
                      <div className="absolute inset-0 rounded-full border-4 border-blue-500/30 animate-ring"></div>
                      <div className="absolute inset-0 rounded-full border-4 border-purple-500/30 animate-ring" style={{ animationDelay: '-0.5s' }}></div>
                      <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full shadow-[0_0_30px_rgba(59,130,246,0.5)] animate-dot flex items-center justify-center">
                        <SpeakerWaveIcon className="w-8 h-8 sm:w-10 sm:h-10 text-white" />
                      </div>
                    </div>
                  ) : (
                    <div className="w-20 h-20 sm:w-24 sm:h-24 bg-slate-800 rounded-full flex items-center justify-center border border-slate-700 shadow-inner">
                      <SpeakerWaveIcon className="w-8 h-8 sm:w-10 sm:h-10 text-slate-600" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 3. Live Captions (Bottom Overlay) */}
            <div className="absolute bottom-4 sm:bottom-8 left-0 right-0 px-4 z-20 flex justify-center pointer-events-none">
              <div className="max-w-2xl w-full text-center pointer-events-auto">
                {streamingLog ? (
                  <div className={`inline-block px-4 py-2 sm:px-6 sm:py-3 rounded-2xl backdrop-blur-md border shadow-xl transition-all duration-300 animate-fade-in-up ${streamingLog.role === 'user'
                      ? 'bg-blue-500/20 border-blue-500/30 text-blue-100'
                      : 'bg-purple-500/20 border-purple-500/30 text-purple-100'
                    }`}>
                    <p className="text-sm sm:text-lg font-medium leading-relaxed tracking-wide line-clamp-3">
                      {streamingLog.text}
                      {status === LiveStatus.CONNECTED && <span className="inline-block w-1.5 h-4 ml-2 bg-current animate-pulse align-middle rounded-full" />}
                    </p>
                  </div>
                ) : (
                  status === LiveStatus.CONNECTED ? (
                    <p className="text-slate-500 text-xs sm:text-sm font-medium animate-pulse tracking-widest uppercase bg-black/20 px-3 py-1 rounded-full inline-block backdrop-blur-sm">
                      {videoMode === 'camera' ? 'Watching Camera & Listening...' :
                        videoMode === 'screen' ? 'Watching Screen & Listening...' :
                          'Listening...'}
                    </p>
                  ) : (
                    <p className="text-slate-500 text-xs sm:text-sm">Ready to connect</p>
                  )
                )}
              </div>
            </div>
          </div>

          {/* Controls Card (Fixed height) */}
          <div className="flex-none bg-slate-900 rounded-2xl border border-slate-800 p-4 sm:p-6 flex flex-col md:flex-row items-stretch md:items-center gap-4 justify-between shadow-lg z-20">
            <div className="flex flex-row gap-4 w-full md:w-auto">
              <div className="flex-1 flex flex-col gap-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Voice</label>
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value as VoiceName)}
                  disabled={status !== LiveStatus.DISCONNECTED}
                  className="bg-slate-950 border border-slate-700 text-slate-200 rounded-lg px-4 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed appearance-none cursor-pointer w-full"
                >
                  {['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'].map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Video Sources */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Video Input</label>
                <div className="flex items-center gap-2">
                  {/* Camera Toggle */}
                  <button
                    onClick={() => setVideoMode(videoMode === 'camera' ? 'none' : 'camera')}
                    disabled={status !== LiveStatus.DISCONNECTED}
                    className={`h-[42px] px-4 rounded-lg border flex items-center justify-center transition-all ${videoMode === 'camera'
                        ? 'bg-blue-600/20 border-blue-500 text-blue-400'
                        : 'bg-slate-950 border-slate-700 text-slate-500 hover:text-slate-300'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title="Toggle Camera"
                  >
                    {videoMode === 'camera' ? <VideoCameraIcon className="w-5 h-5" /> : <VideoCameraSlashIcon className="w-5 h-5" />}
                  </button>

                  {/* Screen Share Toggle */}
                  <button
                    onClick={() => setVideoMode(videoMode === 'screen' ? 'none' : 'screen')}
                    disabled={status !== LiveStatus.DISCONNECTED}
                    className={`h-[42px] px-4 rounded-lg border flex items-center justify-center transition-all ${videoMode === 'screen'
                        ? 'bg-purple-600/20 border-purple-500 text-purple-400'
                        : 'bg-slate-950 border-slate-700 text-slate-500 hover:text-slate-300'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title="Share Screen"
                  >
                    <ComputerDesktopIcon className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 w-full md:w-auto justify-center md:justify-end">
              {status === LiveStatus.CONNECTED || status === LiveStatus.CONNECTING ? (
                <button
                  onClick={cleanup}
                  className="w-full md:w-auto flex items-center justify-center gap-2 px-8 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full font-semibold transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-red-500/20"
                >
                  <StopIcon className="w-5 h-5" />
                  <span>End Session</span>
                </button>
              ) : (
                <button
                  onClick={connect}
                  className={`w-full md:w-auto flex items-center justify-center gap-2 px-8 py-3 rounded-full font-semibold transition-all transform hover:scale-105 active:scale-95 shadow-lg ${!apiKey ? 'bg-slate-700 text-slate-400 cursor-not-allowed opacity-50' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20'
                    }`}
                  disabled={!apiKey}
                >
                  <MicrophoneIcon className="w-5 h-5" />
                  <span>Start Live</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel: Logs */}
        {/* Mobile: Flex-1 to take remaining space + min-h-0 for internal scrolling. Desktop: Fixed width side panel. */}
        {/* Added w-full to ensure consistent width with left panel on mobile */}
        <div className="flex-1 flex flex-col bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden shadow-lg min-h-0 lg:w-96 lg:flex-none lg:h-auto w-full">
          <div className="p-4 sm:p-6 border-b border-slate-800 bg-slate-900/50 flex-none">
            <h2 className="font-semibold text-slate-200">Session History</h2>
          </div>

          <div
            ref={logContainerRef}
            className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 scrollbar-hide scroll-smooth"
          >
            {logs.length === 0 && !streamingLog && (
              <div className="text-center text-slate-600 mt-10 text-sm italic">
                Logs will appear here...
              </div>
            )}

            {/* Committed Logs */}
            {logs.map((log) => (
              <div
                key={log.id}
                className={`flex flex-col animate-fade-in-up ${log.role === 'user' ? 'items-end' : 'items-start'
                  }`}
              >
                <span className="text-[10px] text-slate-500 mb-1 px-1">
                  {log.role.toUpperCase()} • {log.timestamp.toLocaleTimeString()}
                </span>
                <div className={`max-w-[90%] px-3 py-2 rounded-2xl text-sm ${log.role === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-none'
                    : log.role === 'model'
                      ? 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'
                      : 'bg-slate-800/50 text-slate-400 w-full text-center italic text-xs py-1 rounded-lg border border-dashed border-slate-800'
                  }`}>
                  {log.text}
                </div>
              </div>
            ))}

            {/* Streaming Log (Ghost Message in Chat) */}
            {streamingLog && (
              <div className={`flex flex-col animate-fade-in-up ${streamingLog.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <span className="text-[10px] text-slate-500 mb-1 px-1">
                  {streamingLog.role.toUpperCase()} • Now
                </span>
                <div className={`max-w-[90%] px-3 py-2 rounded-2xl text-sm opacity-70 ${streamingLog.role === 'user'
                    ? 'bg-blue-600/50 text-white rounded-tr-none'
                    : 'bg-slate-800/50 text-slate-200 rounded-tl-none border border-slate-700'
                  }`}>
                  {streamingLog.text}
                  <span className="inline-block w-1 h-3 ml-1 bg-current animate-pulse align-middle" />
                </div>
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}