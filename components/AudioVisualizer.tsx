import React, { useEffect, useRef } from 'react';
import { AudioVisualizerProps } from '../types';

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyser, isListening }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!isListening) {
         ctx.clearRect(0, 0, canvas.width, canvas.height);
         return;
      }

      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      // Draw centered visualization
      const centerX = canvas.width / 2;
      
      // Create gradient
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, '#3b82f6'); // Blue-500
      gradient.addColorStop(0.5, '#8b5cf6'); // Violet-500
      gradient.addColorStop(1, '#ec4899'); // Pink-500
      ctx.fillStyle = gradient;

      // Mirror effect for better aesthetics
      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2; // Scale down
        
        // Right side
        ctx.fillRect(centerX + x, (canvas.height - barHeight) / 2, barWidth, barHeight);
        // Left side
        ctx.fillRect(centerX - x - barWidth, (canvas.height - barHeight) / 2, barWidth, barHeight);

        x += barWidth + 1;
        
        if (x > centerX) break; 
      }
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, isListening]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={100} 
      className="w-full h-full rounded-lg opacity-80"
    />
  );
};