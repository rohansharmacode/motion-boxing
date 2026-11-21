import type { CalibrationState } from '../types';
import { cx } from '../components/ui';
import { Silhouette } from '../components/art';

export interface CalibrationOverlayProps {
  state: CalibrationState;
  /** 0-1, used while state === 'holding' (fills over ~2 s). */
  holdProgress?: number;
  /** Optional live webcam element; a dark placeholder is shown otherwise. */
  video?: React.ReactNode;
}

const COPY: Record<CalibrationState, { title: string; hint: string; icon: string; tone: 'cyan' | 'amber' | 'lime' }> = {
  searching: { title: 'Step into frame', hint: 'Stand where the camera can see your whole upper body.', icon: '◎', tone: 'cyan' },
  too_close: { title: 'Too close', hint: 'Take one big step back.', icon: '⇤', tone: 'amber' },
  too_far: { title: 'Too far', hint: 'Step forward until your head fits the frame.', icon: '⇥', tone: 'amber' },
  off_centre: { title: 'Off centre', hint: 'Move to the middle of the frame.', icon: '↔', tone: 'amber' },
  low_light: { title: 'Low light', hint: 'Turn on a light or face a window.', icon: '☀', tone: 'amber' },
  holding: { title: 'Hold your guard', hint: 'Hands up by your chin. Stay still.', icon: '✊', tone: 'cyan' },
  locked: { title: 'Locked in', hint: 'Get ready to fight.', icon: '✓', tone: 'lime' },
};

const R = 70, C = 2 * Math.PI * R;

export function CalibrationOverlay({ state, holdProgress = 0, video }: CalibrationOverlayProps) {
  const c = COPY[state];
  const progress = state === 'locked' ? 1 : state === 'holding' ? holdProgress : 0;
  const colour = c.tone === 'lime' ? 'text-lime' : c.tone === 'amber' ? 'text-amber' : 'text-cyan';
  const frameBorder = c.tone === 'lime' ? 'border-lime' : c.tone === 'amber' ? 'border-amber' : 'border-cyan';

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#05081a]">
      <div className="absolute inset-0">{video ?? <div className="h-full w-full bg-[radial-gradient(ellipse_at_center,#1a2147,#05081a_70%)]" />}</div>
      <div className="absolute inset-0 bg-navy/40" />

      {/* Centre frame with corner brackets */}
      <div className="absolute left-1/2 top-1/2 h-[68%] aspect-[3/4] -translate-x-1/2 -translate-y-1/2">
        {(['left-0 top-0 border-l-4 border-t-4', 'right-0 top-0 border-r-4 border-t-4', 'left-0 bottom-0 border-l-4 border-b-4', 'right-0 bottom-0 border-r-4 border-b-4'] as const).map((p) => (
          <span key={p} className={cx('absolute h-12 w-12 transition-colors duration-300', p, frameBorder)} />
        ))}
        <Silhouette className={cx('absolute inset-[10%] h-[80%] w-[80%] opacity-60 transition-colors', colour)} />
        <svg viewBox="0 0 160 160" className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 -rotate-90">
          <circle cx="80" cy="80" r={R} stroke="rgb(139 150 201 / .3)" strokeWidth="8" fill="none" />
          <circle cx="80" cy="80" r={R} stroke="currentColor" strokeWidth="8" fill="none" strokeLinecap="round"
            className={cx(colour, 'transition-[stroke-dashoffset] duration-100')}
            strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
        </svg>
        {state === 'locked' && <div className="flash-lime pointer-events-none absolute -inset-[100vmax] bg-lime/40" />}
      </div>

      {/* Instruction plate */}
      <div className="absolute inset-x-0 bottom-[6%] flex justify-center" role="status" aria-live="polite">
        <div key={state} className={cx('skew-panel rise flex items-center border-2 bg-navy/90 px-8 py-3', frameBorder)}>
          <div className="flex items-center gap-4">
            <span className={cx('font-display text-4xl', colour)} aria-hidden>{c.icon}</span>
            <div>
              <div className={cx('font-display text-3xl font-bold uppercase', colour)}>{c.title}</div>
              <div className="text-xl text-white/90">{c.hint}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
