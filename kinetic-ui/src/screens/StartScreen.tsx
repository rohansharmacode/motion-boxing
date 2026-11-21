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
  { id: 'player', label: 'Mii Channel', sub: 'Your fighter' },
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

  const h = now.getHours(), h12 = h % 12 || 12, mm = String(now.getMinutes()).padStart(2, '0');
  return (
    <main className="wii-menu">
      <section className="wii-channel-area" aria-label="Game channels">
        <div className="wii-channel-grid">
          {channels.map((channel) => (
            <div className="wii-slot" key={channel.id}>
              <Button variant="wii" className={`wii-channel wii-channel-${channel.id}`} onClick={() => channel.id === 'leaderboard' ? onLeaderboard() : setSelected(channel.id)} aria-label={channel.label}>
                <ChannelArt kind={channel.id} />
              </Button>
              <span className="wii-label" aria-hidden="true">{channel.label}</span>
            </div>
          ))}
          {Array.from({ length: 6 }, (_, i) => <div className="wii-empty-channel" aria-hidden="true" key={i} />)}
        </div>
      </section>

      <footer className="wii-footer">
        <svg className="wii-footer-shape" viewBox="0 0 1000 190" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="wiifoot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e9ebed" /><stop offset="1" stopColor="#d9dcdf" /></linearGradient></defs>
          <path d="M0 10H170C250 10 260 104 340 104H660C740 104 750 10 830 10H1000V190H0Z" fill="url(#wiifoot)" />
          <path d="M0 10H170C250 10 260 104 340 104H660C740 104 750 10 830 10H1000" fill="none" stroke="#29b6e9" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="wii-clock"><time dateTime={now.toISOString()}><b>{h12}<i>:</i>{mm}</b></time><small>{h < 12 ? 'AM' : 'PM'}</small></div>
        <div className="wii-date">{now.toLocaleDateString('en-US', { weekday: 'short' })} {now.getMonth() + 1}/{now.getDate()}</div>
        <Button variant="wii" className="wii-round-button wii-system-button" aria-label={`Mii profile: ${name.trim() || 'Guest'}`} title="Mii profile" onClick={() => setSelected('player')}>Wii</Button>
        <div className="wii-sd" aria-hidden="true">SD</div>
        <Button variant="wii" className="wii-round-button wii-mail-button" aria-label="Open leaderboard" title="Leaderboard" onClick={onLeaderboard}><svg viewBox="0 0 40 30" aria-hidden="true"><path d="M2 4q0-3 3-3h30q3 0 3 3v22q0 3-3 3H5q-3 0-3-3Zm2 1 16 12L36 5" stroke="#fff" strokeWidth="2" /></svg><span>{mockData ? 1 : ''}</span></Button>
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