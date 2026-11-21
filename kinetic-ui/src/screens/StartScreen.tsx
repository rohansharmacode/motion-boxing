import { useEffect, useRef, useState } from 'react';
import type { SportId } from '../types';
import { Button, useInterval } from '../components/ui';
import { ChannelArt } from '../components/ChannelArt';

export interface StartScreenProps {
  defaultName?: string;
  mockData?: boolean;
  onStart: (name: string, sport: SportId) => void;
  onLeaderboard: () => void;
}

type Channel = 'boxing' | 'keeper' | 'bow' | 'player' | 'disc';
const channels: { id: Channel | 'leaderboard'; label: string; sub: string }[] = [
  { id: 'disc', label: 'Disc Channel', sub: 'Kinetic Ring' },
  { id: 'boxing', label: 'Boxing', sub: 'Kinetic Sports' },
  { id: 'keeper', label: 'Reflex Keeper', sub: 'Kinetic Sports' },
  { id: 'bow', label: 'Aero Bow', sub: 'Coming soon' },
  { id: 'player', label: 'Fighter Channel', sub: 'Your player' },
  { id: 'leaderboard', label: 'Leaderboard', sub: 'Kinetic rankings' },
];

export function StartScreen({ defaultName = '', mockData = true, onStart, onLeaderboard }: StartScreenProps) {
  const [name, setName] = useState(defaultName);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [now, setNow] = useState(new Date());
  const dialog = useRef<HTMLDialogElement>(null);
  useInterval(() => setNow(new Date()), 1000);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  const activeChannel = channels.find((c) => c.id === selected);
  const playable = selected === 'boxing' || selected === 'disc' || selected === 'keeper';
  const upcoming = selected === 'bow';

  return (
    <main className="wii-menu">
      <header className="wii-header">
        <div className="wii-brand">Kinetic <span>Ring</span><small>SPORTS CHANNELS</small></div>
        <div className="wii-player"><span className="wii-player-dot" />{name.trim() || 'Guest'}<span className="wii-player-number">1</span></div>
      </header>

      <section className="wii-channel-area" aria-label="Game channels">
        <div className="wii-channel-grid">
          {channels.map((channel) => (
            <Button variant="wii" key={channel.id} className={`wii-channel wii-channel-${channel.id}`} onClick={() => channel.id === 'leaderboard' ? onLeaderboard() : setSelected(channel.id)} aria-label={channel.label}>
              <div className="wii-channel-content">
                <div className="wii-channel-picture"><ChannelArt kind={channel.id} /></div>
                <div className="wii-channel-caption"><strong>{channel.label}</strong><small>{channel.sub}</small></div>
              </div>
            </Button>
          ))}
          {Array.from({ length: 6 }, (_, i) => <div className="wii-empty-channel" aria-hidden="true" key={i}><span>Wii</span></div>)}
        </div>
      </section>

      <footer className="wii-footer">
        <div className="wii-footer-inner">
          <Button variant="wii" className="wii-round-button wii-system-button" aria-label="Fighter profile" title="Fighter profile" onClick={() => setSelected('player')}>Wii</Button>
          <div className="wii-date"><time className="wii-time" dateTime={now.toISOString()}>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><span>{now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
          <Button variant="wii" className="wii-round-button" aria-label="Open leaderboard" title="Leaderboard" onClick={onLeaderboard}><svg viewBox="0 0 40 32" aria-hidden="true"><rect x="3" y="5" width="34" height="24" rx="3" /><path d="m4 7 16 12L36 7" /></svg></Button>
        </div>
        <div className="wii-status"><span>KINETIC RING · WII EDITION</span><span>{mockData ? 'Demo session' : 'Ready to play'}</span></div>
      </footer>

      <dialog ref={dialog} className="wii-dialog" onCancel={() => setSelected(null)} onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }} onClose={() => setSelected(null)}>
        {selected && <>
          <div className={`wii-dialog-art wii-channel-${selected}`}><ChannelArt kind={selected} /></div>
          <form onSubmit={(e) => { e.preventDefault(); if (playable) onStart(name.trim() || 'PLAYER', selected === 'keeper' ? 'keeper' : 'boxing'); else setSelected(null); }}>
            <h2>{activeChannel?.label}</h2>
            {upcoming ? <p>Coming soon</p> : <label>Fighter name<input aria-label="Fighter name" maxLength={20} placeholder="PLAYER" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} /></label>}
            <div className="wii-dialog-actions"><Button variant="wii" className="wii-pill" onClick={() => setSelected(null)}>Wii Menu</Button>{!upcoming && <Button variant="wii" className="wii-pill wii-pill-primary" type="submit">{playable ? 'Start' : 'Save'}</Button>}</div>
          </form>
        </>}
      </dialog>
    </main>
  );
}