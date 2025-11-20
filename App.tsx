import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { getGenAIClient } from './services/geminiService';
import { LiveStatus, LogMessage, VoiceName } from './types';
import { AudioVisualizer } from './components/AudioVisualizer';
import { decodeBase64, float32ToPcmBlob, pcmToAudioBuffer } from './utils/audioUtils';
import { MicrophoneIcon, StopIcon, SpeakerWaveIcon, Cog6ToothIcon, XMarkIcon } from '@heroicons/react/24/solid';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

export default function App() {
  // --- State ---
  const [status, setStatus] = useState<LiveStatus>(LiveStatus.DISCONNECTED);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [streamingLog, setStreamingLog] = useState<{role: 'user' | 'model', text: string} | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>('Puck');
  const [volume, setVolume] = useState<number>(0);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('gemini_api_key') || process.env.API_KEY || '';
  });

  // --- Refs for Audio & Session Management ---
  const sessionRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const logContainerRef = useRef<HTMLDivElement>(null);
  
  // Track the current turn's text content to accumulate streaming parts
  const currentTranscriptRef = useRef<{role: 'user' | 'model', text: string} | null>(null);

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
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
    setShowSettings(false);
    addLog('system', 'API Key updated.');
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

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
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
      if (!apiKey) {
        addLog('system', 'API Key missing. Please configure it in settings.');
        setShowSettings(true);
        return;
      }

      setStatus(LiveStatus.CONNECTING);
      addLog('system', 'Initializing audio devices...');

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 16000 
      });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 24000 
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const analyser = inputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      addLog('system', 'Connecting to Gemini Live...');
      const client = getGenAIClient(apiKey);

      const sessionPromise = client.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          },
          inputAudioTranscription: {}, // Enable input transcription
          outputAudioTranscription: {}, // Enable output transcription
          systemInstruction: "You are a helpful and witty AI assistant. Keep responses concise and conversational."
        },
        callbacks: {
          onopen: () => {
            setStatus(LiveStatus.CONNECTED);
            addLog('system', 'Connected! Start talking.');

            if (!inputAudioContextRef.current || !mediaStreamRef.current) return;
            
            const inputCtx = inputAudioContextRef.current;
            const source = inputCtx.createMediaStreamSource(mediaStreamRef.current);
            audioSourceRef.current = source;
            
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              const pcmBlob = float32ToPcmBlob(inputData);

              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(analyser);
            source.connect(processor);
            processor.connect(inputCtx.destination);
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
      addLog('system', `Connection failed: ${error.message}`);
      cleanup();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col text-white selection:bg-blue-500 selection:text-white relative">
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-fade-in-up">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-white">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white transition-colors">
                <XMarkIcon className="w-6 h-6" />
              </button>
            </div>
            <form onSubmit={handleSaveSettings} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Gemini API Key</label>
                <input 
                  type="password" 
                  name="apiKey"
                  defaultValue={apiKey}
                  placeholder="AIza..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Your key is stored locally in your browser.
                </p>
              </div>
              <button 
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-lg font-semibold transition-colors"
              >
                Save Configuration
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
            <SpeakerWaveIcon className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
            Gemini Live
          </h1>
        </div>
        
        <div className="flex items-center gap-4">
           <div className="flex items-center gap-2 text-sm text-slate-400">
              <span className={`flex items-center gap-2 px-2 py-1 rounded-full text-xs font-medium border ${
                status === LiveStatus.CONNECTED ? 'bg-green-500/10 border-green-500/20 text-green-400' :
                status === LiveStatus.CONNECTING ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' :
                'bg-slate-800 border-slate-700 text-slate-400'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  status === LiveStatus.CONNECTED ? 'bg-green-400 animate-pulse' :
                  status === LiveStatus.CONNECTING ? 'bg-yellow-400' :
                  'bg-slate-500'
                }`}></span>
                {status.toUpperCase()}
              </span>
           </div>
           <button 
             onClick={() => setShowSettings(true)}
             className="p-2 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-all"
             title="Configure API Key"
           >
             <Cog6ToothIcon className="w-5 h-5" />
           </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden p-4 gap-4 max-w-7xl mx-auto w-full">
        
        {/* Left Panel: Controls & Visualization */}
        <div className="flex-1 flex flex-col gap-4">
          
          {/* Visualizer Card */}
          <div className="flex-1 bg-slate-900 rounded-2xl border border-slate-800 p-6 flex flex-col items-center justify-center relative overflow-hidden shadow-2xl shadow-black/50 min-h-[400px]">
            {/* Background Glow */}
            <div className={`absolute inset-0 bg-gradient-to-b from-blue-500/5 to-transparent transition-opacity duration-700 ${status === LiveStatus.CONNECTED ? 'opacity-100' : 'opacity-0'}`}></div>
            
            {/* Center Animation */}
            <div className="relative z-10 mb-8">
              {status === LiveStatus.CONNECTED ? (
                 <div className="relative flex items-center justify-center w-32 h-32">
                   <div className="absolute inset-0 rounded-full border-4 border-blue-500/30 animate-ring"></div>
                   <div className="absolute inset-0 rounded-full border-4 border-purple-500/30 animate-ring" style={{ animationDelay: '-0.5s' }}></div>
                   <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full shadow-[0_0_30px_rgba(59,130,246,0.5)] animate-dot flex items-center justify-center">
                      <SpeakerWaveIcon className="w-10 h-10 text-white" />
                   </div>
                 </div>
              ) : (
                <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center border border-slate-700">
                   <SpeakerWaveIcon className="w-10 h-10 text-slate-600" />
                </div>
              )}
            </div>

            {/* Canvas Visualizer */}
            <div className="w-full h-24 relative z-10 mix-blend-screen">
               <AudioVisualizer 
                 analyser={analyserRef.current} 
                 isListening={status === LiveStatus.CONNECTED} 
               />
            </div>
            
            {/* Live Captions Overlay */}
            <div className="mt-8 w-full max-w-2xl min-h-[60px] text-center relative z-20">
               {streamingLog ? (
                 <div className={`inline-block px-6 py-3 rounded-2xl backdrop-blur-md border shadow-xl transition-all duration-300 animate-fade-in-up ${
                    streamingLog.role === 'user' 
                      ? 'bg-blue-500/20 border-blue-500/30 text-blue-100' 
                      : 'bg-purple-500/20 border-purple-500/30 text-purple-100'
                 }`}>
                    <p className="text-lg md:text-xl font-medium leading-relaxed tracking-wide">
                      {streamingLog.text}
                      {status === LiveStatus.CONNECTED && <span className="inline-block w-1.5 h-4 ml-2 bg-current animate-pulse align-middle rounded-full"/>}
                    </p>
                 </div>
               ) : (
                 status === LiveStatus.CONNECTED && (
                   <p className="text-slate-500 text-sm font-medium animate-pulse tracking-widest uppercase">
                     Listening...
                   </p>
                 )
               )}
               {status !== LiveStatus.CONNECTED && !streamingLog && (
                  <p className="text-slate-500 text-sm">Ready to connect</p>
               )}
            </div>
          </div>

          {/* Controls Card */}
          <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 flex flex-col md:flex-row items-center gap-6 justify-between shadow-lg">
            <div className="flex flex-col gap-2 w-full md:w-auto">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Voice Selection</label>
              <select 
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value as VoiceName)}
                disabled={status !== LiveStatus.DISCONNECTED}
                className="bg-slate-950 border border-slate-700 text-slate-200 rounded-lg px-4 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed appearance-none cursor-pointer"
              >
                {['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'].map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-4 w-full md:w-auto justify-center md:justify-end">
              {status === LiveStatus.CONNECTED || status === LiveStatus.CONNECTING ? (
                <button
                  onClick={cleanup}
                  className="flex items-center gap-2 px-8 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full font-semibold transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-red-500/20"
                >
                  <StopIcon className="w-5 h-5" />
                  <span>End Session</span>
                </button>
              ) : (
                <button
                  onClick={connect}
                  className="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-semibold transition-all transform hover:scale-105 active:scale-95 shadow-lg shadow-blue-500/20"
                >
                  <MicrophoneIcon className="w-5 h-5" />
                  <span>Start Live</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel: Logs */}
        <div className="lg:w-96 flex flex-col bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden shadow-lg h-[500px] lg:h-auto">
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <h2 className="font-semibold text-slate-200">Session History</h2>
          </div>
          
          <div 
            ref={logContainerRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide scroll-smooth"
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
                className={`flex flex-col animate-fade-in-up ${
                  log.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <span className="text-[10px] text-slate-500 mb-1 px-1">
                  {log.role.toUpperCase()} • {log.timestamp.toLocaleTimeString()}
                </span>
                <div className={`max-w-[90%] px-3 py-2 rounded-2xl text-sm ${
                  log.role === 'user' 
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
              <div className={`flex flex-col animate-fade-in-up ${
                  streamingLog.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <span className="text-[10px] text-slate-500 mb-1 px-1">
                  {streamingLog.role.toUpperCase()} • Now
                </span>
                <div className={`max-w-[90%] px-3 py-2 rounded-2xl text-sm opacity-70 ${
                  streamingLog.role === 'user' 
                    ? 'bg-blue-600/50 text-white rounded-tr-none' 
                    : 'bg-slate-800/50 text-slate-200 rounded-tl-none border border-slate-700'
                }`}>
                  {streamingLog.text}
                  <span className="inline-block w-1 h-3 ml-1 bg-current animate-pulse align-middle"/>
                </div>
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}