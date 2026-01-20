
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { ConnectionState, TranscriptionEntry } from './types';
import { SYSTEM_INSTRUCTION, MODEL_NAME } from './constants';

// --- Utility Functions for Audio ---
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}
// --- End Utilities ---

const QUICK_QUESTIONS = [
  { text: "What are the main objectives?", icon: "🎯" },
  { text: "Tell me about the 5 modules.", icon: "📚" },
  { text: "How am I evaluated?", icon: "📊" },
  { text: "What is Agentic AI?", icon: "🤖" },
];

export default function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isListening, setIsListening] = useState(false);
  
  // Refs for audio handling to avoid re-renders
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const currentOutputTranscriptionRef = useRef('');
  const currentInputTranscriptionRef = useRef('');

  const stopConversation = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    activeSourcesRef.current.forEach(source => source.stop());
    activeSourcesRef.current.clear();
    setConnectionState(ConnectionState.DISCONNECTED);
    setIsListening(false);
  }, []);

  const sendTextMessage = (text: string) => {
    if (sessionRef.current && connectionState === ConnectionState.CONNECTED) {
      // Send text to the live session
      sessionRef.current.send({ parts: [{ text }] });
      
      // Manually add to transcript for instant feedback
      setTranscriptions(prev => [
        ...prev,
        { role: 'user', text, timestamp: new Date() }
      ]);
    }
  };

  const startConversation = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      // Initialize audio contexts
      if (!audioContextInRef.current) audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!audioContextOutRef.current) audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            setIsListening(true);
            
            // Start streaming microphone
            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Data
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = audioContextOutRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              const gainNode = outCtx.createGain();
              source.connect(gainNode).connect(outCtx.destination);
              
              source.addEventListener('ended', () => {
                activeSourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              activeSourcesRef.current.add(source);
            }

            // Handle Transcriptions
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscriptionRef.current.trim();
              const modelText = currentOutputTranscriptionRef.current.trim();
              
              if (userText || modelText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(userText ? [{ role: 'user' as const, text: userText, timestamp: new Date() }] : []),
                  ...(modelText ? [{ role: 'model' as const, text: modelText, timestamp: new Date() }] : []),
                ]);
              }
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            // Handle Interrupts
            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => s.stop());
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Live API Error:', e);
            setConnectionState(ConnectionState.ERROR);
            stopConversation();
          },
          onclose: () => {
            setConnectionState(ConnectionState.DISCONNECTED);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Failed to start conversation:', err);
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const clearHistory = () => {
    setTranscriptions([]);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-5xl mb-8 text-center">
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">AI Course Tutor</h1>
        <p className="text-slate-600 italic">"Inteligência Artificial Generativa versus Agentiva"</p>
        <div className="mt-4 flex justify-center gap-2">
           <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
             connectionState === ConnectionState.CONNECTED ? 'bg-green-100 text-green-700' :
             connectionState === ConnectionState.CONNECTING ? 'bg-blue-100 text-blue-700' :
             connectionState === ConnectionState.ERROR ? 'bg-red-100 text-red-700' :
             'bg-slate-200 text-slate-600'
           }`}>
             {connectionState}
           </span>
        </div>
      </header>

      <main className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Course Info Column */}
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 lg:col-span-1">
          <h2 className="text-xl font-semibold mb-4 text-slate-800 flex items-center gap-2">
             <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.246.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
             Course Highlights
          </h2>
          <div className="space-y-4 text-sm text-slate-600">
            <div>
              <p className="font-bold text-slate-800">Title</p>
              <p>IA Generativa vs Agentiva</p>
            </div>
            <div>
              <p className="font-bold text-slate-800">Duration</p>
              <p>25 Hours (25 Accredited)</p>
            </div>
            <div>
              <p className="font-bold text-slate-800">Key Tools</p>
              <p>MagicSchool.ai, n8n.io, customGPTs</p>
            </div>
            <div className="pt-4 border-t border-slate-100">
              <p className="font-bold text-slate-800 mb-2">Evaluation Breakdown</p>
              <div className="flex justify-between items-center mb-1">
                <span>Participation</span>
                <span className="font-medium">30%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5 mb-3">
                <div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: '30%' }}></div>
              </div>
              <div className="flex justify-between items-center mb-1">
                <span>Microproject</span>
                <span className="font-medium">40%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5 mb-3">
                <div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: '40%' }}></div>
              </div>
              <div className="flex justify-between items-center mb-1">
                <span>Reflection</span>
                <span className="font-medium">30%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5">
                <div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: '30%' }}></div>
              </div>
            </div>
          </div>
        </section>

        {/* Conversation Column */}
        <section className="lg:col-span-2 flex flex-col gap-6">
          {/* Chat Bubble History */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[500px]">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <span className="text-sm font-medium text-slate-500">Live Conversation History</span>
              <button 
                onClick={clearHistory}
                className="text-xs text-slate-400 hover:text-red-500 transition-colors"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
              {transcriptions.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-2">
                  <svg className="w-12 h-12 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  <p className="text-sm">Start the conversation to see transcripts</p>
                </div>
              )}
              {transcriptions.map((entry, i) => (
                <div key={i} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed shadow-sm ${
                    entry.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-slate-100 text-slate-800 rounded-tl-none border border-slate-200'
                  }`}>
                    {entry.text}
                  </div>
                </div>
              ))}
            </div>

            {/* Quick Questions Section */}
            <div className="px-4 py-3 bg-white border-t border-slate-100">
               <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Quick Questions</p>
               <div className="flex flex-wrap gap-2">
                 {QUICK_QUESTIONS.map((q, idx) => (
                   <button
                    key={idx}
                    disabled={connectionState !== ConnectionState.CONNECTED}
                    onClick={() => sendTextMessage(q.text)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                      connectionState === ConnectionState.CONNECTED 
                      ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 active:scale-95 border border-indigo-100' 
                      : 'bg-slate-50 text-slate-400 cursor-not-allowed border border-slate-100 opacity-60'
                    }`}
                   >
                     <span>{q.icon}</span>
                     {q.text}
                   </button>
                 ))}
               </div>
            </div>

            {/* Live Visualizer Placeholder / Footer */}
            <div className="p-6 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              <div className="flex flex-col items-center gap-4">
                {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
                  <button 
                    onClick={startConversation}
                    className="group relative inline-flex items-center justify-center px-8 py-3 font-semibold text-white transition-all duration-200 bg-indigo-600 rounded-full hover:bg-indigo-700 active:scale-95 shadow-lg shadow-indigo-200"
                  >
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    Start Tutoring Session
                  </button>
                ) : (
                  <div className="flex flex-col items-center gap-4 w-full">
                    <div className="flex items-center gap-3">
                      <div className="flex gap-1 h-6 items-end">
                        {[...Array(6)].map((_, i) => (
                          <div key={i} className={`w-1 bg-indigo-500 rounded-full animate-pulse`} style={{ animationDelay: `${i * 0.15}s`, height: `${30 + Math.random() * 70}%` }}></div>
                        ))}
                      </div>
                      <span className="text-sm font-medium text-slate-700 animate-pulse">AI is listening...</span>
                    </div>
                    <button 
                      onClick={stopConversation}
                      className="px-6 py-2 border border-red-200 text-red-600 font-medium rounded-full hover:bg-red-50 transition-all active:scale-95 text-sm"
                    >
                      Stop Session
                    </button>
                  </div>
                )}
                <p className="text-[10px] text-slate-400 uppercase tracking-widest text-center">
                  Powered by Gemini 2.5 Native Audio
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
