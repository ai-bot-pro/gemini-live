import React, { useEffect, useRef, useState } from 'react';

interface DigitalAvatarProps {
    analyser: AnalyserNode | null;
    isSessionActive: boolean;
}

export const DigitalAvatar: React.FC<DigitalAvatarProps> = ({ analyser, isSessionActive }) => {
    const [intensity, setIntensity] = useState(0);
    const reqRef = useRef<number>(0);

    useEffect(() => {
        // Reset when session ends
        if (!isSessionActive || !analyser) {
            setIntensity(0);
            return;
        }

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const update = () => {
            analyser.getByteFrequencyData(dataArray);

            // Calculate average energy in the speech range
            let sum = 0;
            const startBin = Math.floor(bufferLength * 0.1); // ~500Hz
            const endBin = Math.floor(bufferLength * 0.4);   // ~4000Hz
            const count = endBin - startBin;

            for (let i = startBin; i < endBin; i++) {
                sum += dataArray[i];
            }

            const avg = count > 0 ? sum / count : 0;
            // Normalize and apply sensitivity curve
            const val = Math.min(1, Math.max(0, (avg - 20) / 120));

            setIntensity(val);
            reqRef.current = requestAnimationFrame(update);
        };

        update();

        return () => cancelAnimationFrame(reqRef.current);
    }, [analyser, isSessionActive]);

    // Dynamic Styles based on audio intensity
    const glowSize = 20 + intensity * 40; // 20px to 60px
    const mouthOpen = 2 + intensity * 15; // 2px to 17px height
    const colorIntensity = 100 + intensity * 155; // brightness

    return (
        <div className="relative w-64 h-64 flex items-center justify-center animate-fade-in">
            {/* Ambient Glow */}
            <div
                className="absolute inset-0 rounded-full bg-blue-500 blur-3xl transition-opacity duration-100"
                style={{ opacity: 0.1 + intensity * 0.4 }}
            />

            {/* Holographic Face SVG */}
            <svg
                viewBox="0 0 200 200"
                className="w-full h-full drop-shadow-[0_0_10px_rgba(59,130,246,0.8)]"
            >
                <defs>
                    <linearGradient id="holoGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor={`rgb(${100}, ${colorIntensity}, 255)`} stopOpacity="0.9" />
                        <stop offset="100%" stopColor={`rgb(${colorIntensity}, 50, 255)`} stopOpacity="0.6" />
                    </linearGradient>
                    <filter id="glow">
                        <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
                        <feMerge>
                            <feMergeNode in="coloredBlur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Tech Ring Background */}
                <circle cx="100" cy="100" r="90" fill="none" stroke="#3b82f6" strokeWidth="1" strokeOpacity="0.2" strokeDasharray="4 4" className={isSessionActive ? "animate-[spin_10s_linear_infinite]" : ""} />
                <circle cx="100" cy="100" r="85" fill="none" stroke="#8b5cf6" strokeWidth="0.5" strokeOpacity="0.2" className={isSessionActive ? "animate-[spin_15s_linear_infinite_reverse]" : ""} />

                <g filter="url(#glow)" className="transition-all duration-75" style={{ transform: `scale(${1 + intensity * 0.05})`, transformOrigin: 'center' }}>
                    {/* Head Contour */}
                    <path
                        d="M100 30 C 60 30, 40 70, 40 110 C 40 160, 70 180, 100 185 C 130 180, 160 160, 160 110 C 160 70, 140 30, 100 30 Z"
                        fill="none"
                        stroke="url(#holoGradient)"
                        strokeWidth="2"
                        strokeOpacity="0.8"
                    />

                    {/* Internal Grid Lines (Wireframe effect) */}
                    <path d="M40 110 Q 100 130 160 110" fill="none" stroke="url(#holoGradient)" strokeWidth="0.5" strokeOpacity="0.3" />
                    <path d="M100 30 V 185" fill="none" stroke="url(#holoGradient)" strokeWidth="0.5" strokeOpacity="0.3" />
                    <path d="M50 70 Q 100 90 150 70" fill="none" stroke="url(#holoGradient)" strokeWidth="0.5" strokeOpacity="0.3" />

                    {/* Eyes */}
                    <g transform="translate(0, 0)">
                        <path d="M70 95 L 85 95" stroke="url(#holoGradient)" strokeWidth="3" strokeLinecap="round" className={isSessionActive ? "animate-pulse" : ""} />
                        <path d="M115 95 L 130 95" stroke="url(#holoGradient)" strokeWidth="3" strokeLinecap="round" className={isSessionActive ? "animate-pulse" : ""} />
                    </g>

                    {/* Dynamic Mouth */}
                    <g transform="translate(100, 135)">
                        {/* Static line */}
                        <rect x="-15" y="0" width="30" height="1" fill="url(#holoGradient)" opacity="0.5" />

                        {/* Waveform bars representing speech */}
                        {isSessionActive && (
                            <>
                                <rect x="-12" y={-mouthOpen * 0.4} width="2" height={mouthOpen * 0.8 + 1} fill="#bae6fd" opacity="0.9" rx="1" />
                                <rect x="-6" y={-mouthOpen * 0.8} width="2" height={mouthOpen * 1.6 + 1} fill="#bae6fd" opacity="0.9" rx="1" />
                                <rect x="0" y={-mouthOpen} width="2" height={mouthOpen * 2 + 1} fill="#bae6fd" opacity="1" rx="1" />
                                <rect x="6" y={-mouthOpen * 0.8} width="2" height={mouthOpen * 1.6 + 1} fill="#bae6fd" opacity="0.9" rx="1" />
                                <rect x="12" y={-mouthOpen * 0.4} width="2" height={mouthOpen * 0.8 + 1} fill="#bae6fd" opacity="0.9" rx="1" />
                            </>
                        )}
                    </g>
                </g>
            </svg>

            {/* Status Text */}
            <div className="absolute -bottom-8 text-blue-400 text-xs font-mono tracking-widest opacity-70 uppercase">
                {isSessionActive ? (intensity > 0.1 ? "Speaking" : "Listening") : "Offline"}
            </div>
        </div>
    );
};