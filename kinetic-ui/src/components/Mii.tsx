/** Original Mii-style avatar: big round head, simple oval eyes, tiny nose, soft smile. */
export interface MiiLook { skin: string; hair: string; shirt: string; style: 0 | 1 | 2 | 3 | 4; glasses?: boolean; mouth?: 'smile' | 'grin' | 'o' | 'flat'; brows?: 'up' | 'flat' | 'angry' }

export const MII_CAST: MiiLook[] = [
  { skin: '#f6d6b8', hair: '#5a3b26', shirt: '#e14b45', style: 0, mouth: 'grin' },
  { skin: '#ffe0c4', hair: '#e9b54c', shirt: '#2ea8e0', style: 2, mouth: 'smile' },
  { skin: '#c98d62', hair: '#1f1a17', shirt: '#7bc043', style: 1, glasses: true, mouth: 'smile' },
  { skin: '#f3c9a3', hair: '#9c4a2b', shirt: '#f3b33d', style: 3, mouth: 'o' },
  { skin: '#8a5a3c', hair: '#141110', shirt: '#9a6ad6', style: 4, mouth: 'grin' },
  { skin: '#ffe3cf', hair: '#2b2b2b', shirt: '#ff7fae', style: 1, mouth: 'smile', brows: 'up' },
  { skin: '#f0c8a0', hair: '#7a5a3a', shirt: '#3fc1b0', style: 0, glasses: true, mouth: 'flat' },
  { skin: '#dca57a', hair: '#3a2a20', shirt: '#4e74d9', style: 2, mouth: 'grin' },
];

function Hair({ style, color }: { style: MiiLook['style']; color: string }) {
  switch (style) {
    case 0: return <path fill={color} d="M-31 -6q-3-34 31-36 34 2 31 36-6-16-16-20-6 8-26 6-12 2-20 14Z" />; // short side part
    case 1: return <path fill={color} d="M-32 4q-6-46 32-46t32 46q-2-14-8-22-18 4-48 0-6 8-8 22Z" />; // bowl
    case 2: return <><path fill={color} d="M-33 -2q-2-40 33-40t33 40l2 36q-8 4-10-6l-2-40q-20 8-46 0l-2 40q-2 10-10 6Z" /></>; // long
    case 3: return <path fill={color} d="M-30 -10q-2-30 30-32 32 2 30 32-4-8-8-10l-4 6-6-10-6 8-6-10-6 10-6-8-4 10q-6 0-14 14Z" />; // spiky
    default: return <><circle fill={color} cx="0" cy="-44" r="11" /><path fill={color} d="M-31 -4q-2-36 31-38 33 2 31 38-10-16-31-18-21 2-31 18Z" /></>; // bun
  }
}

/** Head-and-shoulders Mii centred on (0,0) = middle of the face. */
export function Mii({ look, x = 0, y = 0, s = 1, body = true, children }: { look: MiiLook; x?: number; y?: number; s?: number; body?: boolean; children?: React.ReactNode }) {
  const { skin, hair, shirt, style, glasses, mouth = 'smile', brows = 'flat' } = look;
  const brow = brows === 'up' ? ['M-17 -12l10-3', 'M7 -15l10 3'] : brows === 'angry' ? ['M-17 -15l10 4', 'M7 -11l10-4'] : ['M-17 -13h10', 'M7 -13h10'];
  const m = { smile: <path d="M-8 17q8 7 16 0" fill="none" stroke="#7a3b2e" strokeWidth="2.6" strokeLinecap="round" />,
    grin: <path d="M-10 15q10 12 20 0Z" fill="#fff" stroke="#7a3b2e" strokeWidth="2.4" strokeLinejoin="round" />,
    o: <ellipse cx="0" cy="18" rx="4" ry="5" fill="#7a3b2e" />,
    flat: <path d="M-7 18h14" stroke="#7a3b2e" strokeWidth="2.6" strokeLinecap="round" /> }[mouth];
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {body && <path fill={shirt} d="M-30 70v-22q0-20 30-20t30 20v22Z" />}
      {body && <rect x="-6" y="24" width="12" height="10" fill={skin} />}
      <ellipse cx="-30" cy="4" rx="5" ry="7" fill={skin} /><ellipse cx="30" cy="4" rx="5" ry="7" fill={skin} />
      <path fill={skin} d="M-30 -4q0-34 30-34t30 34q0 36-30 36t-30-36Z" />
      <Hair style={style} color={hair} />
      <g stroke={hair} strokeWidth="3.4" strokeLinecap="round">{brow.map((d) => <path key={d} d={d} />)}</g>
      <ellipse cx="-12" cy="-2" rx="4.2" ry="6" fill="#2a2420" /><ellipse cx="12" cy="-2" rx="4.2" ry="6" fill="#2a2420" />
      <circle cx="-10.5" cy="-4.5" r="1.5" fill="#fff" /><circle cx="13.5" cy="-4.5" r="1.5" fill="#fff" />
      {glasses && <g fill="none" stroke="#3a3a3a" strokeWidth="2.2"><rect x="-21" y="-10" width="17" height="15" rx="5" /><rect x="4" y="-10" width="17" height="15" rx="5" /><path d="M-4 -3h8" /></g>}
      <path d="M-3 7q3 3 6 0" fill="none" stroke="#c48a68" strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="-19" cy="11" rx="5" ry="3" fill="#ff8f8f" opacity=".35" /><ellipse cx="19" cy="11" rx="5" ry="3" fill="#ff8f8f" opacity=".35" />
      {m}
      {children}
    </g>
  );
}
