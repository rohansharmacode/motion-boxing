import { Mii, MII_CAST } from './Mii';

export type ChannelKind = 'disc' | 'boxing' | 'keeper' | 'bow' | 'player' | 'leaderboard';
const C = MII_CAST;
const Glove = ({ x, y, c, r = 0 }: { x: number; y: number; c: string; r?: number }) => (
  <g transform={`translate(${x} ${y}) rotate(${r})`}><path fill={c} stroke="#00000022" strokeWidth="2" d="M-14 8v-14q0-12 14-12t14 12v14q0 8-14 8t-14-8Z" /><rect x="-12" y="14" width="24" height="9" rx="3" fill="#fff" /><path d="M-8 -8q2-5 8-5" stroke="#fff" strokeWidth="3" fill="none" opacity=".6" strokeLinecap="round" /></g>
);

/** Original Wii-style channel pictures, drawn locally with Mii-like characters. */
export function ChannelArt({ kind }: { kind: ChannelKind }) {
  return <svg viewBox="0 0 300 170" preserveAspectRatio="xMidYMid slice" className={`wii-art wii-art-${kind}`} aria-hidden="true">
    {kind === 'disc' && <g transform="translate(150 85)"><circle r="62" fill="#e4e7ea" /><circle r="60" fill="url(#discg)" stroke="#cfd4d8" strokeWidth="2" /><circle r="16" fill="#d5d9dd" /><circle r="7" fill="#fff" /><defs><radialGradient id="discg"><stop offset=".3" stopColor="#ffffff" /><stop offset="1" stopColor="#eef1f3" /></radialGradient></defs><path d="M-40 -30A50 50 0 0 1 20 -48" stroke="#fff" strokeWidth="10" fill="none" opacity=".9" /></g>}
    {kind === 'player' && <g>
      <rect width="300" height="170" fill="#f4e9da" />
      {Array.from({ length: 18 }, (_, i) => { const col = i % 6, row = Math.floor(i / 6); return <Mii key={i} look={C[(i * 5 + row) % C.length]} x={25 + col * 50 + (row % 2) * 12} y={30 + row * 56} s={0.72} body={false} />; })}
    </g>}
    {kind === 'boxing' && <g>
      <rect width="300" height="170" fill="#bfe6f7" /><rect y="118" width="300" height="52" fill="#e9eef2" />
      <g stroke="#e14b45" strokeWidth="4"><path d="M0 70h300" /><path d="M0 92h300" stroke="#fff" /><path d="M0 114h300" stroke="#2ea8e0" /></g>
      <Mii look={{ ...C[0], brows: 'angry' }} x={100} y={72} s={1.05} />
      <Glove x={58} y={88} c="#e14b45" r={-20} /><Glove x={140} y={80} c="#e14b45" r={15} />
      <Mii look={{ ...C[7], mouth: 'o' }} x={215} y={78} s={0.95} />
      <Glove x={180} y={92} c="#2ea8e0" r={-12} /><Glove x={252} y={96} c="#2ea8e0" r={20} />
      <path d="M160 40l8-14 4 14 12-8-6 13" fill="none" stroke="#f3b33d" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </g>}
    {kind === 'keeper' && <g>
      <rect width="300" height="170" fill="#c9ecb4" /><rect y="128" width="300" height="42" fill="#8ccf6a" />
      <path d="M40 132V26h220v106" fill="none" stroke="#fff" strokeWidth="7" strokeLinejoin="round" />
      <g stroke="#ffffff" strokeWidth="1.4" opacity=".7">{Array.from({ length: 10 }, (_, i) => <path key={i} d={`M${60 + i * 20} 30v100`} />)}{Array.from({ length: 5 }, (_, i) => <path key={'h' + i} d={`M44 ${46 + i * 20}h212`} />)}</g>
      <g transform="rotate(-24 150 90)"><Mii look={C[2]} x={150} y={78} s={0.95} /><Glove x={104} y={70} c="#7bc043" r={-30} /><Glove x={196} y={66} c="#7bc043" r={30} /></g>
      <g transform="translate(232 54)"><circle r="17" fill="#fff" stroke="#333" strokeWidth="2" /><path d="M0 -7l7 5-3 8h-8l-3-8Z" fill="#333" /></g>
    </g>}
    {kind === 'bow' && <g>
      <rect width="300" height="170" fill="#fdeec0" /><rect y="130" width="300" height="40" fill="#b9dc8a" />
      <g transform="translate(232 82)"><circle r="44" fill="#fff" stroke="#ddd" strokeWidth="2" /><circle r="34" fill="#2ea8e0" /><circle r="23" fill="#e14b45" /><circle r="12" fill="#f3d46c" /></g>
      <Mii look={{ ...C[3], mouth: 'flat' }} x={86} y={80} s={1} />
      <path d="M128 40q26 45 0 90" fill="none" stroke="#9c4a2b" strokeWidth="5" strokeLinecap="round" /><path d="M128 40v90" stroke="#555" strokeWidth="1.5" />
      <path d="M128 85h88" stroke="#555" strokeWidth="3.5" strokeLinecap="round" /><path d="M216 85l-9-6v12Z" fill="#555" />
    </g>}
    {kind === 'leaderboard' && <g>
      <rect width="300" height="170" fill="#fff6d8" />
      <rect x="112" y="98" width="76" height="72" fill="#f3b33d" /><rect x="34" y="118" width="76" height="52" fill="#c7cdd2" /><rect x="190" y="130" width="76" height="40" fill="#d79a5b" />
      <text x="150" y="146" textAnchor="middle" fontSize="34" fontWeight="700" fill="#fff" fontFamily="Arial">1</text><text x="72" y="156" textAnchor="middle" fontSize="24" fontWeight="700" fill="#fff" fontFamily="Arial">2</text><text x="228" y="162" textAnchor="middle" fontSize="20" fontWeight="700" fill="#fff" fontFamily="Arial">3</text>
      <Mii look={{ ...C[1], mouth: 'grin', brows: 'up' }} x={150} y={44} s={0.78} />
      <Mii look={C[4]} x={72} y={64} s={0.72} /><Mii look={C[5]} x={228} y={78} s={0.68} />
    </g>}
  </svg>;
}
