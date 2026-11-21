// Original vector art: Kinetic Ring wordmark and the UNIT-07 cyber-drone.
export function Logo({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  return (
    <h1 className={`font-display font-bold uppercase italic leading-none tracking-tight ${size === 'lg' ? 'text-7xl xl:text-8xl' : 'text-3xl'}`}>
      <span className="text-glow-cyan text-cyan">Kinetic</span>{' '}
      <span className="text-glow-pink text-pink">Ring</span>
    </h1>
  );
}

export function DroneIcon({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M12 24 L32 12 L52 24 L48 44 L32 54 L16 44 Z" />
      <circle cx="32" cy="32" r="7" fill="currentColor" />
      <path d="M4 22 h10 M50 22 h10 M8 46 l8 -4 M56 46 l-8 -4" strokeLinecap="round" />
    </svg>
  );
}

export function Silhouette({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 300" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round">
      <circle cx="100" cy="52" r="28" />
      <path d="M58 110 Q100 92 142 110 L150 200 L130 205 L125 290 H75 L70 205 L50 200 Z" />
      <path d="M58 112 L38 150 L70 120 M142 112 L162 150 L130 120" />
      <circle cx="74" cy="92" r="13" /><circle cx="126" cy="92" r="13" />
    </svg>
  );
}

export function BadgeIcon({ className = 'h-14 w-14' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <path d="M32 4 L56 16 V36 C56 48 44 58 32 60 C20 58 8 48 8 36 V16 Z" fill="#1B2556" stroke="#C8FF3D" strokeWidth="3" />
      <path d="M36 14 L22 36 H32 L28 52 L44 28 H34 Z" fill="#C8FF3D" />
    </svg>
  );
}
